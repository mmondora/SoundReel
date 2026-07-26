# Film Ratings, Genres, Availability & Filters — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-film user state (watched, fresh/rotten rating + optional 0–100 score, per-service availability) plus TMDb enrichment (genres, overview, cast, score) with a deduplicated, filterable FilmsPage.

**Architecture:** New `film_meta` Postgres table keyed by `film_key` (normalized title+year). Entry JSONB untouched. New `/api/films` aggregation endpoint + PATCH for user state. TMDb detail call extended with credits. FilmsPage reworked into a dedup collection view with filters and one-tap actions.

**Tech Stack:** Fastify + pg (raw SQL), React + Vite, Vitest both sides. Spec: `docs/superpowers/specs/2026-07-26-film-ratings-and-filters-design.md`.

## Global Constraints

- TypeScript strict, no `any`; shared shapes in `types/index.ts` (both sides).
- No ORM — raw SQL via `query()` from `backend/src/utils/db.ts`.
- Tests: Vitest, mock all externals (TMDb, db) — no real network.
- Every pipeline failure logged, never fatal (project convention).
- i18n: every new UI string in both `it` and `en` in `frontend/src/i18n/translations.ts`.
- Dark theme, plain CSS, no component libraries.
- Availability values: `free | paid | absent`; rating values: `fresh | rotten`.
- Enrichment columns vs user-state columns of `film_meta` are never written by the same code path.

---

### Task 1: DB migration + shared types

**Files:**
- Create: `backend/src/db/migrations/002_film_meta.sql`
- Modify: `backend/src/db/init.sql` (append table)
- Modify: `backend/src/types/index.ts`
- Modify: `frontend/src/types/index.ts`

**Interfaces:**
- Produces: `film_meta` table; types `AvailabilityStatus`, `FilmUserMeta`, `FilmMetaRecord`, `AggregatedFilm` used by Tasks 2–5, 7–8.

- [ ] **Step 1: Write migration**

`backend/src/db/migrations/002_film_meta.sql`:

```sql
CREATE TABLE IF NOT EXISTS film_meta (
  film_key TEXT PRIMARY KEY,
  tmdb_id INTEGER,
  genres TEXT[] NOT NULL DEFAULT '{}',
  overview TEXT,
  film_cast TEXT[] NOT NULL DEFAULT '{}',
  tmdb_score NUMERIC(3,1),
  watched BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('fresh','rotten')),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  availability JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Append the same `CREATE TABLE IF NOT EXISTS` block at the end of `backend/src/db/init.sql` (fresh installs get it from init).

- [ ] **Step 2: Add backend types**

In `backend/src/types/index.ts`, after `TmdbSearchResult`:

```ts
export type AvailabilityStatus = 'free' | 'paid' | 'absent';

export interface FilmUserMeta {
  watched: boolean;
  rating: 'fresh' | 'rotten' | null;
  score: number | null;
  availability: Partial<Record<keyof StreamingUrls, AvailabilityStatus>>;
}

export interface FilmMetaRecord extends FilmUserMeta {
  filmKey: string;
  tmdbId: number | null;
  genres: string[];
  overview: string | null;
  cast: string[];
  tmdbScore: number | null;
}

export interface FilmMention {
  entryId: string;
  createdAt: string;
}

export interface AggregatedFilm {
  filmKey: string;
  title: string;
  director: string | null;
  year: string | null;
  imdbUrl: string | null;
  posterUrl: string | null;
  streamingUrls: StreamingUrls | null;
  mentions: FilmMention[];
  meta: FilmMetaRecord | null;
}
```

Extend `TmdbSearchResult` with:

```ts
  genres: string[];
  overview: string | null;
  cast: string[];
  voteAverage: number | null;
```

- [ ] **Step 3: Mirror types in frontend**

Copy the same five declarations (`AvailabilityStatus`, `FilmUserMeta`, `FilmMetaRecord`, `FilmMention`, `AggregatedFilm`) into `frontend/src/types/index.ts` after the `Film` interface. (Frontend has no `TmdbSearchResult`; skip that change there.)

- [ ] **Step 4: Typecheck both sides**

Run: `cd backend && npx tsc --noEmit && cd ../frontend && npx tsc --noEmit`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db backend/src/types frontend/src/types
git commit -m "feat(films): add film_meta table and shared film meta types"
```

---

### Task 2: filmMeta service (film_key + db access)

**Files:**
- Create: `backend/src/services/filmMeta.ts`
- Create: `backend/src/services/filmMeta.test.ts`

**Interfaces:**
- Consumes: `query` from `../utils/db`; types from Task 1.
- Produces:
  - `filmKey(title: string, year: string | null | undefined): string`
  - `upsertFilmEnrichment(input: { filmKey: string; tmdbId: number; genres: string[]; overview: string | null; cast: string[]; tmdbScore: number | null }): Promise<void>`
  - `patchFilmUserMeta(filmKey: string, patch: Partial<FilmUserMeta>): Promise<FilmMetaRecord>`
  - `listFilmMeta(): Promise<Map<string, FilmMetaRecord>>`

- [ ] **Step 1: Write failing tests for filmKey**

`backend/src/services/filmMeta.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn() }));

import { filmKey } from './filmMeta';

describe('filmKey', () => {
  it('lowercases and trims title, appends year', () => {
    expect(filmKey('  A Scanner Darkly ', '2006')).toBe('a scanner darkly::2006');
  });
  it('handles missing year', () => {
    expect(filmKey('Heat', null)).toBe('heat::');
    expect(filmKey('Heat', undefined)).toBe('heat::');
  });
  it('collapses internal whitespace', () => {
    expect(filmKey('The  Matrix', '1999')).toBe('the matrix::1999');
  });
  it('trims year', () => {
    expect(filmKey('Heat', ' 1995 ')).toBe('heat::1995');
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `cd backend && npx vitest run src/services/filmMeta.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement service**

`backend/src/services/filmMeta.ts`:

```ts
import { query } from '../utils/db';
import type { FilmMetaRecord, FilmUserMeta } from '../types';

export function filmKey(title: string, year: string | null | undefined): string {
  const t = title.trim().toLowerCase().replace(/\s+/g, ' ');
  const y = (year ?? '').trim();
  return `${t}::${y}`;
}

interface FilmMetaRow {
  film_key: string;
  tmdb_id: number | null;
  genres: string[];
  overview: string | null;
  film_cast: string[];
  tmdb_score: string | null;
  watched: boolean;
  rating: 'fresh' | 'rotten' | null;
  score: number | null;
  availability: FilmUserMeta['availability'];
}

function rowToRecord(row: FilmMetaRow): FilmMetaRecord {
  return {
    filmKey: row.film_key,
    tmdbId: row.tmdb_id,
    genres: row.genres,
    overview: row.overview,
    cast: row.film_cast,
    tmdbScore: row.tmdb_score === null ? null : Number(row.tmdb_score),
    watched: row.watched,
    rating: row.rating,
    score: row.score,
    availability: row.availability ?? {},
  };
}

const SELECT_COLS =
  'film_key, tmdb_id, genres, overview, film_cast, tmdb_score, watched, rating, score, availability';

export async function upsertFilmEnrichment(input: {
  filmKey: string;
  tmdbId: number;
  genres: string[];
  overview: string | null;
  cast: string[];
  tmdbScore: number | null;
}): Promise<void> {
  await query(
    `INSERT INTO film_meta (film_key, tmdb_id, genres, overview, film_cast, tmdb_score)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (film_key) DO UPDATE SET
       tmdb_id = EXCLUDED.tmdb_id,
       genres = EXCLUDED.genres,
       overview = EXCLUDED.overview,
       film_cast = EXCLUDED.film_cast,
       tmdb_score = EXCLUDED.tmdb_score,
       updated_at = now()`,
    [input.filmKey, input.tmdbId, input.genres, input.overview, input.cast, input.tmdbScore]
  );
}

export async function patchFilmUserMeta(
  key: string,
  patch: Partial<FilmUserMeta>
): Promise<FilmMetaRecord> {
  // Ensure the row exists, then apply only provided fields.
  await query(`INSERT INTO film_meta (film_key) VALUES ($1) ON CONFLICT (film_key) DO NOTHING`, [key]);

  const sets: string[] = [];
  const params: unknown[] = [key];

  if (patch.watched !== undefined) {
    params.push(patch.watched);
    sets.push(`watched = $${params.length}`);
  }
  if (patch.rating !== undefined) {
    params.push(patch.rating);
    sets.push(`rating = $${params.length}`);
    if (patch.rating !== null) sets.push('watched = true');
  }
  if (patch.score !== undefined) {
    params.push(patch.score);
    sets.push(`score = $${params.length}`);
    if (patch.score !== null) sets.push('watched = true');
  }
  if (patch.availability !== undefined) {
    // Merge per-key; explicit null removes the service key.
    const removals = Object.entries(patch.availability)
      .filter(([, v]) => v === null)
      .map(([k]) => k);
    const additions = Object.fromEntries(
      Object.entries(patch.availability).filter(([, v]) => v !== null)
    );
    params.push(JSON.stringify(additions));
    let expr = `availability || $${params.length}::jsonb`;
    for (const k of removals) {
      params.push(k);
      expr = `(${expr}) - $${params.length}`;
    }
    sets.push(`availability = ${expr}`);
  }

  sets.push('updated_at = now()');

  const rows = await query<FilmMetaRow>(
    `UPDATE film_meta SET ${sets.join(', ')} WHERE film_key = $1 RETURNING ${SELECT_COLS}`,
    params
  );
  return rowToRecord(rows[0]);
}

export async function listFilmMeta(): Promise<Map<string, FilmMetaRecord>> {
  const rows = await query<FilmMetaRow>(`SELECT ${SELECT_COLS} FROM film_meta`);
  return new Map(rows.map((r) => [r.film_key, rowToRecord(r)]));
}
```

Note on `patch.availability` typing: incoming JSON may carry `null` values to remove keys; type the route-side body as `Record<string, AvailabilityStatus | null>` (Task 4) and cast when calling — inside the service, `Partial<FilmUserMeta>` availability values may be `null` at runtime; the filter handles it. To keep strict typing honest, declare the patch parameter as:

```ts
export type FilmUserMetaPatch = Omit<Partial<FilmUserMeta>, 'availability'> & {
  availability?: Record<string, 'free' | 'paid' | 'absent' | null>;
};
```

and use `FilmUserMetaPatch` instead of `Partial<FilmUserMeta>` in `patchFilmUserMeta`. Export it.

- [ ] **Step 4: Add SQL-behavior tests (mocked query)**

Append to `filmMeta.test.ts`:

```ts
import { query } from '../utils/db';
import { patchFilmUserMeta, upsertFilmEnrichment } from './filmMeta';

const ROW = {
  film_key: 'heat::1995', tmdb_id: 949, genres: ['Thriller'], overview: 'x',
  film_cast: ['Al Pacino'], tmdb_score: '7.9', watched: false, rating: null,
  score: null, availability: {},
};

describe('patchFilmUserMeta', () => {
  it('setting rating forces watched = true', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([{ ...ROW, rating: 'fresh', watched: true }]);
    const rec = await patchFilmUserMeta('heat::1995', { rating: 'fresh' });
    const updateSql = vi.mocked(query).mock.calls[1][0];
    expect(updateSql).toContain('watched = true');
    expect(rec.watched).toBe(true);
  });

  it('availability merge adds and removes keys', async () => {
    vi.mocked(query).mockResolvedValueOnce([]).mockResolvedValueOnce([ROW]);
    await patchFilmUserMeta('heat::1995', {
      availability: { primeVideo: 'paid', netflix: null },
    });
    const [updateSql, params] = vi.mocked(query).mock.calls[1] as [string, unknown[]];
    expect(updateSql).toContain("availability ||");
    expect(params).toContain('{"primeVideo":"paid"}');
    expect(params).toContain('netflix');
  });
});

describe('upsertFilmEnrichment', () => {
  it('never touches user-state columns', async () => {
    vi.mocked(query).mockResolvedValueOnce([]);
    await upsertFilmEnrichment({
      filmKey: 'heat::1995', tmdbId: 949, genres: ['Thriller'],
      overview: 'x', cast: ['Al Pacino'], tmdbScore: 7.9,
    });
    const sql = vi.mocked(query).mock.calls[0][0];
    expect(sql).not.toMatch(/watched|rating|score|availability/);
  });
});
```

