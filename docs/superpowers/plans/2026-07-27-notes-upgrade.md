# Notes Upgrade — Filters, Search, Place & Book Enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** NotesPage becomes a dedup collection with search + category filters (FilmsPage pattern); `book` notes enriched via OpenLibrary (author, year, cover, link); `place` notes get a client-side Google Maps search link.

**Architecture:** Mirror the film/song features. New `note_meta` table (enrichment only, no user state). `GET /api/notes` aggregation + dedup by normalized text. OpenLibrary enrichment service + pipeline hook + backfill. Frontend rework reusing FilterPanel.

## Global Constraints

- Same as previous features (TS strict, mocked externals, fire-and-forget hooks, house script style, i18n both locales).
- noteKey = `category-normalized` + '::' + `lower(trim(collapse-ws(text)))` where category-normalized maps unknown categories (`note`, `link`, `service`, anything not in the 8 canonical) → `'other'`. Canonical: place, event, brand, book, product, quote, person, other.
- OpenLibrary: no key, be polite — 1 req/s in backfill; search `https://openlibrary.org/search.json?q=<text>&limit=3&fields=title,author_name,first_publish_year,cover_i,key`; pick first doc; cover `https://covers.openlibrary.org/b/id/{cover_i}-M.jpg` when cover_i present; link `https://openlibrary.org{key}`; miss → not persisted (retried next backfill), enrichment errors logged never thrown to pipeline.
- Maps link (frontend only): `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}`.

---

### Task 1: Backend — note_meta, aggregation API, book enrichment, hook, backfill

**Files:**
- Create: `backend/src/db/migrations/005_note_meta.sql` + append to init.sql:
```sql
CREATE TABLE IF NOT EXISTS note_meta (
  note_key TEXT PRIMARY KEY,
  book_title TEXT,
  book_author TEXT,
  book_year INTEGER,
  cover_url TEXT,
  openlibrary_url TEXT,
  enriched_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```
- Create: `backend/src/services/noteMeta.ts` (+test): `normalizeNoteCategory(raw: string | null | undefined): NoteCategory` (canonical 8, unknown→'other'); `noteKey(category: string | null | undefined, text: string): string`; `upsertNoteEnrichment({noteKey, bookTitle, bookAuthor, bookYear, coverUrl, openlibraryUrl})` (sets enriched_at=now()); `listNoteMeta(): Promise<Map<string, NoteMetaRecord>>`.
- Create: `backend/src/services/bookEnrichment.ts` (+test): `enrichBook(text: string): Promise<BookEnrichmentResult | null>` — OpenLibrary search per constraints, URL fields through a safeUrl check, null on miss/error (logged), never throws.
- Create: `backend/src/routes/notes.ts` (+test): `GET /api/notes` — aggregate `results.notes` from `listEntries(10000)`, tolerate malformed (require non-empty string text), dedupe by noteKey (category from most recent mention, normalized), mentions newest-first, left-join note_meta → `{ notes: AggregatedNote[] }`. Register in server.ts.
- Modify: `backend/src/routes/analyze.ts`: after results persisted, fire-and-forget for book-category notes: skip when meta enriched fresh (30d TTL, reuse isStale); enrichBook → upsertNoteEnrichment. Mirror songEnrichmentHook shape → create `backend/src/services/noteEnrichmentHook.ts` (+test).
- Create: `backend/src/scripts/backfillNoteMeta.ts` — house style, `[note-meta]` prefix, targets book notes with meta null/stale, 1000ms sleep, --dry-run.
- Types both sides: `NoteCategory`, `NoteMetaRecord { noteKey, bookTitle, bookAuthor, bookYear, coverUrl, openlibraryUrl, enrichedAt }`, `NoteMention { entryId, createdAt }`, `AggregatedNote { noteKey, text, category: NoteCategory, mentions, meta }`.

- [ ] TDD → full backend suite + tsc both sides → commit `feat(notes): note aggregation API and OpenLibrary book enrichment`.

---

### Task 2: Frontend — NotesPage rework

**Files:** Modify `frontend/src/pages/NotesPage.tsx` (rework, FilmsPage skeleton), `frontend/src/services/api.ts` (`fetchNotes(): Promise<AggregatedNote[]>`), create `frontend/src/utils/noteFilters.ts` (+test): `filterNotes(notes, { categories: NoteCategory[]; text?: string })` (category OR; text over note text + book author/title), `collectCategories(notes)` (present categories, canonical order not alphabetical), `sortNotes(notes, mode: 'date' | 'mentions')`; i18n; CSS.

- Top bar: search + count + sort select (Data/Menzioni) + Filtri(n); active chips; FilterPanel single chips section CATEGORIA (localized labels).
- Note row: category icon+badge (📍 place, 🎫 event, 🏷 brand, 📚 book, 📦 product, 💬 quote, 👤 person, 📝 other), text, mentions ×N link to `/?entry=`.
  - place: `🗺` Maps search link button (client-side URL).
  - book with meta: cover thumb, "di {author} ({year})", OpenLibrary badge-link.
- Category labels i18n both locales (Luogo/Place, Evento/Event, Brand/Brand, Libro/Book, Prodotto/Product, Citazione/Quote, Persona/Person, Altro/Other) + page strings.
- Keep Header stats behavior as current NotesPage does.

- [ ] TDD noteFilters → implement → frontend vitest + tsc + build → commit `feat(notes): dedup notes page with search, category filters and enrichment display`.

---

### Task 3: Verify + deploy + backfill

- [ ] Suites both sides; merge; bump minor (2.5.0); migration 005 BEFORE .rebuild; deploy; verify; backfill dry-run + live (23 book notes ≈ 23 calls); spot-check /api/notes and a book note with cover.
