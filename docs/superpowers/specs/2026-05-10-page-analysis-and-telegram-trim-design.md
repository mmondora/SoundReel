# Page Analysis Pipeline + Telegram Trim — Design

- **Date:** 2026-05-10
- **Branch:** local-port
- **Author:** Michele Mondora (with Claude)
- **Status:** Draft

## Problem

SoundReel today is reel-centric: the analyze pipeline downloads media (Instagram via Instaloader, others via cobalt/AudD) and extracts songs/films. Two gaps:

1. **Non-IG, non-media URLs** (articles, blog posts, GitHub pages, LinkedIn posts, news, wikis) are forced through the legacy media pipeline. The user wants those URLs analyzed as **pages**: a synthesis plus all their external links — without any media download.
2. **Telegram** sends two messages per submitted link (acknowledgement + final result). The user wants one message: a brief AI summary plus a link back to SoundReel.

The result entry already exposes a `links: ExtractedLink[]` field, but it is barely used and lacks metadata (domain, favicon, category) needed to make link lists useful.

## Goals

- Add a **page** branch to the analyze pipeline for any URL whose platform resolves to `'other'`, with no media download.
- Persist a useful, structured set of **all external links** found on the page, plus an AI-generated summary.
- Pick a **representative image** from the page (OG image, Twitter card, apple-touch-icon, or first large image) and use it as the entry thumbnail. No screenshots, no headless browser.
- Reduce Telegram traffic to **one** message per submitted link: an AI summary plus counts plus a link back to SoundReel.
- Keep IG and existing legacy (TikTok, YouTube, etc.) flows intact.

## Non-Goals

- Headless-browser screenshots or JS rendering.
- PDF, video, or audio parsing for non-IG URLs.
- Re-fetch policies for older entries.
- A new dedicated "Article" card component (reuse EntryCard adaptively).
- Search/filter UI over links across entries.
- Multi-user, auth, or sharing changes.

## Architecture

The analyze endpoint gains a third branch alongside the existing two:

```
detectPlatform(url) →
  ├─ 'instagram'                 → extractInstagramLocal (Instaloader, full media)
  ├─ media-rich (tiktok/yt/...)  → extractContentLegacy (oEmbed/OG + cobalt/AudD)
  └─ 'other'                     → extractPage (Readability + links + image, NO media)
```

Detection: existing `detectPlatform` already returns `'other'` for unrecognized hosts. The new branch fires when `platform === 'other'` AND a feature flag `pageExtractionEnabled` is on (default true). Existing media-rich platforms keep their legacy flow unchanged.

The page branch never invokes: cobalt, AudD, Whisper, OCR, ffmpeg, Instaloader, vision/Ollama. It only does HTTP fetch + HTML parsing + AI text analysis.

## Components

### New: `backend/src/services/pageExtractor.ts`

```ts
export interface PageExtractResult {
  finalUrl: string;
  httpStatus: number;
  contentType: string | null;
  title: string | null;            // <title> or og:title
  description: string | null;      // og:description / meta description
  mainText: string | null;         // Readability-extracted main content (null if extraction fails)
  representativeImageUrl: string | null;
  rawLinks: Array<{ url: string; anchorText: string | null }>;
  siteName: string | null;         // og:site_name or hostname
  lang: string | null;             // <html lang>
}

export async function extractPage(url: string): Promise<PageExtractResult>;
```

Implementation notes:
- Fetch with browser-like User-Agent, 15s timeout, follow redirects.
- Reject non-`text/html` Content-Type with a typed error (`UnsupportedContentTypeError`).
- Parse with `jsdom`; pass document into `@mozilla/readability` for `mainText`.
- `pickRepresentativeImage` priority order:
  1. `og:image` / `twitter:image` (resolved to absolute URL).
  2. `apple-touch-icon-precomposed` / `apple-touch-icon` (largest `sizes=` value).
  3. `<link rel="icon" sizes=...>` largest entry.
  4. First `<img>` with `width >= 200 && height >= 200` (or natural-dimension hints in attributes).
  5. `null`.
- `scrapeLinks`: walk all `<a href>`, resolve to absolute URL, dedupe by URL. Drop:
  - `mailto:`, `tel:`, `javascript:`, fragment-only `#...`.
  - Same-host links whose closest ancestor is `<nav>`, `<header>`, `<footer>`, or `<aside>`.
- Cap `rawLinks` at 100 entries (drop the tail) to bound AI input size.

### New deps
- `@mozilla/readability`
- `jsdom`

(Both Apache-2.0/MIT, server-side only, no native binaries.)

### Extended: `backend/src/services/aiAnalysis.ts`