(`beforeEach` with `vi.clearAllMocks()` at describe top.)

- [ ] **Step 5: Run tests, verify pass**

Run: `cd backend && npx vitest run src/services/filmMeta.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/filmMeta.ts backend/src/services/filmMeta.test.ts
git commit -m "feat(films): filmMeta service with key normalization and meta persistence"
```

---

### Task 3: filmSearch enrichment capture

**Files:**
- Modify: `backend/src/services/filmSearch.ts`
- Create: `backend/src/services/filmSearch.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `searchFilm()` now returns extended `TmdbSearchResult` (Task 1 fields: `genres`, `overview`, `cast`, `voteAverage`).

- [ ] **Step 1: Write failing test**

`backend/src/services/filmSearch.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { searchFilm } from './filmSearch';

const SEARCH_RESPONSE = {
  results: [{ id: 949, title: 'Heat', release_date: '1995-12-15', poster_path: '/p.jpg' }],
};
const DETAILS_RESPONSE = {
  imdb_id: 'tt0113277',
  genres: [{ id: 28, name: 'Azione' }, { id: 80, name: 'Crime' }],
  overview: 'Un detective ossessionato...',
  vote_average: 7.916,
  credits: {
    cast: [
      { name: 'Al Pacino' }, { name: 'Robert De Niro' }, { name: 'Val Kilmer' },
      { name: 'Jon Voight' }, { name: 'Tom Sizemore' },
    ],
  },
};

describe('searchFilm', () => {
  beforeEach(() => {
    process.env.TMDB_API_KEY = 'test-key';
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: true, json: async () => DETAILS_RESPONSE }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TMDB_API_KEY;
  });

  it('captures genres, overview, top-4 cast and vote average', async () => {
    const result = await searchFilm('Heat', '1995');
    expect(result).not.toBeNull();
    expect(result?.genres).toEqual(['Azione', 'Crime']);
    expect(result?.overview).toBe('Un detective ossessionato...');
    expect(result?.cast).toEqual(['Al Pacino', 'Robert De Niro', 'Val Kilmer', 'Jon Voight']);
    expect(result?.voteAverage).toBe(7.9);
    expect(result?.imdbId).toBe('tt0113277');
  });

  it('requests credits and italian language on the details call', async () => {
    await searchFilm('Heat', '1995');
    const detailsUrl = vi.mocked(fetch).mock.calls[1][0] as string;
    expect(detailsUrl).toContain('append_to_response=credits');
    expect(detailsUrl).toContain('language=it-IT');
  });

  it('returns empty enrichment when the details call fails', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => SEARCH_RESPONSE })
      .mockResolvedValueOnce({ ok: false, status: 500 }));
    const result = await searchFilm('Heat', '1995');
    expect(result?.genres).toEqual([]);
    expect(result?.cast).toEqual([]);
    expect(result?.voteAverage).toBeNull();
    expect(result?.imdbId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, verify fail**

Run: `cd backend && npx vitest run src/services/filmSearch.test.ts`
Expected: FAIL (`genres` undefined etc.).

- [ ] **Step 3: Implement**

In `filmSearch.ts`, replace `TmdbMovieDetails` and `getImdbId` with:

```ts
interface TmdbMovieDetails {
  imdb_id: string | null;
  genres?: Array<{ id: number; name: string }>;
  overview?: string | null;
  vote_average?: number;
  credits?: { cast?: Array<{ name: string }> };
}

interface MovieDetails {
  imdbId: string | null;
  genres: string[];
  overview: string | null;
  cast: string[];
  voteAverage: number | null;
}

const EMPTY_DETAILS: MovieDetails = {
  imdbId: null, genres: [], overview: null, cast: [], voteAverage: null,
};

async function getMovieDetails(tmdbId: number, apiKey: string): Promise<MovieDetails> {
  try {
    const response = await fetch(
      `https://api.themoviedb.org/3/movie/${tmdbId}?api_key=${apiKey}&language=it-IT&append_to_response=credits`
    );
    if (!response.ok) return EMPTY_DETAILS;
    const data = (await response.json()) as TmdbMovieDetails;
    return {
      imdbId: data.imdb_id || null,
      genres: (data.genres ?? []).map((g) => g.name),
      overview: data.overview || null,
      cast: (data.credits?.cast ?? []).slice(0, 4).map((c) => c.name),
      voteAverage:
        typeof data.vote_average === 'number' ? Math.round(data.vote_average * 10) / 10 : null,
    };
  } catch {
    return EMPTY_DETAILS;
  }
}
```

In `searchFilm`, replace the `getImdbId` call and result construction:

```ts
    const movie = data.results[0];
    const details = await getMovieDetails(movie.id, apiKey);

    const result: TmdbSearchResult = {
      id: movie.id,
      title: movie.title,
      imdbId: details.imdbId,
      posterPath: movie.poster_path
        ? `https://image.tmdb.org/t/p/w200${movie.poster_path}`
        : null,
      releaseDate: movie.release_date || null,
      genres: details.genres,
      overview: details.overview,
      cast: details.cast,
      voteAverage: details.voteAverage,
    };
```

- [ ] **Step 4: Run tests + full backend suite**

Run: `cd backend && npx vitest run src/services/filmSearch.test.ts && npx vitest run`
Expected: PASS (other constructors of `TmdbSearchResult` in tests/mocks may need the new fields — fix them).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/filmSearch.ts backend/src/services/filmSearch.test.ts
git commit -m "feat(films): capture genres, overview, cast and score from TMDb"
```

