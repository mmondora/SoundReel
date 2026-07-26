# Music Tracking — Per-Song State, Metadata Enrichment & Direct Links

**Date**: 2026-07-26
**Status**: Approved (brainstormed with user; implementation not yet planned)

## Problem

Songs extracted from social content are listed per-mention on SongsPage with search
links (YouTube) and Spooty hand-off, but no per-song user state, no genre, no cover
art, no direct platform links. The user wants the same treatment films received:
a deduplicated, filterable collection with quick actions and real metadata.

## Decisions (from brainstorming)

Per-song state (all four):
- **Rating slider** 0–100, identical to films: 🤢/🍅-style endpoints (here 👎/👍),
  outer zones derive the binary rating (<20 dislike, >80 like), explicit clicks win,
  mid-range keeps the current rating. Rating/score implies **listened**.
- **Listened / to-listen** flag (analogue of "watched"), filterable.
- **Downloaded (Spooty)** flag — set automatically when the pipeline/UI successfully
  sends the track to Spooty (`sentToSpooty` already exists in the flow); manually
  togglable for tracks downloaded out-of-band.
- **Favorite ⭐** flag, filterable — the "best of" list.

Metadata/links source: **Deezer primary, iTunes Search API fallback** (both free,
no API key, no OAuth — Spotify API remains blocked without Premium):
- Deezer: `GET https://api.deezer.com/search?q=artist:"X" track:"Y"` → track id,
  direct link (`link`), album title + cover (`album.cover_medium`), 30s preview
  (`preview`), artist; genre via `GET /album/{id}` (`genres.data[].name`).
- iTunes: `GET https://itunes.apple.com/search?term=…&media=music&limit=5&country=IT`
  → `trackViewUrl`, `artworkUrl100`, `primaryGenreName`, `previewUrl`.
- Fallback: song not found on Deezer → try iTunes. Neither → song stays as today
  (YouTube search link only). Provider errors logged, never fatal.

View: **SongsPage reworked in FilmsPage style** — one row per unique song, cover
art, genre badges, mention count ×N linking to entries, filter bar (genre chips,
listened all/listened/to-listen, favorites-only toggle, downloaded filter), quick
actions inline (slider, ⭐, 👂 listened, Spooty send/downloaded state).

## Architecture (mirrors the film feature 1:1 where possible)

### Identity

`song_key = lower(trim(artist)) || '::' || lower(trim(title))` (whitespace-collapsed,
same normalization as `filmKey`). Same accepted limitation: differing extracted
spellings produce separate keys; store provider ids for future consolidation.

### Database — new table `song_meta` (migration `004_song_meta.sql`)

```sql
CREATE TABLE IF NOT EXISTS song_meta (
  song_key TEXT PRIMARY KEY,
  -- enrichment (written by pipeline/backfill only)
  deezer_id BIGINT,
  itunes_id BIGINT,
  genres TEXT[] NOT NULL DEFAULT '{}',
  album TEXT,
  cover_url TEXT,
  preview_url TEXT,
  deezer_url TEXT,
  itunes_url TEXT,
  enriched_at TIMESTAMPTZ,
  -- user state (written by PATCH only)
  listened BOOLEAN NOT NULL DEFAULT false,
  favorite BOOLEAN NOT NULL DEFAULT false,
  downloaded BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('like','dislike')),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Rating/score non-null ⇒ `listened = true` (server-side, single SET — reuse the
lesson from `patchFilmUserMeta`: one watched-style assignment, placeholder/params
invariant test).

### Backend

- `services/songEnrichment.ts`: `enrichSong(artist, title)` → Deezer then iTunes,
  unified `{ deezerId, itunesId, genres, album, coverUrl, previewUrl, deezerUrl,
  itunesUrl }`; URLs validated `^https?:`; all fields nullable; errors logged not
  thrown to callers in the pipeline path.
- `services/songMeta.ts`: `songKey()`, `upsertSongEnrichment()` (enrichment columns
  only), `patchSongUserMeta()` (user columns only, availability-style partial
  semantics), `listSongMeta()`, `getSongMeta()`.
- Routes `routes/songs.ts`:
  - `GET /api/songs` — aggregate entries' `results.songs`, dedupe by `song_key`,
    mentions with entryId+createdAt, left-join `song_meta`, malformed tolerated.
  - `PATCH /api/songs/:songKey` — user state, validated, `{ meta }`.
- Pipeline hook (analyze.ts, where songs land in results): fire-and-forget
  enrichment upsert, skip when `enriched_at` fresh (30d TTL), never blocking.
- Spooty auto-flag: where the code currently reports `sentToSpooty: true`, also
  `patch downloaded = true` on song_meta (fire-and-forget).
- Backfill `scripts/backfillSongMeta.ts` — house style (`[song-meta]` prefix,
  dry-run, per-item try/catch, ~4 req/s max vs Deezer's 50 req/5s limit,
  pool.end, require.main).

### Frontend

- `utils/songFilters.ts` (mirrors filmFilters): genre OR-chips, listened filter,
  favorite-only, downloaded filter. Tested.
- SongsPage rework in FilmsPage's structure: fetch + optimistic patch with the
  same per-key seq-guard + scoped rollback pattern (extract the seq-guard/apply
  logic shared with FilmsPage into a small hook `useOptimisticMeta` if it stays
  readable; duplicate otherwise — implementer judgment).
- Song row: cover (fallback 🎵), title + artist, album, genre badges, ★-slider
  block (👎 [slider] 👍 n%), 👂 listened toggle (title-adjacent, prominent, like
  the film eye), ⭐ favorite, Spooty state (existing send action + downloaded
  badge), direct links: Deezer / Apple Music badges when known, YouTube search
  always, 30s preview play button (`<audio>`, one at a time).
- i18n both locales; plain CSS reusing film styles where classes are generic.

### Quota / limits

Deezer: 50 req/5s (public, no key) — backfill throttled to ~4 req/s is safe.
iTunes: ~20 req/min documented informally — it is the fallback only; backfill
sleeps 3s before each iTunes call. ~600 unique songs ≈ one afternoon of backfill
at worst; run once, then TTL refreshes only new songs.

## Error handling

Same conventions as films: every failure logged, pipeline never blocked, PATCH
validation → 400, optimistic UI rollback scoped per song.

## Testing

Mirror the film test suite shapes: songKey normalization; enrichment mapping per
provider (mocked fetch) incl. fallback order and URL validation; patch semantics
(rating⇒listened single-assignment, placeholder/params invariant); GET dedup +
malformed tolerance; filters truth table; slider derivation reuse (`ratingFromScore`
is generic — reuse as-is).

## Out of scope

- Spotify anything (blocked without Premium).
- Playlist management, cross-song dedup beyond song_key, audio fingerprint re-runs.
- Editing genres by hand.