Add a sibling export `analyzeWebPage(input: PageExtractResult): Promise<MediaAiAnalysisResult>` with a dedicated prompt template (`prompts/webPageAnalysis`) registered through the existing prompt loader.

The prompt receives:
- `title`, `description`, `siteName`, `lang`, `mainText` (truncated to ~8 000 chars).
- `rawLinks` (up to 100, with anchor text).

It returns the existing `MediaAiAnalysisResult` shape:
- `summary` (~280 chars in Italian, language-aware).
- `links: ExtractedLink[]` — each `{ url, label, category }` selected from `rawLinks` (no invented URLs); category ∈ {`referenced`, `sponsor`, `navigation`, `related`, `social`, `other`}.
- `tags`, `notes`.
- `songs`, `films` — usually empty for non-media pages, but allowed (e.g. a music review).
- `transcription`/`visualContext`/`overlayText` — always null for the page branch.

The function MUST NOT add links that are not in `rawLinks`. Server-side, after AI returns, post-process each link to fill `domain` and `faviconUrl`.

### Extended: `backend/src/types/index.ts`

```ts
export interface ExtractedLink {
  url: string;
  label: string | null;
  domain?: string | null;
  faviconUrl?: string | null;
  title?: string | null;
  category?:
    | 'referenced' | 'sponsor' | 'navigation'
    | 'related'    | 'social'  | 'other'
    | null;
}
```

All new fields are optional → existing IG/TikTok entries remain valid.

### Extended: `backend/src/routes/analyze.ts`

Add the `'other'` branch after the existing IG/legacy split. The branch:

1. `findEntryByUrl(normalizedUrl)` — same idempotency as IG; honors `allowDuplicateUrls`.
2. `createEntry({ sourcePlatform: 'other', status: 'processing', ... })`.
3. `extractPage(url)`.
4. `actionLog: page_fetched { httpStatus, finalUrl, contentType }`.
5. `actionLog: page_parsed { hasMainText, mainTextChars, linksCount, hasImage }`.
6. `saveThumbnailLocal(representativeImageUrl, entryId)` (existing helper handles remote URL + resize) → fall back to `null` on failure.
7. `updateEntry({ caption: description ?? title, thumbnailUrl, mediaUrl: null })`.
8. `analyzeWebPage(...)` if `aiAnalysisEnabled`, else empty result.
9. Enrich each AI-returned link server-side: `domain` = parsed hostname, `faviconUrl` = `https://www.google.com/s2/favicons?sz=64&domain=${domain}`.
10. If `songs.length > 0` → existing Spotify search + add-to-playlist flow (reused).
11. If `films.length > 0` → existing TMDb search flow (reused).
12. `updateEntry({ status: 'completed', results })`.
13. `actionLog: completed { totalLinks, hasSummary, songs, films, tags }`.
14. If `autoEnrichEnabled` → existing `enrichWithOpenAI` (reused).

URL normalization (used both for the idempotency key and saved `sourceUrl`): lowercase host, strip trailing slash, drop tracking params (`utm_*`, `fbclid`, `gclid`, `mc_*`, `igshid`).

### SSRF guard

Before fetch, reject URLs whose hostname resolves to a private/loopback range:
- Reject if hostname is `localhost`, `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`.
- Allow only `http://` and `https://` schemes.
- Fail closed with an `SsrfBlockedError`; entry status = `error`.

### Telegram: `backend/src/routes/telegram.ts`

Changes:
1. **Remove** the immediate "Ricevuto! Link da X — Analisi in corso" message.
2. Webhook still acknowledges with `200 OK` immediately and processes in background.
3. The single final message uses the new `telegramResponse` template:
   ```
   <b>{title or siteName}</b>
   {summary, max ~280 chars, ellipsis if longer}

   🔗 {links} · 🎵 {songs} · 🎬 {films}
   🌐 <a href="{frontendUrl}">Apri su SoundReel</a>
   ```
4. For IG entries: `title` = author handle or first caption line; `summary` = AI summary or truncated caption.
5. On error: one short message — `❌ Analisi fallita: {short reason}\n🌐 <a>Vedi log</a>`.
6. `/start`, `/stats`, `/status` commands unchanged.
7. Update the default `telegramResponse` prompt in `config/prompts`. Preserve any user-customized template that already differs from the previous default.

## Data Flow (page branch)

