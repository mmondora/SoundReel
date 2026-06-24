# ADR-0001: Postgres FTS over pgvector for Semantic Search

## Status
Accepted

## Date
2026-06-23

## Owners
Michele Mondora

## Related
- `backend/src/services/queryExpander.ts`
- `backend/src/routes/search.ts`
- `backend/src/db/init.sql` (search_vector column, GIN index, trigger)
- ADR-0002: simple FTS dictionary for mixed IT/EN content
- ADR-0003: Reuse qwen2.5:3b for query expansion

---

## 1. Context
SoundReel accumulates 400+ entries (Instagram Reels, TikTok, posts) with captions, AI summaries, song titles, and film mentions in mixed Italian/English. Users need to find content by memory fragments — partial song titles, mood descriptions, or artist names they half-remember. Plain `ILIKE` search was proving insufficient: it misses synonyms, alternate spellings, and cross-language equivalents. A semantic search layer was needed without introducing new infrastructure into a single-user personal app.

## 2. Decision
Use Postgres Full-Text Search (FTS) with a `tsvector` column and GIN index, augmented by Ollama-powered query expansion for synonym coverage. pgvector was explicitly rejected.

## 3. Drivers
- 400+ entries and growing: `ILIKE` queries scan full table with no ranking
- Personal use: user searches by mood/memory, not exact title
- Ollama `qwen2.5:3b` already running for content analysis — free capacity available
- No budget or ops appetite for new services (vector DB, embedding model)

## 4. Options Considered

### Option A: Postgres FTS + Ollama query expansion (chosen)
- **Pros**: no new infrastructure; Postgres already present; GIN index gives fast ranked search; `qwen2.5:3b` already loaded; synonym expansion covers cross-language queries; graceful degradation if Ollama unavailable
- **Cons**: true vector similarity not available; FTS relevance ranking is coarse (`ts_rank`); synonym quality depends on LLM prompt quality
- **Cost impact**: zero — reuses existing Postgres + Ollama resources

### Option B: pgvector with embedding model
- **Pros**: true semantic similarity; cosine distance ranking; language-agnostic
- **Cons**: requires `pgvector` Postgres extension (not currently installed); requires a dedicated embedding model (`nomic-embed-text` ~275 MB VRAM); backfill of 400+ entries at startup; embeddings must be regenerated if model changes; significantly higher ops complexity
- **Cost impact**: ~275 MB additional VRAM on GEEKOM A8 Max (shared GPU); Docker build changes; migration script required

### Option C: Client-side Fuse.js fuzzy search
- **Pros**: zero backend changes; instant results; works offline
- **Cons**: loads all 400+ entries to browser on every page load; no ranking; no synonym expansion; memory usage grows with corpus; breaks on slow connections
- **Cost impact**: zero infrastructure cost, but poor UX at scale

## 5. Decision Rationale
Option A wins because the "good enough" bar for a personal app is low, and the cost of overshooting it (pgvector ops) is real. The key insight: `qwen2.5:3b` is already resident in VRAM for content analysis — synonym expansion adds negligible load. FTS with GIN index gives sub-millisecond ranked queries over 400+ entries. The only genuine limitation (no cosine similarity) matters only when query expansion fails to surface the right synonyms, which is the natural upgrade trigger for pgvector if needed.

## 6. Consequences

### Positive
- Zero new infrastructure; no new Docker services
- Search latency: GIN index queries measure in single-digit milliseconds
- Synonym expansion covers Italian/English cross-language queries
- Ranked results via `ts_rank` give better UX than unordered `ILIKE`

### Negative
- True semantic similarity (embedding cosine distance) not available — "sad songs" won't find entries tagged "malinconia" unless Ollama returns that synonym
- FTS ranking is document-frequency-based, not semantic — relevance degrades on short captions
- Synonym quality is prompt-dependent and non-deterministic

### Follow-ups
- Monitor search result quality over next 30 days; if users report missed results, evaluate pgvector upgrade
- Consider adding `plainto_tsquery` fallback when `websearch_to_tsquery` returns empty

## 7. Guardrails
- `queryExpander.ts` must enforce 5s `Promise.race` timeout (see ADR-0003)
- GIN index must be verified present after migrations: `\d entries` should show `search_vector_idx`
- Search endpoint must return results even when Ollama is down (fallback to keywords-only)

## 8. Migration Plan
Already implemented. The `search_vector` column, GIN index, and trigger were added via `init.sql`. Existing entries were backfilled via trigger on `UPDATE`. No downtime was required.

## 9. Rollback
**Trigger**: synonym expansion produces consistently poor results AND user reports >3 missed searches per week.

**Steps to upgrade to pgvector**:
1. `CREATE EXTENSION IF NOT EXISTS vector;` on Postgres container
2. Add `embedding vector(768)` column to `entries`
3. Pull `nomic-embed-text` on Ollama
4. Backfill embeddings for all entries (background job)
5. Add `GET /api/search/v2` endpoint using cosine distance
6. Switch frontend to v2 endpoint; keep v1 as fallback during transition
7. Deprecate FTS endpoint after validation period

**Estimated effort**: 1–2 days implementation, 1 day validation.
