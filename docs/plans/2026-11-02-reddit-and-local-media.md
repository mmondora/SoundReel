# Reddit + Local Media Browse — Implementation Plan

**Goal:** Reddit post+article text/summary usable; offline replay of saved media in inspector + library.

**Architecture:** Improve `extractRedditRss` (rawLinks + optional article fetch). Expose local files via `GET /api/entries/:id/media` and prefer them over CDN in entry payloads. Inspector + `/library` UI consume those URLs.

**Tech:** Fastify, JSDOM pageExtractor, React inspector, existing `/media/:entryId/:filename`.

**Order:** Reddit → media API → inspector → library.

---

### Task 1: Reddit rawLinks from post HTML

**Files:** `backend/src/services/pageExtractor.ts`, `pageExtractor.redditRss.test.ts`

Extract `<a href>` from post content into `rawLinks`; filter reddit-internal optionally keep external only for primary article.

### Task 2: Fetch linked article into mainText

**Files:** same + tests

If primary external URL exists, `extractPage(article)` and append `## Linked article` section; merge rawLinks; never fail entry on article error.

### Task 3: detectPlatform reddit

**Files:** `contentExtractorLegacy.ts` detectPlatform (already has reddit patterns — verify classification).

### Task 4: listEntryMedia + GET /api/entries/:id/media

**Files:** `localMedia.ts`, `routes/media.ts` or `entries.ts`, tests

### Task 5: Prefer local URLs on getEntry/listEntries

**Files:** `db.ts` or entries route mapper

### Task 6: Inspector local player + frames

**Files:** `EntryInspector.tsx`, styles, api.ts

### Task 7: Library page

**Files:** `LibraryPage.tsx`, App, Header, `GET /api/library`

---
