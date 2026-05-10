# Page Analysis Pipeline + Telegram Trim — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `'other'` URL branch to the analyze pipeline (Readability + link harvesting + representative image, no media download), and trim Telegram to a single AI-summary message per submitted link.

**Architecture:** The analyze route gains a third branch alongside the existing IG and legacy paths. A new `pageExtractor` service does HTTP fetch + jsdom + Readability + link/image scraping, with no media download. A new `analyzeWebPage` mode of the AI service produces a synthesis and categorized links. `ExtractedLink` type is extended with optional `domain`, `faviconUrl`, `title`, `category`. Telegram drops the ack message and uses a new compact AI-summary template. Schema is fully retro-compatible.

**Tech Stack:** Node 20 + TypeScript strict, Fastify, Postgres (existing), `@mozilla/readability` + `jsdom` (new), `undici` (existing), Handlebars (existing), React + Vite frontend.

**Spec:** `docs/superpowers/specs/2026-05-10-page-analysis-and-telegram-trim-design.md`

**Project rule (from `CLAUDE.md`):** "NON creare test automatici a meno che non venga richiesto esplicitamente." This plan therefore replaces TDD test steps with **manual smoke-verification steps** (running the dev server, curling the API, watching action logs, opening the UI). Each task still has a tight write → verify → commit cadence.

---

## File Structure

**New files (backend):**
- `backend/src/services/pageExtractor.ts` — HTTP fetch + jsdom + Readability + link & image scraping. Pure function, no I/O outside fetch.
- `backend/src/services/urlNormalize.ts` — Trim tracking params, lowercase host, normalize trailing slash. Used by analyze + idempotency.
- `backend/src/services/ssrfGuard.ts` — Reject loopback/private/link-local hosts.
- `backend/src/services/aiAnalysisWebPage.ts` — Web-page-specific AI analysis. Wraps Ollama generateText + the new prompt; returns `MediaAiAnalysisResult`.

**Modified files (backend):**
- `backend/src/types/index.ts` — Extend `ExtractedLink` with optional metadata fields.
- `backend/src/utils/db.ts` — Add `pageExtractionEnabled` to `FeaturesConfig`.
- `backend/src/services/promptLoader.ts` — Add `webPageAnalysis` prompt to `PromptsConfig`; rewrite default `telegramResponse` template.
- `backend/src/routes/analyze.ts` — Branch on `platform === 'other'` to call the page pipeline. Use `urlNormalize` + `ssrfGuard`. Reuse Spotify/TMDb/auto-enrich.
- `backend/src/routes/telegram.ts` — Remove ack message; rebuild final message from new template (title, summary, counts, link).
- `backend/package.json` — Add `@mozilla/readability` and `jsdom` dependencies.

**Modified files (frontend):**
- `frontend/src/types/index.ts` — Extend `ExtractedLink` to match backend.
- `frontend/src/components/EntryCard.tsx` — Use new link metadata (favicon, domain, category grouping). Already shows summary; no change there.
- `frontend/src/components/CompactCard.tsx` — Show `summary` first 100 chars when present; add `🔗 N` chip.

**No file deletions.** No legacy code is removed in this plan.

---

## Task Order Rationale

Tasks are ordered so each commit leaves the system runnable:
1. Tasks 1–3: types, deps, config (no behavior change yet).
2. Tasks 4–6: pure helpers (`urlNormalize`, `ssrfGuard`, `pageExtractor`) — testable by curl-less standalone scripts.
3. Tasks 7–8: AI prompt + service.
4. Task 9: wire into `/api/analyze` behind the new flag.
5. Task 10: Telegram trim.
6. Tasks 11–12: frontend.
7. Task 13: smoke matrix.

---

## Task 1: Extend `ExtractedLink` type (backend)

**Files:**
- Modify: `backend/src/types/index.ts` (the `ExtractedLink` interface)

- [ ] **Step 1: Replace the existing `ExtractedLink` interface**

In `backend/src/types/index.ts`, find:

```ts
export interface ExtractedLink {
  url: string;
  label: string | null;
}
```

Replace with:

```ts
export type ExtractedLinkCategory =
  | 'referenced'
  | 'sponsor'
  | 'navigation'
  | 'related'
  | 'social'
  | 'other';

export interface ExtractedLink {
  url: string;
  label: string | null;
  domain?: string | null;
  faviconUrl?: string | null;
  title?: string | null;
  category?: ExtractedLinkCategory | null;
}
```

- [ ] **Step 2: Verify typecheck still passes**

Run: `cd backend && npm run typecheck`
Expected: no new errors. Existing IG entries already have only `{ url, label }` — the new fields are optional, so no consumer breaks.

- [ ] **Step 3: Commit**

```bash
git add backend/src/types/index.ts
git commit -m "feat(types): extend ExtractedLink with domain/favicon/title/category"
```

---

## Task 2: Add `pageExtractionEnabled` feature flag

**Files:**
- Modify: `backend/src/utils/db.ts:247-265`

- [ ] **Step 1: Add the field to `FeaturesConfig` and its default**

In `backend/src/utils/db.ts`, change:

```ts
export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  useVertexAi: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false,
  allowDuplicateUrls: false,
  autoEnrichEnabled: false,
  mediaAnalysisEnabled: false,
  useVertexAi: false,
  transcriptionEnabled: true,
  aiAnalysisEnabled: true,
};
```

To:

```ts
export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  useVertexAi: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
  pageExtractionEnabled: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false,
  allowDuplicateUrls: false,
  autoEnrichEnabled: false,
  mediaAnalysisEnabled: false,
  useVertexAi: false,
  transcriptionEnabled: true,
  aiAnalysisEnabled: true,
  pageExtractionEnabled: true,
};
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/utils/db.ts
git commit -m "feat(config): add pageExtractionEnabled feature flag (default on)"
```

---

## Task 3: Add `@mozilla/readability` and `jsdom` dependencies

**Files:**
- Modify: `backend/package.json`
- Modify: `backend/package-lock.json` (auto-generated)

- [ ] **Step 1: Install runtime deps and types**

Run:
```bash
cd backend
npm install @mozilla/readability jsdom
npm install -D @types/jsdom
```

Expected: `package.json` now lists `@mozilla/readability` and `jsdom` under `dependencies`, `@types/jsdom` under `devDependencies`. No lockfile errors.

- [ ] **Step 2: Verify imports compile**

Create a temporary scratch file to confirm imports resolve. Run:

```bash
cd backend && cat <<'EOF' > /tmp/readability_smoke.ts
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!doctype html><html><body><p>hi</p></body></html>', { url: 'https://example.com' });
const reader = new Readability(dom.window.document);
const article = reader.parse();
console.log(article?.textContent?.trim() || 'none');
EOF
npx tsx /tmp/readability_smoke.ts
rm /tmp/readability_smoke.ts
```

Expected stdout: contains `hi` (Readability extracted the paragraph) or `none` if the doc was too small for Readability — either is fine; what matters is no import error.

- [ ] **Step 3: Commit**

```bash
git add backend/package.json backend/package-lock.json
git commit -m "build(backend): add @mozilla/readability + jsdom"
```

---

## Task 4: Implement `urlNormalize`

**Files:**
- Create: `backend/src/services/urlNormalize.ts`

- [ ] **Step 1: Create the file**

```ts
// backend/src/services/urlNormalize.ts

const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_/i,
  /^igshid$/i,
  /^_ga$/i,
  /^ref$/i,
  /^ref_src$/i,
];

/**
 * Normalize a URL for idempotency comparison and storage.
 * - Lowercase host.
 * - Strip well-known tracking query params.
 * - Drop the URL fragment.
 * - Remove a single trailing slash from the path (but keep "/" as-is).
 */
export function normalizeUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return input.trim();
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  const keep: [string, string][] = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAM_PATTERNS.some((re) => re.test(k))) {
      keep.push([k, v]);
    }
  }
  parsed.search = '';
  for (const [k, v] of keep) parsed.searchParams.append(k, v);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}
```

- [ ] **Step 2: Smoke-verify with a one-shot script**

Run:
```bash
cd backend && npx tsx -e '
import { normalizeUrl } from "./src/services/urlNormalize";
const cases = [
  ["https://Example.COM/path/?utm_source=tg&id=1#frag", "https://example.com/path?id=1"],
  ["https://x.com/foo/", "https://x.com/foo"],
  ["https://x.com/", "https://x.com/"],
  ["not a url", "not a url"],
];
for (const [inp, expected] of cases) {
  const got = normalizeUrl(inp);
  console.log(got === expected ? "OK" : "FAIL", JSON.stringify({inp, expected, got}));
}
'
```

Expected: four lines all starting with `OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/urlNormalize.ts
git commit -m "feat(backend): add urlNormalize for idempotency keys"
```

---

## Task 5: Implement `ssrfGuard`

**Files:**
- Create: `backend/src/services/ssrfGuard.ts`

- [ ] **Step 1: Create the file**

```ts
// backend/src/services/ssrfGuard.ts

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export class SsrfBlockedError extends Error {
  constructor(public readonly hostname: string, public readonly reason: string) {
    super(`SSRF blocked: ${hostname} (${reason})`);
    this.name = 'SsrfBlockedError';
  }
}

const PRIVATE_V4_BLOCKS: Array<[string, number]> = [
  ['10.0.0.0', 8],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
  ['0.0.0.0', 8],
];

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function inV4Block(ip: string, block: string, bits: number): boolean {
  const ipInt = ipv4ToInt(ip);
  const blockInt = ipv4ToInt(block);
  if (ipInt === null || blockInt === null) return false;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ipInt & mask) === (blockInt & mask);
}

function isPrivateV6(ip: string): boolean {
  const lc = ip.toLowerCase();
  if (lc === '::1' || lc === '::') return true;
  if (lc.startsWith('fc') || lc.startsWith('fd')) return true;     // unique local
  if (lc.startsWith('fe80')) return true;                          // link-local
  return false;
}

/**
 * Throw SsrfBlockedError if the URL is not a public http/https URL.
 * Resolves DNS so a public-looking hostname pointing to a private IP also fails.
 */
export async function assertPublicHttpUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new SsrfBlockedError(rawUrl, 'invalid_url');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SsrfBlockedError(parsed.hostname, `bad_protocol:${parsed.protocol}`);
  }

  const host = parsed.hostname;
  if (!host || host === 'localhost' || host.endsWith('.localhost')) {
    throw new SsrfBlockedError(host, 'localhost');
  }

  let ip = host;
  if (isIP(host) === 0) {
    try {
      const res = await lookup(host);
      ip = res.address;
    } catch {
      throw new SsrfBlockedError(host, 'dns_failed');
    }
  }

  if (isIP(ip) === 4) {
    for (const [block, bits] of PRIVATE_V4_BLOCKS) {
      if (inV4Block(ip, block, bits)) {
        throw new SsrfBlockedError(host, `private_v4:${block}/${bits}`);
      }
    }
  } else if (isIP(ip) === 6 && isPrivateV6(ip)) {
    throw new SsrfBlockedError(host, 'private_v6');
  }

  return parsed;
}
```

- [ ] **Step 2: Smoke-verify**

Run:
```bash
cd backend && npx tsx -e '
import { assertPublicHttpUrl, SsrfBlockedError } from "./src/services/ssrfGuard";
async function check(url: string, expectBlock: boolean) {
  try {
    await assertPublicHttpUrl(url);
    console.log(expectBlock ? "FAIL (expected block)" : "OK", url);
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      console.log(expectBlock ? "OK (blocked)" : "FAIL (unexpected block)", url, e.reason);
    } else {
      console.log("FAIL (other error)", url, String(e));
    }
  }
}
(async () => {
  await check("https://example.com/", false);
  await check("http://localhost/", true);
  await check("http://127.0.0.1/", true);
  await check("http://192.168.1.1/", true);
  await check("ftp://example.com/", true);
})();
'
```

Expected: all 5 lines start with `OK`.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/ssrfGuard.ts
git commit -m "feat(backend): add ssrfGuard to block private/loopback URLs"
```

---

## Task 6: Implement `pageExtractor`

**Files:**
- Create: `backend/src/services/pageExtractor.ts`

- [ ] **Step 1: Create the file**

```ts
// backend/src/services/pageExtractor.ts

import { request } from 'undici';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { Logger } from './debugLogger';
import { assertPublicHttpUrl } from './ssrfGuard';

export class PageFetchError extends Error {
  constructor(public readonly httpStatus: number | null, public readonly cause: string) {
    super(`Page fetch failed: ${cause} (status=${httpStatus ?? 'n/a'})`);
    this.name = 'PageFetchError';
  }
}

export class UnsupportedContentTypeError extends Error {
  constructor(public readonly contentType: string) {
    super(`Unsupported content type: ${contentType}`);
    this.name = 'UnsupportedContentTypeError';
  }
}

export interface PageRawLink {
  url: string;
  anchorText: string | null;
}

