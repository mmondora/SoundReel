# Context-Aware Enrichment ("Arricchisci") Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken manual "Deep Search" trigger and replace its context-blind enrichment with a single self-classifying enrichment ("Arricchisci") that detects tech/security/claim/generic content and, for security/claim categories, surfaces a verdict tag (vero/falso/dubbio/ai-generated/phishing/sicuro/sospetto) with confidence and explanation.

**Architecture:** One rewritten OpenAI prompt (Responses API + `web_search_preview`, already in use) does classification and category-tailored output in a single call, returning a JSON object (not array) with `category`, optional `verdict`, and `items[]` (each item now carries an `explanation`). The service, route, types, and UI are updated to the new shape end-to-end.

**Tech Stack:** TypeScript (backend Node 20 + Fastify, frontend React), PostgreSQL (jsonb `results` column), Vitest for tests, Handlebars for prompt templating.

## Global Constraints

- TypeScript strict mode, no `any` — types live in `types/index.ts` (backend and frontend, kept in sync).
- No ORM — direct SQL via `pg` (already the case in `utils/db.ts`; not touched by this plan beyond the existing `updateEntry`/`appendActionLog` calls).
- Secrets via env vars only — untouched by this plan.
- Every pipeline failure must be caught and logged, never crash the request (CLAUDE.md § Resilienza della pipeline).
- Tests: Vitest, mocked `fetch`/DB/services — no real calls to OpenAI, Instagram, etc. (CLAUDE.md testing rules).
- Verification commands used throughout this plan:
  - Backend tests: `cd /home/mike/works/Soundreel/backend && npx vitest run <file>`
  - Backend typecheck: `cd /home/mike/works/Soundreel/backend && npm run typecheck`
  - Frontend typecheck: `cd /home/mike/works/Soundreel/frontend && npx tsc -b`

---

### Task 1: Shared Enrichment Types

**Files:**
- Modify: `backend/src/types/index.ts:61-84` (replace `EnrichmentLink`/`EnrichmentItem`, update `EntryResults.enrichments`)
- Modify: `frontend/src/types/index.ts:59-82` (same change, kept in sync as today)

**Interfaces:**
- Produces: `EnrichmentCategory`, `EnrichmentVerdictLabel`, `EnrichmentVerdict`, `EnrichmentLink`, `EnrichmentItem`, `EnrichmentResult` — used by every later task.

This is a pure type change with no independent test cycle; verification is the typecheck command run in Step 2.

- [ ] **Step 1: Edit backend types**

In `backend/src/types/index.ts`, replace lines 61-70 (`EnrichmentLink` / `EnrichmentItem`) with:

```ts
export type EnrichmentCategory = 'tech' | 'security' | 'claim' | 'generic';

export type EnrichmentVerdictLabel =
  | 'vero' | 'falso' | 'dubbio' | 'ai-generated' | 'phishing' | 'sicuro' | 'sospetto';

export interface EnrichmentVerdict {
  label: EnrichmentVerdictLabel;
  confidence: number;
  explanation: string;
}

export interface EnrichmentLink {
  url: string;
  title: string;
  snippet: string;
}

export interface EnrichmentItem {
  label: string;
  explanation: string;
  links: EnrichmentLink[];
}

export interface EnrichmentResult {
  category: EnrichmentCategory;
  verdict?: EnrichmentVerdict;
  items: EnrichmentItem[];
}
```

Then in `EntryResults` (originally lines 72-84), change:

```ts
  enrichments?: EnrichmentItem[];
```

to:

```ts
  enrichments?: EnrichmentResult;
```

- [ ] **Step 2: Mirror the same edit in frontend types**

In `frontend/src/types/index.ts`, replace lines 59-68 (`EnrichmentLink` / `EnrichmentItem`) with the identical block from Step 1, and change `EntryResults.enrichments` (originally line 78) from `EnrichmentItem[]` to `EnrichmentResult`, exactly as in Step 1.

- [ ] **Step 3: Verify both projects still typecheck**

Run: `cd /home/mike/works/Soundreel/backend && npm run typecheck`
Expected: FAILS — `backend/src/services/openaiEnrich.ts` still returns `EnrichmentItem[]` and `backend/src/routes/analyze.ts` still calls `.length`/`.reduce` on the old array shape. This confirms the type change is live; both call sites are fixed in Tasks 3 and 5.

Run: `cd /home/mike/works/Soundreel/frontend && npx tsc -b`
Expected: FAILS — `frontend/src/components/EntryInspector.tsx` still treats `enrichments` as an array. Fixed in Task 8.

