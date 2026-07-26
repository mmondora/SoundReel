# Music Tracking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Per-song user state (rating slider + like/dislike, listened, favorite ⭐, downloaded/Spooty), Deezer→iTunes enrichment (genre, album, cover, preview, direct links), deduplicated filterable SongsPage.

**Architecture:** Mirror the shipped film feature 1:1 — the film code IS the template. `song_meta` table ≈ `film_meta`; `songMeta.ts` ≈ `filmMeta.ts`; `songEnrichment.ts` ≈ `filmSearch`+`streamingAvailability` mappers; `routes/songs.ts` ≈ `routes/films.ts`; SongsPage rework ≈ FilmsPage+FilmCard. Spec governs: `docs/superpowers/specs/2026-07-26-music-tracking-design.md`.

**Tech Stack:** Fastify + pg raw SQL, React + Vite, Vitest all-mocked, TS strict.

## Global Constraints

- TS strict, no `any`; types in `types/index.ts` both sides; no ORM; no real HTTP in tests.
- Enrichment columns written only by pipeline/backfill; user-state columns only by PATCH. Never mixed.
- `patchSongUserMeta`: rating/score non-null ⇒ `listened = true` with EXACTLY ONE listened assignment in the SET list (regression class from `patchFilmUserMeta`: no duplicate column assignment, no orphan params — reuse its `assertAllParamsUsed`-style test).
- All provider URLs validated `^https?:` before storing (reuse/mirror `safeUrl`).
- Pipeline hooks fire-and-forget with `.catch(logError)`, TTL skip 30d.
- Scripts: house style (`[song-meta]` prefix, --dry-run, per-item try/catch, pool.end, require.main).
- Song identity: `songKey(artist, title)` = `lower(collapse-ws(trim(artist)))::lower(collapse-ws(trim(title)))` — note ARTIST first, and BOTH sides lowercased/collapsed (filmKey collapses only title; here both).
- Deezer throttle ≥250ms between calls in backfill; iTunes fallback calls sleep 3s.

---

### Task 1: Migration 004 + types + songMeta service