export interface PageExtractResult {
  finalUrl: string;
  httpStatus: number;
  contentType: string;
  title: string | null;
  description: string | null;
  mainText: string | null;
  representativeImageUrl: string | null;
  rawLinks: PageRawLink[];
  siteName: string | null;
  lang: string | null;
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_HTML_BYTES = 5_000_000;          // 5 MB
const MAX_RAW_LINKS = 100;
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 SoundReelBot/2';

let log = new Logger('pageExtractor');
export function setLogger(logger: Logger): void {
  log = logger;
}

export async function extractPage(rawUrl: string): Promise<PageExtractResult> {
  const parsed = await assertPublicHttpUrl(rawUrl);

  log.info('Fetch pagina', { url: parsed.toString() });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await request(parsed.toString(), {
      method: 'GET',
      headers: {
        'user-agent': USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'it,en;q=0.8',
      },
      maxRedirections: 5,
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    throw new PageFetchError(null, `network:${(e as Error).message}`);
  }
  clearTimeout(timer);

  const httpStatus = res.statusCode;
  if (httpStatus < 200 || httpStatus >= 400) {
    throw new PageFetchError(httpStatus, `http_${httpStatus}`);
  }

  const contentType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (!contentType.startsWith('text/html') && !contentType.startsWith('application/xhtml')) {
    throw new UnsupportedContentTypeError(contentType || 'unknown');
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_HTML_BYTES) {
      throw new PageFetchError(httpStatus, 'html_too_large');
    }
    chunks.push(buf);
  }
  const html = Buffer.concat(chunks).toString('utf8');
  const finalUrl = parsed.toString();

  const dom = new JSDOM(html, { url: finalUrl });
  const doc = dom.window.document;

  const meta = (sel: string): string | null => {
    const el = doc.querySelector(sel) as HTMLMetaElement | null;
    const v = el?.getAttribute('content') ?? null;
    return v && v.trim() ? v.trim() : null;
  };

  const title =
    meta('meta[property="og:title"]') ||
    meta('meta[name="twitter:title"]') ||
    (doc.querySelector('title')?.textContent?.trim() || null);

  const description =
    meta('meta[property="og:description"]') ||
    meta('meta[name="twitter:description"]') ||
    meta('meta[name="description"]');

  const siteName = meta('meta[property="og:site_name"]') || dom.window.location.hostname || null;
  const lang = doc.documentElement.getAttribute('lang') || null;

  const representativeImageUrl = pickRepresentativeImage(doc, finalUrl);
  const rawLinks = scrapeLinks(doc, finalUrl);

  let mainText: string | null = null;
  try {
    const reader = new Readability(doc.cloneNode(true) as Document);
    const article = reader.parse();
    mainText = article?.textContent?.trim() || null;
    if (mainText && mainText.length < 50) mainText = null;
  } catch (e) {
    log.warn('Readability fail', { error: String(e) });
    mainText = null;
  }

  return {
    finalUrl,
    httpStatus,
    contentType,
    title,
    description,
    mainText,
    representativeImageUrl,
    rawLinks,
    siteName,
    lang,
  };
}

function abs(href: string, base: string): string | null {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function pickRepresentativeImage(doc: Document, baseUrl: string): string | null {
  const og =
    doc.querySelector('meta[property="og:image"]')?.getAttribute('content') ||
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute('content') ||
    doc.querySelector('meta[name="twitter:image:src"]')?.getAttribute('content');
  if (og) {
    const a = abs(og, baseUrl);
    if (a) return a;
  }

  const iconCandidates: Array<{ size: number; url: string }> = [];
  doc
    .querySelectorAll<HTMLLinkElement>(
      'link[rel="apple-touch-icon"], link[rel="apple-touch-icon-precomposed"], link[rel="icon"]',
    )
    .forEach((el) => {
      const href = el.getAttribute('href');
      if (!href) return;
      const a = abs(href, baseUrl);
      if (!a) return;
      const sizesAttr = el.getAttribute('sizes') || '';
      const m = sizesAttr.match(/(\d+)x(\d+)/);
      const size = m ? Number(m[1]) : 0;
      iconCandidates.push({ size, url: a });
    });
  if (iconCandidates.length > 0) {
    iconCandidates.sort((x, y) => y.size - x.size);
    if (iconCandidates[0].size >= 144) return iconCandidates[0].url;
  }

  const imgs = Array.from(doc.querySelectorAll<HTMLImageElement>('img'));
  for (const img of imgs) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) continue;
    const w = Number(img.getAttribute('width') || '0');
    const h = Number(img.getAttribute('height') || '0');
    if (w >= 200 && h >= 200) {
      const a = abs(src, baseUrl);
      if (a) return a;
    }
  }
  for (const img of imgs) {
    const src = img.getAttribute('src') || img.getAttribute('data-src');
    if (!src) continue;
    const a = abs(src, baseUrl);
    if (a) return a;
  }
  if (iconCandidates.length > 0) return iconCandidates[0].url;
  return null;
}

function scrapeLinks(doc: Document, baseUrl: string): PageRawLink[] {
  const baseHost = new URL(baseUrl).hostname;
  const seen = new Set<string>();
  const out: PageRawLink[] = [];

  const anchors = Array.from(doc.querySelectorAll<HTMLAnchorElement>('a[href]'));
  for (const a of anchors) {
    if (out.length >= MAX_RAW_LINKS) break;

    const rawHref = a.getAttribute('href') || '';
    if (!rawHref || rawHref.startsWith('#') || rawHref.startsWith('javascript:')) continue;
    if (rawHref.startsWith('mailto:') || rawHref.startsWith('tel:')) continue;

    const absUrl = abs(rawHref, baseUrl);
    if (!absUrl) continue;
    if (!absUrl.startsWith('http://') && !absUrl.startsWith('https://')) continue;

    const u = new URL(absUrl);
    const sameHost = u.hostname === baseHost;
    if (sameHost && isInChromeBlock(a)) continue;

    if (seen.has(absUrl)) continue;
    seen.add(absUrl);

    const anchorText = (a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200) || null;
    out.push({ url: absUrl, anchorText });
  }

  return out;
}