- [ ] **Step 4: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/types/index.ts frontend/src/types/index.ts
git commit -m "feat(types): add category/verdict shape for context-aware enrichment"
```

---

### Task 2: Rewrite the Enrichment Prompt Template

**Files:**
- Modify: `backend/src/services/promptLoader.ts:107-149` (the `enrichment` entry in `DEFAULT_PROMPTS`)
- Test: `backend/src/services/promptLoader.test.ts` (new file)

**Interfaces:**
- Consumes: none new.
- Produces: `DEFAULT_PROMPTS.enrichment.template` now expects `songs`, `films`, `notes`, `tags`, `links`, `caption` as Handlebars context (added `links`, others unchanged) and instructs the model to output the `{category, verdict?, items[]}` JSON shape from Task 1. `openaiEnrich.ts` (Task 3) passes `links` into the template context.

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/promptLoader.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getDefaultPrompts, renderTemplate } from './promptLoader';

describe('enrichment prompt template', () => {
  it('instructs the model to classify category and emit the new JSON shape', () => {
    const { template } = getDefaultPrompts().enrichment;
    expect(template).toContain('"category"');
    expect(template).toContain('"verdict"');
    expect(template).toContain('"tech"');
    expect(template).toContain('"security"');
    expect(template).toContain('"claim"');
    expect(template).toContain('"generic"');
    expect(template).toContain('phishing');
  });

  it('renders links into the prompt when provided', () => {
    const { template } = getDefaultPrompts().enrichment;
    const rendered = renderTemplate(template, {
      songs: [], films: [], notes: [], tags: [],
      links: [{ url: 'https://github.com/foo/bar', label: null }],
      caption: null,
    });
    expect(rendered).toContain('https://github.com/foo/bar');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/promptLoader.test.ts`
Expected: FAIL — current template has no `"category"`/`"verdict"` keys and never renders a `links` loop.

- [ ] **Step 3: Replace the `enrichment` template**