---

### Task 4: analyze pipeline hook + films API routes

**Files:**
- Modify: `backend/src/routes/analyze.ts` (both `searchFilm` call sites, ~lines 731 and 748)
- Create: `backend/src/routes/films.ts`
- Create: `backend/src/routes/films.test.ts`
- Modify: `backend/src/server.ts` (register route)

**Interfaces:**
- Consumes: `filmKey`, `upsertFilmEnrichment`, `patchFilmUserMeta`, `listFilmMeta`, `FilmUserMetaPatch` (Task 2); `listEntries` from `../utils/db`; types from Task 1.
- Produces: `GET /api/films` → `{ films: AggregatedFilm[] }`; `PATCH /api/films/:filmKey` → `{ meta: FilmMetaRecord }`; `registerFilmsRoutes(app)`.

- [ ] **Step 1: Hook enrichment upsert into analyze.ts**

At both call sites, after a successful `searchFilm` result (`tmdbResult` non-null), add fire-and-forget upsert. Example for the ~731 site (adapt variable names at the second site):

```ts
        if (tmdbResult) {
          void upsertFilmEnrichment({
            filmKey: filmKey(filmData.title, filmData.year),
            tmdbId: tmdbResult.id,
            genres: tmdbResult.genres,
            overview: tmdbResult.overview,
            cast: tmdbResult.cast,
            tmdbScore: tmdbResult.voteAverage,
          }).catch((err) => logError('film_meta upsert failed', { err: String(err) }));
        }
```

Import `filmKey`, `upsertFilmEnrichment` from `../services/filmMeta`. Use the same title/year values the site already passes to `searchFilm`.

- [ ] **Step 2: Write failing route tests**

`backend/src/routes/films.test.ts` (follow `entries.test.ts` pattern):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => ({ listEntries: vi.fn() }));
vi.mock('../services/filmMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/filmMeta')>();
  return {
    filmKey: actual.filmKey,
    listFilmMeta: vi.fn(),
    patchFilmUserMeta: vi.fn(),
  };
});
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerFilmsRoutes } from './films';
import { listEntries } from '../utils/db';
import { listFilmMeta, patchFilmUserMeta } from '../services/filmMeta';

function buildApp() {
  const app = Fastify();
  registerFilmsRoutes(app);
  return app;
}

function entry(id: string, createdAt: string, films: unknown[]) {
  return { id, createdAt, results: { films } } as never;
}

const HEAT = { title: 'Heat', director: 'Michael Mann', year: '1995', imdbUrl: null, posterUrl: 'p.jpg', streamingUrls: null };

describe('GET /api/films', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dedups mentions of the same film across entries', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [HEAT]),
      entry('e2', '2026-07-02T00:00:00Z', [{ ...HEAT, title: ' heat ' }]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    const { films } = res.json();
    expect(films).toHaveLength(1);
    expect(films[0].filmKey).toBe('heat::1995');
    expect(films[0].mentions).toHaveLength(2);
  });

  it('display fields come from the most recent mention and meta is joined', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [{ ...HEAT, posterUrl: null }]),
      entry('e2', '2026-07-02T00:00:00Z', [HEAT]),
    ]);
    const meta = { filmKey: 'heat::1995', tmdbId: 949, genres: ['Thriller'], overview: null, cast: [], tmdbScore: 7.9, watched: true, rating: 'fresh', score: null, availability: {} };
    vi.mocked(listFilmMeta).mockResolvedValue(new Map([['heat::1995', meta as never]]));
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    const { films } = res.json();
    expect(films[0].posterUrl).toBe('p.jpg');
    expect(films[0].meta.rating).toBe('fresh');
  });

  it('skips malformed film objects without failing', async () => {
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-07-01T00:00:00Z', [null, { noTitle: true }, HEAT]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'GET', url: '/api/films' });
    expect(res.statusCode).toBe(200);
    expect(res.json().films).toHaveLength(1);
  });
});

