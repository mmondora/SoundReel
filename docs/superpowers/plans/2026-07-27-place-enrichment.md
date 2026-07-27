# Place Enrichment (Nominatim/OSM) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** `place` notes get geocoded via Nominatim (OpenStreetMap): resolved name + address, coordinates, OSM link; displayed on NotesPage; pipeline hook + backfill (~172 existing places).

**Architecture:** Extends the notes feature shipped today. Mirror `bookEnrichment.ts` exactly — including its match-verification + cleaned-query-second-pass design (that lesson was learned the hard way live). New columns on `note_meta` (006). Hook extends `noteEnrichmentHook` to dispatch by category.

## Global Constraints

- As previous features. Nominatim POLICY: mandatory `User-Agent: SoundReel/<version> (personal journal app; contact: mmondora@mondora.com)` header; max 1 req/s (backfill sleep ≥1100ms); no autocomplete-style usage.
- Endpoint: `https://nominatim.openstreetmap.org/search?q=<text>&format=jsonv2&limit=3&accept-language=it`. Verified live response fields: `name`, `display_name`, `lat`/`lon` (strings → parseFloat), `osm_type` ('node'|'way'|'relation'), `osm_id` (number), `type`, `importance`.
- OSM URL built as `https://www.openstreetmap.org/${osm_type}/${osm_id}` ONLY when osm_type matches ^(node|way|relation)$ and osm_id is a positive integer.
- Match acceptance (anti-junk, mirrors bookEnrichment): normalized (lowercase, punctuation-stripped, ws-collapsed) `name` contained in normalized note text or vice versa; when the effective query has ≤2 tokens require near-equality with `name`. Scan all ≤3 results; two-pass (raw text, then cleaned via the same cleanQuery helper — export/share it from bookEnrichment instead of duplicating); reject-all → null (miss, not persisted).
- Coordinates stored as numbers; `Number.isFinite` guard on parseFloat results, else null (and if lat/lon null → treat as miss).

---

### Task 1: Backend

**Files:**
- Create `backend/src/db/migrations/006_place_meta.sql` + init.sql sync:
```sql
ALTER TABLE note_meta
  ADD COLUMN IF NOT EXISTS place_name TEXT,
  ADD COLUMN IF NOT EXISTS place_display_name TEXT,
  ADD COLUMN IF NOT EXISTS place_lat DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS place_lon DOUBLE PRECISION,
  ADD COLUMN IF NOT EXISTS osm_url TEXT;
```
- Create `backend/src/services/placeEnrichment.ts` (+test): `enrichPlace(text: string): Promise<PlaceEnrichmentResult | null>` per constraints (never throws, null on miss/error, logs).
- Modify `backend/src/services/noteMeta.ts` (+test): extend `NoteMetaRecord` (both types files) with `placeName, placeDisplayName, placeLat, placeLon, osmUrl` (null defaults); add `upsertPlaceEnrichment({noteKey, ...})` setting enriched_at=now(), never touching book columns; row mapper + SELECT_COLS extended.
- Modify `backend/src/services/noteEnrichmentHook.ts` (+test): dispatch by normalized category — 'book' → enrichBook→upsertNoteEnrichment (unchanged), 'place' → enrichPlace→upsertPlaceEnrichment; same TTL check per key.
- Modify `backend/src/scripts/backfillNoteMeta.ts`: targets now book AND place notes (stale/null), category-dispatched, sleep 1100ms; summary counts per category.
- Extract/share `cleanQuery` + normalize helpers from bookEnrichment (export from bookEnrichment or move to a small shared module — implementer's call, minimal churn).

- [ ] TDD → full backend + tsc both sides → commit `feat(notes): nominatim place enrichment`.

### Task 2: Frontend

- NotesPage place rows with meta: line `placeDisplayName` (muted, truncate 1 line via title attr for full), badge-links: `🗺 Maps` — when lat/lon present use `https://www.google.com/maps/search/?api=1&query=${lat},${lon}` else existing text-search URL — and `OSM` (osmUrl) when present. i18n only if any new label needed (Maps/OSM are proper nouns — no new keys expected).
- filterNotes text haystack gains placeName/placeDisplayName (+test).

- [ ] TDD → frontend suites + tsc + build → commit `feat(notes): show resolved place data`.

### Task 3: Verify + deploy + backfill

- [ ] Suites; merge; bump patch (2.5.1); migration 006 before .rebuild; deploy; backfill dry-run + live (~172 places ≈ 4 min at 1.1s); spot-check meta correctness in DB (junk-rate check on a sample!) and live page.