function isInChromeBlock(el: Element): boolean {
  let cur: Element | null = el;
  while (cur && cur !== cur.ownerDocument?.body) {
    const tag = cur.tagName.toLowerCase();
    if (tag === 'nav' || tag === 'header' || tag === 'footer' || tag === 'aside') return true;
    cur = cur.parentElement;
  }
  return false;
}
```

- [ ] **Step 2: Smoke-verify against a real public URL**

Run:
```bash
cd backend && npx tsx -e '
import { extractPage } from "./src/services/pageExtractor";
(async () => {
  const r = await extractPage("https://example.com/");
  console.log(JSON.stringify({
    finalUrl: r.finalUrl,
    httpStatus: r.httpStatus,
    title: r.title,
    description: r.description,
    siteName: r.siteName,
    lang: r.lang,
    hasMainText: !!r.mainText,
    mainTextChars: r.mainText?.length || 0,
    image: r.representativeImageUrl,
    links: r.rawLinks.length,
  }, null, 2));
})();
'
```

Expected: `httpStatus: 200`, `title` non-null, `links` ≥ 1 (`https://www.iana.org/...`). The exact text may vary; what matters is the JSON parses and the structure is populated.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/pageExtractor.ts
git commit -m "feat(backend): add pageExtractor (Readability + links + image)"
```

---

## Task 7: Add `webPageAnalysis` prompt + extend `PromptsConfig`

**Files:**
- Modify: `backend/src/services/promptLoader.ts`

- [ ] **Step 1: Add the prompt id to the config interface**

In `backend/src/services/promptLoader.ts`, change:

```ts
export interface PromptsConfig {
  contentAnalysis: PromptTemplate;
  telegramResponse: PromptTemplate;
  enrichment: PromptTemplate;
  mediaAnalysis: PromptTemplate;
}
```

To:

```ts
export interface PromptsConfig {
  contentAnalysis: PromptTemplate;
  telegramResponse: PromptTemplate;
  enrichment: PromptTemplate;
  mediaAnalysis: PromptTemplate;
  webPageAnalysis: PromptTemplate;
}
```

- [ ] **Step 2: Add the default `webPageAnalysis` prompt**

In the `DEFAULT_PROMPTS` object, after `mediaAnalysis`, add:

```ts
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
```

(The literal `—` and `à` keep the Italian em-dash and `à` correct inside a TS template string without escaping issues.)

- [ ] **Step 3: Update the `getPrompts` merge to include the new id**

In `getPrompts`, the `cachedPrompts` assignment block currently merges the four known prompts. Update it to include the new id:

```ts
    cachedPrompts = {
      contentAnalysis: data.contentAnalysis || DEFAULT_PROMPTS.contentAnalysis,
      telegramResponse: data.telegramResponse || DEFAULT_PROMPTS.telegramResponse,
      enrichment: data.enrichment || DEFAULT_PROMPTS.enrichment,
      mediaAnalysis: data.mediaAnalysis || DEFAULT_PROMPTS.mediaAnalysis,
      webPageAnalysis: data.webPageAnalysis || DEFAULT_PROMPTS.webPageAnalysis,
    };