describe('PATCH /api/films/:filmKey', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects invalid rating', async () => {
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/films/heat%3A%3A1995', payload: { rating: 'meh' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects out-of-range score and invalid availability values', async () => {
    const app = buildApp();
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { score: 101 } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'PATCH', url: '/api/films/k', payload: { availability: { netflix: 'cheap' } } })).statusCode).toBe(400);
  });

  it('passes valid patch through and returns updated meta', async () => {
    vi.mocked(patchFilmUserMeta).mockResolvedValue({ filmKey: 'heat::1995', watched: true } as never);
    const res = await buildApp().inject({
      method: 'PATCH', url: '/api/films/heat%3A%3A1995',
      payload: { rating: 'fresh', availability: { primeVideo: 'paid', netflix: null } },
    });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(patchFilmUserMeta)).toHaveBeenCalledWith('heat::1995', {
      rating: 'fresh', availability: { primeVideo: 'paid', netflix: null },
    });
    expect(res.json().meta.watched).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests, verify fail**

Run: `cd backend && npx vitest run src/routes/films.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement route**

`backend/src/routes/films.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import { filmKey, listFilmMeta, patchFilmUserMeta } from '../services/filmMeta';
import type { FilmUserMetaPatch } from '../services/filmMeta';
import type { AggregatedFilm, Film } from '../types';
import { logError } from '../utils/logger';

const RATINGS = new Set(['fresh', 'rotten']);
const AVAILABILITY = new Set(['free', 'paid', 'absent']);

function isFilm(value: unknown): value is Film {
  return (
    typeof value === 'object' && value !== null &&
    typeof (value as { title?: unknown }).title === 'string' &&
    (value as { title: string }).title.trim().length > 0
  );
}

export function registerFilmsRoutes(app: FastifyInstance): void {
  app.get('/api/films', async (_req, reply) => {
    try {
      const [entries, metaMap] = await Promise.all([listEntries(), listFilmMeta()]);
      const byKey = new Map<string, AggregatedFilm>();

      for (const entry of entries) {
        const films = entry.results?.films;
        if (!Array.isArray(films)) continue;
        for (const raw of films) {
          if (!isFilm(raw)) continue;
          const key = filmKey(raw.title, raw.year);
          const createdAt = String(entry.createdAt ?? '');
          const existing = byKey.get(key);
          if (!existing) {
            byKey.set(key, {
              filmKey: key,
              title: raw.title,
              director: raw.director ?? null,
              year: raw.year ?? null,
              imdbUrl: raw.imdbUrl ?? null,
              posterUrl: raw.posterUrl ?? null,
              streamingUrls: raw.streamingUrls ?? null,
              mentions: [{ entryId: entry.id, createdAt }],
              meta: metaMap.get(key) ?? null,
            });
          } else {
            existing.mentions.push({ entryId: entry.id, createdAt });
            // listEntries returns newest first; first-seen mention already has freshest fields.
          }
        }
      }

      return reply.send({ films: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/films failed', { err: String(err) });
      return reply.code(500).send({ error: 'films aggregation failed' });
    }
  });

  app.patch<{ Params: { filmKey: string }; Body: FilmUserMetaPatch }>(
    '/api/films/:filmKey',
    async (req, reply) => {
      const body = req.body ?? {};
      if (body.watched !== undefined && typeof body.watched !== 'boolean') {
        return reply.code(400).send({ error: 'watched must be boolean' });
      }
      if (body.rating !== undefined && body.rating !== null && !RATINGS.has(body.rating)) {
        return reply.code(400).send({ error: 'rating must be fresh|rotten|null' });
      }
      if (
        body.score !== undefined && body.score !== null &&
        (!Number.isInteger(body.score) || body.score < 0 || body.score > 100)
      ) {
        return reply.code(400).send({ error: 'score must be an integer 0-100 or null' });
      }
      if (body.availability !== undefined) {
        for (const value of Object.values(body.availability)) {
          if (value !== null && !AVAILABILITY.has(value)) {
            return reply.code(400).send({ error: 'availability values must be free|paid|absent|null' });
          }
        }
      }

      try {
        const meta = await patchFilmUserMeta(req.params.filmKey, body);
        return reply.send({ meta });
      } catch (err) {
        logError('PATCH /api/films failed', { filmKey: req.params.filmKey, err: String(err) });
        return reply.code(500).send({ error: 'film meta update failed' });
      }
    }
  );
}
```

Check `listEntries` ordering in `utils/db.ts`: if it is NOT newest-first, sort mentions and take display fields from the most recent mention instead of first-seen (test in Step 2 pins the behavior — make it pass honestly).

- [ ] **Step 5: Register in server.ts**

Add import + `registerFilmsRoutes(app);` next to the existing `register*Routes` calls.

- [ ] **Step 6: Run tests, verify pass; typecheck**

Run: `cd backend && npx vitest run src/routes/films.test.ts && npx tsc --noEmit`
Expected: PASS, clean.

- [ ] **Step 7: Commit**

```bash
git add backend/src/routes/films.ts backend/src/routes/films.test.ts backend/src/routes/analyze.ts backend/src/server.ts
git commit -m "feat(films): films aggregation API, user meta PATCH, pipeline enrichment hook"
```

---

### Task 5: Genre backfill script

**Files:**
- Create: `backend/src/scripts/backfillFilmMeta.ts`

**Interfaces:**
- Consumes: `listEntries` (db), `searchFilm` (Task 3), `filmKey`/`upsertFilmEnrichment`/`listFilmMeta` (Task 2).
- Produces: CLI script, `--dry-run` flag.

- [ ] **Step 1: Implement script**

`backend/src/scripts/backfillFilmMeta.ts` (mirror the structure of `backfillSlides.ts` — plain async main, console output, `process.exit`):

```ts
import { listEntries } from '../utils/db';
import { searchFilm } from '../services/filmSearch';
import { filmKey, listFilmMeta, upsertFilmEnrichment } from '../services/filmMeta';
import type { Film } from '../types';

const DRY_RUN = process.argv.includes('--dry-run');
const DELAY_MS = 250;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const entries = await listEntries();
  const existing = await listFilmMeta();

  const targets = new Map<string, { title: string; year: string | null }>();
  for (const entry of entries) {
    const films = entry.results?.films;
    if (!Array.isArray(films)) continue;
    for (const film of films as Film[]) {
      if (!film || typeof film.title !== 'string' || !film.title.trim()) continue;
      const key = filmKey(film.title, film.year);
      const meta = existing.get(key);
      if (meta && meta.genres.length > 0) continue; // already enriched
      if (!targets.has(key)) targets.set(key, { title: film.title.trim(), year: film.year ?? null });
    }
  }

  console.log(`${targets.size} films to enrich${DRY_RUN ? ' (dry-run)' : ''}`);
  let ok = 0;
  let miss = 0;

  for (const [key, film] of targets) {
    if (DRY_RUN) {
      console.log(`[dry-run] ${key}`);
      continue;
    }
    const tmdb = await searchFilm(film.title, film.year);
    if (!tmdb || (tmdb.genres.length === 0 && !tmdb.overview)) {
      console.log(`MISS  ${key}`);
      miss++;
    } else {
      await upsertFilmEnrichment({
        filmKey: key,
        tmdbId: tmdb.id,
        genres: tmdb.genres,
        overview: tmdb.overview,
        cast: tmdb.cast,
        tmdbScore: tmdb.voteAverage,
      });
      console.log(`OK    ${key} [${tmdb.genres.join(', ')}]`);
      ok++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`Done: ${ok} enriched, ${miss} misses, ${targets.size} total`);
  process.exit(0);
}

main().catch((err) => {
  console.error('backfill failed', err);
  process.exit(1);
});
```

- [ ] **Step 2: Typecheck + dry-run smoke locally if db reachable**

Run: `cd backend && npx tsc --noEmit`
Expected: clean. (Real run happens in production after deploy; script hits real TMDb — that is its purpose, not a test.)

- [ ] **Step 3: Commit**

```bash
git add backend/src/scripts/backfillFilmMeta.ts
git commit -m "feat(films): backfill script for TMDb film enrichment"
```

---

### Task 6: Frontend API client + filter logic module

**Files:**
- Modify: `frontend/src/services/api.ts`
- Create: `frontend/src/utils/filmFilters.ts`
- Create: `frontend/src/utils/filmFilters.test.ts`

**Interfaces:**
- Consumes: `AggregatedFilm`, `FilmMetaRecord`, `FilmUserMeta`, `AvailabilityStatus` types (Task 1).
- Produces:
  - `fetchFilms(): Promise<AggregatedFilm[]>`
  - `patchFilmMeta(filmKey: string, patch: FilmMetaPatchBody): Promise<FilmMetaRecord>` where `FilmMetaPatchBody = { watched?: boolean; rating?: 'fresh'|'rotten'|null; score?: number|null; availability?: Record<string, AvailabilityStatus|null> }`
  - `type WatchedFilter = 'all' | 'watched' | 'unwatched'`
  - `type AvailabilityFilter = 'all' | 'free' | 'notfree'`
  - `filterFilms(films: AggregatedFilm[], opts: { genres: string[]; watched: WatchedFilter; availability: AvailabilityFilter }): AggregatedFilm[]`
  - `collectGenres(films: AggregatedFilm[]): string[]`

- [ ] **Step 1: Write failing filter tests**

`frontend/src/utils/filmFilters.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { filterFilms, collectGenres } from './filmFilters';
import type { AggregatedFilm } from '../types';

function film(key: string, meta: Partial<NonNullable<AggregatedFilm['meta']>> | null): AggregatedFilm {
  return {
    filmKey: key, title: key, director: null, year: null, imdbUrl: null,
    posterUrl: null, streamingUrls: null, mentions: [],
    meta: meta === null ? null : {
      filmKey: key, tmdbId: null, genres: [], overview: null, cast: [],
      tmdbScore: null, watched: false, rating: null, score: null, availability: {},
      ...meta,
    },
  };
}

const FILMS = [
  film('a', { genres: ['Thriller'], watched: true, availability: { netflix: 'free' } }),
  film('b', { genres: ['Fantascienza', 'Thriller'], availability: { primeVideo: 'paid' } }),
  film('c', null),
];

describe('filterFilms', () => {
  it('no filters returns everything', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'all' })).toHaveLength(3);
  });
  it('genre filter is OR across selected genres', () => {
    const out = filterFilms(FILMS, { genres: ['Fantascienza'], watched: 'all', availability: 'all' });
    expect(out.map((f) => f.filmKey)).toEqual(['b']);
  });
  it('watched / unwatched split; missing meta counts as unwatched', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'watched', availability: 'all' }).map((f) => f.filmKey)).toEqual(['a']);
    expect(filterFilms(FILMS, { genres: [], watched: 'unwatched', availability: 'all' }).map((f) => f.filmKey)).toEqual(['b', 'c']);
  });
  it('availability free = at least one service marked free', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'free' }).map((f) => f.filmKey)).toEqual(['a']);
  });
  it('availability notfree = has marks but none free', () => {
    expect(filterFilms(FILMS, { genres: [], watched: 'all', availability: 'notfree' }).map((f) => f.filmKey)).toEqual(['b']);
  });
});

