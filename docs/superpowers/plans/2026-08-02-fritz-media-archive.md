# Fritz Media Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SoundReel's music library, public-domain films, and a film catalogue playable from the FRITZ!Box DLNA server by syncing them nightly to its USB stick.

**Architecture:** The GEEKOM stays the source of truth. A nightly bash script mounts the Fritz over SMB3 and rsyncs into dedicated `SoundReel/` subdirectories of the existing Tesla media stick. Inside SoundReel, a new Internet Archive enrichment provider (same blueprint as book/place/wiki) flags films available in the public domain, a manual per-film download writes them to `/home/mike/Films`, and an HTML export renders the whole film list with platform links.

**Tech Stack:** Node 20 + Fastify + TypeScript (backend), React + Vite (frontend), PostgreSQL 17 (direct `pg` queries, no ORM), Vitest, bash + systemd timer + cifs-utils (sync).

## Global Constraints

- TypeScript strict mode; no `any`. Types live in `backend/src/types/index.ts` and `frontend/src/types/index.ts` (kept in sync by hand).
- No ORM — direct SQL through the `query()` helper in `backend/src/utils/db.ts`.
- Tests never call real external services. Internet Archive is always mocked (project rule: no live calls to external sources in tests).
- Every pipeline step is independent: a failure is logged and the rest continues.
- Secrets come from env vars, never hardcoded, never committed.
- Fritz host is the IP `192.168.178.10` — never the hostname `fritz.box`, which resolves to an unreachable public IPv6 from this network.
- SMB share is `FRITZ.NAS`, dialect `vers=3.0` (SMB1 is disabled on the box).
- Sync destinations are `TESLA_MEDIA/Music/SoundReel/` and `TESLA_MEDIA/Movies/SoundReel/` — never the parent directories, which hold the car's existing library.
- Migration number is **008** (`007` is claimed by the in-flight wiki-enrichment branch). `init.sql` must be updated in the same task so a fresh database matches a migrated one.
- Commit messages: Conventional Commits, body explains *why*.

---

### Task 1: Internet Archive enrichment service

**Files:**
- Create: `backend/src/services/archiveEnrichment.ts`
- Test: `backend/src/services/archiveEnrichment.test.ts`

**Interfaces:**
- Consumes: `isAcceptedMatch(title: string, query: string): boolean` and `cleanQuery(text: string): string` from `./bookEnrichment`; `safeUrl(u: unknown): string | null` from `./songEnrichment`; `logInfo`/`logWarning` from `../utils/logger`.
- Produces:
  - `export interface ArchiveEnrichmentResult { identifier: string; title: string; year: string | null; pageUrl: string; fileUrl: string | null; }`
  - `export type ArchiveEnrichmentOutcome = { status: 'hit'; result: ArchiveEnrichmentResult } | { status: 'miss' } | { status: 'error' };`
  - `export async function enrichFilmFromArchive(title: string, year: string | null): Promise<ArchiveEnrichmentOutcome>`

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/archiveEnrichment.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn() }));

import { enrichFilmFromArchive } from './archiveEnrichment';

const originalFetch = global.fetch;

function searchResponse(docs: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ response: { numFound: docs.length, docs } }),
  } as Response;
}

function metadataResponse(files: unknown[]) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ files }),
  } as Response;
}