In `backend/src/services/promptLoader.ts`, replace the entire `enrichment: { ... }` block (lines 107-149) with:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/promptLoader.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/promptLoader.ts backend/src/services/promptLoader.test.ts
git commit -m "feat(prompts): rewrite enrichment template for context classification + verdict"
```

---

### Task 3: Rewrite `openaiEnrich.ts` Service

**Files:**
- Modify: `backend/src/services/openaiEnrich.ts` (full rewrite)
- Test: `backend/src/services/openaiEnrich.test.ts` (new file)

**Interfaces:**
- Consumes: `EnrichmentResult`, `EnrichmentItem`, `EnrichmentVerdict`, `EnrichmentVerdictLabel`, `EntryResults` from `../types` (Task 1); `getPrompt`/`renderTemplate` from `./promptLoader` (Task 2, template now expects a `links` key); `getOpenAIConfig` from `../utils/db`; `logWarning` from `../utils/logger`.
- Produces: `enrichWithOpenAI(results: EntryResults, caption: string | null): Promise<EnrichmentResult>` — used by Task 4 (route) and Task 5 (analyze.ts auto-enrich).

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/openaiEnrich.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../utils/db', () => ({ getOpenAIConfig: vi.fn() }));
vi.mock('./promptLoader', () => ({ getPrompt: vi.fn(), renderTemplate: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn() }));

import { enrichWithOpenAI } from './openaiEnrich';
import { getOpenAIConfig } from '../utils/db';
import { getPrompt, renderTemplate } from './promptLoader';
import { logWarning } from '../utils/logger';

const EMPTY_RESULTS = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };

function mockOpenAIOutputText(text: string) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
    }),
  }));
}

describe('enrichWithOpenAI', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getOpenAIConfig).mockResolvedValue({ apiKey: 'sk-test', enabled: true });
    vi.mocked(getPrompt).mockResolvedValue({
      name: 'x', description: 'x', template: 'TPL', variables: [], updatedAt: '2026-01-01',
    });
    vi.mocked(renderTemplate).mockReturnValue('rendered prompt');
  });

  it('throws when API key is missing', async () => {
    vi.mocked(getOpenAIConfig).mockResolvedValue({ apiKey: null, enabled: false });
    await expect(enrichWithOpenAI(EMPTY_RESULTS, null)).rejects.toThrow(/API key non configurata/);
  });

  it('throws when the OpenAI response is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' }));
    await expect(enrichWithOpenAI(EMPTY_RESULTS, null)).rejects.toThrow(/OpenAI API error 500/);
  });

  it('returns generic empty fallback when there is no output_text content', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ output: [] }),
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
  });

  it('parses a tech category response without a verdict', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'tech',
      items: [{
        label: 'foo/bar', explanation: 'A CLI tool for X, actively maintained, MIT license.',
        links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: 'GitHub repo' }],
      }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('tech');
    expect(result.verdict).toBeUndefined();
    expect(result.items).toEqual([{
      label: 'foo/bar', explanation: 'A CLI tool for X, actively maintained, MIT license.',
      links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: 'GitHub repo' }],
    }]);
  });

  it('parses a security category response with a verdict, clamping confidence', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'security',
      verdict: { label: 'phishing', confidence: 150, explanation: 'Domain registered yesterday, mimics a bank login page.' },
      items: [{ label: 'evil-bank-login.com', explanation: 'Newly registered domain.', links: [] }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('security');
    expect(result.verdict).toEqual({
      label: 'phishing', confidence: 100, explanation: 'Domain registered yesterday, mimics a bank login page.',
    });
    expect(result.items).toEqual([]); // item has no links, filtered out like today
  });

  it('parses a claim category response with a verdict', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'claim',
      verdict: { label: 'falso', confidence: 92, explanation: 'No credible source reports this; likely satire.' },
      items: [{
        label: 'Massive doorway discovered in Kentucky', explanation: 'Originated from a satire site, no scientific source confirms it.',
        links: [{ url: 'https://example.com/factcheck', title: 'Fact-check article', snippet: 'Debunked' }],
      }],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('claim');
    expect(result.verdict?.label).toBe('falso');
    expect(result.items[0].label).toBe('Massive doorway discovered in Kentucky');
  });

  it('defaults to generic when category is missing or invalid', async () => {
    mockOpenAIOutputText(JSON.stringify({ items: [] }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.category).toBe('generic');
  });

  it('drops verdict for tech/generic even if the model includes one', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'generic',
      verdict: { label: 'vero', confidence: 99, explanation: 'should be ignored' },
      items: [],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.verdict).toBeUndefined();
  });

  it('falls back to generic/empty and logs a warning on malformed JSON', async () => {
    mockOpenAIOutputText('not valid json {{{');
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
    expect(logWarning).toHaveBeenCalled();
  });

  it('strips markdown code fences before parsing', async () => {
    mockOpenAIOutputText('```json\n' + JSON.stringify({ category: 'generic', items: [] }) + '\n```');
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result).toEqual({ category: 'generic', items: [] });
  });

  it('filters out items missing label or links, and links missing url/title', async () => {
    mockOpenAIOutputText(JSON.stringify({
      category: 'generic',
      items: [
        { label: 'no links', explanation: '', links: [] },
        { explanation: 'no label', links: [{ url: 'https://x.com', title: 'x' }] },
        {
          label: 'valid', explanation: 'ok',
          links: [
            { url: 'https://x.com', title: 'x', snippet: 'y' },
            { url: 'https://missing-title.com' },
          ],
        },
      ],
    }));
    const result = await enrichWithOpenAI(EMPTY_RESULTS, null);
    expect(result.items).toEqual([{
      label: 'valid', explanation: 'ok',
      links: [{ url: 'https://x.com', title: 'x', snippet: 'y' }],
    }]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/openaiEnrich.test.ts`
Expected: FAIL — current `enrichWithOpenAI` returns `EnrichmentItem[]` from a top-level array, not `{category, verdict?, items}` from a top-level object; most assertions above fail or throw.

- [ ] **Step 3: Rewrite the implementation**

Replace the full contents of `backend/src/services/openaiEnrich.ts` with:

```ts
import { getOpenAIConfig } from '../utils/db';
import { getPrompt, renderTemplate } from './promptLoader';
import { logWarning } from '../utils/logger';
import type {
  EnrichmentResult,
  EnrichmentItem,
  EnrichmentVerdict,
  EnrichmentVerdictLabel,
  EntryResults,
} from '../types';

interface OpenAIResponseOutput {
  type: string;
  content?: Array<{
    type: string;
    text?: string;
  }>;
}

interface OpenAIResponse {
  output: OpenAIResponseOutput[];
}

const VALID_CATEGORIES: readonly string[] = ['tech', 'security', 'claim', 'generic'];
const VALID_VERDICT_LABELS: readonly EnrichmentVerdictLabel[] = [
  'vero', 'falso', 'dubbio', 'ai-generated', 'phishing', 'sicuro', 'sospetto',
];

const FALLBACK_RESULT: EnrichmentResult = { category: 'generic', items: [] };

async function buildPrompt(results: EntryResults, caption: string | null): Promise<string> {
  const promptConfig = await getPrompt('enrichment');
  return renderTemplate(promptConfig.template, {
    songs: results.songs,
    films: results.films,
    notes: results.notes,
    tags: results.tags,
    links: results.links,
    caption: caption ? caption.slice(0, 500) : null,
  });
}

function parseVerdict(raw: unknown): EnrichmentVerdict | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const v = raw as Record<string, unknown>;
  if (typeof v.label !== 'string' || !VALID_VERDICT_LABELS.includes(v.label as EnrichmentVerdictLabel)) return undefined;
  if (typeof v.explanation !== 'string') return undefined;
  const confidence = typeof v.confidence === 'number' && Number.isFinite(v.confidence)
    ? Math.min(100, Math.max(0, v.confidence))
    : 0;
  return { label: v.label as EnrichmentVerdictLabel, confidence, explanation: v.explanation };
}

function parseItems(raw: unknown): EnrichmentItem[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> =>
      !!item && typeof item === 'object' &&
      typeof (item as Record<string, unknown>).label === 'string' &&
      Array.isArray((item as Record<string, unknown>).links)
    )
    .map((item) => ({
      label: item.label as string,
      explanation: typeof item.explanation === 'string' ? item.explanation : '',
      links: (item.links as Array<Record<string, unknown>>)
        .filter((link) => typeof link.url === 'string' && typeof link.title === 'string')
        .map((link) => ({
          url: link.url as string,
          title: link.title as string,
          snippet: (link.snippet as string) || '',
        })),
    }))
    .filter((item) => item.links.length > 0);
}

function parseEnrichmentResponse(content: string): EnrichmentResult {
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (error) {
    logWarning('enrichWithOpenAI: JSON parse fallito', { error: String(error), raw: jsonStr.slice(0, 200) });
    return FALLBACK_RESULT;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    logWarning('enrichWithOpenAI: risposta non è un JSON object', { raw: jsonStr.slice(0, 200) });
    return FALLBACK_RESULT;
  }

  const obj = parsed as Record<string, unknown>;
  const category: EnrichmentResult['category'] =
    typeof obj.category === 'string' && VALID_CATEGORIES.includes(obj.category)
      ? (obj.category as EnrichmentResult['category'])
      : 'generic';

  const result: EnrichmentResult = { category, items: parseItems(obj.items) };
  if (category === 'security' || category === 'claim') {
    const verdict = parseVerdict(obj.verdict);
    if (verdict) result.verdict = verdict;
  }
  return result;
}

export async function enrichWithOpenAI(
  results: EntryResults,
  caption: string | null
): Promise<EnrichmentResult> {
  const config = await getOpenAIConfig();
  if (!config.apiKey) {
    throw new Error('OpenAI API key non configurata. Vai nelle Impostazioni per inserirla.');
  }

  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      tools: [{ type: 'web_search_preview' }],
      input: await buildPrompt(results, caption),
      temperature: 0.2,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI API error ${response.status}: ${errorText}`);
  }

  const data = await response.json() as OpenAIResponse;

  let content = '';
  for (const output of data.output) {
    if (output.type === 'message' && output.content) {
      for (const block of output.content) {
        if (block.type === 'output_text' && block.text) {
          content += block.text;
        }
      }
    }
  }

  if (!content) {
    return FALLBACK_RESULT;
  }

  return parseEnrichmentResponse(content);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/openaiEnrich.test.ts`
Expected: PASS (all 12 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/openaiEnrich.ts backend/src/services/openaiEnrich.test.ts
git commit -m "feat(enrich): classify content into tech/security/claim/generic with verdict"
```

---

### Task 4: Register `POST /api/entries/enrich` Route

**Files:**
- Modify: `backend/src/routes/entries.ts:1-6` (imports) and add a new route block inside `registerEntriesRoutes`
- Test: `backend/src/routes/entries.test.ts` (new file)

**Interfaces:**
- Consumes: `enrichWithOpenAI` from `../services/openaiEnrich` (Task 3); `getEntry`, `updateEntry`, `appendActionLog`, `createActionLog` from `../utils/db`; `logError` from `../utils/logger`.
- Produces: `POST /api/entries/enrich` — request `{ entryId: string }`, response `{ success: true, enrichment: EnrichmentResult }` (200), `{ error: string }` (400/404), or `{ success: false, error: string }` (500). Consumed by frontend `enrichEntry()` in Task 6.

- [ ] **Step 1: Write the failing test**

