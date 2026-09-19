import { describe, it, expect, vi } from 'vitest';
import { parseAnalysisResponse, MAX_RESPONSE_CHARS } from './aiAnalysis';

vi.mock('../utils/logger', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

/**
 * Il 19 settembre qwen è andato in loop su un reel: la stessa nota ripetuta —
 * `{"text": "Dove ca**o siete?", "category": "quote"}` — fino a 224.000
 * caratteri e 83.037 token, poi troncata a metà stringa. Il JSON era
 * illeggibile, l'analisi risultava vuota e partiva il fallback a pagamento.
 *
 * Il tetto vero sta nelle opzioni della richiesta (`num_predict`); questi
 * test coprono la rete di sicurezza a valle, per quando quel tetto non viene
 * applicato — un backend che ignora l'opzione, un router che riscrive le
 * opzioni per conto suo.
 */
const INPUT = {
  caption: 'Vegani e vegetariani di tutta Italia, dove siete?',
  musicInfo: null,
  transcript: null,
  transcriptLanguage: null,
  ocrText: null,
  visualContext: null,
  slidePaths: [],
  thumbnailPath: null,
};

describe('risposta fuori scala', () => {
  it('scarta 224KB senza tentare di parsarli', () => {
    // JSON *valido*, apposta: se fosse malformato verrebbe bocciato comunque
    // dal parser, e il test passerebbe senza provare niente sulla soglia.
    const note = Array(4000).fill({ text: 'Dove ca**o siete?', category: 'quote' });
    const runaway = JSON.stringify({ songs: [], films: [], notes: note, links: [], tags: [] });

    expect(() => JSON.parse(runaway)).not.toThrow();
    expect(runaway.length).toBeGreaterThan(MAX_RESPONSE_CHARS);
    expect(parseAnalysisResponse(runaway, INPUT)).toBeNull();
  });

  // La soglia deve stare larga rispetto a un'analisi vera, o taglierebbe
  // risultati buoni: un'analisi completa sta sotto i mille token.
  it('lascia passare una risposta lunga ma sensata', () => {
    const noteVere = Array.from({ length: 30 }, (_, i) =>
      `    { "text": "Osservazione numero ${i} sul contenuto del video", "category": "other" }`
    ).join(',\n');
    const lunga = `{\n  "songs": [],\n  "films": [],\n  "notes": [\n${noteVere}\n  ],\n  "links": [],\n  "tags": ["#uno"],\n  "summary": "Un riassunto di lunghezza normale."\n}`;

    expect(lunga.length).toBeLessThan(MAX_RESPONSE_CHARS);
    const risultato = parseAnalysisResponse(lunga, INPUT);
    expect(risultato?.notes).toHaveLength(30);
  });

  // La spirale può anche fermarsi entro il tetto e lasciare venti copie della
  // stessa nota: sono rumore comunque.
  it('toglie le note ripetute', () => {
    const ripetuta = '{ "text": "Dove ca**o siete?", "category": "quote" }';
    const json = `{"notes": [${Array(20).fill(ripetuta).join(',')}], "tags": [], "links": []}`;

    const risultato = parseAnalysisResponse(json, INPUT);
    expect(risultato?.notes).toHaveLength(1);
  });

  it('non confonde due note diverse della stessa categoria', () => {
    const json = `{"notes": [
      { "text": "Prima osservazione", "category": "quote" },
      { "text": "Seconda osservazione", "category": "quote" }
    ], "tags": [], "links": []}`;

    expect(parseAnalysisResponse(json, INPUT)?.notes).toHaveLength(2);
  });

  // Maiuscole e spazi di troppo sono la stessa nota per chi legge.
  it('riconosce come ripetuta anche una copia scritta diversamente', () => {
    const json = `{"notes": [
      { "text": "Dove siete?", "category": "quote" },
      { "text": "  dove siete?  ", "category": "quote" }
    ], "tags": [], "links": []}`;

    expect(parseAnalysisResponse(json, INPUT)?.notes).toHaveLength(1);
  });
});