describe('enrichFilmFromArchive', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('returns a hit with page and file URLs for a confident title+year match', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'night_of_the_living_dead', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([
        { name: 'nightlivingdead.mp4', format: 'h.264', size: '900000000' },
      ]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');

    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.identifier).toBe('night_of_the_living_dead');
    expect(outcome.result.year).toBe('1968');
    expect(outcome.result.pageUrl).toBe('https://archive.org/details/night_of_the_living_dead');
    expect(outcome.result.fileUrl).toBe(
      'https://archive.org/download/night_of_the_living_dead/nightlivingdead.mp4'
    );
  });

  it('rejects a doc whose title does not match the query', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'something_else', title: 'A Totally Different Film', year: '1968' },
    ]));

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('miss');
  });

  it('rejects a title match whose year is off by more than one', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([
      { identifier: 'wrong_year', title: 'Night of the Living Dead', year: '1990' },
    ]));

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('miss');
  });

  it('accepts a year off by one (Archive metadata is inconsistent about release vs upload year)', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'off_by_one', title: 'Night of the Living Dead', year: '1969' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'film.mp4', format: 'h.264', size: '100' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
  });

  it('returns a miss when the search finds nothing', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(searchResponse([]));
    const outcome = await enrichFilmFromArchive('Obscure Nonexistent Film', '1970');
    expect(outcome.status).toBe('miss');
  });

  it('returns a hit with a null fileUrl when no playable file is present', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'audio_only', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'notes.txt', format: 'Text', size: '10' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.fileUrl).toBeNull();
  });

  it('prefers the largest mp4 when several are present', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'multi', title: 'Night of the Living Dead', year: '1968' },
      ]))
      .mockResolvedValueOnce(metadataResponse([
        { name: 'small.mp4', format: 'h.264', size: '100' },
        { name: 'big.mp4', format: 'h.264', size: '900' },
      ]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('hit');
    if (outcome.status !== 'hit') return;
    expect(outcome.result.fileUrl).toContain('big.mp4');
  });

  it('returns an error status on a non-2xx search response', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 503 } as Response);
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('returns an error status when the response body is not valid JSON', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('bad json'); },
    } as unknown as Response);
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('returns an error status when fetch itself rejects', async () => {
    global.fetch = vi.fn().mockRejectedValueOnce(new Error('network down'));
    const outcome = await enrichFilmFromArchive('Night of the Living Dead', '1968');
    expect(outcome.status).toBe('error');
  });

  it('falls back to a cleaned query on a first-pass miss', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([]))
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'metropolis', title: 'Metropolis', year: '1927' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'metropolis.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Metropolis - restored edition', '1927');
    expect(outcome.status).toBe('hit');
    expect(fetchMock.mock.calls.length).toBe(3);
  });

  it('searches without a year filter when the film has no year', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(searchResponse([
        { identifier: 'noyear', title: 'Nosferatu', year: '1922' },
      ]))
      .mockResolvedValueOnce(metadataResponse([{ name: 'n.mp4', format: 'h.264', size: '5' }]));
    global.fetch = fetchMock;

    const outcome = await enrichFilmFromArchive('Nosferatu', null);
    expect(outcome.status).toBe('hit');
    const firstUrl = String(fetchMock.mock.calls[0][0]);
    expect(firstUrl).not.toContain('year');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/services/archiveEnrichment.test.ts`
Expected: FAIL — cannot find module `./archiveEnrichment`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/archiveEnrichment.ts`:

```typescript
import { logInfo, logWarning } from '../utils/logger';
import { isAcceptedMatch, cleanQuery } from './bookEnrichment';
import { safeUrl } from './songEnrichment';

export interface ArchiveEnrichmentResult {
  identifier: string;
  title: string;
  year: string | null;
  pageUrl: string;
  fileUrl: string | null;
}

/** Mirrors the miss/error distinction the other enrichment providers expose,
 * so a backfill can tell "no public-domain copy exists" from "Archive is
 * down" and avoid tripping its consecutive-error abort on ordinary misses. */
export type ArchiveEnrichmentOutcome =
  | { status: 'hit'; result: ArchiveEnrichmentResult }
  | { status: 'miss' }
  | { status: 'error' };

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const REQUEST_TIMEOUT_MS = 15_000;

/** Archive.org asks identified traffic to carry a descriptive User-Agent with
 * a contact, same policy shape as Nominatim. */
const USER_AGENT = `SoundReel/${process.env.npm_package_version ?? '2.5'} (personal journal app; contact: mmondora@mondora.com)`;

interface ArchiveDoc {
  identifier?: unknown;
  title?: unknown;
  year?: unknown;
}

interface ArchiveFile {
  name?: unknown;
  format?: unknown;
  size?: unknown;
}

/** Archive metadata is user-supplied and inconsistent about release year vs
 * upload year, so a one-year drift is tolerated; anything wider is treated as
 * a different film. */
function yearMatches(docYear: unknown, wanted: string | null): boolean {
  if (!wanted) return true;
  const a = Number(String(docYear ?? '').slice(0, 4));
  const b = Number(wanted.slice(0, 4));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1;
}

function selectDoc(docs: ArchiveDoc[], query: string, year: string | null): ArchiveDoc | null {
  return (
    docs.find(
      (doc) =>
        typeof doc.title === 'string' &&
        typeof doc.identifier === 'string' &&
        isAcceptedMatch(doc.title, query) &&
        yearMatches(doc.year, year)
    ) ?? null
  );
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`archive.org ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchUrl(title: string, year: string | null): string {
  const clauses = [`title:("${title.replace(/"/g, '')}")`, 'mediatype:(movies)'];
  if (year) clauses.push(`year:[${Number(year) - 1} TO ${Number(year) + 1}]`);
  const params = new URLSearchParams({
    q: clauses.join(' AND '),
    rows: '10',
    output: 'json',
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'year');
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/** Picks the largest playable file: Archive items routinely carry several
 * encodes plus non-video derivatives, and the biggest mp4 is the full-quality
 * one rather than a preview. */
function selectFileUrl(identifier: string, files: ArchiveFile[]): string | null {
  const playable = files
    .filter((f) => typeof f.name === 'string' && /\.(mp4|m4v)$/i.test(f.name))
    .map((f) => ({ name: String(f.name), size: Number(f.size ?? 0) }))
    .sort((a, b) => b.size - a.size);
  if (playable.length === 0) return null;
  return safeUrl(`https://archive.org/download/${encodeURIComponent(identifier)}/${playable[0].name}`);
}

async function searchOnce(query: string, year: string | null): Promise<ArchiveDoc | null> {
  const payload = (await getJson(buildSearchUrl(query, year))) as {
    response?: { docs?: ArchiveDoc[] };
  };
  const docs = payload?.response?.docs ?? [];
  return selectDoc(docs, query, year);
}

/**
 * Looks up a film on Internet Archive. Two passes, mirroring bookEnrichment:
 * the raw title first, then a cleaned form for titles carrying edition or
 * subtitle noise.
 */
export async function enrichFilmFromArchive(
  title: string,
  year: string | null
): Promise<ArchiveEnrichmentOutcome> {
  const raw = title.trim();
  if (!raw) return { status: 'miss' };

  try {
    let doc = await searchOnce(raw, year);

    if (!doc) {
      const cleaned = cleanQuery(raw);
      if (cleaned && cleaned !== raw) {
        doc = await searchOnce(cleaned, year);
      }
    }

    if (!doc) {
      logInfo('archive.org: nessun match', { title: raw, year });
      return { status: 'miss' };
    }

    const identifier = String(doc.identifier);
    const metadata = (await getJson(`${METADATA_ENDPOINT}/${encodeURIComponent(identifier)}`)) as {
      files?: ArchiveFile[];
    };
    const fileUrl = selectFileUrl(identifier, metadata?.files ?? []);
    const pageUrl = safeUrl(`https://archive.org/details/${encodeURIComponent(identifier)}`);

    if (!pageUrl) return { status: 'miss' };

    logInfo('archive.org: match trovato', { title: raw, identifier, hasFile: !!fileUrl });
    return {
      status: 'hit',
      result: {
        identifier,
        title: String(doc.title),
        year: doc.year != null ? String(doc.year) : null,
        pageUrl,
        fileUrl,
      },
    };
  } catch (err) {
    logWarning('archive.org: lookup fallito', { title: raw, err: String(err) });
    return { status: 'error' };
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd backend && npx vitest run src/services/archiveEnrichment.test.ts`
Expected: PASS, 12 tests.

If `encodeURIComponent(identifier)` breaks the expected download URL in the "hit" test, note that Archive identifiers are `[A-Za-z0-9._-]` so encoding is a no-op for real values — keep the encoding (defense in depth) and keep the test identifiers realistic.

- [ ] **Step 5: Typecheck and commit**

```bash
cd backend && npx tsc --noEmit
git add backend/src/services/archiveEnrichment.ts backend/src/services/archiveEnrichment.test.ts
git commit -m "feat(films): internet archive enrichment provider

Two-pass search (raw title, then cleaned) against archive.org's
advancedsearch API restricted to mediatype:movies, reusing the shared
conservative matching helpers. Year drift of one is tolerated because
Archive metadata mixes release and upload year. Returns the largest mp4
derivative as the downloadable file, or null when the item has none."
```

---

### Task 2: Database columns and film_meta plumbing

**Files:**
- Create: `backend/src/db/migrations/008_film_archive.sql`
- Modify: `backend/src/db/init.sql` (the `film_meta` CREATE TABLE)
- Modify: `backend/src/services/filmMeta.ts`
- Modify: `backend/src/types/index.ts` (`FilmMetaRecord`)
- Modify: `frontend/src/types/index.ts` (`FilmMetaRecord`)
- Test: `backend/src/services/filmMeta.test.ts` (extend the existing file)

**Interfaces:**
- Consumes: `ArchiveEnrichmentResult` from Task 1; the existing `query()` helper and `filmKey()`.
- Produces:
  - `export async function upsertArchiveEnrichment(input: { filmKey: string; result: ArchiveEnrichmentResult | null }): Promise<void>` in `filmMeta.ts` — writes only `ia_*` columns, never user state.
  - `export async function setArchiveDownloadedPath(filmKey: string, path: string | null): Promise<void>` in `filmMeta.ts`.
  - `FilmMetaRecord` gains: `iaIdentifier: string | null; iaTitle: string | null; iaYear: string | null; iaPageUrl: string | null; iaFileUrl: string | null; iaCheckedAt: string | null; iaDownloadedPath: string | null;`

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/services/filmMeta.test.ts`:

```typescript
describe('upsertArchiveEnrichment', () => {
  beforeEach(() => vi.clearAllMocks());

  it('inserts the row then writes only ia_* columns', async () => {
    await upsertArchiveEnrichment({
      filmKey: 'metropolis::1927',
      result: {
        identifier: 'metropolis',
        title: 'Metropolis',
        year: '1927',
        pageUrl: 'https://archive.org/details/metropolis',
        fileUrl: 'https://archive.org/download/metropolis/m.mp4',
      },
    });

    const [insertSql] = vi.mocked(query).mock.calls[0];
    expect(insertSql).toContain('INSERT INTO film_meta');
    expect(insertSql).toContain('ON CONFLICT (film_key) DO NOTHING');

    const [updateSql, params] = vi.mocked(query).mock.calls[1];
    expect(updateSql).toContain('ia_identifier');
    expect(updateSql).toContain('ia_checked_at = now()');
    // User state must never be touched by an enrichment write.
    expect(updateSql).not.toContain('watched');
    expect(updateSql).not.toContain('rating');
    expect(updateSql).not.toContain('score');
    expect(updateSql).not.toContain('availability');
    expect(params).toContain('metropolis');
  });

  it('records a miss by stamping ia_checked_at with null identifiers', async () => {
    await upsertArchiveEnrichment({ filmKey: 'nope::1999', result: null });

    const [updateSql, params] = vi.mocked(query).mock.calls[1];
    expect(updateSql).toContain('ia_checked_at = now()');
    expect(params[1]).toBeNull();
  });

  it('never clears a downloaded path on re-check', async () => {
    await upsertArchiveEnrichment({ filmKey: 'metropolis::1927', result: null });
    const [updateSql] = vi.mocked(query).mock.calls[1];
    expect(updateSql).not.toContain('ia_downloaded_path');
  });
});

describe('setArchiveDownloadedPath', () => {
  beforeEach(() => vi.clearAllMocks());

  it('writes the path for the given film', async () => {
    await setArchiveDownloadedPath('metropolis::1927', '/home/mike/Films/Metropolis (1927).mp4');
    const [sql, params] = vi.mocked(query).mock.calls[0];
    expect(sql).toContain('ia_downloaded_path');
    expect(params).toEqual(['metropolis::1927', '/home/mike/Films/Metropolis (1927).mp4']);
  });
});
```

Add `upsertArchiveEnrichment, setArchiveDownloadedPath` to the existing import from `./filmMeta` at the top of that test file.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd backend && npx vitest run src/services/filmMeta.test.ts`
Expected: FAIL — `upsertArchiveEnrichment is not a function`.

- [ ] **Step 3: Write the migration**

Create `backend/src/db/migrations/008_film_archive.sql`:

```sql
ALTER TABLE film_meta
  ADD COLUMN IF NOT EXISTS ia_identifier TEXT,
  ADD COLUMN IF NOT EXISTS ia_title TEXT,
  ADD COLUMN IF NOT EXISTS ia_year TEXT,
  ADD COLUMN IF NOT EXISTS ia_page_url TEXT,
  ADD COLUMN IF NOT EXISTS ia_file_url TEXT,
  ADD COLUMN IF NOT EXISTS ia_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ia_downloaded_path TEXT;
```

- [ ] **Step 4: Mirror the columns in init.sql**

In `backend/src/db/init.sql`, inside `CREATE TABLE IF NOT EXISTS film_meta (...)`, add before the `updated_at` line:

```sql
  ia_identifier TEXT,
  ia_title TEXT,
  ia_year TEXT,
  ia_page_url TEXT,
  ia_file_url TEXT,
  ia_checked_at TIMESTAMPTZ,
  ia_downloaded_path TEXT,
```

- [ ] **Step 5: Write the filmMeta implementation**

In `backend/src/services/filmMeta.ts`, add to the `FilmMetaRow` interface:

```typescript
  ia_identifier: string | null;
  ia_title: string | null;
  ia_year: string | null;
  ia_page_url: string | null;
  ia_file_url: string | null;
  ia_checked_at: Date | null;
  ia_downloaded_path: string | null;
```

Add to `rowToRecord`'s returned object:

```typescript
    iaIdentifier: row.ia_identifier,
    iaTitle: row.ia_title,
    iaYear: row.ia_year,
    iaPageUrl: row.ia_page_url,
    iaFileUrl: row.ia_file_url,
    iaCheckedAt: row.ia_checked_at ? row.ia_checked_at.toISOString() : null,
    iaDownloadedPath: row.ia_downloaded_path,
```

Append the two new functions, importing `ArchiveEnrichmentResult` from `./archiveEnrichment`:

```typescript
/**
 * Writes the Internet Archive lookup outcome. `result: null` records a
 * checked-and-not-found, so a backfill can skip re-querying it for a while.
 * Deliberately never writes ia_downloaded_path: a later re-check must not
 * erase a film already sitting on disk.
 */
export async function upsertArchiveEnrichment(input: {
  filmKey: string;
  result: ArchiveEnrichmentResult | null;
}): Promise<void> {
  await query(`INSERT INTO film_meta (film_key) VALUES ($1) ON CONFLICT (film_key) DO NOTHING`, [input.filmKey]);
  await query(
    `UPDATE film_meta SET
       ia_identifier = $2,
       ia_title = $3,
       ia_year = $4,
       ia_page_url = $5,
       ia_file_url = $6,
       ia_checked_at = now(),
       updated_at = now()
     WHERE film_key = $1`,
    [
      input.filmKey,
      input.result?.identifier ?? null,
      input.result?.title ?? null,
      input.result?.year ?? null,
      input.result?.pageUrl ?? null,
      input.result?.fileUrl ?? null,
    ]
  );
}

/** Records where a downloaded public-domain film landed on disk. */
export async function setArchiveDownloadedPath(filmKey: string, path: string | null): Promise<void> {
  await query(
    `UPDATE film_meta SET ia_downloaded_path = $2, updated_at = now() WHERE film_key = $1`,
    [filmKey, path]
  );
}
```

- [ ] **Step 6: Extend both FilmMetaRecord types**

In `backend/src/types/index.ts` and `frontend/src/types/index.ts`, add to `FilmMetaRecord`:

```typescript
  iaIdentifier: string | null;
  iaTitle: string | null;
  iaYear: string | null;
  iaPageUrl: string | null;
  iaFileUrl: string | null;
  iaCheckedAt: string | null;
  iaDownloadedPath: string | null;
```

- [ ] **Step 7: Fix test fixtures that build a FilmMetaRecord**

Run `cd backend && npx tsc --noEmit` and `cd frontend && npx tsc --noEmit`. Every fixture that constructs a complete `FilmMetaRecord` now fails to compile. Add the seven fields as `null` to each. Expect hits in `backend/src/routes/films.test.ts` and the frontend film filter tests.

- [ ] **Step 8: Run the full suites**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Run: `cd frontend && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 9: Apply the migration to the running database**

```bash
docker exec -i soundreel-db psql -U soundreel -d soundreel < backend/src/db/migrations/008_film_archive.sql
docker exec soundreel-db psql -U soundreel -d soundreel -c "\d film_meta" | grep ia_
```
Expected: the seven `ia_*` columns are listed.

- [ ] **Step 10: Commit**

```bash
git add backend/src/db/migrations/008_film_archive.sql backend/src/db/init.sql \
        backend/src/services/filmMeta.ts backend/src/services/filmMeta.test.ts \
        backend/src/types/index.ts frontend/src/types/index.ts \
        backend/src/routes/films.test.ts frontend/src
git commit -m "feat(films): ia_* columns for internet archive enrichment

Migration 008 (007 belongs to the in-flight wiki branch) plus the
matching init.sql change so a fresh database equals a migrated one. The
enrichment write touches only ia_* columns and deliberately leaves
ia_downloaded_path alone, so re-checking a film cannot orphan a file
already on disk."
```

---

### Task 3: Archive lookup and download endpoints

**Files:**
- Create: `backend/src/services/archiveDownloader.ts`
- Create: `backend/src/services/archiveDownloader.test.ts`
- Modify: `backend/src/routes/films.ts`
- Test: `backend/src/routes/films.test.ts` (extend)

**Interfaces:**
- Consumes: `enrichFilmFromArchive` (Task 1), `upsertArchiveEnrichment` / `setArchiveDownloadedPath` / `listFilmMeta` (Task 2), existing `aggregateFilms` and `LIST_ENTRIES_LIMIT` from `./films`.
- Produces:
  - `export function archiveFilmFilename(title: string, year: string | null): string` — `"Metropolis (1927).mp4"`, filesystem-safe.
  - `export async function downloadArchiveFilm(input: { fileUrl: string; title: string; year: string | null }): Promise<string>` — returns the absolute path written; throws on failure.
  - Routes `POST /api/films/:filmKey/archive-lookup` and `POST /api/films/:filmKey/archive-download`, both replying `{ meta: FilmMetaRecord | null }`.

- [ ] **Step 1: Write the failing downloader tests**

Create `backend/src/services/archiveDownloader.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { archiveFilmFilename, downloadArchiveFilm } from './archiveDownloader';

const originalFetch = global.fetch;

function bodyResponse(bytes: Buffer, contentLength?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? contentLength ?? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('archiveFilmFilename', () => {
  it('formats title and year', () => {
    expect(archiveFilmFilename('Metropolis', '1927')).toBe('Metropolis (1927).mp4');
  });

  it('omits the year when absent', () => {
    expect(archiveFilmFilename('Metropolis', null)).toBe('Metropolis.mp4');
  });

  it('strips path separators and control characters', () => {
    expect(archiveFilmFilename('A/B: the\\film', '1970')).toBe('A-B- the-film (1970).mp4');
  });

  it('truncates an absurdly long title', () => {
    const name = archiveFilmFilename('x'.repeat(400), '1970');
    expect(name.length).toBeLessThanOrEqual(160);
    expect(name.endsWith('.mp4')).toBe(true);
  });
});

describe('downloadArchiveFilm', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(join(tmpdir(), 'soundreel-films-'));
    process.env.FILMS_LIBRARY_PATH = dir;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.FILMS_LIBRARY_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file and returns its path', async () => {
    global.fetch = vi.fn().mockResolvedValue(bodyResponse(Buffer.from('video-bytes')));
    const path = await downloadArchiveFilm({
      fileUrl: 'https://archive.org/download/metropolis/m.mp4',
      title: 'Metropolis',
      year: '1927',
    });
    expect(path).toBe(join(dir, 'Metropolis (1927).mp4'));
    expect(await fs.readFile(path, 'utf8')).toBe('video-bytes');
  });

  it('refuses a file larger than the ceiling before downloading it', async () => {
    global.fetch = vi.fn().mockResolvedValue(bodyResponse(Buffer.from('x'), String(20 * 1024 * 1024 * 1024)));
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'Huge', year: null })
    ).rejects.toThrow(/too large/i);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('throws and leaves no partial file when the response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'Gone', year: null })
    ).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('throws when FILMS_LIBRARY_PATH is not configured', async () => {
    delete process.env.FILMS_LIBRARY_PATH;
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'X', year: null })
    ).rejects.toThrow(/FILMS_LIBRARY_PATH/);
  });

  it('rejects a non-archive.org URL', async () => {
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://evil.example.com/x.mp4', title: 'X', year: null })
    ).rejects.toThrow(/archive\.org/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/services/archiveDownloader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the downloader**

Create `backend/src/services/archiveDownloader.ts`:

```typescript
import { promises as fs } from 'fs';
import { join } from 'path';
import { logInfo, logError } from '../utils/logger';

/** A public-domain feature at Archive quality tops out well under this; the
 * ceiling exists so a mis-matched multi-hour item cannot fill the disk. */
const MAX_BYTES = 8 * 1024 * 1024 * 1024;
const MAX_FILENAME_LENGTH = 160;

/** Filesystem-safe `Title (Year).mp4`. Path separators and control characters
 * become dashes so a hostile or merely odd Archive title cannot escape the
 * films directory. */
export function archiveFilmFilename(title: string, year: string | null): string {
  const safeTitle = title
    .replace(/[/\\:*?"<>| -]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  const suffix = year ? ` (${year})` : '';
  const budget = MAX_FILENAME_LENGTH - suffix.length - '.mp4'.length;
  return `${safeTitle.slice(0, budget).trim()}${suffix}.mp4`;
}

/**
 * Downloads one Archive-hosted film into FILMS_LIBRARY_PATH and returns the
 * path written. Throws on any failure, leaving nothing behind — the caller
 * records the path in film_meta only on success.
 */
export async function downloadArchiveFilm(input: {
  fileUrl: string;
  title: string;
  year: string | null;
}): Promise<string> {
  const root = process.env.FILMS_LIBRARY_PATH;
  if (!root) throw new Error('FILMS_LIBRARY_PATH not set');

  // The URL always comes from our own enrichment record rather than user
  // input, but pinning the host keeps that guarantee local and checkable.
  let parsed: URL;
  try {
    parsed = new URL(input.fileUrl);
  } catch {
    throw new Error('invalid file url');
  }
  if (parsed.hostname !== 'archive.org' && !parsed.hostname.endsWith('.archive.org')) {
    throw new Error('file url is not hosted on archive.org');
  }

  const res = await fetch(input.fileUrl);
  if (!res.ok) throw new Error(`archive download failed: HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) {
    throw new Error(`file too large: ${declared} bytes`);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) {
    throw new Error(`file too large: ${buffer.byteLength} bytes`);
  }

  await fs.mkdir(root, { recursive: true });
  const dest = join(root, archiveFilmFilename(input.title, input.year));
  try {
    await fs.writeFile(dest, buffer);
  } catch (err) {
    await fs.rm(dest, { force: true });
    logError('archive download: scrittura fallita', { dest, err: String(err) });
    throw err;
  }

  logInfo('archive download ok', { dest, bytes: buffer.byteLength });
  return dest;
}
```

- [ ] **Step 4: Run the downloader tests**

Run: `cd backend && npx vitest run src/services/archiveDownloader.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Write the failing route tests**

Append to `backend/src/routes/films.test.ts` (add `enrichFilmFromArchive`, `upsertArchiveEnrichment`, `setArchiveDownloadedPath`, `downloadArchiveFilm` to the existing `vi.mock` blocks for their modules):

```typescript
describe('POST /api/films/:filmKey/archive-lookup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-08-01T00:00:00Z', [{ title: 'Metropolis', year: '1927' }]),
    ]);
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
  });

  it('404s for an unknown film', async () => {
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/nope%3A%3A1999/archive-lookup' });
    expect(res.statusCode).toBe(404);
  });

  it('persists a hit and returns the refreshed meta', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({
      status: 'hit',
      result: {
        identifier: 'metropolis',
        title: 'Metropolis',
        year: '1927',
        pageUrl: 'https://archive.org/details/metropolis',
        fileUrl: 'https://archive.org/download/metropolis/m.mp4',
      },
    });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(upsertArchiveEnrichment)).toHaveBeenCalledWith(
      expect.objectContaining({ filmKey: 'metropolis::1927' })
    );
  });

  it('persists a miss as a null result', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({ status: 'miss' });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(upsertArchiveEnrichment)).toHaveBeenCalledWith({
      filmKey: 'metropolis::1927',
      result: null,
    });
  });

  it('502s on a provider error without writing anything', async () => {
    vi.mocked(enrichFilmFromArchive).mockResolvedValue({ status: 'error' });
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-lookup' });
    expect(res.statusCode).toBe(502);
    expect(vi.mocked(upsertArchiveEnrichment)).not.toHaveBeenCalled();
  });
});

