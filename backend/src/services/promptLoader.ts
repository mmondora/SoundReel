import Handlebars from 'handlebars';
import { getPromptsConfig, setPromptsConfig } from '../utils/db';
import { logInfo, logWarning } from '../utils/logger';

export interface PromptTemplate {
  name: string;
  description: string;
  template: string;
  variables: string[];
  updatedAt: string;
}

export interface PromptsConfig {
  contentAnalysis: PromptTemplate;
  telegramResponse: PromptTemplate;
  enrichment: PromptTemplate;
  mediaAnalysis: PromptTemplate;
  webPageAnalysis: PromptTemplate;
}

const DEFAULT_PROMPTS: PromptsConfig = {
  contentAnalysis: {
    name: 'Analisi contenuto (multimodale locale)',
    description: 'Prompt per estrarre canzoni, film, note da caption + trascrizione + OCR + contesto visivo',
    template: `Analizza questo contenuto proveniente da un post social (Instagram) ed estrai TUTTE le informazioni utili.

Le fonti di input (alcune possono essere vuote):

1) Caption del post:
"{{caption}}"

{{#if hasMusicInfo}}
2) Musica ufficiale del post (metadato autoritativo fornito da Instagram):
   - Titolo: "{{musicInfo.title}}"
   - Artista: "{{musicInfo.artist}}"
REGOLA: questa canzone è GIÀ nota e verrà usata dal sistema. NON includerla nell'array "songs" del JSON a meno che la caption o altro testo ne menzioni ESPLICITAMENTE UN'ALTRA diversa.
{{/if}}

{{#if hasTranscript}}
3) Trascrizione del parlato (lingua: {{transcriptLanguage}}):
"""
{{transcript}}
"""
{{/if}}

{{#if hasOcr}}
4) Testo estratto via OCR dai frame video e/o dalle slide del carosello (testo sovrapposto / overlay):
"""
{{ocrText}}
"""
{{/if}}

{{#if hasVisualContext}}
5) Descrizione visiva sintetica dei frame chiave del video:
"""
{{visualContext}}
"""
{{/if}}

{{#if isCarousel}}[Sono allegate {{carouselCount}} immagini del carosello — osservale per completezza]{{else}}{{#if hasImage}}[È allegata la thumbnail del post]{{/if}}{{/if}}

Compiti:

- CANZONI: Estrai canzoni esplicitamente menzionate in caption, OCR o transcript (titolo + artista, album se disponibile). NON dedurre canzoni dalle descrizioni visive. Se sono menzionati solo artisti/band, usa la loro hit più famosa come canzone. {{#if hasMusicInfo}}NON includere "{{musicInfo.title}}" di "{{musicInfo.artist}}" perché è già nota.{{/if}}

- FILM/SERIE: Estrai film o serie menzionati/citati/mostrati (titolo, regista o null, anno o null).

- NOTE: Luoghi (place), eventi (event), brand (brand), libri (book), prodotti (product), citazioni testuali (quote), persone non-artiste (person), altro (other).

- LINK: URL presenti nei testi (caption, OCR, transcript).

- TAG: Hashtag (#x) e menzioni (@x) dalla caption.

- SUMMARY: Riassunto di 1-2 frasi dell'intero contenuto (caption + video + overlay).

- TRANSCRIPTION: Ricopia qui il transcript ricevuto, oppure null se assente.

- VISUAL_CONTEXT: Ricopia la descrizione visiva ricevuta, oppure null.

- OVERLAY_TEXT: Ricopia il testo OCR ricevuto, oppure null.

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti:
{
  "songs": [ { "title": "...", "artist": "...", "album": "... o null" } ],
  "films": [ { "title": "...", "director": "... o null", "year": "... o null" } ],
  "notes": [ { "text": "...", "category": "place|event|brand|book|product|quote|person|other" } ],
  "links": [ { "url": "https://...", "label": "... o null" } ],
  "tags": ["#tag", "@utente"],
  "summary": "...",
  "transcription": "... o null",
  "visualContext": "... o null",
  "overlayText": "... o null"
}

Se non trovi nulla, rispondi: { "songs": [], "films": [], "notes": [], "links": [], "tags": [], "summary": null, "transcription": null, "visualContext": null, "overlayText": null }`,
    variables: [
      'caption', 'hasCaption',
      'musicInfo', 'hasMusicInfo',
      'transcript', 'hasTranscript', 'transcriptLanguage',
      'ocrText', 'hasOcr',
      'visualContext', 'hasVisualContext',
      'isCarousel', 'carouselCount',
      'hasImage',
    ],
    updatedAt: new Date().toISOString()
  },
  enrichment: {
    name: 'Enrichment contestuale (Arricchisci)',
    description: 'Prompt che classifica il contenuto (tech/security/claim/generic) e produce arricchimento su misura, con verdict per sicurezza e fact-check',
    template: `Dato il seguente contenuto estratto da un post social:

{{#each songs}}
- Canzone: "{{title}}" di {{artist}}
{{/each}}
{{#each films}}
- Film: "{{title}}"{{#if director}} di {{director}}{{/if}}{{#if year}} ({{year}}){{/if}}
{{/each}}
{{#each notes}}
- {{category}}: {{text}}
{{/each}}
{{#each links}}
- Link: {{url}}{{#if label}} ({{label}}){{/if}}
{{/each}}
{{#each tags}}
- Tag: #{{this}}
{{/each}}
{{#if caption}}
- Caption del post: "{{caption}}"
{{/if}}

Prima di tutto CAPISCI di che tipo di contenuto si tratta, scegliendo UNA categoria tra:

- "tech": il contenuto principale è un link a un repository GitHub, un progetto software, uno strumento per sviluppatori o documentazione tecnica.
- "security": il contenuto riguarda un link, un dominio o un servizio la cui affidabilità/sicurezza è rilevante da valutare (link sospetti, shortener, offerte, richieste di credenziali, domini poco noti).
- "claim": il contenuto afferma un fatto, una notizia, un evento straordinario o virale la cui veridicità va verificata (es. scoperte incredibili, notizie clamorose, leggende metropolitane).
- "generic": nessuno dei casi sopra si applica — canzoni, film, prodotti, luoghi, persone menzionati senza bisogno di verifica di sicurezza o veridicità.

Poi, IN BASE ALLA CATEGORIA scelta, produci il contenuto richiesto:

- Se "tech": per ogni repository/progetto trovato, spiega cosa fa, con quali tecnologie è costruito, quanto è attivo/mantenuto, licenza se nota, e considerazioni tecniche utili. NON includere "verdict".
- Se "security": valuta il/i link o domini coinvolti. Cerca segnali di phishing, scam, reputazione del dominio, età del dominio se determinabile. Includi "verdict" con "label" tra "sicuro" | "sospetto" | "phishing", "confidence" (0-100) e "explanation" chiara.
- Se "claim": verifica l'affermazione cercando fonti attendibili sul web. Includi "verdict" con "label" tra "vero" | "falso" | "dubbio" | "ai-generated", "confidence" (0-100) e "explanation" che cita cosa hai trovato (o non trovato) a supporto.
- Se "generic": cerca link utili e verificati per ogni elemento rilevante (canzone, film, prodotto, brand, luogo, persona, evento), come faresti oggi. NON includere "verdict".

Per ogni elemento analizzato, in "items", includi sempre "label" (nome sintetico dell'elemento), "explanation" (2-3 frasi di considerazioni/dettagli), e "links" (URL verificati pertinenti, array vuoto se non applicabile).

Rispondi SOLO con un JSON object valido, senza markdown, senza backtick, senza testo aggiuntivo.
Formato:
{
  "category": "tech" | "security" | "claim" | "generic",
  "verdict": {
    "label": "sicuro" | "sospetto" | "phishing" | "vero" | "falso" | "dubbio" | "ai-generated",
    "confidence": 0-100,
    "explanation": "..."
  },
  "items": [
    {
      "label": "Nome dell'elemento",
      "explanation": "Considerazioni e dettagli",
      "links": [
        { "url": "https://...", "title": "Titolo del link", "snippet": "Breve descrizione" }
      ]
    }
  ]
}

Ometti completamente il campo "verdict" se la categoria è "tech" o "generic".
Se non trovi nulla di rilevante, rispondi con: { "category": "generic", "items": [] }`,
    variables: ['songs', 'films', 'notes', 'tags', 'links', 'caption'],
    updatedAt: new Date().toISOString()
  },
  mediaAnalysis: {
    name: 'Analisi Media (Audio/Video)',
    description: 'Prompt per analizzare audio e video con trascrizione, riconoscimento musica e descrizione visiva',
    template: `Analizza in dettaglio questo contenuto multimediale proveniente da un post social.

{{#if caption}}Caption del post: "{{caption}}"{{/if}}

{{#if hasImage}}[Thumbnail del post allegata come immagine]{{/if}}

[File media (audio/video) allegato]

Esegui TUTTE le seguenti analisi:

1. TRASCRIZIONE: Trascrivi FEDELMENTE tutto il parlato, i dialoghi, la voce narrante e qualsiasi testo pronunciato nel media. Se non c'è parlato, scrivi null.

2. MUSICA: Identifica canzoni in sottofondo o cantate. Per ciascuna indica titolo, artista e album se possibile.

3. FILM/SERIE: Identifica riferimenti a film, serie TV, scene o citazioni riconoscibili.

4. CONTESTO VISIVO: Descrivi brevemente le scene principali del video: ambientazioni, persone, azioni, prodotti mostrati, brand visibili.

5. TESTO SOVRAPPOSTO: Trascrivi qualsiasi testo che appare sovrapposto nel video (sottotitoli aggiunti, didascalie, scritte grafiche). Se non c'è testo sovrapposto, scrivi null.

6. NOTE: Estrai osservazioni utili (luoghi, eventi, brand, libri, prodotti, citazioni, persone) con le categorie appropriate.

7. LINK: Estrai tutti gli URL presenti nel testo o mostrati nel video.

8. TAG: Estrai hashtag e menzioni.

9. SUMMARY: Un breve riassunto di 1-2 frasi del contenuto complessivo.

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti:
{
  "transcription": "trascrizione completa del parlato o null",
  "songs": [
    { "title": "nome canzone", "artist": "artista", "album": "album o null" }
  ],
  "films": [
    { "title": "titolo", "director": "regista o null", "year": "anno o null" }
  ],
  "visualContext": "descrizione delle scene principali del video o null",
  "overlayText": "testo sovrapposto nel video o null",
  "notes": [
    { "text": "descrizione", "category": "place|event|brand|book|product|quote|person|other" }
  ],
  "links": [
    { "url": "https://...", "label": "descrizione del link o null" }
  ],
  "tags": ["#hashtag", "@utente"],
  "summary": "breve riassunto di 1-2 frasi"
}

Se non trovi nulla per un campo, usa un array vuoto [] o null.`,
    variables: ['caption', 'hasImage'],
    updatedAt: new Date().toISOString()
  },
  webPageAnalysis: {
    name: 'Analisi pagina web',
    description: 'Prompt per analizzare una pagina web (articolo, blog, post) e produrre sintesi + link categorizzati',
    template: `Analizza questa pagina web ed estrai informazioni strutturate.

Fonti:
- Titolo: "{{title}}"
{{#if description}}- Descrizione: "{{description}}"{{/if}}
{{#if siteName}}- Sito: {{siteName}}{{/if}}
{{#if lang}}- Lingua dichiarata: {{lang}}{{/if}}

{{#if hasMainText}}
Testo principale (estratto via Readability):
"""
{{mainText}}
"""
{{else}}
[Testo principale non estraibile — analizza usando solo titolo + descrizione]
{{/if}}

Link presenti nella pagina (massimo 100, già dedotti):
{{#each rawLinks}}
- {{url}}{{#if anchorText}} — "{{anchorText}}"{{/if}}
{{/each}}

Compiti:
1) SUMMARY: Sintesi in italiano, max 280 caratteri, una sola frase o due brevi. Cattura il punto della pagina.
2) LINKS: Seleziona dai link forniti quelli più utili (max 30). Per ognuno:
   - "url": **deve esistere ESATTAMENTE in rawLinks**, non inventare
   - "label": breve etichetta in italiano (anchor text pulito o derivato dal contesto)
   - "category": una di "referenced" | "sponsor" | "navigation" | "related" | "social" | "other"
3) TAGS: Hashtag o keyword tematiche (max 8).
4) NOTES: Luoghi, eventi, brand, libri, prodotti, citazioni, persone menzionati.
5) SONGS: Solo se la pagina cita esplicitamente canzoni (titolo + artista).
6) FILMS: Solo se la pagina cita film/serie (titolo + regista? + anno?).

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti:
{
  "summary": "... (max 280 char)",
  "links": [ { "url": "https://...", "label": "...", "category": "referenced" } ],
  "tags": ["..."],
  "notes": [ { "text": "...", "category": "place|event|brand|book|product|quote|person|other" } ],
  "songs": [ { "title": "...", "artist": "...", "album": "... o null" } ],
  "films": [ { "title": "...", "director": "... o null", "year": "... o null" } ]
}

Se non trovi nulla rispondi con summary "..." e gli altri campi come array vuoti.`,
    variables: ['title', 'description', 'siteName', 'lang', 'mainText', 'hasMainText', 'rawLinks'],
    updatedAt: new Date().toISOString(),
  },
  telegramResponse: {
    name: 'Risposta Telegram',
    description: 'Template per la risposta del bot dopo l\'analisi',
    template: `<b>{{title}}</b>
{{#if hasSummary}}{{summary}}{{/if}}

{{#if hasCounts}}🔗 {{linksCount}} · 🎵 {{songsCount}} · 🎬 {{filmsCount}}{{/if}}
🌐 <a href="{{frontendUrl}}">Apri su SoundReel</a>`,
    variables: [
      'title', 'summary', 'hasSummary',
      'linksCount', 'songsCount', 'filmsCount', 'hasCounts',
      'frontendUrl',
    ],
    updatedAt: new Date().toISOString()
  }
};