```

- [ ] **Step 4: Replace the default `telegramResponse` template**

In `DEFAULT_PROMPTS.telegramResponse.template`, replace the existing template string with:

```hbs
<b>{{title}}</b>
{{#if hasSummary}}{{summary}}{{/if}}

{{#if hasCounts}}🔗 {{linksCount}} · 🎵 {{songsCount}} · 🎬 {{filmsCount}}{{/if}}
🌐 <a href="{{frontendUrl}}">Apri su SoundReel</a>
```

Update `variables` to:

```ts
    variables: [
      'title', 'summary', 'hasSummary',
      'linksCount', 'songsCount', 'filmsCount', 'hasCounts',
      'frontendUrl',
    ],
```

(Existing user-customized templates in Postgres are preserved by the merge above; only the default — used on a fresh DB or when a user has not customized — changes.)

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors. The `PromptsConfig` interface change forces the new key to be present in defaults; that is satisfied by Step 2.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/promptLoader.ts
git commit -m "feat(prompts): add webPageAnalysis prompt and trim telegramResponse default"
```

---

## Task 8: Implement `analyzeWebPage`

**Files:**
- Create: `backend/src/services/aiAnalysisWebPage.ts`

- [ ] **Step 1: Create the file**

```ts
// backend/src/services/aiAnalysisWebPage.ts

import { generateText } from './ollamaClient';
import { logInfo, logWarning } from '../utils/logger';
import { getPrompt, renderTemplate } from './promptLoader';
import type { MediaAiAnalysisResult, ExtractedLink, ExtractedLinkCategory, AiUsageMetadata } from '../types';
import type { PageExtractResult, PageRawLink } from './pageExtractor';

export interface WebPageAnalysisResponse {
  result: MediaAiAnalysisResult;
  usageMetadata: AiUsageMetadata | null;
}

const VALID_CATEGORIES: ExtractedLinkCategory[] = [
  'referenced', 'sponsor', 'navigation', 'related', 'social', 'other',
];

const MAIN_TEXT_BUDGET = 8_000; // chars

const EMPTY: MediaAiAnalysisResult = {
  songs: [],
  films: [],
  notes: [],
  links: [],
  tags: [],
  summary: null,
  transcription: null,
  visualContext: null,
  overlayText: null,
};

export async function analyzeWebPage(input: PageExtractResult): Promise<WebPageAnalysisResponse> {
  const hasAnyInput = !!input.title || !!input.description || !!input.mainText || input.rawLinks.length > 0;
  if (!hasAnyInput) {
    logInfo('Pagina senza contenuto analizzabile');
    return { result: EMPTY, usageMetadata: null };
  }

  const promptConfig = await getPrompt('webPageAnalysis');
  const mainText = input.mainText
    ? input.mainText.length > MAIN_TEXT_BUDGET
      ? input.mainText.slice(0, MAIN_TEXT_BUDGET) + '\n[...troncato...]'
      : input.mainText
    : null;

  const prompt = renderTemplate(promptConfig.template, {
    title: input.title || '[senza titolo]',
    description: input.description || null,
    siteName: input.siteName || null,
    lang: input.lang || null,
    mainText,
    hasMainText: !!mainText,
    rawLinks: input.rawLinks,
  });

  let raw: string;
  try {
    raw = await generateText(prompt);
  } catch (e) {
    logWarning('Web-page LLM failed', { error: String(e) });
    return { result: EMPTY, usageMetadata: null };
  }

  const parsed = parseJsonLoose(raw);
  if (!parsed) {
    logWarning('Web-page LLM JSON parse failed', { raw: raw.slice(0, 500) });
    return { result: EMPTY, usageMetadata: null };
  }

  const allowedUrls = new Set(input.rawLinks.map((l) => l.url));
  const links = sanitizeLinks(parsed.links, allowedUrls);

  const result: MediaAiAnalysisResult = {
    songs: Array.isArray(parsed.songs) ? parsed.songs.filter(isSongShape) : [],
    films: Array.isArray(parsed.films) ? parsed.films.filter(isFilmShape) : [],
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter(isNoteShape) : [],
    links,
    tags: Array.isArray(parsed.tags) ? parsed.tags.filter((t: unknown): t is string => typeof t === 'string').slice(0, 16) : [],
    summary: typeof parsed.summary === 'string' && parsed.summary.trim()
      ? parsed.summary.trim().slice(0, 500)
      : null,
    transcription: null,
    visualContext: null,
    overlayText: null,
  };

  return { result, usageMetadata: null };
}

function parseJsonLoose(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  try {
    const v = JSON.parse(trimmed);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function sanitizeLinks(value: unknown, allowed: Set<string>): ExtractedLink[] {
  if (!Array.isArray(value)) return [];
  const out: ExtractedLink[] = [];
  for (const v of value) {
    if (!v || typeof v !== 'object') continue;
    const o = v as Record<string, unknown>;
    const url = typeof o.url === 'string' ? o.url : null;
    if (!url || !allowed.has(url)) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : null;
    const cat = typeof o.category === 'string' ? (o.category as ExtractedLinkCategory) : null;
    const category = cat && VALID_CATEGORIES.includes(cat) ? cat : 'other';
    out.push({ url, label, category });
    if (out.length >= 30) break;
  }
  return out;
}

function isSongShape(v: unknown): v is { title: string; artist: string; album: string | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === 'string' && typeof o.artist === 'string';
}

function isFilmShape(v: unknown): v is { title: string; director: string | null; year: string | null } {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.title === 'string';
}

function isNoteShape(v: unknown): boolean {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.text === 'string' && typeof o.category === 'string';
}
```

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 3: Smoke-verify (dev server already running locally with Ollama)**

Start the dev server in another terminal: `cd backend && npm run dev`. Then run:

```bash
cd backend && npx tsx -e '
import { extractPage } from "./src/services/pageExtractor";
import { analyzeWebPage } from "./src/services/aiAnalysisWebPage";
(async () => {
  const page = await extractPage("https://example.com/");
  const r = await analyzeWebPage(page);
  console.log(JSON.stringify(r.result, null, 2));
})();
'
```

Expected: a JSON object with `summary` (string or null), `links` array with each `url` present in the original page, `category` ∈ allowed list, and other arrays (possibly empty). If `summary` is null, that is fine — the page is trivial.

- [ ] **Step 4: Commit**

```bash
git add backend/src/services/aiAnalysisWebPage.ts
git commit -m "feat(backend): add analyzeWebPage AI service"
```

---

## Task 9: Wire the page branch into `/api/analyze`

**Files:**
- Modify: `backend/src/routes/analyze.ts`

- [ ] **Step 1: Import the new modules at the top of `analyze.ts`**

Add these imports next to the existing `contentExtractor` import:

```ts
import { extractPage, PageFetchError, UnsupportedContentTypeError, setLogger as setPageExtractorLogger } from '../services/pageExtractor';
import { analyzeWebPage } from '../services/aiAnalysisWebPage';
import { normalizeUrl } from '../services/urlNormalize';
import { SsrfBlockedError } from '../services/ssrfGuard';
```

Also add the `Spotify`/`TMDb` imports — they are already imported. No change there.

- [ ] **Step 2: Normalize the URL early**

Right after `if (!url) { reply.code(400)... }`, add:

```ts
const normalizedUrl = normalizeUrl(url);
```

Then replace the two later occurrences of `url` used for `findEntryByUrl(url)` and as the `sourceUrl` of `initialEntry` with `normalizedUrl`.

- [ ] **Step 3: Add the page branch**

Find the line:

```ts
const platform = detectPlatform(url);
const isInstagram = platform === 'instagram';
```

Replace with:

```ts
const platform = detectPlatform(normalizedUrl);
const isInstagram = platform === 'instagram';
const isPage = !isInstagram && platform === 'other' && featuresConfig.pageExtractionEnabled;
```

Find the existing `if (isInstagram) { ... } else { ... }` block in the extraction phase (the one after `await extractContent(url, extractOptions)`). We will keep the existing IG and legacy branches but add a third one **above** the existing extraction logic.

Specifically, replace the entire **Extraction** + **Thumbnail persistence** + **Branch: IG local pipeline vs legacy pipeline** sections (the block that starts with `log.info('Inizio estrazione contenuto')` and ends just before the `// AI log + result merge (shared)` comment) with the following structure:

```ts
// ---------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------
let audioResult: AudioRecognitionResult | null = null;
let aiResponse: AiAnalysisResponse;
let transcript: string | null = null;
let transcriptLanguage: string | null = null;
let persistentThumb: string | null = null;
let captionForEntry: string | null = null;
let mediaUrlForEntry: string | null = null;

if (isPage) {
  // ======= PAGE PIPELINE (no media download) =======
  setPageExtractorLogger(log);
  log.info('Page pipeline');
  try {
    const page = await extractPage(normalizedUrl);
    await appendActionLog(entryId, createActionLog('page_fetched', {
      httpStatus: page.httpStatus,
      finalUrl: page.finalUrl,
      contentType: page.contentType,
    }));
    await appendActionLog(entryId, createActionLog('page_parsed', {
      hasMainText: !!page.mainText,
      mainTextChars: page.mainText?.length || 0,
      linksCount: page.rawLinks.length,
      hasImage: !!page.representativeImageUrl,
    }));

    if (page.representativeImageUrl) {
      const saved = await saveThumbnailLocal(page.representativeImageUrl, entryId);
      if (saved) {
        persistentThumb = saved.relativeUrl;
        await appendActionLog(entryId, createActionLog('thumbnail_saved', {
          source: 'page_image',
          relativeUrl: saved.relativeUrl,
          sizeBytes: saved.sizeBytes,
        }));
      } else {
        persistentThumb = page.representativeImageUrl;
        await appendActionLog(entryId, createActionLog('thumbnail_save_failed', {
          sourceUrl: page.representativeImageUrl,
        }));
      }
    }

    captionForEntry = page.description || page.title;
    mediaUrlForEntry = null;

    await updateEntry(entryId, {
      caption: captionForEntry,
      thumbnailUrl: persistentThumb,
      mediaUrl: mediaUrlForEntry,
    });

    if (featuresConfig.aiAnalysisEnabled) {
      const aiRes = await analyzeWebPage(page);
      aiResponse = aiRes;
    } else {
      aiResponse = { result: emptyMedia(), usageMetadata: null };
    }
  } catch (e) {
    if (e instanceof SsrfBlockedError) {
      await appendActionLog(entryId, createActionLog('page_ssrf_blocked', {
        hostname: e.hostname,
        reason: e.reason,
      }));
    } else if (e instanceof UnsupportedContentTypeError) {
      await appendActionLog(entryId, createActionLog('page_unsupported_content_type', {
        contentType: e.contentType,
      }));
    } else if (e instanceof PageFetchError) {
      await appendActionLog(entryId, createActionLog('page_fetch_failed', {
        httpStatus: e.httpStatus,
        cause: e.cause,
      }));
    } else {
      await appendActionLog(entryId, createActionLog('page_fetch_failed', {
        cause: String(e),
      }));
    }
    await updateEntry(entryId, { status: 'error' });
    await appendActionLog(entryId, createActionLog('completed', {
      status: 'error',
      reason: 'page_pipeline_failed',
    }));
    const errEntry = await getEntry(entryId);
    reply.send({ success: false, entryId, entry: errEntry, error: String(e) });
    return;
  }
} else {
  // ======= EXISTING IG + LEGACY PIPELINES (unchanged below) =======
  log.info('Inizio estrazione contenuto');
  const extractOptions: {
    cobaltEnabled: boolean;
    instagramCookies?: { sessionId: string; csrfToken: string; dsUserId: string };
    entryId?: string;
  } = { cobaltEnabled: featuresConfig.cobaltEnabled };

  if (isInstagram) {
    extractOptions.entryId = entryId;
  }

  const content = await extractContent(normalizedUrl, extractOptions);
  log.info('Estrazione contenuto completata', {
    hasCaption: content.hasCaption,
    hasAudio: content.hasAudio,
    hasThumbnail: !!content.thumbnailUrl || !!content.localPaths?.thumbnailPath,
    slides: content.localPaths?.slidePaths.length ?? content.carouselUrls.length,
    frames: content.localPaths?.framePaths.length ?? 0,
  });

  // [PASTE THE EXISTING IG/legacy branch starting from `if (isInstagram) { ... }`
  //  through the end of `// LEGACY PIPELINE (non-IG)` block here, UNCHANGED,
  //  except: replace any literal `url` reference in this block with `normalizedUrl`.]
}
```

> **Important:** Do not retype the existing IG/legacy branch by hand. Open `analyze.ts`, cut the original block (everything from `log.info('Inizio estrazione contenuto')` through the end of the `// ======= LEGACY PIPELINE (non-IG) =======` block, finishing right before the `// AI log + result merge (shared)` comment), and paste it inside the `else` branch above. Then replace any `url` token inside that pasted block with `normalizedUrl`. Leave the comments intact.

- [ ] **Step 4: Enrich AI-returned links with `domain` + `faviconUrl`**

Find the line `const merged = mergeResults(audioResult, aiResult);`. Immediately after the `for (const filmData of merged.films)` loop completes (just before `const notes: Note[] = merged.notes;`), insert:

```ts
const enrichedLinks: ExtractedLink[] = merged.links.map((l) => {
  let domain: string | null = null;
  try {
    domain = new URL(l.url).hostname.replace(/^www\./, '');
  } catch {
    domain = null;
  }
  return {
    ...l,
    domain,
    faviconUrl: domain ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}` : null,
  };
});
```

Then change the line:

```ts
const links: ExtractedLink[] = merged.links;
```

to:

```ts
const links: ExtractedLink[] = enrichedLinks;
```

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Smoke-verify with three URLs (web channel)**

Start dev server: `cd backend && npm run dev`. Then in another shell:

```bash
# Page (other)
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com/","channel":"web"}' | jq '.entry.results | {summary, links}'
```

Expected: `summary` is a string (or null if AI returns nothing); `links` is an array; each link has `domain` and `faviconUrl` populated.

```bash
# IG regression — pick any IG reel URL you have used before
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.instagram.com/reel/<ID>/","channel":"web"}' | jq '.success, (.entry.results | {songs: (.songs|length), films: (.films|length)})'
```

Expected: `true`, songs/films counts as before.

```bash
# Legacy regression — TikTok
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.tiktok.com/@<user>/video/<id>","channel":"web"}' | jq '.success'
```

Expected: `true`.

```bash
# SSRF guard
curl -s -X POST http://127.0.0.1:8080/api/analyze \
  -H 'content-type: application/json' \
  -d '{"url":"http://127.0.0.1:9999/","channel":"web"}' | jq '.success, .entry.actionLog[-2:]'
