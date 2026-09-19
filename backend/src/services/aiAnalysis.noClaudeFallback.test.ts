import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * La non-regressione che conta davvero.
 *
 * I test su `repairJsonEscapes` provano che la riparazione funziona; questi
 * provano la conseguenza per cui è stata scritta: un'analisi che qwen ha fatto
 * bene non deve più finire su Claude solo perché l'OCR aveva infilato una
 * barra rovesciata nel testo.
 *
 * Il 19 settembre è costato due chiamate — `claude-opus-4-8` e poi `haiku` —
 * su un reel dove qwen aveva già estratto note, persona e link corretti.
 */

const generateText = vi.fn();
const runClaudePrompt = vi.fn();

vi.mock('./ollamaClient', () => ({
  generateText: (...a: unknown[]) => generateText(...a),
  OllamaImage: class {},
  BackendUnavailableError: class extends Error {},
  OllamaTransientError: class extends Error {},
}));

vi.mock('./claudeFallback', () => ({
  runClaudePrompt: (...a: unknown[]) => runClaudePrompt(...a),
  logFallbackOutcome: vi.fn(),
}));

vi.mock('./promptLoader', () => ({
  getPrompt: vi.fn().mockResolvedValue({ template: '{{caption}} {{ocrText}}' }),
  renderTemplate: (tpl: string, vars: Record<string, unknown>) =>
    tpl.replace('{{caption}}', String(vars.caption ?? '')).replace('{{ocrText}}', String(vars.ocrText ?? '')),
}));

vi.mock('../utils/logger', () => ({
  logInfo: vi.fn(),
  logWarning: vi.fn(),
  logError: vi.fn(),
}));

/** La risposta reale di qwen, con la barra rovesciata che l'OCR gli ha passato. */
const RISPOSTA_CON_BARRA = `{
  "songs": [],
  "films": [],
  "notes": [
    { "text": "L'IMPERMANENZA", "category": "quote" },
    { "text": "Deepak Chopra", "category": "person" }
  ],
  "links": [],
  "tags": ["#DeepakChopra", "#Consapevolezza"],
  "summary": "Riflessione sull'impermanenza come ciò che rende la vita preziosa.",
  "visualContext": "wif We % \\ N"
}`;

const INPUT = {
  caption: "L'impermanenza rende la vita elegante e preziosa, diceva Deepak Chopra in questo video.",
  musicInfo: null,
  transcript: 'impermanence makes life elegant and precious',
  transcriptLanguage: 'en',
  ocrText: null,
  visualContext: null,
  slidePaths: [],
  thumbnailPath: null,
};

describe('una risposta valida di qwen non finisce su Claude', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    generateText.mockResolvedValue({ text: RISPOSTA_CON_BARRA, usageMetadata: null });
    runClaudePrompt.mockResolvedValue({ status: 'ok', text: '{}', model: 'haiku' });
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('il JSON con la barra rovesciata viene letto, non scartato', async () => {
    const { parseAnalysisResponse } = await import('./aiAnalysis');
    const risultato = parseAnalysisResponse(RISPOSTA_CON_BARRA, INPUT);

    expect(risultato).not.toBeNull();
    expect(risultato?.notes.map((n) => n.text)).toEqual(['L\'IMPERMANENZA', 'Deepak Chopra']);
    expect(risultato?.tags).toContain('#DeepakChopra');
    expect(risultato?.summary).toContain('impermanenza');
  });

  // Il punto: nessuna chiamata a pagamento per rifare un lavoro già fatto.
  it('Claude non viene chiamato', async () => {
    const { analyzeWithAi } = await import('./aiAnalysis');
    const risposta = await analyzeWithAi(INPUT);

    expect(runClaudePrompt).not.toHaveBeenCalled();
    expect(risposta.result.notes).toHaveLength(2);
    expect(risposta.fallback).toBeNull();
  });

  // La rete di sicurezza resta: se il modello non produce davvero niente, il
  // fallback deve continuare a scattare come prima.
  it('ma Claude interviene ancora quando qwen non estrae nulla', async () => {
    generateText.mockResolvedValue({
      text: '{"songs":[],"films":[],"notes":[],"links":[],"tags":[],"summary":null}',
      usageMetadata: null,
    });
    runClaudePrompt.mockResolvedValue({
      status: 'ok',
      model: 'haiku',
      text: '{"songs":[],"films":[],"notes":[{"text":"recuperata","category":"other"}],"links":[],"tags":[],"summary":"riassunto"}',
    });

    const { analyzeWithAi } = await import('./aiAnalysis');
    const risposta = await analyzeWithAi(INPUT);

    expect(runClaudePrompt).toHaveBeenCalledTimes(1);
    expect(risposta.result.notes.map((n) => n.text)).toEqual(['recuperata']);
  });

  // Se nemmeno la riparazione basta, si rinuncia come prima: meglio nessun
  // risultato che uno inventato dal riparatore.
  it('un JSON irrecuperabile resta un fallimento', async () => {
    const { parseAnalysisResponse } = await import('./aiAnalysis');
    expect(parseAnalysisResponse('{"notes": [ {"text": mancano le virgolette} ]}', INPUT)).toBeNull();
  });
});

describe('il rumore OCR non arriva al modello', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
  });

  // Prima ancora della riparazione: se la barra non entra nel prompt, il
  // modello non ha niente da ricopiare.
  it('la barra rovesciata non entra nel prompt', async () => {
    const { buildAnalysisPrompt } = await import('./aiAnalysis');
    const prompt = await buildAnalysisPrompt({ ...INPUT, ocrText: 'wif We % \\ N' });

    expect(prompt).not.toContain('\\');
    expect(prompt).toContain('wif We % N');
  });

  it('il testo vero dell\'OCR arriva intero', async () => {
    const { buildAnalysisPrompt } = await import('./aiAnalysis');
    const prompt = await buildAnalysisPrompt({ ...INPUT, ocrText: "L'IMPERMANENZA — Deepak Chopra" });

    expect(prompt).toContain("L'IMPERMANENZA — Deepak Chopra");
  });
});
