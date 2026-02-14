import Handlebars from 'handlebars';
import { db } from '../utils/firestore';
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
}

const DEFAULT_PROMPTS: PromptsConfig = {
  contentAnalysis: {
    name: 'Analisi contenuto (Gemini)',
    description: 'Prompt per estrarre canzoni e film da caption e thumbnail',
    template: `Analizza questo contenuto proveniente da un post social ed estrai TUTTE le informazioni utili.

Per le CANZONI cerca:
- Titoli di canzoni specifiche
- Artisti o band menzionati (es. "George Harrison", "Fleetwood Mac") - in questo caso usa il nome dell'artista come "artist" e la loro canzone più famosa come "title"
- Album menzionati
- Hashtag relativi a musica (es. #fleetwoodmac, #70smusic)

Per i FILM/SERIE cerca:
- Titoli di film o serie TV
- Scene o citazioni riconoscibili
- Registi o attori menzionati

Per le NOTE estrai osservazioni utili come:
- Luoghi menzionati (category: "place")
- Eventi (category: "event")
- Brand o aziende (category: "brand")
- Libri (category: "book")
- Prodotti (category: "product")
- Citazioni testuali (category: "quote")
- Persone menzionate che non sono artisti/registi (category: "person")
- Altro di rilevante (category: "other")

Per i LINK estrai tutti gli URL presenti nel testo con una breve descrizione.

Per i TAG estrai tutti gli hashtag (#esempio) e le menzioni (@utente).

Caption del post:
"{{caption}}"

{{#if hasImage}}[Thumbnail del post allegata come immagine]{{/if}}

IMPORTANTE: Se trovi artisti musicali menzionati (anche solo negli hashtag), includili come canzoni usando la loro hit più famosa.

Rispondi ESCLUSIVAMENTE con JSON valido, senza markdown, senza commenti, senza altro testo:
{
  "songs": [
    { "title": "nome canzone", "artist": "artista", "album": "album o null" }
  ],
  "films": [
    { "title": "titolo", "director": "regista o null", "year": "anno o null" }
  ],
  "notes": [
    { "text": "descrizione", "category": "place|event|brand|book|product|quote|person|other" }
  ],
  "links": [
    { "url": "https://...", "label": "descrizione del link o null" }
  ],
  "tags": ["#hashtag", "@utente"],
  "summary": "breve riassunto di 1-2 frasi del contenuto del post"
}

Se non trovi nulla, rispondi: { "songs": [], "films": [], "notes": [], "links": [], "tags": [], "summary": null }`,
    variables: ['caption', 'hasImage'],
    updatedAt: new Date().toISOString()
  },
  telegramResponse: {
    name: 'Risposta Telegram',
    description: 'Template per la risposta del bot dopo l\'analisi',
    template: `🎵 SoundReel ha analizzato il tuo link!

{{#if hasSongs}}
🎶 Canzoni trovate:
{{#each songs}}
• {{title}} — {{artist}}{{#if album}} ({{album}}){{/if}}{{#if addedToPlaylist}} ✓{{/if}}
{{/each}}
{{/if}}

{{#if hasFilms}}
🎬 Film trovati:
{{#each films}}
• {{title}}{{#if year}} ({{year}}){{/if}}{{#if director}} — {{director}}{{/if}}
{{/each}}
{{/if}}

{{#if hasNotes}}
📝 Note:
{{#each notes}}
• {{text}}
{{/each}}
{{/if}}

{{#if hasLinks}}
🔗 Link:
{{#each links}}
• {{#if label}}{{label}}: {{/if}}{{url}}
{{/each}}
{{/if}}

{{#if hasTags}}
🏷 {{#each tags}}{{this}} {{/each}}
{{/if}}

{{#unless hasSongs}}{{#unless hasFilms}}{{#unless hasNotes}}{{#unless hasLinks}}{{#unless hasTags}}
❌ Nessun contenuto identificato.
{{/unless}}{{/unless}}{{/unless}}{{/unless}}{{/unless}}`,
    variables: ['songs', 'films', 'notes', 'links', 'tags', 'hasSongs', 'hasFilms', 'hasNotes', 'hasLinks', 'hasTags', 'frontendUrl'],
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
    const doc = await db.collection('config').doc('prompts').get();

    if (!doc.exists) {
      logInfo('Prompt config non trovata, uso default');
      cachedPrompts = DEFAULT_PROMPTS;
      cacheTimestamp = now;
      return DEFAULT_PROMPTS;
    }

    const data = doc.data() as Partial<PromptsConfig>;
    cachedPrompts = {
      contentAnalysis: data.contentAnalysis || DEFAULT_PROMPTS.contentAnalysis,
      telegramResponse: data.telegramResponse || DEFAULT_PROMPTS.telegramResponse
    };
    cacheTimestamp = now;

    logInfo('Prompt caricati da Firestore');
    return cachedPrompts;
  } catch (error) {
    logWarning('Errore caricamento prompt, uso default', { error });
    return DEFAULT_PROMPTS;
  }
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
