# Semantic Search Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a global search bar to SoundReel that finds entries by topic using Postgres FTS and Ollama synonym expansion.

**Architecture:** A `search_vector` tsvector column (maintained by trigger) indexes all text fields from each entry. On search, `qwen2.5:3b` expands the query into synonyms (5s timeout, graceful fallback). The backend ORs original + synonyms via `websearch_to_tsquery`, ranks by `ts_rank`, returns up to 20 results. A header-mounted input + dropdown overlay renders results without navigation.

**Tech Stack:** Postgres 17 FTS (`tsvector`, GIN index, `simple` dictionary), Fastify, React + TypeScript, existing `ollamaClient.ts` / `generateText`.

## Global Constraints

- No new Docker services or npm packages
- TypeScript strict mode — no `any`
- No automated tests (per CLAUDE.md) — verify manually via curl + browser
- `simple` dictionary only (no `italian`/`english` — content is mixed IT/EN)
- Ollama expansion timeout: 5 seconds, non-blocking fallback to original query
- qwen2.5:3b only — no new models
- No Firebase, no Next.js, no heavy UI libs

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/db/migrations/001_search_vector.sql` | Create | Column + index + trigger + backfill |
| `backend/src/db/init.sql` | Modify | Add column + index + trigger for fresh deployments |
| `backend/src/services/queryExpander.ts` | Create | Ollama synonym expansion with 5s timeout |
| `backend/src/routes/search.ts` | Create | `GET /api/search` handler |
| `backend/src/server.ts` | Modify | Register search route |
| `frontend/src/types/index.ts` | Modify | Add `SearchResult`, `SearchResponse` types |
| `frontend/src/services/api.ts` | Modify | Add `searchEntries()` function |
| `frontend/src/hooks/useSearch.ts` | Create | Debounced search state hook |
| `frontend/src/components/SearchOverlay.tsx` | Create | Results dropdown component |
| `frontend/src/components/Header.tsx` | Modify | Add search input + overlay integration |
| `frontend/src/styles/index.css` | Modify | Search input + overlay styles |

---

### Task 1: Database Migration

**Files:**
- Create: `backend/src/db/migrations/001_search_vector.sql`
- Modify: `backend/src/db/init.sql`

**Interfaces:**
- Produces: `entries.search_vector tsvector` column maintained by `entries_search_vector_trigger`

- [ ] **Step 1: Create migration file**

Create `backend/src/db/migrations/001_search_vector.sql`:

```sql
-- Migration 001: add search_vector column with GIN index and auto-update trigger

ALTER TABLE entries ADD COLUMN IF NOT EXISTS search_vector tsvector;

CREATE INDEX IF NOT EXISTS idx_entries_search ON entries USING GIN(search_vector);

CREATE OR REPLACE FUNCTION entries_build_search_vector(
  p_caption TEXT,
  p_results JSONB
) RETURNS tsvector AS $$
DECLARE
  tags_text  TEXT;
  notes_text TEXT;
  songs_text TEXT;
  films_text TEXT;
  links_text TEXT;