describe('collectGenres', () => {
  it('unique sorted genre list', () => {
    expect(collectGenres(FILMS)).toEqual(['Fantascienza', 'Thriller']);
  });
});
```

- [ ] **Step 2: Run tests, verify fail**

Run: `cd frontend && npx vitest run src/utils/filmFilters.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement filters**

`frontend/src/utils/filmFilters.ts`:

```ts
import type { AggregatedFilm } from '../types';

export type WatchedFilter = 'all' | 'watched' | 'unwatched';
export type AvailabilityFilter = 'all' | 'free' | 'notfree';

export interface FilmFilterOptions {
  genres: string[];
  watched: WatchedFilter;
  availability: AvailabilityFilter;
}

export function filterFilms(films: AggregatedFilm[], opts: FilmFilterOptions): AggregatedFilm[] {
  return films.filter((film) => {
    if (opts.genres.length > 0) {
      const genres = film.meta?.genres ?? [];
      if (!opts.genres.some((g) => genres.includes(g))) return false;
    }
    if (opts.watched !== 'all') {
      const watched = film.meta?.watched ?? false;
      if (opts.watched === 'watched' && !watched) return false;
      if (opts.watched === 'unwatched' && watched) return false;
    }
    if (opts.availability !== 'all') {
      const statuses = Object.values(film.meta?.availability ?? {});
      const hasFree = statuses.includes('free');
      if (opts.availability === 'free' && !hasFree) return false;
      if (opts.availability === 'notfree' && (hasFree || statuses.length === 0)) return false;
    }
    return true;
  });
}

export function collectGenres(films: AggregatedFilm[]): string[] {
  const set = new Set<string>();
  for (const film of films) for (const g of film.meta?.genres ?? []) set.add(g);
  return [...set].sort((a, b) => a.localeCompare(b));
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd frontend && npx vitest run src/utils/filmFilters.test.ts`
Expected: PASS.

- [ ] **Step 5: Add API client functions**

Append to `frontend/src/services/api.ts` (uses existing `url()` + `json()` helpers; import `AggregatedFilm`, `FilmMetaRecord`, `AvailabilityStatus` from `../types`):

```ts
// --- Films ---

export interface FilmMetaPatchBody {
  watched?: boolean;
  rating?: 'fresh' | 'rotten' | null;
  score?: number | null;
  availability?: Record<string, AvailabilityStatus | null>;
}

export async function fetchFilms(): Promise<AggregatedFilm[]> {
  const res = await fetch(url('/api/films'));
  const data = await json<{ films: AggregatedFilm[] }>(res);
  return data.films;
}

export async function patchFilmMeta(
  filmKey: string,
  patch: FilmMetaPatchBody
): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}
```

- [ ] **Step 6: Typecheck + commit**

Run: `cd frontend && npx tsc --noEmit`