// Cache
let cachedPrompts: PromptsConfig | null = null;
let cacheTimestamp = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minuti

export async function getPrompts(): Promise<PromptsConfig> {
  const now = Date.now();

  if (cachedPrompts && (now - cacheTimestamp) < CACHE_TTL) {
    return cachedPrompts;
  }

  try {
    const data = (await getPromptsConfig()) as unknown as Partial<PromptsConfig>;

    if (!data || Object.keys(data).length === 0) {
      logInfo('Prompt config non trovata, uso default');
      cachedPrompts = DEFAULT_PROMPTS;
      cacheTimestamp = now;
      return DEFAULT_PROMPTS;
    }

    cachedPrompts = {
      contentAnalysis: data.contentAnalysis || DEFAULT_PROMPTS.contentAnalysis,
      telegramResponse: data.telegramResponse || DEFAULT_PROMPTS.telegramResponse,
      enrichment: data.enrichment || DEFAULT_PROMPTS.enrichment,
      mediaAnalysis: data.mediaAnalysis || DEFAULT_PROMPTS.mediaAnalysis,
      webPageAnalysis: data.webPageAnalysis || DEFAULT_PROMPTS.webPageAnalysis,
    };
    cacheTimestamp = now;

    logInfo('Prompt caricati da Postgres');
    return cachedPrompts;
  } catch (error) {
    logWarning('Errore caricamento prompt, uso default', { error });
    return DEFAULT_PROMPTS;
  }
}

export async function savePrompts(config: PromptsConfig): Promise<void> {
  await setPromptsConfig(config as unknown as Record<string, string>);
  invalidateCache();
}

export async function getPrompt(promptId: keyof PromptsConfig): Promise<PromptTemplate> {
  const prompts = await getPrompts();
  return prompts[promptId];
}

export function renderTemplate(template: string, data: Record<string, unknown>): string {
  const compiled = Handlebars.compile(template);
  return compiled(data);
}

export function invalidateCache(): void {
  cachedPrompts = null;
  cacheTimestamp = 0;
}

export function getDefaultPrompts(): PromptsConfig {
  return DEFAULT_PROMPTS;
}