Create `backend/src/routes/entries.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({
  pool: { connect: vi.fn() },
  listEntries: vi.fn(),
  getEntry: vi.fn(),
  updateEntry: vi.fn(),
  deleteEntry: vi.fn(),
  deleteAllEntries: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn(),
}));
vi.mock('../services/spotify', () => ({ addToPlaylist: vi.fn() }));
vi.mock('../services/openaiEnrich', () => ({ enrichWithOpenAI: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { registerEntriesRoutes } from './entries';
import { getEntry, updateEntry, appendActionLog, createActionLog } from '../utils/db';
import { enrichWithOpenAI } from '../services/openaiEnrich';

function buildApp() {
  const app = Fastify();
  registerEntriesRoutes(app);
  return app;
}

const MOCK_ENTRY = {
  id: 'entry-1',
  sourceUrl: 'https://github.com/foo/bar',
  caption: 'check this out',
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
};

describe('POST /api/entries/enrich', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActionLog).mockReturnValue({ action: 'test', details: {}, timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('returns 400 when entryId is missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: {} });
    expect(res.statusCode).toBe(400);
  });

  it('returns 404 when entry is not found', async () => {
    vi.mocked(getEntry).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });

  it('persists and logs the enrichment on success', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(enrichWithOpenAI).mockResolvedValue({
      category: 'tech',
      items: [{ label: 'foo/bar', explanation: 'A CLI tool', links: [{ url: 'https://github.com/foo/bar', title: 'foo/bar', snippet: '' }] }],
    });
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.enrichment.category).toBe('tech');
    expect(updateEntry).toHaveBeenCalledWith('entry-1', {
      'results.enrichments': expect.objectContaining({ category: 'tech' }),
    });
    expect(appendActionLog).toHaveBeenCalledWith('entry-1', expect.objectContaining({ action: 'test' }));
    expect(createActionLog).toHaveBeenCalledWith('manual_enrich', expect.objectContaining({ category: 'tech', items: 1, hasVerdict: false }));
  });

  it('returns 500 and logs manual_enrich_failed when the service throws', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(enrichWithOpenAI).mockRejectedValue(new Error('OpenAI API key non configurata.'));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/entries/enrich', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(500);
    expect(res.json().success).toBe(false);
    expect(createActionLog).toHaveBeenCalledWith('manual_enrich_failed', expect.objectContaining({ error: expect.stringContaining('OpenAI API key') }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/routes/entries.test.ts`
Expected: FAIL with 404 (route not registered → Fastify default 404 handler) for every case.

- [ ] **Step 3: Add the route**

In `backend/src/routes/entries.ts`, replace the import block (lines 1-5):

```ts
import type { FastifyInstance } from 'fastify';
import { pool } from '../utils/db';
import { listEntries, getEntry, updateEntry, deleteEntry, deleteAllEntries, appendActionLog, createActionLog } from '../utils/db';
import { addToPlaylist } from '../services/spotify';
import { enrichWithOpenAI } from '../services/openaiEnrich';
import { logError } from '../utils/logger';
import type { Entry } from '../types';
```

Then add this route inside `registerEntriesRoutes`, immediately after the `DELETE '/api/entries'` block (originally lines 27-30, before the SSE `/api/entries/stream` block):

```ts
  interface EnrichBody { entryId?: string; }

  app.post<{ Body: EnrichBody }>('/api/entries/enrich', async (req, reply) => {
    const { entryId } = req.body;
    if (!entryId || typeof entryId !== 'string') {
      return reply.code(400).send({ error: 'entryId is required' });
    }

    const entry = await getEntry(entryId);
    if (!entry) {
      return reply.code(404).send({ error: 'Not found' });
    }

    try {
      const enrichment = await enrichWithOpenAI(entry.results, entry.caption);
      await updateEntry(entryId, { 'results.enrichments': enrichment });
      await appendActionLog(entryId, createActionLog('manual_enrich', {
        category: enrichment.category,
        items: enrichment.items.length,
        hasVerdict: !!enrichment.verdict,
      }));
      return reply.send({ success: true, enrichment });
    } catch (err) {
      logError('manual enrich error', { entryId, err: String(err) });
      await appendActionLog(entryId, createActionLog('manual_enrich_failed', { error: String(err) }));
      return reply.code(500).send({ success: false, error: 'Enrichment failed' });
    }
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/routes/entries.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/routes/entries.ts backend/src/routes/entries.test.ts
git commit -m "fix(entries): register missing POST /api/entries/enrich route"
```

---

### Task 5: Update `analyze.ts` Auto-Enrich Call Site

**Files:**
- Modify: `backend/src/routes/analyze.ts:743-763`