**Files:** Create `backend/src/db/migrations/004_song_meta.sql` (spec's CREATE TABLE verbatim), append same to `backend/src/db/init.sql`; extend both `types/index.ts`; create `backend/src/services/songMeta.ts` + test.

**Interfaces (produced, exact):**

```ts
export type SongRating = 'like' | 'dislike';
export interface SongUserMeta {
  listened: boolean; favorite: boolean; downloaded: boolean;
  rating: SongRating | null; score: number | null;
}
export interface SongMetaRecord extends SongUserMeta {
  songKey: string;
  deezerId: number | null; itunesId: number | null;
  genres: string[]; album: string | null; coverUrl: string | null;
  previewUrl: string | null; deezerUrl: string | null; itunesUrl: string | null;
  enrichedAt: string | null;
}
export interface SongMention { entryId: string; createdAt: string; }
export interface AggregatedSong {
  songKey: string; title: string; artist: string; album: string | null;
  youtubeUrl: string | null; spotifyUrl: string | null;
  mentions: SongMention[]; meta: SongMetaRecord | null;
}
// songMeta.ts
export function songKey(artist: string, title: string): string;
export type SongUserMetaPatch = Partial<SongUserMeta>;
export async function upsertSongEnrichment(input: { songKey: string; deezerId: number | null; itunesId: number | null; genres: string[]; album: string | null; coverUrl: string | null; previewUrl: string | null; deezerUrl: string | null; itunesUrl: string | null }): Promise<void>; // sets enriched_at = now()
export async function patchSongUserMeta(key: string, patch: SongUserMetaPatch): Promise<SongMetaRecord>;
export async function listSongMeta(): Promise<Map<string, SongMetaRecord>>;
export async function getSongMeta(key: string): Promise<SongMetaRecord | null>;
```

Implementation mirrors `filmMeta.ts` (ensure-row, dynamic SET with single-listened-assignment guard, row mapper). Tests mirror `filmMeta.test.ts` incl.: songKey cases (both sides normalized, numeric-free), rating⇒listened single assignment, `{listened:false, rating:'like'}` → one assignment `listened = true`, placeholder/params invariant on all patch shapes, enrichment upsert never touches user columns (word-bounded regex).

- [ ] TDD → scoped tests PASS → full backend + tsc both sides → commit `feat(music): song_meta table, types and persistence service`.

---

### Task 2: songEnrichment service (Deezer + iTunes fallback)

**Files:** Create `backend/src/services/songEnrichment.ts` + test.

**Interface:**

```ts
export interface SongEnrichmentResult {
  deezerId: number | null; itunesId: number | null; genres: string[];
  album: string | null; coverUrl: string | null; previewUrl: string | null;
  deezerUrl: string | null; itunesUrl: string | null;
}
export async function enrichSong(artist: string, title: string): Promise<SongEnrichmentResult | null>;
// null = found on neither provider. Provider HTTP errors: log + try next provider / return null (never throw — pipeline path).
```

Deezer: `GET https://api.deezer.com/search?q=${encodeURIComponent(`artist:"${artist}" track:"${title}"`)}` → first result: `id`, `link`, `preview`, `album.title`, `album.cover_medium`, `album.id`. Then `GET https://api.deezer.com/album/{album.id}` → `genres.data[].name` (failure → genres []). Empty `data` → fallback.
iTunes: `GET https://itunes.apple.com/search?term=${encodeURIComponent(artist + ' ' + title)}&media=music&limit=5&country=IT` → first result whose `artistName`/`trackName` loosely match (lowercase containment either direction) else first result: `trackId`, `trackViewUrl`, `artworkUrl100`, `previewUrl`, `collectionName`, `primaryGenreName` → genres [that one].
All URLs through `safeUrl`-equivalent. Deezer rate-limit response (`{"error":{"code":4}}`) → treat as provider error (log, fallback iTunes).

Tests (fetch stubbed): Deezer happy path incl. genre fetch; Deezer miss → iTunes fallback; both miss → null; Deezer album-genres failure tolerated; iTunes loose-match selection; URL validation drops `javascript:`; Deezer error code 4 → fallback; network throw → null (logged).

- [ ] TDD → PASS → full suite + tsc → commit `feat(music): deezer/itunes song enrichment service`.

---

### Task 3: Routes + pipeline hook + Spooty flag + backfill

**Files:** Create `backend/src/routes/songs.ts` + test; modify `backend/src/server.ts` (register), `backend/src/routes/analyze.ts` (hook), `backend/src/services/songResolver.ts` (downloaded flag); create `backend/src/scripts/backfillSongMeta.ts`.

- `GET /api/songs`: aggregate `results.songs` from `listEntries(10000)`, dedupe by `songKey(artist, title)` (skip songs without non-empty string title AND artist — both required for identity; song with missing artist: use `''` artist, still keyed), mentions newest-first, display fields from most recent mention, left-join `listSongMeta()`, malformed tolerated, 500 logged. Response `{ songs: AggregatedSong[] }`.
- `PATCH /api/songs/:songKey`: validate booleans, rating enum like|dislike|null, score int 0-100|null → `patchSongUserMeta` → `{ meta }`; 400 invalid.
- analyze.ts: where songs are persisted after resolution (both merged.songs and slide songs if separate — inspect the file; mirror the film hook placement): fire-and-forget async block — `getSongMeta(key)`, skip if `enrichedAt` fresh (30d, reuse `isStale`), else `enrichSong` → non-null → `upsertSongEnrichment`.
- songResolver.ts: where `sentToSpooty` becomes true, fire-and-forget `patchSongUserMeta(songKey(artist,title), { downloaded: true }).catch(logError)`.
- Backfill `backfillSongMeta.ts`: mirror `backfillStreaming.ts`; targets = deduped songs whose meta `enrichedAt` null/stale; 300ms sleep; counts enriched/miss/errors.

Tests: route GET dedup/meta join/malformed + PATCH validation matrix (mirror films.test.ts); spooty flag call asserted with mocked songMeta in songResolver.test.ts (extend existing file); hook covered via unit tests of predicates (no analyze harness — same accepted approach as films).

- [ ] TDD → full backend suite + tsc → commit `feat(music): songs API, pipeline enrichment hook, spooty flag and backfill`.

---

### Task 4: Frontend

**Files:** Create `frontend/src/utils/songFilters.ts` + test, `frontend/src/components/SongCard.tsx` (+ test for exported pure helpers if any); modify `frontend/src/pages/SongsPage.tsx` (rework), `frontend/src/services/api.ts`, `frontend/src/i18n/translations.ts`, `frontend/src/styles/index.css`. Read FilmsPage/FilmCard first — same skeleton, same seq-guard optimistic pattern (duplicate the small applyPatch logic; do NOT refactor FilmsPage in this task).

- `api.ts`: `fetchSongs(): Promise<AggregatedSong[]>`, `patchSongMeta(songKey, patch: SongMetaPatchBody): Promise<SongMetaRecord>` where `SongMetaPatchBody = { listened?: boolean; favorite?: boolean; downloaded?: boolean; rating?: 'like'|'dislike'|null; score?: number|null }`.
- `songFilters.ts`: `filterSongs(songs, { genres: string[]; listened: 'all'|'listened'|'unlistened'; favorite: boolean; downloaded: 'all'|'yes'|'no' })` + `collectGenres` (reuse pattern; genre OR; missing meta = unlistened/not-favorite/not-downloaded). Tested truth table.
- SongsPage rework (keep Header/stats behavior as-is): fetch + seq-guarded optimistic `applyPatch` + `mergePatch` (exported, tested — mirror FilmsPage.test.ts cases with listened instead of watched, plus favorite/downloaded passthrough).
- SongCard row: cover (`meta.coverUrl` else 🎵), title + artist (+ album muted), genre badges, slider block `👎 [slider] 👍 n%` reusing `.rating-slider` CSS and `ratingFromScore` (maps to like/dislike), 👂 listened toggle title-adjacent (`.watched-toggle` class reuse), ⭐ favorite toggle, downloaded badge/toggle (Spooty icon `⬇`, active when downloaded), direct badges: Deezer (`meta.deezerUrl`), Apple Music (`meta.itunesUrl`), YouTube search (existing `youtubeUrl` or generated), preview ▶ button with a single shared `<audio>` (component-local; pause any playing when another starts — module-level ref acceptable), mentions ×N link.
- i18n (both locales): `songsFilterListened` 'Ascoltate'/'Listened', `songsFilterUnlistened` 'Da ascoltare'/'To listen', `songsFilterFavorites` 'Preferite'/'Favorites', `songsFilterDownloaded` 'Scaricate'/'Downloaded', `songsMarkLike` 'Mi piace'/'Like', `songsMarkDislike` 'Non mi piace'/'Dislike', `songsMarkListened` 'Segna come ascoltata'/'Mark as listened', `songsMarkFavorite` 'Preferita'/'Favorite', `songsMarkDownloaded` 'Scaricata (Spooty)'/'Downloaded (Spooty)', `songsPreview` 'Anteprima'/'Preview', `songsMentions` 'menzioni'/'mentions'. Reuse `filmsFilterAll` for 'Tutti'.
- Existing SongsPage tests (`SongsPage.test.ts`): keep/adapt exported helpers (`artistOf`, `dedupeKey`) only if still used; if the rework obsoletes them, migrate the tests to the new exported `mergePatch`/helpers rather than deleting coverage.

- [ ] TDD filters/mergePatch → implement → frontend vitest + tsc clean → commit `feat(music): dedup songs page with rating, flags, enrichment and filters`.

---

### Task 5: Verify + deploy + backfill

- [ ] Full suites + tsc both sides in worktree.
- [ ] Merge to main, bump minor (2.4.0), push.
- [ ] `docker exec -i soundreel-db psql -U soundreel -d soundreel < backend/src/db/migrations/004_song_meta.sql` BEFORE `.rebuild` (SELECT references new table).
- [ ] Deploy via `.rebuild`; verify GIT_REVISION + version.
- [ ] `node dist/scripts/backfillSongMeta.js --dry-run` then live in container; verify `/api/songs` carries meta; spot-check a known song.