```bash
git add frontend/src/services/api.ts frontend/src/utils/filmFilters.ts frontend/src/utils/filmFilters.test.ts
git commit -m "feat(films): frontend films API client and filter logic"
```

---

### Task 7: FilmsPage rework (UI)

**Files:**
- Modify: `frontend/src/pages/FilmsPage.tsx` (full rewrite)
- Modify: `frontend/src/i18n/translations.ts`
- Modify: frontend stylesheet (locate the file that defines `.list-item-row` / `.badge-link`, likely under `frontend/src/styles/`; append there)

**Interfaces:**
- Consumes: `fetchFilms`, `patchFilmMeta`, `FilmMetaPatchBody` (Task 6); `filterFilms`, `collectGenres`, `WatchedFilter`, `AvailabilityFilter` (Task 6); types (Task 1).
- Produces: user-facing page; no exports consumed elsewhere.

- [ ] **Step 1: Add i18n strings**

In `frontend/src/i18n/translations.ts` add to the interface and both locales:

```ts
  filmsFilterAll: string;        // it: 'Tutti'            en: 'All'
  filmsFilterWatched: string;    // it: 'Visti'            en: 'Watched'
  filmsFilterUnwatched: string;  // it: 'Non visti'        en: 'Unwatched'
  filmsFilterFree: string;       // it: 'Gratis'           en: 'Free'
  filmsFilterNotFree: string;    // it: 'Non gratis'       en: 'Not free'
  filmsMentions: string;         // it: 'menzioni'         en: 'mentions'
  filmsMarkFresh: string;        // it: 'Fresco'           en: 'Fresh'
  filmsMarkRotten: string;       // it: 'Marcio'           en: 'Rotten'
  filmsMarkWatched: string;      // it: 'Segna come visto' en: 'Mark as watched'
  filmsScorePlaceholder: string; // it: '%'                en: '%'
  filmsAvailabilityHint: string; // it: 'Disponibilità: click sul punto per cambiare stato' en: 'Availability: click the dot to cycle status'
  filmsTmdbScore: string;        // it: 'Voto TMDb'        en: 'TMDb score'
```

- [ ] **Step 2: Rewrite FilmsPage**

Replace `frontend/src/pages/FilmsPage.tsx` with the dedup collection view. Structure (full component, key parts shown — implementer writes the complete file):

```tsx
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Header } from '../components/Header';
import { fetchFilms, patchFilmMeta } from '../services/api';
import type { FilmMetaPatchBody } from '../services/api';
import { filterFilms, collectGenres } from '../utils/filmFilters';
import type { WatchedFilter, AvailabilityFilter } from '../utils/filmFilters';
import { useLanguage } from '../i18n';
import type { AggregatedFilm, AvailabilityStatus, JournalStats, StreamingUrls } from '../types';

const SERVICES: Array<{ key: keyof StreamingUrls; label: string; className: string }> = [
  { key: 'netflix', label: 'Netflix', className: 'netflix' },
  { key: 'primeVideo', label: 'Prime', className: 'prime' },
  { key: 'raiPlay', label: 'Rai', className: 'raiplay' },
  { key: 'now', label: 'NOW', className: 'now' },
  { key: 'disneyPlus', label: 'D+', className: 'disney' },
  { key: 'appleTv', label: 'TV', className: 'appletv' },
];

const AVAILABILITY_CYCLE: Array<AvailabilityStatus | null> = [null, 'free', 'paid', 'absent'];

export function FilmsPage() {
  const [films, setFilms] = useState<AggregatedFilm[]>([]);
  const [loading, setLoading] = useState(true);
  const [genreFilter, setGenreFilter] = useState<string[]>([]);
  const [watchedFilter, setWatchedFilter] = useState<WatchedFilter>('all');
  const [availabilityFilter, setAvailabilityFilter] = useState<AvailabilityFilter>('all');
  const [scoreEditing, setScoreEditing] = useState<string | null>(null);
  const { t } = useLanguage();

  useEffect(() => {
    fetchFilms().then(setFilms).catch(() => setFilms([])).finally(() => setLoading(false));
  }, []);

  const genres = useMemo(() => collectGenres(films), [films]);
  const visible = useMemo(
    () => filterFilms(films, { genres: genreFilter, watched: watchedFilter, availability: availabilityFilter }),
    [films, genreFilter, watchedFilter, availabilityFilter]
  );

  // Optimistic patch: apply locally, PATCH, roll back on failure.
  async function applyPatch(filmKey: string, patch: FilmMetaPatchBody) { /* see below */ }

  ...
}
```

`applyPatch` behavior (implement exactly):
1. Snapshot current `films` state.
2. `setFilms` with the patch merged into the target film's `meta` locally (create a default meta object if `meta` is null; rating/score non-null ⇒ `watched: true`; availability keys with `null` value removed, others set).
3. `await patchFilmMeta(filmKey, patch)`; on success, replace that film's `meta` with the server record. On error, restore the snapshot.

Row rendering (per visible film):
- Poster (or 🎬 placeholder), title + year + director.
- `meta.tmdbScore != null` → `<span className="film-score" title={t.filmsTmdbScore}>★ {meta.tmdbScore.toFixed(1)}</span>`.
- Genre badges: `meta.genres.map(g => <span className="genre-badge">{g}</span>)`.
- Overview: `<p className="film-overview">{meta.overview}</p>` (CSS clamps to 2 lines).
- Cast: `<div className="film-cast">{meta.cast.join(', ')}</div>`.
- Rating controls:
  ```tsx
  <button className={`rating-btn ${meta?.rating === 'fresh' ? 'active' : ''}`}
    title={t.filmsMarkFresh}
    onClick={() => applyPatch(film.filmKey, { rating: meta?.rating === 'fresh' ? null : 'fresh' })}>🍅</button>
  <button className={`rating-btn ${meta?.rating === 'rotten' ? 'active' : ''}`}
    title={t.filmsMarkRotten}
    onClick={() => applyPatch(film.filmKey, { rating: meta?.rating === 'rotten' ? null : 'rotten' })}>🤢</button>
  ```