BEGIN
  SELECT string_agg(value::text, ' ')
    INTO tags_text
    FROM jsonb_array_elements_text(COALESCE(p_results->'tags', '[]'::jsonb));

  SELECT string_agg(elem->>'text', ' ')
    INTO notes_text
    FROM jsonb_array_elements(COALESCE(p_results->'notes', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'artist', ''), ' ')
    INTO songs_text
    FROM jsonb_array_elements(COALESCE(p_results->'songs', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'director', ''), ' ')
    INTO films_text
    FROM jsonb_array_elements(COALESCE(p_results->'films', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'label', '') || ' ' || COALESCE(elem->>'domain', ''), ' ')
    INTO links_text
    FROM jsonb_array_elements(COALESCE(p_results->'links', '[]'::jsonb)) elem;

  RETURN
    setweight(to_tsvector('simple', COALESCE(p_caption, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'summary', '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(tags_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(notes_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(songs_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(films_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'transcription', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'visualContext', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'overlayText', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(links_text, '')), 'C');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION entries_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := entries_build_search_vector(NEW.caption, NEW.results);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_search_vector_update ON entries;
CREATE TRIGGER entries_search_vector_update
  BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_search_vector_trigger();

-- Backfill existing rows
UPDATE entries
SET search_vector = entries_build_search_vector(caption, results)
WHERE search_vector IS NULL;
```

- [ ] **Step 2: Apply migration to running DB**

```bash
docker exec -i soundreel-db psql -U soundreel soundreel \
  < backend/src/db/migrations/001_search_vector.sql
```

Expected output:
```
ALTER TABLE
CREATE INDEX
CREATE FUNCTION
CREATE FUNCTION
DROP TRIGGER
CREATE TRIGGER
UPDATE 424
```

Verify column exists and backfill worked:
```bash
docker exec soundreel-db psql -U soundreel soundreel \
  -c "SELECT COUNT(*) FROM entries WHERE search_vector IS NOT NULL;"
```
Expected: `424` (or current count).

- [ ] **Step 3: Update init.sql for fresh deployments**

In `backend/src/db/init.sql`, after the existing `CREATE INDEX IF NOT EXISTS idx_entries_status` line, add:

```sql
-- Search vector for FTS
ALTER TABLE entries ADD COLUMN IF NOT EXISTS search_vector tsvector;
CREATE INDEX IF NOT EXISTS idx_entries_search ON entries USING GIN(search_vector);

CREATE OR REPLACE FUNCTION entries_build_search_vector(
  p_caption TEXT,
  p_results JSONB
) RETURNS tsvector AS $$
DECLARE
  tags_text  TEXT;
  notes_text TEXT;
  songs_text TEXT;
  films_text TEXT;
  links_text TEXT;
BEGIN
  SELECT string_agg(value::text, ' ')
    INTO tags_text
    FROM jsonb_array_elements_text(COALESCE(p_results->'tags', '[]'::jsonb));

  SELECT string_agg(elem->>'text', ' ')
    INTO notes_text
    FROM jsonb_array_elements(COALESCE(p_results->'notes', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'artist', ''), ' ')
    INTO songs_text
    FROM jsonb_array_elements(COALESCE(p_results->'songs', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'title', '') || ' ' || COALESCE(elem->>'director', ''), ' ')
    INTO films_text
    FROM jsonb_array_elements(COALESCE(p_results->'films', '[]'::jsonb)) elem;

  SELECT string_agg(
      COALESCE(elem->>'label', '') || ' ' || COALESCE(elem->>'domain', ''), ' ')
    INTO links_text
    FROM jsonb_array_elements(COALESCE(p_results->'links', '[]'::jsonb)) elem;

  RETURN
    setweight(to_tsvector('simple', COALESCE(p_caption, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'summary', '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(tags_text, '')), 'A') ||
    setweight(to_tsvector('simple', COALESCE(notes_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(songs_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(films_text, '')), 'B') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'transcription', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'visualContext', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(p_results->>'overlayText', '')), 'C') ||
    setweight(to_tsvector('simple', COALESCE(links_text, '')), 'C');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION entries_search_vector_trigger() RETURNS trigger AS $$
BEGIN
  NEW.search_vector := entries_build_search_vector(NEW.caption, NEW.results);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS entries_search_vector_update ON entries;
CREATE TRIGGER entries_search_vector_update
  BEFORE INSERT OR UPDATE ON entries
  FOR EACH ROW EXECUTE FUNCTION entries_search_vector_trigger();
```

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/001_search_vector.sql backend/src/db/init.sql
git commit -m "feat(db): add search_vector column with FTS trigger and backfill"
```

---

### Task 2: Query Expander Service

**Files:**
- Create: `backend/src/services/queryExpander.ts`

**Interfaces:**
- Consumes: `generateText(prompt: string): Promise<OllamaResponse>` from `./ollamaClient`
- Consumes: `logWarning(msg: string, data?: unknown): void` from `../utils/logger`
- Produces: `expandQuery(q: string): Promise<string[]>` — returns array of synonym strings, empty on timeout/error

- [ ] **Step 1: Create `backend/src/services/queryExpander.ts`**

```typescript
import { generateText } from './ollamaClient';
import { logWarning } from '../utils/logger';

const EXPAND_TIMEOUT_MS = 5_000;

async function doExpand(q: string): Promise<string[]> {
  const prompt = `Return a JSON array of up to 10 search terms related to: "${q}"
Include synonyms and related concepts in both Italian and English.
Output only the JSON array, no explanation, no markdown.
Example output: ["GPU", "home server", "NVIDIA", "inferenza locale", "edge AI"]`;

  const { text } = await generateText(prompt);
  const match = text.match(/\[[\s\S]*?\]/);
  if (!match) return [];

  const parsed = JSON.parse(match[0]) as unknown[];
  return parsed
    .filter((t): t is string => typeof t === 'string' && t.trim().length > 0)
    .slice(0, 10);
}

export async function expandQuery(q: string): Promise<string[]> {
  const timeout = new Promise<string[]>((resolve) =>
    setTimeout(() => resolve([]), EXPAND_TIMEOUT_MS)
  );

  try {
    return await Promise.race([doExpand(q), timeout]);
  } catch (err) {
    logWarning('Query expansion failed, using original query only', { err: String(err) });
    return [];
  }
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add backend/src/services/queryExpander.ts
git commit -m "feat(search): Ollama query expander with 5s timeout fallback"
```

---

### Task 3: Search Route + Server Registration

**Files:**
- Create: `backend/src/routes/search.ts`
- Modify: `backend/src/server.ts`

**Interfaces:**
- Consumes: `query<T>(sql: string, params: unknown[]): Promise<T[]>` from `../utils/db`
- Consumes: `expandQuery(q: string): Promise<string[]>` from `../services/queryExpander`
- Consumes: `logInfo(msg: string, data?: unknown): void` from `../utils/logger`
- Produces: `GET /api/search?q=<string>&limit=<number>` → `{ results: SearchRow[], expandedTerms: string[], total: number }`

- [ ] **Step 1: Create `backend/src/routes/search.ts`**

```typescript
import type { FastifyInstance } from 'fastify';
import { query } from '../utils/db';
import { expandQuery } from '../services/queryExpander';
import { logInfo, logError } from '../utils/logger';

interface SearchRow {
  id: string;
  source_url: string;
  source_platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  results: unknown;
  created_at: Date;
  rank: number;
}

interface SearchResultItem {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  caption: string | null;
  thumbnailUrl: string | null;
  results: unknown;
  createdAt: string;
  rank: number;
}

interface SearchResponse {
  results: SearchResultItem[];
  expandedTerms: string[];
  total: number;
}

export function registerSearchRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { q?: string; limit?: string } }>(
    '/api/search',
    async (req, reply) => {
      const q = (req.query.q ?? '').trim();
      const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 20)));

      if (q.length < 2) {
        return { results: [], expandedTerms: [], total: 0 } satisfies SearchResponse;
      }

      const expandedTerms = await expandQuery(q);

      // Build parameterized query: original terms OR each synonym term
      // $1 = original query, $2 = limit, $3..N = synonym terms
      const params: unknown[] = [q, limit];
      let combinedQuery = `websearch_to_tsquery('simple', $1)`;

      if (expandedTerms.length > 0) {
        const synonymClauses = expandedTerms.map((term, i) => {
          params.push(term);
          return `websearch_to_tsquery('simple', $${i + 3})`;
        });
        combinedQuery = `(${combinedQuery} || ${synonymClauses.join(' || ')})`;
      }

      const sql = `
        SELECT
          id,
          source_url,
          source_platform,
          caption,
          thumbnail_url,
          results,
          created_at,
          ts_rank(search_vector, ${combinedQuery}) AS rank
        FROM entries
        WHERE search_vector @@ ${combinedQuery}
        ORDER BY rank DESC
        LIMIT $2
      `;

      try {
        const rows = await query<SearchRow>(sql, params);

        const results: SearchResultItem[] = rows.map((r) => ({
          id: r.id,
          sourceUrl: r.source_url,
          sourcePlatform: r.source_platform,
          caption: r.caption,
          thumbnailUrl: r.thumbnail_url,
          results: r.results,
          createdAt: r.created_at instanceof Date
            ? r.created_at.toISOString()
            : String(r.created_at),
          rank: r.rank,
        }));

        logInfo('Search', { q, synonyms: expandedTerms.length, found: results.length });
        return { results, expandedTerms, total: results.length } satisfies SearchResponse;
      } catch (err) {
        logError('Search query failed', { err: String(err), q });
        reply.code(500).send({ error: 'Search failed' });
      }
    }
  );
}
```

- [ ] **Step 2: Register route in `backend/src/server.ts`**

Add import after the existing route imports:
```typescript
import { registerSearchRoute } from './routes/search';
```

Add registration call after `registerAdminRoutes(app);`:
```typescript
registerSearchRoute(app);
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification**

Start backend in dev mode:
```bash
cd backend && npm run dev
```

Test with curl (no expansion, keyword only):
```bash
curl "http://localhost:8080/api/search?q=spotify"
```
Expected: JSON with `results` array and `expandedTerms` array, `total` >= 0.

Test short query rejection:
```bash
curl "http://localhost:8080/api/search?q=a"
```
Expected: `{"results":[],"expandedTerms":[],"total":0}`

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/search.ts backend/src/server.ts
git commit -m "feat(search): GET /api/search endpoint with FTS + synonym expansion"
```

---

### Task 4: Frontend Types + API Function

**Files:**
- Modify: `frontend/src/types/index.ts`
- Modify: `frontend/src/services/api.ts`

**Interfaces:**
- Produces: `SearchResult` interface (used by hook and overlay)
- Produces: `searchEntries(q: string): Promise<SearchResponse>` function

- [ ] **Step 1: Add types to `frontend/src/types/index.ts`**

Append at the end of the file:

```typescript
export interface SearchResult {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  caption: string | null;
  thumbnailUrl: string | null;
  results: {
    songs: Array<{ title: string; artist: string }>;
    films: Array<{ title: string }>;
    notes: Array<{ text: string }>;
    tags: string[];
    summary: string | null;
  };
  createdAt: string;
  rank: number;
}

export interface SearchResponse {
  results: SearchResult[];
  expandedTerms: string[];
  total: number;
}
```

- [ ] **Step 2: Add `searchEntries` to `frontend/src/services/api.ts`**

Add import at top of api.ts (after existing imports):
```typescript
import type { SearchResponse } from '../types';
```

Append at the end of api.ts:
```typescript
// --- Search ---

export async function searchEntries(q: string, limit = 20): Promise<SearchResponse> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(url(`/api/search?${params.toString()}`));
  return json<SearchResponse>(res);
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/types/index.ts frontend/src/services/api.ts
git commit -m "feat(search): SearchResult types and searchEntries API function"
```

---

### Task 5: useSearch Hook

**Files:**
- Create: `frontend/src/hooks/useSearch.ts`

**Interfaces:**
- Consumes: `searchEntries(q: string): Promise<SearchResponse>` from `../services/api`
- Consumes: `SearchResult`, `SearchResponse` from `../types`
- Produces: `useSearch(query: string): { results: SearchResult[], expandedTerms: string[], loading: boolean, error: string | null }`

- [ ] **Step 1: Create `frontend/src/hooks/useSearch.ts`**

```typescript
import { useState, useEffect, useRef } from 'react';
import { searchEntries } from '../services/api';
import type { SearchResult } from '../types';

interface SearchState {
  results: SearchResult[];
  expandedTerms: string[];
  loading: boolean;
  error: string | null;
}

const INITIAL_STATE: SearchState = {
  results: [],
  expandedTerms: [],
  loading: false,
  error: null,
};

const DEBOUNCE_MS = 400;
const MIN_QUERY_LEN = 2;

export function useSearch(query: string): SearchState {
  const [state, setState] = useState<SearchState>(INITIAL_STATE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    clearTimeout(timerRef.current);

    if (query.trim().length < MIN_QUERY_LEN) {
      setState(INITIAL_STATE);
      return;
    }

    setState((s) => ({ ...s, loading: true, error: null }));

    timerRef.current = setTimeout(async () => {
      try {
        const data = await searchEntries(query);
        if (!mountedRef.current) return;
        setState({
          results: data.results,
          expandedTerms: data.expandedTerms,
          loading: false,
          error: null,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        setState((s) => ({ ...s, loading: false, error: String(err) }));
      }
    }, DEBOUNCE_MS);

    return () => clearTimeout(timerRef.current);
  }, [query]);

  return state;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useSearch.ts
git commit -m "feat(search): useSearch hook with 400ms debounce"
```

---

### Task 6: SearchOverlay Component

**Files:**
- Create: `frontend/src/components/SearchOverlay.tsx`

**Interfaces:**
- Consumes: `SearchResult` from `../types`
- Consumes: `useSearch(query: string)` from `../hooks/useSearch`
- Produces: `<SearchOverlay query={string} onClose={() => void} />` — renders results dropdown

- [ ] **Step 1: Create `frontend/src/components/SearchOverlay.tsx`**

Note: click-outside is handled in Header (on the `search-wrapper` div) so that clicks on the
search input itself don't close the overlay. SearchOverlay only handles Esc.

```typescript
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../hooks/useSearch';
import type { SearchResult } from '../types';

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
  twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
  linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
  spotify: 'SP', soundcloud: 'SND',
};

function truncate(s: string | null, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function ResultRow({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  const navigate = useNavigate();

  const handleClick = () => {
    onClose();
    navigate(`/entries/${result.id}`);
  };

  const label = PLATFORM_LABELS[result.sourcePlatform] ?? 'WEB';
  const summary = result.results.summary ?? result.caption;
  const songCount = result.results.songs.length;
  const filmCount = result.results.films.length;
  const noteCount = result.results.notes.length;

  return (
    <button className="search-result-row" onClick={handleClick}>
      {result.thumbnailUrl ? (
        <img src={result.thumbnailUrl} alt="" className="search-result-thumb" loading="lazy" />
      ) : (
        <div className="search-result-thumb-placeholder">{label}</div>
      )}
      <div className="search-result-body">
        <div className="search-result-url">{truncate(result.sourceUrl, 60)}</div>
        {summary && (
          <div className="search-result-summary">{truncate(summary, 120)}</div>
        )}
        <div className="search-result-badges">
          {songCount > 0 && <span>♪ {songCount}</span>}
          {filmCount > 0 && <span>🎬 {filmCount}</span>}
          {noteCount > 0 && <span>📝 {noteCount}</span>}
          {result.results.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="search-result-tag">{tag}</span>
          ))}
        </div>
      </div>
    </button>
  );
}

interface SearchOverlayProps {
  query: string;
  onClose: () => void;
}

export function SearchOverlay({ query, onClose }: SearchOverlayProps) {
  const { results, expandedTerms, loading, error } = useSearch(query);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (query.trim().length < 2) return null;

  return (
    <div className="search-overlay">
      {loading && <div className="search-overlay-status">Ricerca in corso…</div>}
      {error && <div className="search-overlay-status search-overlay-error">Errore: {error}</div>}
      {!loading && !error && results.length === 0 && (
        <div className="search-overlay-status">Nessun risultato per "{query}"</div>
      )}
      {expandedTerms.length > 0 && (
        <div className="search-expanded-terms">
          Cercato anche: {expandedTerms.join(', ')}
        </div>
      )}
      <div className="search-results-list">
        {results.map((r) => (
          <ResultRow key={r.id} result={r} onClose={onClose} />
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/SearchOverlay.tsx
git commit -m "feat(search): SearchOverlay dropdown component"
```

---

### Task 7: Header Integration + CSS

**Files:**
- Modify: `frontend/src/components/Header.tsx`
- Modify: `frontend/src/styles/index.css`

**Interfaces:**
- Consumes: `<SearchOverlay query={string} onClose={() => void} />` from `./SearchOverlay`
- No interface changes to `HeaderProps` — search state is internal to Header

- [ ] **Step 1: Modify `frontend/src/components/Header.tsx`**

Replace full file content:

```typescript
import { useState, useCallback, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { JournalStats } from '../types';
import { useLanguage } from '../i18n';
import { SearchOverlay } from './SearchOverlay';

const APP_VERSION = __APP_VERSION__;
const GIT_REVISION = __GIT_REVISION__;

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const { t } = useLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleClose = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery('');
  }, []);

  // Click-outside on the wrapper div (covers both input + overlay)
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setSearchOpen(e.target.value.trim().length >= 2);
  };

  return (
    <header className="header">
      <div className="header-content">
        <div className="logo-wrapper">
          <Link to="/" className="logo">
            SoundReel
          </Link>
          <span className="version-badge" title={`build ${GIT_REVISION}`}>v{APP_VERSION}</span>
        </div>
        <div className="stats">
          <Link to="/entries" className="stat stat-link">{stats.totalEntries} {t.entries}</Link>
          <Link to="/songs" className="stat stat-link">{stats.totalSongs} {t.songs}</Link>
          <Link to="/films" className="stat stat-link">{stats.totalFilms} {t.films}</Link>
          <Link to="/notes" className="stat stat-link">{stats.totalNotes} {t.notes}</Link>
        </div>
        <div className="search-wrapper" ref={wrapperRef}>
          <input
            className="search-input"
            type="search"
            placeholder="Cerca…"
            value={searchQuery}
            onChange={handleSearchChange}
            onFocus={() => {
              if (searchQuery.trim().length >= 2) setSearchOpen(true);
            }}
            aria-label="Cerca tra i link salvati"
          />
          {searchOpen && (
            <SearchOverlay query={searchQuery} onClose={handleClose} />
          )}
        </div>
        <nav className="nav">
          <Link to="/console" className="nav-link">{t.console}</Link>
          <Link to="/prompts" className="nav-link">{t.aiPrompts}</Link>
          <Link to="/admin" className="nav-link">Admin</Link>
          <Link to="/settings" className="nav-link">{t.settings}</Link>
        </nav>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Add CSS to `frontend/src/styles/index.css`**

Append at the end of the file:

```css
/* Search */

.search-wrapper {
  position: relative;
  flex: 0 0 220px;
}

.search-input {
  width: 100%;
  padding: 0.4rem 0.75rem;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: 0.875rem;
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--accent);
}

.search-overlay {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  min-width: 360px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  z-index: 200;
  overflow: hidden;
}

.search-overlay-status {
  padding: 0.75rem 1rem;
  color: var(--text-muted);
  font-size: 0.875rem;
}

.search-overlay-error {
  color: var(--error, #f87171);
}

.search-expanded-terms {
  padding: 0.4rem 1rem;
  font-size: 0.75rem;
  color: var(--text-muted);
  border-bottom: 1px solid var(--border);
  font-style: italic;
}

.search-results-list {
  max-height: 420px;
  overflow-y: auto;
}

.search-result-row {
  display: flex;
  align-items: flex-start;
  gap: 0.75rem;
  width: 100%;
  padding: 0.75rem 1rem;
  background: none;
  border: none;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  text-align: left;
  transition: background 0.15s;
}

.search-result-row:last-child {
  border-bottom: none;
}

.search-result-row:hover {
  background: var(--bg-primary);
}

.search-result-thumb {
  width: 48px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}

.search-result-thumb-placeholder {
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  border-radius: var(--radius-sm);
  font-size: 0.65rem;
  font-weight: 700;
  color: var(--text-muted);
  flex-shrink: 0;
}

.search-result-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.search-result-url {
  font-size: 0.75rem;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.search-result-summary {
  font-size: 0.875rem;
  color: var(--text-primary);
  line-height: 1.4;
}

.search-result-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.search-result-tag {
  background: var(--accent-soft);
  color: var(--accent);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
}

@media (max-width: 768px) {
  .search-wrapper {
    flex: 1;
    min-width: 0;
  }
  .search-overlay {
    min-width: 0;
    left: -1rem;
    right: -1rem;
  }
}
```

- [ ] **Step 3: Verify TypeScript compiles**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Manual verification in browser**

Start dev servers:
```bash
# Terminal 1
cd backend && npm run dev
# Terminal 2
cd frontend && npm run dev
```

Open `http://localhost:5173`. Verify:
- Search input visible in header
- Typing < 2 chars: no overlay
- Typing a real word (e.g. `spotify`): overlay appears with results after ~400ms + Ollama latency
- "Cercato anche:" row shows expanded terms
- Click result: navigates to entry detail, overlay closes
- Esc key: closes overlay
- Click outside overlay: closes

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Header.tsx frontend/src/styles/index.css
git commit -m "feat(search): global search input in header with results overlay"
```

---

### Task 8: Deploy

- [ ] **Step 1: Trigger rebuild**

```bash
touch /home/mike/works/Soundreel/.rebuild
```

- [ ] **Step 2: Wait ~60s, verify deploy log**

```bash
cat /home/mike/works/Soundreel/.rebuild-log
```

Expected: successful build and container restart.

- [ ] **Step 3: Apply migration to production DB**

```bash
docker exec -i soundreel-db psql -U soundreel soundreel \
  < backend/src/db/migrations/001_search_vector.sql
```

Expected: `UPDATE N` where N = current entry count.

- [ ] **Step 4: Smoke test production**

```bash
curl "https://soundreel.casamon.dev/api/search?q=spotify"
```

Expected: JSON response with results.