**Interfaces:**
- Consumes: `enrichWithOpenAI` returning `EnrichmentResult` (Task 3, changed from `EnrichmentItem[]`).

No dedicated test file exists today for this code path (confirmed: no `analyze.test.ts` in the repo). Verification is the backend typecheck command plus the full test suite run in Task 9.

- [ ] **Step 1: Update the auto-enrich block**

In `backend/src/routes/analyze.ts`, replace lines 743-763:

```ts
      if (featuresConfig.autoEnrichEnabled) {
        try {
          const openaiConfig = await getOpenAIConfig();
          if (openaiConfig.enabled && openaiConfig.apiKey) {
            const entryResults = { songs, films, notes, links, tags, summary: summary ?? null };
            const enrichments = await enrichWithOpenAI(entryResults, captionForEnrich);
            if (enrichments.length > 0) {
              await updateEntry(entryId, { 'results.enrichments': enrichments });
              await appendActionLog(entryId, createActionLog('auto_enriched', {
                provider: 'openai',
                items: enrichments.length,
                links: enrichments.reduce((sum, i) => sum + i.links.length, 0),
              }));
              results.enrichments = enrichments;
            }
          }
        } catch (enrichError) {
          log.warn('Auto-enrichment fallito', { error: String(enrichError) });
          await appendActionLog(entryId, createActionLog('auto_enrich_failed', { error: String(enrichError) }));
        }
      }
```

with:

```ts
      if (featuresConfig.autoEnrichEnabled) {
        try {
          const openaiConfig = await getOpenAIConfig();
          if (openaiConfig.enabled && openaiConfig.apiKey) {
            const entryResults = { songs, films, notes, links, tags, summary: summary ?? null };
            const enrichment = await enrichWithOpenAI(entryResults, captionForEnrich);
            if (enrichment.items.length > 0 || enrichment.verdict) {
              await updateEntry(entryId, { 'results.enrichments': enrichment });
              await appendActionLog(entryId, createActionLog('auto_enriched', {
                provider: 'openai',
                category: enrichment.category,
                items: enrichment.items.length,
                links: enrichment.items.reduce((sum, i) => sum + i.links.length, 0),
                hasVerdict: !!enrichment.verdict,
              }));
              results.enrichments = enrichment;
            }
          }
        } catch (enrichError) {
          log.warn('Auto-enrichment fallito', { error: String(enrichError) });
          await appendActionLog(entryId, createActionLog('auto_enrich_failed', { error: String(enrichError) }));
        }
      }
```

- [ ] **Step 2: Verify backend typecheck now passes**

Run: `cd /home/mike/works/Soundreel/backend && npm run typecheck`
Expected: PASS — this was the failure predicted in Task 1 Step 3; it's now resolved.

- [ ] **Step 3: Run the full backend test suite**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run`
Expected: PASS — all existing tests plus the new ones from Tasks 2-4.

- [ ] **Step 4: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/routes/analyze.ts
git commit -m "fix(analyze): adapt auto-enrich call site to EnrichmentResult shape"
```

---

### Task 6: Frontend Types and API Client

**Files:**
- Modify: `frontend/src/services/api.ts:1` (import) and `:65-72` (`enrichEntry`)

**Interfaces:**
- Consumes: `EnrichmentResult` from `../types` (Task 1, frontend side already applied).
- Produces: `enrichEntry(entryId: string): Promise<{ success: boolean; enrichment: EnrichmentResult }>` — consumed by `EntryInspector.tsx` in Task 8 (call site itself, `handleEnrich`, does not need to change — it only awaits the promise and ignores the return value today).

- [ ] **Step 1: Update the import**

In `frontend/src/services/api.ts`, change line 1:

```ts
import type { Entry, SearchResponse } from '../types';
```

to:

```ts
import type { Entry, SearchResponse, EnrichmentResult } from '../types';
```

- [ ] **Step 2: Update `enrichEntry`**

Replace lines 65-72:

```ts
export async function enrichEntry(entryId: string): Promise<{ success: boolean; enrichments: unknown[] }> {
  const res = await fetch(url('/api/entries/enrich'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
  return json(res);
}
```

with:

```ts
export async function enrichEntry(entryId: string): Promise<{ success: boolean; enrichment: EnrichmentResult }> {
  const res = await fetch(url('/api/entries/enrich'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entryId }),
  });
  return json(res);
}
```

- [ ] **Step 3: Verify frontend typecheck**