```

Expected: `false`; action log includes `page_ssrf_blocked`.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/analyze.ts
git commit -m "feat(backend): add page branch + URL normalization to /api/analyze"
```

---

## Task 10: Trim Telegram to one message

**Files:**
- Modify: `backend/src/routes/telegram.ts`

- [ ] **Step 1: Remove the ack message**

Delete the line:

```ts
await sendTelegramMessage(chatId, `✅ Ricevuto! Link da <b>${platformLabel}</b>\n🔗 ${url}\n\n⏳ Analisi in corso...`, token);
```

The `platform` / `platformLabel` lookup just above is no longer needed for the ack; but `platform` is still used implicitly nowhere else in this function. Remove the `platformLabels` map and `platformLabel` variable as well. Keep `const platform = detectPlatform(url);` only if used elsewhere — in the current code it is not, so remove that line too.

- [ ] **Step 2: Rewrite `formatTelegramResponse`**

Replace the existing `formatTelegramResponse` function with:

```ts
async function formatTelegramResponse(result: AnalyzeResult, entryId: string): Promise<string> {
  const results = result.entry?.results || { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
  const { songs, films, links } = results;
  const summaryRaw = (results as { summary?: string | null }).summary;
  const summary = summaryRaw ? truncateForTelegram(summaryRaw, 280) : null;
  const title = pickTitle(result, summary);

  const linksCount = links.length;
  const songsCount = songs.length;
  const filmsCount = films.length;
  const hasCounts = linksCount > 0 || songsCount > 0 || filmsCount > 0;

  try {
    const promptConfig = await getPrompt('telegramResponse');
    const response = renderTemplate(promptConfig.template, {
      title: escapeHtml(title),
      summary: summary ? escapeHtml(summary) : '',
      hasSummary: !!summary,
      linksCount, songsCount, filmsCount, hasCounts,
      frontendUrl: frontendUrl(entryId),
    });
    return response.replace(/\n{3,}/g, '\n\n').trim();
  } catch {
    const safeTitle = escapeHtml(title);
    const lines = [`<b>${safeTitle}</b>`];
    if (summary) lines.push(escapeHtml(summary));
    lines.push('');
    if (hasCounts) lines.push(`🔗 ${linksCount} · 🎵 ${songsCount} · 🎬 ${filmsCount}`);
    lines.push(`🌐 <a href="${frontendUrl(entryId)}">Apri su SoundReel</a>`);
    return lines.join('\n');
  }
}

function pickTitle(result: AnalyzeResult, summary: string | null): string {
  const r = result.entry as { caption?: string | null; sourceUrl?: string } | undefined;
  const caption = r?.caption?.split(/\r?\n/)[0]?.trim();
  if (caption && caption.length > 0) return caption.slice(0, 90);
  if (summary) return summary.slice(0, 80);
  if (r?.sourceUrl) {
    try { return new URL(r.sourceUrl).hostname.replace(/^www\./, ''); }
    catch { return 'SoundReel' }
  }
  return 'SoundReel';
}

function truncateForTelegram(s: string, max: number): string {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
```

