# Film Ratings, Genres, Availability & Filters — Design

**Date**: 2026-07-26
**Status**: Approved

## Problem

Films extracted from social content are listed per-mention on FilmsPage with no user state. The user wants to:

1. Mark films as watched with a Rotten Tomatoes-style rating (one-tap fresh/rotten, optional 0–100 score).
2. See each film's genre(s) (thriller, sci-fi, …).
3. Filter by genre and by watched/unwatched.
4. Flag per-service availability (e.g. "A Scanner Darkly on Prime only paid").

## Decisions (from brainstorming)

- **Rating**: binary fresh/rotten (one tap) + optional 0–100 score.
- **Availability**: per-service status — `free` | `paid` | `absent` per streaming service (unset = unknown).
- **Genres**: automatic from TMDb (official genre names), captured at analysis time + one-off backfill of existing films. Not user-editable.
- **Films view**: deduplicated — one row per film, with mention count linking back to entries. Filters at top.
- **Storage**: separate `film_meta` table (approach A). Entry JSONB (`results.films`) stays untouched.

## Architecture

### Film identity

`film_key = lower(trim(title)) || '::' || coalesce(trim(year), '')`

Computed identically in backend aggregation and upserts. Known limitation: same film with differing extracted titles across entries produces two keys. Accepted for a single-user app; `tmdb_id` is stored when known for future consolidation.

### Database

New migration (append to migration flow used by existing schema; also in `init.sql` for fresh installs):

```sql
CREATE TABLE IF NOT EXISTS film_meta (
  film_key TEXT PRIMARY KEY,
  tmdb_id INTEGER,
  genres TEXT[] NOT NULL DEFAULT '{}',
  watched BOOLEAN NOT NULL DEFAULT false,
  rating TEXT CHECK (rating IN ('fresh','rotten')),
  score SMALLINT CHECK (score BETWEEN 0 AND 100),
  availability JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

- `availability` shape: `{"netflix":"free","primeVideo":"paid",...}` — keys are the service ids already used in `StreamingUrls` (`netflix`, `primeVideo`, `raiPlay`, `now`, `disneyPlus`, `appleTv`); values `free|paid|absent`; missing key = unknown.
- Setting `rating` (or `score`) forces `watched = true` server-side. Clearing rating does NOT clear watched.

### Backend

**New route `backend/src/routes/films.ts`:**

- `GET /api/films`
  Aggregates all films from `entries.results->'films'`, dedups by `film_key`, left-joins `film_meta`.
  Response item: `{ filmKey, title, director, year, imdbUrl, posterUrl, streamingUrls, mentions: [{entryId, createdAt}], meta: { tmdbId, genres, watched, rating, score, availability } }`.
  Film display fields come from the most recent mention (it has the freshest enrichment).
- `PATCH /api/films/:filmKey`
  Body: partial `{ watched?, rating?, score?, availability? }`. Upserts `film_meta`. `rating: null` / `score: null` clear the field. `availability` is merged per-key; value `null` removes that service key. Validates enums; 400 on bad input.

**`filmSearch.ts` extension:**

- TMDb search response already contains `genre_ids`; movie detail call already made for IMDb id contains `genres` (names). Capture TMDb `id` + genre names.
- After successful film enrichment during analysis, upsert `film_meta (film_key, tmdb_id, genres)` — never touching user state columns (`ON CONFLICT ... DO UPDATE SET tmdb_id, genres, updated_at` only when genres were found).
- Failure to fetch/store genres never blocks the pipeline (log to actionLog per project convention).

**Backfill script `backend/src/scripts/backfillFilmGenres.ts`:**

- Iterate distinct films from entries missing genres in `film_meta`.
- TMDb search (title + year) → detail → genres + tmdb_id. Upsert.
- Rate-limited (~250ms between calls), idempotent, `--dry-run` support, logs misses.

### Frontend

**FilmsPage rework (dedup collection view):**

- Fetch `GET /api/films` via `services/api.ts` (new `fetchFilms()`); local state, optimistic updates on PATCH.
- Filter bar:
  - Genre chips built from genres present in data (multi-select, OR semantics).
  - Watched toggle: All / Watched / Unwatched.
  - Availability filter: All / Free somewhere / Paid-only or absent (any service marked non-free and none free).
- List rows: poster, title (year, director), genre badges, mention count `×N` linking to the most recent entry (existing `/?entry=` pattern), streaming badges.
- Quick actions per row:
  - 🍅 / 🤢 buttons — one tap sets rating (and watched); tapping the active one clears rating (watched stays).
  - Score: small `%` affordance next to rating opens inline number input (0–100), optional.
  - Watched: eye toggle for watched-without-rating.
  - Availability: each streaming badge keeps its existing link behavior (opens the service search URL). Next to each badge, a small state dot cycles on click: unknown → free → paid → absent → unknown. Visual: neutral / green / yellow / strikethrough-red. The dot, not the badge, owns state changes so navigation is never hijacked.
- i18n: new strings in both languages following existing `i18n` pattern.
- CSS: plain CSS additions in existing stylesheet, dark theme.

**FilmItem (journal entry card)**: unchanged this iteration (state lives on FilmsPage). YAGNI.

## Error handling

- PATCH failures roll back optimistic update and show existing toast/error pattern.
- GET aggregation tolerates malformed film objects in JSONB (skip, don't 500).
- TMDb errors in backfill/analysis logged, never fatal.

## Testing

- Backend (Vitest / node runner, mocks only — no real TMDb):
  - `film_key` normalization cases (case, whitespace, missing year).
  - GET dedup + meta join + malformed film tolerance.
  - PATCH validation, upsert semantics, rating⇒watched, availability merge/removal.
  - filmSearch genre capture with mocked TMDb responses.
  - Backfill script logic with mocked fetch + dry-run.
- Frontend (Vitest): filter logic (genre OR, watched, availability), rating toggle behavior.

## Out of scope

- Editing genres by hand.
- Consolidating differing titles of the same film.
- Ratings UI inside journal entry cards (FilmItem).
- Multi-user anything.