```
URL in (web/telegram)
  ├─ normalize URL (drop tracking params, lowercase host)
  ├─ findEntryByUrl → if exists & !allowDuplicateUrls: reply with existing entry
  ├─ detectPlatform → 'other'
  ├─ SSRF guard
  ├─ createEntry { sourcePlatform: 'other', status: 'processing' }
  ├─ extractPage(url)
  │     ├─ fetch (UA, 15s, follow redirects)
  │     ├─ verify Content-Type text/html
  │     ├─ JSDOM + meta parse
  │     ├─ Readability → mainText
  │     ├─ pickRepresentativeImage
  │     └─ scrapeLinks (cap 100)
  ├─ actionLog: page_fetched / page_parsed
  ├─ saveThumbnailLocal(imageUrl) → persistent thumb (or null)
  ├─ updateEntry { caption, thumbnailUrl, mediaUrl: null }
  ├─ analyzeWebPage(...) → MediaAiAnalysisResult (or empty if AI off)
  ├─ enrich links (domain, faviconUrl)
  ├─ Spotify (if songs) / TMDb (if films) — existing flows
  ├─ updateEntry { status: 'completed', results }
  ├─ actionLog: completed
  ├─ autoEnrich (if enabled)
  └─ reply { success, entryId, entry }
```

## Frontend

`frontend/src/components/EntryCard.tsx`:
- Render `results.summary` as a hero-text block under the thumbnail when present.
- Render the **Links** section using the extended `ExtractedLink` shape: each row shows `faviconUrl` + `domain` + `label || title || url`. Links open in a new tab with `rel="noopener noreferrer"`.
- If `category` is present on at least one link, group links by category (collapsible sections, all open by default). If no categories, render as a flat list.
- Already-empty `songs`/`films` sections continue to render conditionally (no change).
- Platform badge: surface "Web" label with a globe icon for `sourcePlatform === 'other'` (entry already exists in `platforms.json`).

`frontend/src/components/CompactCard.tsx`:
- If `results.summary` is present, show its first 100 chars in place of the caption preview.
- Add a `🔗 N` chip to the existing `🎵 N · 🎬 N` row.

No new routes, no new top-level components.

## Error Handling

| Failure | Outcome |
|---|---|
| `fetch` timeout / network error | entry `status: error`; actionLog `page_fetch_failed { error }`; Telegram error message. |
| HTTP 4xx/5xx | entry `status: error`; actionLog `page_fetch_failed { httpStatus }`. |
| Non-HTML Content-Type (PDF, video, image, …) | entry `status: error`; actionLog `page_unsupported_content_type { contentType }`. |
| SSRF blocked URL | entry `status: error`; actionLog `page_ssrf_blocked { hostname }`. |
| Readability returns null (paywall, JS-only) | proceed with `title + description + meta` only; `mainText: null`; AI handles. |
| No image candidates | `thumbnailUrl: null`; UI uses existing placeholder. |
| `aiAnalysisEnabled=false` | entry completes with empty `results.songs/films/links/notes/tags`, `summary: null`. |
| AI timeout / parse error | actionLog `ai_analyzed { status: 'error' }`; entry completes with empty results. |

## Idempotency

`findEntryByUrl` keyed by the normalized URL. Default behavior: skip and return existing entry. Override via `featuresConfig.allowDuplicateUrls`. No re-fetch policy.

## Configuration

New feature flag in `config/features`:
- `pageExtractionEnabled: boolean` (default `true`). When `false`, `'other'` URLs fall through to legacy (current behavior).

No new secrets. No env-var changes.

## Testing (manual)

CLAUDE.md forbids automatic tests unless requested. Smoke-test set, run via UI and Telegram for each URL:
1. Blog post (e.g. dev.to article).
2. News article (e.g. ANSA / NYT public page).
3. GitHub repo README.
4. Wikipedia page.
5. LinkedIn public post.
6. Direct PDF link → expect graceful error.
7. Paywalled article (NYT) → expect partial result via meta only.
8. JS-heavy single-page app (e.g. a Twitter/X status) → expect partial result via meta.
9. IG reel (regression).
10. TikTok URL (legacy regression).
11. `http://localhost/` → expect SSRF block.
12. `http://192.168.1.1/` → expect SSRF block.

## Rollout

1. Implement on branch `local-port`.
2. Deploy self-hosted backend.
3. Toggle `pageExtractionEnabled` on.
4. Run smoke set. Watch debug logs for unexpected errors.
5. Update CHANGELOG entry.
6. No data migration: schema is fully retro-compatible.

## Out of Scope

- Headless-browser rendering or screenshots.
- PDF/audio/video parsing for non-IG URLs.
- Per-domain custom extractors.
- Cross-entry link search/filter UI.
- Re-fetching aged entries.
- Dedicated Article card UI (reuse EntryCard adaptively).