- [ ] **Step 3: Update the `AnalyzeResult` type used by Telegram**

In the same file, change:

```ts
interface AnalyzeResult {
  success: boolean;
  entryId?: string;
  entry?: {
    results: {
      songs: Array<{ title: string; artist: string; album: string | null; addedToPlaylist: boolean }>;
      films: Array<{ title: string; year: string | null; director: string | null }>;
      notes: Array<{ text: string; category: string }>;
      links: Array<{ url: string; label: string | null }>;
      tags: string[];
      transcript?: string | null;
    };
  };
  error?: string;
}
```

To:

```ts
interface AnalyzeResult {
  success: boolean;
  entryId?: string;
  entry?: {
    caption?: string | null;
    sourceUrl?: string;
    results: {
      songs: Array<{ title: string; artist: string; album: string | null; addedToPlaylist: boolean }>;
      films: Array<{ title: string; year: string | null; director: string | null }>;
      notes: Array<{ text: string; category: string }>;
      links: Array<{ url: string; label: string | null }>;
      tags: string[];
      summary?: string | null;
      transcript?: string | null;
    };
  };
  error?: string;
}
```

- [ ] **Step 4: Adjust the error message**

Replace the two `'❌ Si è verificato un errore durante l\'analisi. Riprova più tardi.'` strings with:

```ts
`❌ Analisi fallita.\n🌐 <a href="${process.env.FRONTEND_URL || 'https://soundreel.casamon.dev'}">Apri SoundReel</a>`
```

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Smoke-verify with a fake Telegram update**

Start dev server: `cd backend && npm run dev`. Then in another shell post a synthetic webhook update for a public page URL:

```bash
curl -s -X POST http://127.0.0.1:8080/telegram/webhook \
  -H 'content-type: application/json' \
  -H "x-telegram-bot-api-secret-token: $TELEGRAM_WEBHOOK_SECRET" \
  -d '{
    "update_id": 999,
    "message": {
      "message_id": 1,
      "chat": { "id": 1 },
      "text": "https://example.com/",
      "entities": [{"type":"url","offset":0,"length":19}]
    }
  }'
```

Expected: HTTP 200. Watch the dev-server logs to confirm only **one** outgoing Telegram `sendMessage` call (the final one) is attempted — no `Ricevuto!` ack call. The Telegram API call may fail with a 401/400 if your local `chat.id=1` is fake; that is expected and not a regression.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/telegram.ts
git commit -m "feat(telegram): drop ack message, use compact AI-summary template"
```

---

## Task 11: Mirror `ExtractedLink` in the frontend types

**Files:**
- Modify: `frontend/src/types/index.ts`

- [ ] **Step 1: Update the `ExtractedLink` interface**

Find:

```ts
export interface ExtractedLink {
  url: string;
  label: string | null;
}
```

Replace with:

```ts
export type ExtractedLinkCategory =
  | 'referenced'
  | 'sponsor'
  | 'navigation'
  | 'related'
  | 'social'
  | 'other';

export interface ExtractedLink {
  url: string;
  label: string | null;
  domain?: string | null;
  faviconUrl?: string | null;
  title?: string | null;
  category?: ExtractedLinkCategory | null;
}
```

If the file does not contain `ExtractedLink`, locate where `links: ...` is referenced under `EntryResults` and define `ExtractedLink` once at the top, then change `links: Array<{ url: string; label: string | null }>` to `links: ExtractedLink[]`.

- [ ] **Step 2: Typecheck the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/types/index.ts
git commit -m "feat(frontend/types): mirror ExtractedLink metadata fields"
```

---

## Task 12: Update `EntryCard` and `CompactCard` for link metadata

**Files:**
- Modify: `frontend/src/components/EntryCard.tsx` (the `hasLinks` block, currently lines ~439–453)
- Modify: `frontend/src/components/CompactCard.tsx`

- [ ] **Step 1: Replace the existing Links section in `EntryCard.tsx`**

Find the block:

```tsx
{hasLinks && (
  <section className="entry-section links">
    <h3 className="section-title">{t.linksSection}</h3>
    <ul className="links-list">
      {entry.results.links.map((link, index) => (
        <li key={index} className="link-item">
          <span className="link-icon">🔗</span>
          <a href={link.url} target="_blank" rel="noopener noreferrer" className="link-url">
            {link.label || link.url}
          </a>
        </li>
      ))}
    </ul>
  </section>
)}
```

Replace with:

```tsx
{hasLinks && (
  <section className="entry-section links">
    <h3 className="section-title">{t.linksSection}</h3>
    <ul className="links-list">
      {entry.results.links.map((link, index) => {
        const domain = link.domain
          || (() => { try { return new URL(link.url).hostname.replace(/^www\./, ''); } catch { return null; } })();
        const favicon = link.faviconUrl
          || (domain ? `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(domain)}` : null);
        const labelText = link.label || link.title || link.url;
        return (
          <li key={index} className={`link-item${link.category ? ` link-cat-${link.category}` : ''}`}>
            {favicon
              ? <img src={favicon} alt="" className="link-favicon" width={16} height={16} loading="lazy" />
              : <span className="link-icon">🔗</span>}
            <a href={link.url} target="_blank" rel="noopener noreferrer" className="link-url">
              {labelText}
            </a>
            {domain && <span className="link-domain">{domain}</span>}
            {link.category && <span className="link-category">{link.category}</span>}
          </li>
        );
      })}
    </ul>
  </section>
)}
```