- Watched eye toggle: `👁` button, `active` when `meta?.watched`, `onClick` → `applyPatch(film.filmKey, { watched: !(meta?.watched ?? false) })`, title `t.filmsMarkWatched`.
- Score: when rating set, show small `%` button → `setScoreEditing(film.filmKey)`; when `scoreEditing === film.filmKey` render `<input type="number" min={0} max={100}>` that PATCHes score on Enter/blur then `setScoreEditing(null)`. Display `meta.score != null → \`${meta.score}%\``.
- Streaming badges: keep existing `<a className="badge-link ...">` links (from `film.streamingUrls`); after each, availability dot:
  ```tsx
  <button
    className={`avail-dot ${meta?.availability?.[svc.key] ?? 'unknown'}`}
    title={t.filmsAvailabilityHint}
    onClick={() => {
      const current = meta?.availability?.[svc.key] ?? null;
      const next = AVAILABILITY_CYCLE[(AVAILABILITY_CYCLE.indexOf(current) + 1) % AVAILABILITY_CYCLE.length];
      applyPatch(film.filmKey, { availability: { [svc.key]: next } });
    }}
  />
  ```
- Mentions: `<Link to={`/?entry=${film.mentions[0].entryId}`}>×{film.mentions.length} {t.filmsMentions}</Link>`.

Filter bar above the list:
- Genre chips: one button per genre from `genres`; click toggles membership in `genreFilter`; `active` class when selected.
- Watched segmented control: three buttons (`t.filmsFilterAll` / `t.filmsFilterWatched` / `t.filmsFilterUnwatched`).
- Availability segmented control: three buttons (`t.filmsFilterAll` / `t.filmsFilterFree` / `t.filmsFilterNotFree`).

Keep `Header stats` behavior: compute `JournalStats`-shaped object from mentions counts (`totalFilms: films.reduce((a, f) => a + f.mentions.length, 0)`; other totals 0 are acceptable only if Header renders them conditionally — otherwise keep using `useAllEntries()` solely for stats as today).

Sort order: `meta.tmdbScore` desc? No — keep stable, sort by most recent mention date desc (mentions[0].createdAt).

- [ ] **Step 3: Add CSS**

Append to the stylesheet that already defines `.list-item-row`:

```css
.films-filter-bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; align-items: center; }
.genre-chip { background: none; border: 1px solid var(--border, #333); border-radius: 999px; padding: 2px 10px; font-size: 12px; color: inherit; cursor: pointer; }
.genre-chip.active { border-color: #e50914; color: #fff; background: rgba(229, 9, 20, 0.15); }
.filter-segment { display: inline-flex; border: 1px solid var(--border, #333); border-radius: 6px; overflow: hidden; }
.filter-segment button { background: none; border: none; padding: 4px 10px; font-size: 12px; color: inherit; cursor: pointer; }
.filter-segment button.active { background: rgba(255, 255, 255, 0.12); }
.film-score { font-size: 12px; color: #f5c518; margin-left: 6px; }
.genre-badge { font-size: 11px; border: 1px solid var(--border, #333); border-radius: 4px; padding: 1px 6px; margin-right: 4px; opacity: 0.8; }
.film-overview { font-size: 12px; opacity: 0.7; margin: 4px 0; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.film-cast { font-size: 11px; opacity: 0.6; }
.rating-btn { background: none; border: none; font-size: 18px; cursor: pointer; opacity: 0.35; padding: 2px; }
.rating-btn.active { opacity: 1; transform: scale(1.15); }
.score-input { width: 52px; background: #1a1a1a; color: inherit; border: 1px solid #444; border-radius: 4px; padding: 2px 4px; }
.avail-dot { width: 10px; height: 10px; border-radius: 50%; border: 1px solid #555; background: transparent; cursor: pointer; padding: 0; margin-left: 2px; }
.avail-dot.free { background: #2ecc71; border-color: #2ecc71; }
.avail-dot.paid { background: #f1c40f; border-color: #f1c40f; }
.avail-dot.absent { background: #e74c3c; border-color: #e74c3c; opacity: 0.5; }
```

Adjust selectors/variables to match the actual stylesheet conventions found in the file.

- [ ] **Step 4: Typecheck + full frontend tests**

Run: `cd frontend && npx tsc --noEmit && npx vitest run`
Expected: clean, all pass.

- [ ] **Step 5: Manual smoke via dev server (optional if backend reachable)**

`cd frontend && npm run dev` — verify page renders, filters act, tap 🍅 issues PATCH (network tab).

- [ ] **Step 6: Commit**

```bash
git add frontend/src/pages/FilmsPage.tsx frontend/src/i18n/translations.ts frontend/src/styles
git commit -m "feat(films): dedup films page with ratings, filters and availability"
```

---

### Task 8: Full verification + deploy + production backfill

**Files:** none new.

- [ ] **Step 1: Full suites both sides**

Run: `cd backend && npx vitest run && npx tsc --noEmit && cd ../frontend && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 2: Merge to main (if on worktree branch) and push**

Follow superpowers:finishing-a-development-branch.

- [ ] **Step 3: Apply migration in production**

```bash
docker exec -i soundreel-db psql -U soundreel -d soundreel < backend/src/db/migrations/002_film_meta.sql
```

- [ ] **Step 4: Deploy**

```bash
touch /home/mike/works/Soundreel/.rebuild
# after ~60s
cat /home/mike/works/Soundreel/.rebuild-log
```

- [ ] **Step 5: Run backfill in production container**

```bash
docker compose exec soundreel node dist/scripts/backfillFilmMeta.js --dry-run
docker compose exec soundreel node dist/scripts/backfillFilmMeta.js
```

(Verify the compiled script path in the image — adjust to actual build output layout, check how existing scripts like `backfillSlides` are invoked in production and use the same invocation style.)

- [ ] **Step 6: Verify live**

`curl -s https://soundreel.casamon.dev/api/films | head -c 2000` — films carry `meta.genres`; open FilmsPage, tap a rating, reload, state persists.
