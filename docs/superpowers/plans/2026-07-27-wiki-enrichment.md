# Person & Brand Enrichment (Wikipedia) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** `person` (226) and `brand` (473) notes enriched via Wikipedia (it, fallback en): short description, thumbnail, article link; displayed on NotesPage; hook + backfill. Seventh iteration of the proven template — bookEnrichment/placeEnrichment are the blueprints, including match verification, cleaned-query variants, throttle, hit/miss/error discrimination, touch-on-miss TTL.

## Global Constraints

- As previous features. Wikipedia policy: descriptive User-Agent (derive version like placeEnrichment does), throttle ≥500ms between requests (module-level, in the fetch helper, _reset for tests).
- Flow per note text: (1) `GET https://it.wikipedia.org/w/api.php?action=query&list=search&srsearch=<q>&format=json&srlimit=3` → candidates `query.search[] { title, snippet }`; (2) acceptance: normalized (place-style normalize: punctuation→space) containment either direction between candidate `title` and the note text; ≤2-token query → near-equality; query variants raw/cleanQuery (max 2 search calls per language); (3) no accepted candidate on it → same on en.wikipedia (max 2 more); (4) accepted title → `GET https://<lang>.wikipedia.org/api/rest_v1/page/summary/<encodeURIComponent(title with spaces→_)>` → `{ description, extract, thumbnail.source, content_urls.desktop.page }`. Disambiguation pages (`type === 'disambiguation'` in summary) → treat candidate as rejected, try next candidate.
- Verified live: summary returns `title, description, extract, thumbnail{source}, content_urls.desktop.page, type`.
- Stored: wiki_title, wiki_description (prefer `description`, fallback first 200 chars of extract), wiki_thumbnail_url (safeUrl), wiki_url (safeUrl, must be https://<lang>.wikipedia.org/...). Result null on no acceptance (miss). hit/miss/error discrimination like placeEnrichment. Miss → touchNoteEnrichedAt (never wipe).
- Total budget backfill: ~699 notes × up to 5 req ≈ manageable at 500ms; abort on consecutive errors (existing counter).

---

### Task 1: Backend

- Migration `007_wiki_meta.sql` + init.sql sync:
```sql
ALTER TABLE note_meta
  ADD COLUMN IF NOT EXISTS wiki_title TEXT,
  ADD COLUMN IF NOT EXISTS wiki_description TEXT,
  ADD COLUMN IF NOT EXISTS wiki_thumbnail_url TEXT,
  ADD COLUMN IF NOT EXISTS wiki_url TEXT;
```
- `backend/src/services/wikiEnrichment.ts` (+test): `enrichWikiDetailed(text) → {status:'hit', result: WikiEnrichmentResult}|{status:'miss'}|{status:'error'}` + `enrichWiki` null-wrapper. Reuse cleanQuery/isAcceptedMatch-style helpers (import from bookEnrichment; place-local normalize pattern — import normalizePlace? it's place-local: EXPORT it from placeEnrichment or lift both into a shared textMatch module, implementer's call, no duplication).
- `noteMeta.ts` (+test): NoteMetaRecord + wikiTitle/wikiDescription/wikiThumbnailUrl/wikiUrl both types files; `upsertWikiEnrichment` (wiki columns + enriched_at only; word-bounded regex tests vs book/place/user columns).
- `noteEnrichmentHook.ts` (+test): dispatch adds 'person' and 'brand' → wiki path (same TTL, miss → touch).
- `backfillNoteMeta.ts`: targets extended to person/brand (wiki columns null/stale), per-category counts, wiki 'error' feeds consecutive-error abort.

- [ ] TDD → full backend + tsc both sides → commit `feat(notes): wikipedia person and brand enrichment`.

### Task 2: Frontend

- NotesPage person/brand rows with meta: thumbnail (round for person, square for brand — same `note-cover`-style class, onError fallback), wiki_description muted line (single-line ellipsis + title attr), `Wikipedia` badge-link (wiki_url). filterNotes haystack gains wikiTitle/wikiDescription (+test). Attribution: NotesPage footer gains 'Wikipedia (CC BY-SA)' link https://it.wikipedia.org next to OSM; LicensesPage data-providers too.

- [ ] TDD → frontend suites + tsc + build → commit `feat(notes): show wikipedia person and brand data`.

### Task 3: Verify + deploy + backfill

- [ ] Suites; merge; bump patch (2.5.2); migration 007 before .rebuild; deploy; backfill dry-run + live; junk-rate spot-check on a sample of person/brand rows in DB before declaring done.