(The `entry-summary` paragraph already exists at line ~354 — no change needed there.)

- [ ] **Step 2: Update `CompactCard.tsx`**

Open `frontend/src/components/CompactCard.tsx`. Find the place where the caption preview is rendered (search for `entry.caption`) and the place where song/film counts are shown. Apply two changes:

1. Where the caption preview is computed, prefer `summary` first 100 chars when present:

```tsx
const summary = entry.results?.summary;
const previewText = (summary && summary.trim())
  ? summary.trim().slice(0, 100) + (summary.trim().length > 100 ? '…' : '')
  : (entry.caption || '');
```

Then render `previewText` wherever the previous caption preview was rendered.

2. Where the existing `🎵 N · 🎬 N` chip row is built, prepend `🔗` count:

```tsx
const linksCount = entry.results?.links?.length || 0;
const songsCount = entry.results?.songs?.length || 0;
const filmsCount = entry.results?.films?.length || 0;
// ... in JSX:
{(linksCount + songsCount + filmsCount) > 0 && (
  <span className="compact-counts">
    {linksCount > 0 && <>🔗 {linksCount}</>}
    {songsCount > 0 && <> · 🎵 {songsCount}</>}
    {filmsCount > 0 && <> · 🎬 {filmsCount}</>}
  </span>
)}
```

(Adapt to the existing JSX structure; do not duplicate an existing chip row — replace it.)

- [ ] **Step 3: Typecheck the frontend**

Run: `cd frontend && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Visual smoke check**

Start the frontend: `cd frontend && npm run dev`. Submit a non-IG URL through the home page (or open an entry that already has links). Confirm:
- Summary shows above the caption block.
- Links section shows favicons and domain text.
- Compact card list shows `🔗 N` counter.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/EntryCard.tsx frontend/src/components/CompactCard.tsx
git commit -m "feat(frontend): show link favicons/domain/category and summary in compact card"
```

---

## Task 13: Smoke-test matrix

**Files:** _no code changes — verification only_

- [ ] **Step 1: Run the smoke set**

Have backend + frontend dev servers running. For each URL below, submit it via the home page UI **and** via the synthetic Telegram webhook (use the curl command from Task 10 with the URL substituted). Confirm both the entry record (in the UI) and the Telegram log show the expected outcome.

| # | URL | Expected outcome |
|---|---|---|
| 1 | `https://dev.to/...any-public-post...` | Page entry, summary present, ≥1 external link, favicons rendered. |
| 2 | `https://www.ansa.it/...any-article...` | Page entry, summary present, links categorized. |
| 3 | `https://github.com/anthropics/anthropic-cookbook` | Page entry, README extracted, GitHub-internal links categorized. |
| 4 | `https://it.wikipedia.org/wiki/Roma` | Long mainText truncated; summary plausible; many links. |
| 5 | `https://www.linkedin.com/posts/...any-public-post...` | Partial: meta only, summary still produced. |
| 6 | A direct PDF URL (e.g. `https://arxiv.org/pdf/2106.09685.pdf`) | Entry status `error`, action log `page_unsupported_content_type`. |
| 7 | `https://www.nytimes.com/...paywalled...` | Partial result via meta only; no crash. |
| 8 | `https://twitter.com/<user>/status/<id>` | Partial result; no media download. |
| 9 | An IG reel URL you've used before | Existing IG flow still produces songs/films/thumbnail. |
| 10 | A TikTok URL | Existing legacy flow still works. |
| 11 | `http://localhost/` | Entry status `error`, action log `page_ssrf_blocked`. |
| 12 | `http://192.168.1.1/` | Entry status `error`, action log `page_ssrf_blocked`. |

- [ ] **Step 2: Telegram one-message confirmation**

Send a single page URL through your real Telegram bot and confirm exactly **one** message arrives in the chat (the final one), with the new format: `<b>title</b>` line, summary line, counts line, "Apri su SoundReel" link.

- [ ] **Step 3: CHANGELOG entry**

Append to `CHANGELOG.md` (top of the unreleased / next section):

```markdown
- Added: page-extraction pipeline for non-Instagram URLs (Readability + link harvesting + representative image, no media download).
- Added: `pageExtractionEnabled` feature flag (default on).
- Added: `domain`, `faviconUrl`, `title`, `category` fields on `ExtractedLink` (optional, retro-compatible).
- Changed: Telegram bot now sends a single message per submitted link (AI summary + counts + SoundReel link). The "Ricevuto!" ack message has been removed.
- Changed: URL normalization (lowercase host, strip tracking params) before idempotency lookup.
- Security: SSRF guard on outbound page fetches (rejects loopback/private/link-local hosts and non-http(s) schemes).
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): page extraction pipeline + telegram trim"
```

---

## Self-Review

- **Spec coverage**
  - Page branch + Readability + link scraping → Tasks 4, 5, 6, 9.
  - Representative image → Task 6 (`pickRepresentativeImage`) + Task 9 (saved via `saveThumbnailLocal`).
  - SSRF guard → Task 5 + Task 9 error handling.
  - URL normalization (idempotency + tracking strip) → Task 4 + Task 9.
  - Extended `ExtractedLink` (backend + frontend) → Tasks 1, 11.
  - `pageExtractionEnabled` feature flag → Task 2.
  - `webPageAnalysis` AI prompt + service → Tasks 7, 8.
  - Telegram trim to one message + new template → Task 7 (template) + Task 10 (route).
  - Frontend EntryCard / CompactCard updates → Task 12.
  - Smoke matrix + CHANGELOG → Task 13.

- **Placeholder scan:** No `TBD`, `TODO`, "implement later", or "similar to Task N" present. Each step that changes code shows the actual code. The only meta-instruction is the cut-and-paste guidance in Task 9 Step 3 (clearly explained, not a placeholder).

- **Type consistency:**
  - `ExtractedLinkCategory` defined identically in backend (Task 1) and frontend (Task 11).
  - `analyzeWebPage` returns `MediaAiAnalysisResult` (existing type), so `mergeResults` continues to accept its `.result` field.
  - `pageExtractionEnabled` added to `FeaturesConfig` (Task 2) and read in Task 9 (`featuresConfig.pageExtractionEnabled`).
  - Telegram template variables (Task 7) match the template-render call (Task 10): `title, summary, hasSummary, linksCount, songsCount, filmsCount, hasCounts, frontendUrl`.

- **Scope check:** Single coherent feature (page pipeline) plus a tightly-related Telegram cleanup. Both share the same data model changes. One plan is appropriate.