describe('POST /api/films/:filmKey/archive-download', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(listEntries).mockResolvedValue([
      entry('e1', '2026-08-01T00:00:00Z', [{ title: 'Metropolis', year: '1927' }]),
    ]);
  });

  it('409s when the film has no archive file url', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(new Map());
    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(409);
    expect(vi.mocked(downloadArchiveFilm)).not.toHaveBeenCalled();
  });

  it('downloads and records the path', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(
      new Map([['metropolis::1927', filmMeta({ iaFileUrl: 'https://archive.org/download/metropolis/m.mp4' })]])
    );
    vi.mocked(downloadArchiveFilm).mockResolvedValue('/films/Metropolis (1927).mp4');

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(setArchiveDownloadedPath)).toHaveBeenCalledWith(
      'metropolis::1927',
      '/films/Metropolis (1927).mp4'
    );
  });

  it('500s and records nothing when the download throws', async () => {
    vi.mocked(listFilmMeta).mockResolvedValue(
      new Map([['metropolis::1927', filmMeta({ iaFileUrl: 'https://archive.org/download/metropolis/m.mp4' })]])
    );
    vi.mocked(downloadArchiveFilm).mockRejectedValue(new Error('boom'));

    const res = await buildApp().inject({ method: 'POST', url: '/api/films/metropolis%3A%3A1927/archive-download' });
    expect(res.statusCode).toBe(500);
    expect(vi.mocked(setArchiveDownloadedPath)).not.toHaveBeenCalled();
  });
});
```

Define a `filmMeta(overrides)` helper in that test file if one does not already exist — it must return a complete `FilmMetaRecord` with every field defaulted (`null`/`[]`/`false`) and the overrides applied.

- [ ] **Step 6: Run to verify failure**

Run: `cd backend && npx vitest run src/routes/films.test.ts`
Expected: FAIL — routes return 404 because they do not exist yet.

- [ ] **Step 7: Add the routes**

In `backend/src/routes/films.ts`, extend the imports and append inside `registerFilmsRoutes` (after the existing refresh-streaming route):

```typescript
  app.post<{ Params: { filmKey: string } }>(
    '/api/films/:filmKey/archive-lookup',
    async (req, reply) => {
      const key = req.params.filmKey;
      try {
        const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
        const film = aggregateFilms(entries, metaMap).get(key);
        if (!film) return reply.code(404).send({ error: 'film not found' });

        const outcome = await enrichFilmFromArchive(film.title, film.year);
        if (outcome.status === 'error') {
          // A provider outage must not be recorded as "checked, not found":
          // that would suppress the film from a later retry.
          return reply.code(502).send({ error: 'archive lookup failed' });
        }

        await upsertArchiveEnrichment({
          filmKey: key,
          result: outcome.status === 'hit' ? outcome.result : null,
        });

        const freshMeta = (await listFilmMeta()).get(key) ?? null;
        return reply.send({ meta: freshMeta });
      } catch (err) {
        logError('POST /api/films/:filmKey/archive-lookup failed', { filmKey: key, err: String(err) });
        return reply.code(500).send({ error: 'archive lookup failed' });
      }
    }
  );

  app.post<{ Params: { filmKey: string } }>(
    '/api/films/:filmKey/archive-download',
    async (req, reply) => {
      const key = req.params.filmKey;
      try {
        const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
        const film = aggregateFilms(entries, metaMap).get(key);
        if (!film) return reply.code(404).send({ error: 'film not found' });

        const fileUrl = film.meta?.iaFileUrl ?? null;
        if (!fileUrl) {
          return reply.code(409).send({ error: 'film has no archive.org file' });
        }

        let path: string;
        try {
          path = await downloadArchiveFilm({ fileUrl, title: film.title, year: film.year });
        } catch (err) {
          logError('POST /api/films/:filmKey/archive-download failed', { filmKey: key, err: String(err) });
          return reply.code(500).send({ error: 'archive download failed' });
        }

        await setArchiveDownloadedPath(key, path);
        const freshMeta = (await listFilmMeta()).get(key) ?? null;
        return reply.send({ meta: freshMeta });
      } catch (err) {
        logError('POST /api/films/:filmKey/archive-download failed', { filmKey: key, err: String(err) });
        return reply.code(500).send({ error: 'archive download failed' });
      }
    }
  );
