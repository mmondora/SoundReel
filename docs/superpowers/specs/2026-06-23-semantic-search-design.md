# Semantic Search Design

**Date:** 2026-06-23  
**Status:** Approved  
**Scope:** Global full-text search with Ollama synonym expansion across all saved entries

---

## Problem

No search mechanism exists. Finding a saved link requires scrolling the journal. With 424+ entries growing at 10+/day, retrieval by topic becomes impossible without search.

## Goal

A global search bar that finds entries by topic — including synonyms and related terms — across all extracted content (caption, summary, tags, songs, films, notes, transcription, links).

---

## Approach

**Postgres Full-Text Search + Ollama query expansion** (Approach A).

- No new infrastructure or Docker containers
- Ollama `qwen2.5:3b` already running — used for synonym expansion
- Postgres 17 FTS built-in — `tsvector` + GIN index
- `simple` dictionary (no aggressive stemming — content is mixed IT/EN)

---

## Data Layer

### Schema change

```sql
ALTER TABLE entries ADD COLUMN search_vector tsvector;
CREATE INDEX idx_entries_search ON entries USING GIN(search_vector);
```

### search_vector content

Concatenates (weighted) text from:
- `caption` — weight A
- `results->>'summary'` — weight A
- `results->'tags'` (array → space-joined string) — weight A
- `results->'notes'` (each `note.text`) — weight B
- `results->'songs'` (each `title` + `artist`) — weight B
- `results->'films'` (each `title` + `director`) — weight B
- `results->>'transcription'` — weight C
- `results->>'visualContext'` — weight C
- `results->>'overlayText'` — weight C
- `results->'links'` (each `label` + `domain`) — weight C

### Trigger

A Postgres trigger rebuilds `search_vector` on every INSERT or UPDATE of `entries`, keeping the index always current.

### Backfill

Migration runs `UPDATE entries SET search_vector = <computed>` for all 424 existing entries at deploy time.

---

## Backend

### Endpoint

```
GET /api/search?q=<query>&limit=20
```

### Flow

```
user query
  │
  ├─→ Ollama qwen2.5:3b: expand to synonyms
  │     prompt: return JSON array of ≤10 related terms (IT + EN), no explanation
  │     timeout: 5s
  │     fallback: use original query only (no expansion)
  │
  ├─→ build tsquery:
  │     original terms (prefix match) OR each synonym term
  │
  └─→ Postgres:
        SELECT id, source_url, source_platform, caption,
               thumbnail_url, results, created_at,
               ts_rank(search_vector, query) AS rank
        FROM entries, websearch_to_tsquery('simple', $1) query
        WHERE search_vector @@ query
        ORDER BY rank DESC
        LIMIT $2
```

`websearch_to_tsquery` handles multi-word queries gracefully (no syntax errors from user input).

Synonym terms from Ollama are appended as additional OR clauses via `to_tsquery`.

### Response shape

```json
{
  "results": [
    {
      "id": "...",
      "sourceUrl": "...",
      "sourcePlatform": "youtube",
      "caption": "...",
      "thumbnailUrl": "...",
      "results": { "songs": [], "films": [], "notes": [], "tags": [], "summary": "..." },
      "createdAt": "...",
      "rank": 0.42
    }
  ],
  "expandedTerms": ["GPU", "home server", "NVIDIA", "inferenza locale"],
  "total": 12
}
```

### Error handling

- Ollama timeout/error → log warning, proceed with original query only
- Empty query (<2 chars) → return `{ results: [], expandedTerms: [], total: 0 }`
- Postgres FTS error → return 500 with error detail

---

## Frontend

### Search bar placement

Added to `Header.tsx` — always visible in navigation bar.

### Behavior

- Debounce: 400ms after last keystroke
- Minimum 2 characters to trigger search
- Spinner shown during Ollama + Postgres round-trip
- `Esc` closes results overlay
- Click outside overlay closes it

### Results overlay

Dropdown panel below header (not a new page/route):

```
┌─────────────────────────────────────────────────┐
│ 🔍 macchine ai compute da mettere in casa        │
├─────────────────────────────────────────────────┤
│ Cercato anche: GPU, home server, NVIDIA...       │
├─────────────────────────────────────────────────┤
│ [thumb]  youtube.com/watch?v=...                 │
│          NVIDIA RTX 5090 home lab setup          │
│          Tags: GPU · AI · homelab                │
├─────────────────────────────────────────────────┤
│ [thumb]  reddit.com/r/homelab/...                │
│          Best AI compute for home 2025           │
│          ♪ 0   🎬 0   📝 3                      │
└─────────────────────────────────────────────────┘
```

Each result shows:
- Thumbnail (or platform badge placeholder)
- Truncated source URL
- Summary or caption (first 120 chars)
- Badge row: song count, film count, note count

Click on result: navigates to entry detail (existing EntryDetail view).

### New files / changes

| File | Change |
|------|--------|
| `frontend/src/components/Header.tsx` | Add search input + overlay |
| `frontend/src/components/SearchOverlay.tsx` | New — result list component |
| `frontend/src/hooks/useSearch.ts` | New — debounced fetch + state |
| `backend/src/routes/search.ts` | New — GET /api/search |
| `backend/src/services/queryExpander.ts` | New — Ollama synonym expansion |
| `backend/src/db/init.sql` | Add column + index + trigger |
| `backend/src/db/migrations/001_search_vector.sql` | New — migration + backfill |

---

## Constraints

- No new Docker services
- No new npm packages (FTS is Postgres native; fetch is browser native)
- `qwen2.5:3b` used for expansion — same model already in use, no VRAM increase
- `simple` dictionary: no stemming, handles mixed IT/EN content correctly
- Ollama failure is non-blocking — search degrades gracefully to keyword-only