Run: `cd /home/mike/works/Soundreel/frontend && npx tsc -b`
Expected: Still FAILS — `EntryInspector.tsx` (`hasEnrichments`, the enrichments render block) is fixed in Task 8. Confirm the *only* remaining errors are in `EntryInspector.tsx`.

- [ ] **Step 4: Commit**

```bash
cd /home/mike/works/Soundreel
git add frontend/src/services/api.ts
git commit -m "feat(api): return typed EnrichmentResult from enrichEntry"
```

---

### Task 7: Rename the Deep Search CTA to "Arricchisci"

**Files:**
- Modify: `frontend/src/i18n/translations.ts:436` (IT) and `:673` (EN)

**Interfaces:**
- Consumes: none.
- Produces: `t.runDeepSearch` string value used by the existing button JSX in `EntryInspector.tsx:340` (unchanged code, only the displayed string changes).

No test covers this file (string-only i18n dictionary, no test infra for it in the repo). Verification is a visual/grep check.

- [ ] **Step 1: Update the Italian string**

In `frontend/src/i18n/translations.ts`, change line 436:

```ts
    runDeepSearch: 'Esegui Deep Search',
```

to:

```ts
    runDeepSearch: 'Arricchisci',
```

- [ ] **Step 2: Update the English string**

Change line 673:

```ts
    runDeepSearch: 'Run Deep Search',
```

to:

```ts
    runDeepSearch: 'Enrich',
```

- [ ] **Step 3: Verify the change**

Run: `grep -n "runDeepSearch:" /home/mike/works/Soundreel/frontend/src/i18n/translations.ts`
Expected:
```
436:    runDeepSearch: 'Arricchisci',
673:    runDeepSearch: 'Enrich',
```

- [ ] **Step 4: Commit**

```bash
cd /home/mike/works/Soundreel
git add frontend/src/i18n/translations.ts
git commit -m "feat(i18n): rename Deep Search CTA to Arricchisci/Enrich"
```

---

### Task 8: Render Verdict Badge and Item Explanations in `EntryInspector`

**Files:**
- Modify: `frontend/src/components/EntryInspector.tsx:1-2` (imports), `:85-94` (near `NOTE_CATEGORY_LABELS`, add verdict tone map), `:112` (`hasEnrichments`), `:316-334` (enrichments render block)
- Modify: `frontend/src/styles/index.css` (after line 613, before the `/* Inspector placeholder */` comment)

**Interfaces:**
- Consumes: `EnrichmentResult`, `EnrichmentVerdictLabel` from `../types` (Task 1); `entry.results.enrichments` is now `EnrichmentResult | undefined` (was `EnrichmentItem[] | undefined`).

- [ ] **Step 1: Add the type import and verdict tone map**

In `frontend/src/components/EntryInspector.tsx`, change line 2:

```tsx
import type { Entry, Note } from '../types';
```

to:

```tsx
import type { Entry, Note, EnrichmentVerdictLabel } from '../types';
```

Then, immediately after the `NOTE_CATEGORY_LABELS` block (originally lines 85-94), add:

```tsx
const VERDICT_TONE: Record<EnrichmentVerdictLabel, 'safe' | 'warning' | 'danger'> = {
  vero: 'safe',
  sicuro: 'safe',
  dubbio: 'warning',
  sospetto: 'warning',
  falso: 'danger',
  'ai-generated': 'danger',
  phishing: 'danger',
};
```

- [ ] **Step 2: Fix `hasEnrichments`**

Change line 112:

```tsx
  const hasEnrichments = (entry.results.enrichments?.length || 0) > 0;
```

to:

```tsx
  const hasEnrichments = !!entry.results.enrichments;
```

- [ ] **Step 3: Rewrite the enrichments render block**

Replace lines 316-334:

```tsx
      {/* Enrichments */}
      {hasEnrichments && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.enrichmentsSection}</h3>
          {entry.results.enrichments!.map((item, i) => (
            <div key={i} className="enrichment-item">
              <span className="enrichment-label">{item.label}</span>
              <ul className="enrichment-links">
                {item.links.map((link, li) => (
                  <li key={li} className="enrichment-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a>
                    {link.snippet && <span className="enrichment-snippet">{link.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
```

with:

```tsx
      {/* Enrichments */}
      {hasEnrichments && (
        <section className="inspector-section">
          <h3 className="inspector-section-title">{t.enrichmentsSection}</h3>
          {entry.results.enrichments!.verdict && (
            <div className={`enrichment-verdict enrichment-verdict-${VERDICT_TONE[entry.results.enrichments!.verdict.label]}`}>
              <span className="enrichment-verdict-label">{entry.results.enrichments!.verdict.label.toUpperCase()}</span>
              <span className="enrichment-verdict-confidence">{entry.results.enrichments!.verdict.confidence}%</span>
              <p className="enrichment-verdict-explanation">{entry.results.enrichments!.verdict.explanation}</p>
            </div>
          )}
          {entry.results.enrichments!.items.map((item, i) => (
            <div key={i} className="enrichment-item">
              <span className="enrichment-label">{item.label}</span>
              {item.explanation && <p className="enrichment-item-explanation">{item.explanation}</p>}
              <ul className="enrichment-links">
                {item.links.map((link, li) => (
                  <li key={li} className="enrichment-link">
                    <a href={link.url} target="_blank" rel="noopener noreferrer">{link.title}</a>
                    {link.snippet && <span className="enrichment-snippet">{link.snippet}</span>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
```

- [ ] **Step 4: Add verdict badge CSS**

In `frontend/src/styles/index.css`, insert immediately after line 613 (`}` closing `.inspector-deepsearch-btn:disabled`) and before the `/* Inspector placeholder */` comment on line 615:

```css

.enrichment-verdict {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  border-radius: var(--radius-sm);
  margin-bottom: 0.75rem;
  border: 1px solid transparent;
}

.enrichment-verdict-safe {
  background: rgba(52, 199, 89, 0.1);
  border-color: rgba(52, 199, 89, 0.3);
  color: #1f8a3d;
}

.enrichment-verdict-warning {
  background: rgba(255, 204, 0, 0.12);
  border-color: rgba(255, 204, 0, 0.35);
  color: #8a6d00;
}

.enrichment-verdict-danger {
  background: rgba(255, 59, 48, 0.1);
  border-color: rgba(255, 59, 48, 0.35);
  color: #c62828;
}

.enrichment-verdict-label {
  font-weight: 700;
  font-size: 0.8rem;
  letter-spacing: 0.03em;
}

.enrichment-verdict-confidence {
  font-size: 0.75rem;
  opacity: 0.8;
}

.enrichment-verdict-explanation {
  flex-basis: 100%;
  font-size: 0.85rem;
  margin: 0.25rem 0 0;
  opacity: 0.9;
}

.enrichment-item-explanation {
  font-size: 0.85rem;
  color: var(--text-muted);
  margin: 0.25rem 0 0.5rem;
}
```

- [ ] **Step 5: Verify frontend typecheck now passes**

Run: `cd /home/mike/works/Soundreel/frontend && npx tsc -b`
Expected: PASS — no remaining errors from Task 1/6's predicted failures.

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/Soundreel
git add frontend/src/components/EntryInspector.tsx frontend/src/styles/index.css
git commit -m "feat(ui): render verdict badge and item explanations for context enrichment"
```

---

### Task 9: Full Verification Pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full backend test suite**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run`
Expected: PASS, net gain of 4 new test files (`promptLoader.test.ts`, `openaiEnrich.test.ts`, `entries.test.ts` plus updated coverage), no regressions.

- [ ] **Step 2: Run backend typecheck**

Run: `cd /home/mike/works/Soundreel/backend && npm run typecheck`
Expected: PASS, zero errors.

- [ ] **Step 3: Run frontend typecheck**

Run: `cd /home/mike/works/Soundreel/frontend && npx tsc -b`
Expected: PASS, zero errors.

- [ ] **Step 4: Manual smoke check (best-effort)**

Start the frontend dev server (`cd /home/mike/works/Soundreel/frontend && npm run dev`) against a running backend, open an existing completed entry with no enrichments, and confirm:
- The CTA button reads "Arricchisci" (IT) instead of "Esegui Deep Search".
- Clicking it no longer 404s (requires a configured OpenAI API key in Settings; without one, the button should surface `t.enrichError` via the existing `alert()` in `handleEnrich`, which itself is unchanged — confirming the route is reachable rather than 404ing).

Document the actual observed result (pass/fail + why) rather than assuming success — this step depends on local Postgres/OpenAI credentials being available in the dev environment; if they are not, state that explicitly instead of claiming the check passed.

- [ ] **Step 5: Confirm the design spec's Testing section is fully covered**

Cross-check against `docs/superpowers/specs/2026-07-24-context-enrichment-design.md` § Testing:
- `openaiEnrich.spec.ts` equivalent → `openaiEnrich.test.ts` (Task 3): tech/security/claim/generic cases + malformed-JSON fallback — all present.
- Route test for `POST /api/entries/enrich` → `entries.test.ts` (Task 4): success, missing-entry 404, non-throwing service-failure path — all present.