```

- [ ] **Step 8: Run the suites and typecheck**

Run: `cd backend && npx vitest run && npx tsc --noEmit`
Expected: all green.

- [ ] **Step 9: Mount the films directory in the container**

In `docker-compose.yml`, under the `soundreel` service, add to `environment:`:

```yaml
      FILMS_LIBRARY_PATH: /films
```

and to `volumes:`:

```yaml
      - /home/mike/Films:/films
```

Create the host directory: `mkdir -p /home/mike/Films`

- [ ] **Step 10: Commit**

```bash
git add backend/src/services/archiveDownloader.ts backend/src/services/archiveDownloader.test.ts \
        backend/src/routes/films.ts backend/src/routes/films.test.ts docker-compose.yml
git commit -m "feat(films): archive lookup and download endpoints

Two manual, per-film actions: lookup persists the Internet Archive match
(or a recorded miss), download fetches the mp4 into FILMS_LIBRARY_PATH
and stores the resulting path. A provider outage returns 502 without
writing, so it is retryable rather than cached as a miss. The downloader
pins the host to archive.org, caps the size, and leaves nothing behind
on failure."
```

---

### Task 4: FilmCard archive badge and download button

**Files:**
- Modify: `frontend/src/services/api.ts`
- Modify: `frontend/src/components/FilmCard.tsx`
- Modify: `frontend/src/pages/FilmsPage.tsx`
- Modify: `frontend/src/i18n/translations.ts`
- Modify: `frontend/src/styles/index.css`

**Interfaces:**
- Consumes: `FilmMetaRecord.iaIdentifier/iaPageUrl/iaFileUrl/iaDownloadedPath` (Task 2); routes from Task 3.
- Produces:
  - `export async function archiveLookupFilm(filmKey: string): Promise<FilmMetaRecord>`
  - `export async function archiveDownloadFilm(filmKey: string): Promise<FilmMetaRecord>`
  - `FilmCardProps` gains `onArchiveLookup: () => Promise<void>` and `onArchiveDownload: () => Promise<void>`.

- [ ] **Step 1: Add the API helpers**

In `frontend/src/services/api.ts`, after `refreshFilmStreaming`:

```typescript
// Manual per-film Internet Archive actions. Both throw on non-2xx (409 when
// the film has no archive file, 502 when Archive itself failed) — the caller
// catches and surfaces it, per the pipeline resilience convention.
export async function archiveLookupFilm(filmKey: string): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}/archive-lookup`), {
    method: 'POST',
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}

export async function archiveDownloadFilm(filmKey: string): Promise<FilmMetaRecord> {
  const res = await fetch(url(`/api/films/${encodeURIComponent(filmKey)}/archive-download`), {
    method: 'POST',
  });
  const data = await json<{ meta: FilmMetaRecord }>(res);
  return data.meta;
}
```

- [ ] **Step 2: Add the translation keys**

In `frontend/src/i18n/translations.ts`, add to the `Translations` interface near the other `films*` keys:

```typescript
  filmsArchiveBadge: string;
  filmsArchiveLookup: string;
  filmsArchiveDownload: string;
  filmsArchiveDownloaded: string;
  filmsArchiveNone: string;
```

Italian block:

```typescript
    filmsArchiveBadge: 'Archive',
    filmsArchiveLookup: 'Cerca su Internet Archive',
    filmsArchiveDownload: 'Scarica in archivio',
    filmsArchiveDownloaded: 'Scaricato in archivio',
    filmsArchiveNone: 'Nessuna copia di pubblico dominio trovata',
```

English block:

```typescript
    filmsArchiveBadge: 'Archive',
    filmsArchiveLookup: 'Search Internet Archive',
    filmsArchiveDownload: 'Download to archive',
    filmsArchiveDownloaded: 'Downloaded to archive',
    filmsArchiveNone: 'No public-domain copy found',
```

- [ ] **Step 3: Wire the card**

In `frontend/src/components/FilmCard.tsx`, extend `FilmCardProps`:

```typescript
  onArchiveLookup: () => Promise<void>;
  onArchiveDownload: () => Promise<void>;
```

Add state next to `refreshing`:

```typescript
  const [archiveBusy, setArchiveBusy] = useState(false);
```

Add the handler next to `handleRefreshStreaming`:

```typescript
  async function runArchiveAction(action: () => Promise<void>) {
    if (archiveBusy) return;
    setArchiveBusy(true);
    try {
      await action();
    } finally {
      setArchiveBusy(false);
    }
  }
```

Render inside the badges row that already holds the service badges, after them:

```tsx
        {meta?.iaPageUrl ? (
          <span className="film-service">
            <a
              href={meta.iaPageUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="badge-link archive"
            >
              {t.filmsArchiveBadge}
            </a>
            {meta.iaDownloadedPath ? (
              <span className="archive-downloaded" title={t.filmsArchiveDownloaded}>✓</span>
            ) : meta.iaFileUrl ? (
              <button
                type="button"
                className="archive-btn"
                title={t.filmsArchiveDownload}
                disabled={archiveBusy}
                onClick={() => runArchiveAction(onArchiveDownload)}
              >
                ⬇
              </button>
            ) : null}
          </span>
        ) : (
          <button
            type="button"
            className="archive-btn"
            title={meta?.iaCheckedAt ? t.filmsArchiveNone : t.filmsArchiveLookup}
            disabled={archiveBusy}
            onClick={() => runArchiveAction(onArchiveLookup)}
          >
            {meta?.iaCheckedAt ? '∅' : '🔍'}
          </button>
        )}
```

- [ ] **Step 4: Wire the page**

In `frontend/src/pages/FilmsPage.tsx`, import the two helpers, then add handlers modelled on the existing `refreshStreaming` (which already merges the returned meta into local state — copy that merge logic exactly rather than inventing a second one):

```typescript
  async function archiveLookup(filmKey: string) {
    try {
      const serverMeta = await archiveLookupFilm(filmKey);
      applyServerMeta(filmKey, serverMeta);
    } catch (e) {
      console.error('archive lookup failed', e);
    }
  }

  async function archiveDownload(filmKey: string) {
    try {
      const serverMeta = await archiveDownloadFilm(filmKey);
      applyServerMeta(filmKey, serverMeta);
    } catch (e) {
      console.error('archive download failed', e);
    }
  }
```

If `refreshStreaming` inlines its state merge instead of calling a shared `applyServerMeta`, extract that merge into `applyServerMeta(filmKey, meta)` first and have all three call it.

Pass both props to every `<FilmCard>` usage (there are two):

```tsx
              onArchiveLookup={() => archiveLookup(film.filmKey)}
              onArchiveDownload={() => archiveDownload(film.filmKey)}
```

- [ ] **Step 5: Add the styles**

In `frontend/src/styles/index.css`, next to the other badge-link colours:

```css
.badge-link.archive { background: #6b7280; }

.archive-btn {
  background: none;
  border: 1px solid var(--border);
  border-radius: 50%;
  width: 1.4rem;
  height: 1.4rem;
  font-size: 0.6rem;
  line-height: 1;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 0;
}

.archive-btn:disabled { opacity: 0.5; cursor: default; }

.archive-downloaded {
  font-size: 0.7rem;
  color: var(--success);
}
```

- [ ] **Step 6: Typecheck, test, build**

Run: `cd frontend && npx tsc --noEmit && npx vitest run && npm run build`
Expected: all green. Fix any test that constructs `FilmCardProps` by adding the two new handlers.

- [ ] **Step 7: Commit**

```bash
git add frontend/src
git commit -m "feat(films): archive badge and manual download button

The card shows a magnifier until a film has been checked against
Internet Archive, then either the Archive badge-link with a download
button, a checkmark once the file is on disk, or a struck-through
marker when the check found nothing. Download stays manual so nothing
lands on the archive without a deliberate click."
```

---

### Task 5: Watchlist HTML export

**Files:**
- Create: `backend/src/services/watchlistExport.ts`
- Create: `backend/src/services/watchlistExport.test.ts`
- Create: `backend/scripts/export-watchlist.ts`
- Modify: `backend/package.json` (scripts)

**Interfaces:**
- Consumes: `AggregatedFilm` from `../types`; `listEntries`, `listFilmMeta`, `aggregateFilms`, `LIST_ENTRIES_LIMIT` from the films route module.
- Produces: `export function renderWatchlistHtml(films: AggregatedFilm[]): string`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/services/watchlistExport.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { renderWatchlistHtml } from './watchlistExport';
import type { AggregatedFilm } from '../types';

function film(overrides: Partial<AggregatedFilm> = {}): AggregatedFilm {
  return {
    filmKey: 'metropolis::1927',
    title: 'Metropolis',
    director: 'Fritz Lang',
    year: '1927',
    imdbUrl: 'https://www.imdb.com/title/tt0017136/',
    posterUrl: 'https://image.tmdb.org/t/p/w200/poster.jpg',
    streamingUrls: {
      netflix: 'https://www.netflix.com/search?q=Metropolis',
      primeVideo: 'https://www.primevideo.com/search?phrase=Metropolis',
      raiPlay: 'https://www.raiplay.it/ricerca.html?q=Metropolis',
      now: 'https://www.nowtv.it/cerca?q=Metropolis',
      disneyPlus: 'https://www.disneyplus.com/search/Metropolis',
      appleTv: 'https://tv.apple.com/search?term=Metropolis',
    },
    mentions: [{ entryId: 'e1', createdAt: '2026-08-01T00:00:00Z' }],
    meta: null,
    ...overrides,
  } as AggregatedFilm;
}

describe('renderWatchlistHtml', () => {
  it('renders a self-contained document with the film title', () => {
    const html = renderWatchlistHtml([film()]);
    expect(html).toContain('<!doctype html>');
    expect(html).toContain('Metropolis');
    expect(html).toContain('Fritz Lang');
    expect(html).toContain('1927');
    // Self-contained: no external stylesheet or script.
    expect(html).not.toContain('<link rel="stylesheet"');
    expect(html).not.toContain('<script src=');
  });

  it('includes every platform link', () => {
    const html = renderWatchlistHtml([film()]);
    expect(html).toContain('netflix.com/search?q=Metropolis');
    expect(html).toContain('primevideo.com/search?phrase=Metropolis');
    expect(html).toContain('raiplay.it/ricerca.html?q=Metropolis');
    expect(html).toContain('nowtv.it/cerca?q=Metropolis');
    expect(html).toContain('disneyplus.com/search/Metropolis');
    expect(html).toContain('tv.apple.com/search?term=Metropolis');
  });

  it('renders a film with no streaming data at all', () => {
    const html = renderWatchlistHtml([film({ streamingUrls: null, posterUrl: null, director: null, year: null })]);
    expect(html).toContain('Metropolis');
  });

  it('escapes HTML metacharacters in titles', () => {
    const html = renderWatchlistHtml([film({ title: 'Fear & <Loathing>' })]);
    expect(html).toContain('Fear &amp; &lt;Loathing&gt;');
    expect(html).not.toContain('<Loathing>');
  });

  it('marks a film downloaded to the archive', () => {
    const html = renderWatchlistHtml([
      film({
        meta: {
          iaDownloadedPath: '/films/Metropolis (1927).mp4',
          iaPageUrl: 'https://archive.org/details/metropolis',
        } as AggregatedFilm['meta'],
      }),
    ]);
    expect(html).toContain('archive.org/details/metropolis');
  });

  it('renders an empty list without crashing', () => {
    const html = renderWatchlistHtml([]);
    expect(html).toContain('<!doctype html>');
  });

  it('sorts films alphabetically by title', () => {
    const html = renderWatchlistHtml([
      film({ filmKey: 'z::1', title: 'Zabriskie Point' }),
      film({ filmKey: 'a::2', title: 'Amarcord' }),
    ]);
    expect(html.indexOf('Amarcord')).toBeLessThan(html.indexOf('Zabriskie Point'));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `cd backend && npx vitest run src/services/watchlistExport.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the exporter**

Create `backend/src/services/watchlistExport.ts`:

```typescript
import type { AggregatedFilm, StreamingUrls } from '../types';

/** Same service list and order as the FilmCard badges, so the exported page
 * and the app agree on what "where can I watch this" means. */
const SERVICES: Array<{ key: keyof StreamingUrls; label: string }> = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'primeVideo', label: 'Prime' },
  { key: 'raiPlay', label: 'Rai' },
  { key: 'now', label: 'NOW' },
  { key: 'disneyPlus', label: 'D+' },
  { key: 'appleTv', label: 'TV' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCard(film: AggregatedFilm): string {
  const subtitle = [film.director, film.year].filter(Boolean).map(String).map(escapeHtml).join(' · ');
  const poster = film.posterUrl
    ? `<img src="${escapeHtml(film.posterUrl)}" alt="" loading="lazy">`
    : '<div class="noposter">🎬</div>';

  const links: string[] = [];
  if (film.streamingUrls) {
    for (const svc of SERVICES) {
      const href = film.streamingUrls[svc.key];
      if (href) links.push(`<a href="${escapeHtml(href)}">${svc.label}</a>`);
    }
  }
  if (film.imdbUrl) links.push(`<a href="${escapeHtml(film.imdbUrl)}">IMDb</a>`);
  if (film.meta?.iaPageUrl) links.push(`<a href="${escapeHtml(film.meta.iaPageUrl)}">Archive</a>`);

  const downloaded = film.meta?.iaDownloadedPath ? '<span class="dl">✓ in archivio</span>' : '';

  return `<article>
  ${poster}
  <div class="body">
    <h2>${escapeHtml(film.title)}${downloaded}</h2>
    <p class="sub">${subtitle}</p>
    <p class="links">${links.join(' ')}</p>
  </div>
</article>`;
}

/**
 * Renders the whole film list as one self-contained HTML page. It lives on
 * the Fritz storage next to the media, so it must work with no network beyond
 * the links themselves and no local assets: styles are inlined and there is
 * no JavaScript. Posters are remote URLs and simply do not render offline.
 */
export function renderWatchlistHtml(films: AggregatedFilm[]): string {
  const sorted = [...films].sort((a, b) => a.title.localeCompare(b.title));
  const cards = sorted.map(renderCard).join('\n');

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SoundReel — Film</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 1rem; background: #0a0a0a; color: #f5f5f7;
       font-family: system-ui, -apple-system, sans-serif; }
h1 { font-size: 1.2rem; margin: 0 0 1rem; }
article { display: flex; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid #262626; }
article img, .noposter { width: 60px; height: 90px; object-fit: cover; border-radius: 4px;
       background: #1a1a1a; display: flex; align-items: center; justify-content: center; flex: none; }
.body { min-width: 0; }
h2 { font-size: .95rem; margin: 0 0 .2rem; font-weight: 600; }
.sub { font-size: .75rem; color: #a1a1aa; margin: 0 0 .35rem; }
.links a { display: inline-block; font-size: .65rem; font-weight: 600; padding: .1rem .4rem;
       margin: 0 .2rem .2rem 0; border-radius: 4px; background: #27272a; color: #f5f5f7;
       text-decoration: none; }
.dl { font-size: .65rem; color: #22c55e; margin-left: .4rem; }
.links { margin: 0; }
</style>
</head>
<body>
<h1>SoundReel — Film (${sorted.length})</h1>
${cards}
</body>
</html>
`;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd backend && npx vitest run src/services/watchlistExport.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Write the CLI entry point**

Create `backend/scripts/export-watchlist.ts`:

```typescript
/**
 * Writes the film catalogue to the path given as argv[2]. Run by the nightly
 * fritz-sync job; safe to run by hand for a quick look.
 *
 *   npm run export:watchlist -- /tmp/watchlist.html
 */
import { writeFileSync } from 'fs';
import { listEntries } from '../src/utils/db';
import { listFilmMeta } from '../src/services/filmMeta';
import { aggregateFilms, LIST_ENTRIES_LIMIT } from '../src/routes/films';
import { renderWatchlistHtml } from '../src/services/watchlistExport';

async function main(): Promise<void> {
  const dest = process.argv[2];
  if (!dest) {
    console.error('usage: export-watchlist <dest.html>');
    process.exit(2);
  }

  const [entries, metaMap] = await Promise.all([listEntries(LIST_ENTRIES_LIMIT), listFilmMeta()]);
  const films = [...aggregateFilms(entries, metaMap).values()];
  writeFileSync(dest, renderWatchlistHtml(films), 'utf8');
  console.log(`watchlist: ${films.length} film -> ${dest}`);
  process.exit(0);
}

main().catch((err) => {
  console.error('watchlist export failed:', err);
  process.exit(1);
});
```

If `aggregateFilms` or `LIST_ENTRIES_LIMIT` is not exported from `backend/src/routes/films.ts`, export it — `musicLibrary.ts` already imports `aggregateSongs` from the songs route the same way, so the pattern is established.

- [ ] **Step 6: Add the npm script**

In `backend/package.json`, under `scripts`, matching the style of the existing backfill scripts:

```json
    "export:watchlist": "tsx scripts/export-watchlist.ts"
```

- [ ] **Step 7: Verify it runs against the real database**

```bash
docker exec soundreel npm run export:watchlist -- /tmp/watchlist.html
docker exec soundreel head -20 /tmp/watchlist.html
```
Expected: a film count on stdout and valid HTML.

- [ ] **Step 8: Commit**

```bash
cd backend && npx tsc --noEmit && npx vitest run
git add backend/src/services/watchlistExport.ts backend/src/services/watchlistExport.test.ts \
        backend/scripts/export-watchlist.ts backend/package.json backend/src/routes/films.ts
git commit -m "feat(films): self-contained watchlist HTML export

Renders every journal film as a static page with poster, credits and the
same platform links the card shows, reusing the service list rather than
forking it. Inline styles and no JavaScript, because the file is read
off the Fritz USB storage rather than served by the app."
```

---

### Task 6: Nightly Fritz sync

**Files:**
- Create: `scripts/fritz-sync.sh`
- Create: `scripts/fritz-sync.service`
- Create: `scripts/fritz-sync.timer`
- Create: `scripts/fritz-sync.env.example`
- Modify: `CLAUDE.md` (deploy/commands section)

**Interfaces:**
- Consumes: `npm run export:watchlist` (Task 5); `FILMS_LIBRARY_PATH` host directory `/home/mike/Films` (Task 3).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Write the example env file**

Create `scripts/fritz-sync.env.example`:

```bash
# Copy to /etc/soundreel/fritz-sync.env, chown root:root, chmod 0600.
# The hostname fritz.box is NOT usable here: it resolves to an unreachable
# public IPv6 on this network, and 192.168.178.1 is a MikroTik router.
FRITZ_HOST=192.168.178.10
FRITZ_SHARE=FRITZ.NAS
FRITZ_USER=geekom
FRITZ_PASSWORD=change-me
# Volume directory inside the share; also asserted before any rsync runs.
FRITZ_VOLUME=TESLA_MEDIA
MUSIC_SRC=/home/mike/Music
FILMS_SRC=/home/mike/Films
```

- [ ] **Step 2: Write the sync script**

Create `scripts/fritz-sync.sh`:

```bash
#!/bin/bash
# Nightly one-way sync of the SoundReel media library to the FRITZ!Box USB
# stick, where the box's own DLNA server picks it up for the TV.
#
# The stick is the car's Tesla media drive and already holds its own Music/
# and Movies/ trees, so everything written here lives under a dedicated
# SoundReel/ subdirectory and --delete is scoped to those. Syncing onto the
# parent directories would wipe that library.
set -euo pipefail

ENV_FILE="${FRITZ_SYNC_ENV:-/etc/soundreel/fritz-sync.env}"
LOG_FILE="${FRITZ_SYNC_LOG:-/var/log/soundreel/fritz-sync.log}"
MOUNTPOINT="$(mktemp -d /tmp/fritz-sync.XXXXXX)"

log() {
  mkdir -p "$(dirname "$LOG_FILE")"
  echo "$(date -Is) $*" | tee -a "$LOG_FILE"
}

cleanup() {
  local status=$?
  if mountpoint -q "$MOUNTPOINT"; then
    umount "$MOUNTPOINT" || log "WARN umount failed"
  fi
  rmdir "$MOUNTPOINT" 2>/dev/null || true
  [ $status -ne 0 ] && log "FAILED (exit $status)"
  exit $status
}
trap cleanup EXIT

if [ ! -r "$ENV_FILE" ]; then
  log "ERROR env file not readable: $ENV_FILE"
  exit 1
fi
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${FRITZ_HOST:?}" "${FRITZ_SHARE:?}" "${FRITZ_USER:?}" "${FRITZ_PASSWORD:?}"
: "${FRITZ_VOLUME:?}" "${MUSIC_SRC:?}" "${FILMS_SRC:?}"

log "mounting //$FRITZ_HOST/$FRITZ_SHARE"
mount -t cifs "//$FRITZ_HOST/$FRITZ_SHARE" "$MOUNTPOINT" \
  -o "username=$FRITZ_USER,password=$FRITZ_PASSWORD,vers=3.0,iocharset=utf8,uid=$(id -u),gid=$(id -g)"

# A swapped or unplugged stick would leave the mount pointing at something
# unexpected, and --delete would then act on the wrong tree. Refuse to
# proceed unless the expected volume is really there.
VOLUME_DIR="$MOUNTPOINT/$FRITZ_VOLUME"
if [ ! -d "$VOLUME_DIR" ]; then
  log "ERROR expected volume '$FRITZ_VOLUME' not found on the share"
  exit 1
fi

MUSIC_DEST="$VOLUME_DIR/Music/SoundReel"
FILMS_DEST="$VOLUME_DIR/Movies/SoundReel"
mkdir -p "$MUSIC_DEST" "$FILMS_DEST"

log "syncing music"
rsync -a --delete --partial --no-perms --no-owner --no-group \
  "$MUSIC_SRC/" "$MUSIC_DEST/"

if [ -d "$FILMS_SRC" ]; then
  log "syncing films"
  rsync -a --delete --partial --no-perms --no-owner --no-group \
    "$FILMS_SRC/" "$FILMS_DEST/"
else
  log "films source missing, skipped: $FILMS_SRC"
fi

log "exporting watchlist"
WATCHLIST_TMP="$(mktemp /tmp/watchlist.XXXXXX.html)"
if docker exec soundreel npm run --silent export:watchlist -- /tmp/watchlist.html \
   && docker cp soundreel:/tmp/watchlist.html "$WATCHLIST_TMP"; then
  cp "$WATCHLIST_TMP" "$VOLUME_DIR/watchlist.html"
else
  log "WARN watchlist export failed, keeping the previous copy"
fi
rm -f "$WATCHLIST_TMP"

MUSIC_COUNT=$(find "$MUSIC_DEST" -type f | wc -l)
FILMS_COUNT=$(find "$FILMS_DEST" -type f | wc -l)
log "OK music=$MUSIC_COUNT films=$FILMS_COUNT"
```

Note the deliberate choices: `--no-perms --no-owner --no-group` because the CIFS mount cannot represent POSIX ownership and rsync would otherwise re-copy everything each night; the watchlist failure is a warning, not a fatal error, because stale catalogue beats no media sync.

- [ ] **Step 3: Make it executable and shellcheck it**

```bash
chmod +x scripts/fritz-sync.sh
bash -n scripts/fritz-sync.sh && echo "syntax ok"
```

- [ ] **Step 4: Write the systemd units**

Create `scripts/fritz-sync.service`:

```ini
[Unit]
Description=SoundReel media sync to FRITZ!Box USB storage
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/home/mike/works/Soundreel/scripts/fritz-sync.sh
```

Create `scripts/fritz-sync.timer`:

```ini
[Unit]
Description=Nightly SoundReel media sync to the FRITZ!Box

[Timer]
OnCalendar=*-*-* 04:00:00
Persistent=true

[Install]
WantedBy=timers.target
```

`Persistent=true` so a run missed while the machine was off happens at the next boot.

- [ ] **Step 5: Install and dry-run**

These need root, so the user runs them:

```bash
sudo mkdir -p /etc/soundreel /var/log/soundreel
sudo cp scripts/fritz-sync.env.example /etc/soundreel/fritz-sync.env
sudo chmod 600 /etc/soundreel/fritz-sync.env
sudo nano /etc/soundreel/fritz-sync.env     # set the real password
sudo apt-get install -y cifs-utils
sudo /home/mike/works/Soundreel/scripts/fritz-sync.sh
```

Expected: log lines ending in `OK music=<n> films=<n>`, and the files visible on the stick.

Verify from a second terminal without root:

```bash
smbclient //192.168.178.10/FRITZ.NAS -U geekom -m SMB3 -c 'ls TESLA_MEDIA\Music\SoundReel'
```

- [ ] **Step 6: Enable the timer**

```bash
sudo cp scripts/fritz-sync.service scripts/fritz-sync.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now fritz-sync.timer
systemctl list-timers fritz-sync.timer
```

- [ ] **Step 7: Document it**

In `CLAUDE.md`, under "Comandi utili", add:

```markdown
# Sync manuale della libreria verso la chiavetta del FRITZ!Box
sudo ./scripts/fritz-sync.sh
cat /var/log/soundreel/fritz-sync.log
```

And under the external-API list, a line noting that the Fritz is at
`192.168.178.10` (share `FRITZ.NAS`, SMB3) and that the sync writes only into
`TESLA_MEDIA/Music/SoundReel` and `TESLA_MEDIA/Movies/SoundReel`.

- [ ] **Step 8: Commit**

```bash
git add scripts/fritz-sync.sh scripts/fritz-sync.service scripts/fritz-sync.timer \
        scripts/fritz-sync.env.example CLAUDE.md
git commit -m "feat(sync): nightly media sync to the FRITZ!Box USB storage

Mounts the box over SMB3, asserts the expected volume is present, then
rsyncs music and downloaded public-domain films into dedicated
SoundReel/ subdirectories — the stick already carries the car's Tesla
library, which --delete on the parent directories would have destroyed.
Credentials live in a root-only env file outside the repo. A failed
watchlist export downgrades to a warning so it cannot block the media
sync."
```

---

## Deployment

After Task 6, bump and deploy as usual:

```bash
./scripts/bump-version.sh
git add -A && git commit -m "chore: bump version"
touch .rebuild
# wait ~90s, then verify:
docker exec soundreel node -p "require('/app/package.json').version"
```

The `docker-compose.yml` change from Task 3 (the `/home/mike/Films` mount) requires the container to be recreated, which the rebuild does.
