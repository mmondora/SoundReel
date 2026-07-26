# Streaming Availability — Direct Platform Links & Free/Paid Detection

**Date**: 2026-07-26
**Status**: Draft — awaiting user review

## Problem

Film cards show *search* links per platform (Netflix, Prime, …) and a manually-set
availability dot (free/paid/absent). The user wants real availability data: on which
platforms a film is actually available, whether each option is free, subscription,
rental or purchase (with price), and **direct links to the film's page** on each
platform instead of search links.

## Decisions (from brainstorming)

- **Provider**: Watchmode primary (free tier 1000 req/month is enough); Movie of the
  Night (RapidAPI) supported behind a config flag. Both implemented.
- **Fetch strategy**: automatic for new films in the analysis pipeline + one-off
  backfill for existing films + TTL refresh when data is older than 30 days.
- **Manual dots**: kept as user override. API data populates the badges; a manual
  dot state always wins visually until reset.

## Unified service contract

`backend/src/services/streamingAvailability.ts`

```ts
type StreamingOptionType = 'FREE' | 'SUBSCRIPTION' | 'RENTAL' | 'PURCHASE';

interface StreamingPlatformOption {
  platform: string;        // "Netflix", "RaiPlay", "Apple TV", ...
  type: StreamingOptionType;
  is_free: boolean;        // true only for FREE
  price: number | null;    // numeric for RENTAL/PURCHASE, null otherwise
  url: string;             // deep link to the film on the platform
}

async function getStreamingPlatforms(
  imdbId: string,
  countryCode: string,
  provider: 'watchmode' | 'movie_of_the_night'
): Promise<StreamingPlatformOption[]>;
```

Behavior:
- Movie not found on the provider → `[]` (not an error).
- HTTP/API failure → throw `Error` carrying status code + message; callers log and
  continue (pipeline resilience convention).
- No hardcoded titles; works for any IMDb id.

### Watchmode mapping (two-step)

1. `GET https://api.watchmode.com/v1/search/?apiKey=…&search_field=imdb_id&search_value={imdbId}`
   → first result whose `imdb_id` matches → `title_id`. The `title_id` is persisted
   (see storage) so refreshes skip this step.
2. `GET https://api.watchmode.com/v1/title/{title_id}/sources/?apiKey=…&regions={country}`
   → filter `region === countryCode`, map per source:
   - `free` → `FREE`; `sub` → `SUBSCRIPTION`; `rent` → `RENTAL`; `buy` → `PURCHASE`
   - other types (`tv_everywhere`, …) → **ignored** (documented choice: they are
     cable-login gateways, not actionable for this app)
   - `name` → platform, `web_url` → url, `price` → price
   - Dedupe: same platform+type keeps the lowest price.

### Movie of the Night mapping (single call)

`GET https://streaming-availability.p.rapidapi.com/shows/{imdbId}` with RapidAPI
headers → `streamingOptions[countryCode.toLowerCase()]`, map per option:
- `free`, `ads` → `FREE`; `subscription` → `SUBSCRIPTION`; `rent` → `RENTAL`;
  `buy` → `PURCHASE`; `addon` → `SUBSCRIPTION` (documented choice: included in an
  add-on plan the user may have); anything else → ignored
- `service.name` → platform, `link` → url, `price.amount` (number) → price

## Configuration (env vars)

- `WATCHMODE_API_KEY` — Watchmode key
- `MOVIE_OF_THE_NIGHT_API_KEY` — RapidAPI key
- `STREAMING_AVAILABILITY_PROVIDER` — `watchmode` (default) | `movie_of_the_night`
- `STREAMING_COUNTRY` — default `IT`
- Feature is OFF (no fetches, UI falls back to search links) when the selected
  provider's key is missing. Never hardcode keys.

## Storage

`film_meta` gains (migration `003_streaming_availability.sql`, additive):

```sql
ALTER TABLE film_meta
  ADD COLUMN IF NOT EXISTS streaming_options JSONB,          -- StreamingPlatformOption[]
  ADD COLUMN IF NOT EXISTS streaming_checked_at TIMESTAMPTZ, -- last successful check
  ADD COLUMN IF NOT EXISTS watchmode_title_id INTEGER;       -- cached IMDb→Watchmode resolve
```

- `streaming_options = '[]'` with `streaming_checked_at` set means "checked, not
  available anywhere" — distinct from `NULL` = never checked.
- Written only by the availability fetcher; user-state columns untouched.
- The manual `availability` column stays as-is (override semantics).

## Fetch orchestration

- **Pipeline hook** (analyze.ts, after TMDb enrichment which provides the IMDb id):
  fire-and-forget fetch + upsert, `.catch` → logError. Never blocks or fails analysis.
  Skipped when film has no IMDb id or data is fresher than the TTL.
- **Backfill/refresh script** `backend/src/scripts/backfillStreaming.ts`:
  targets = films in `film_meta` with an IMDb id (from entries' `imdbUrl` or TMDb id
  lookup) whose `streaming_checked_at` is NULL or older than 30 days. Rate-limited
  (1 req/s), `--dry-run`, idempotent, per-item try/catch, `[streaming]` log prefix,
  summary with API-call count (quota visibility).
- **TTL**: 30 days (`STREAMING_TTL_DAYS` env, default 30).
- Quota math (Watchmode free = 1000/month): ~128 films with IMDb id → initial
  backfill ≈ 256 calls (search+sources), monthly refresh ≈ 128 (title_id cached).

## API surface

- `GET /api/films` meta gains `streamingOptions: StreamingPlatformOption[] | null`
  and `streamingCheckedAt: string | null`.
- New `POST /api/films/:filmKey/refresh-streaming` — on-demand refresh for one film
  (used by a small refresh affordance on the card; respects provider config, ignores
  TTL). Returns updated meta. 404 when film has no IMDb id.

## Frontend

- When `streamingOptions` is non-null: platform badges render from the API data —
  direct link to the film, colored by type (FREE green, SUBSCRIPTION neutral,
  RENTAL/PURCHASE yellow with `€ price`). Platforms not in the data don't render
  badges (the film simply isn't there — that's the point).
- When `streamingOptions` is null (never checked / feature off): current behavior —
  search links for all six services.
- Manual dot: still rendered next to each badge; when set, its color wins over the
  API-derived one (override). Reset by cycling to unknown.
- Availability filter (`free`/`notfree`) uses, per film: manual marks where present,
  else API data (`is_free` on any option → free).
- Small "↻" affordance on the card triggers the on-demand refresh endpoint.

## Error handling

- Provider errors logged (`logWarning`/`logError`) with status + body snippet;
  pipeline and backfill continue.
- Quota exhaustion (HTTP 429 / Watchmode quota error): backfill aborts cleanly with
  a clear message (no point hammering); pipeline hook just logs.
- Unknown platform names pass through verbatim (no whitelist).

## Testing (all mocked — no real API calls)

- Service: Watchmode two-step happy path; imdb not found → `[]`; sources mapping
  incl. ignored types and price dedupe; Movie of the Night mapping incl. `ads`→FREE,
  `addon`→SUBSCRIPTION; HTTP error → thrown with status; provider selection by flag;
  missing key → feature-off behavior.
- Route: refresh endpoint (200 with updated meta, 404 no imdb id, 400 bad key).
- Backfill: target selection incl. TTL, quota-abort on 429, dry-run.
- Frontend: badge rendering from streamingOptions vs fallback, override precedence,
  filter logic with mixed manual/API data.

## Out of scope

- Historical price tracking, notifications on availability changes.
- Multi-country support in the UI (single `STREAMING_COUNTRY`).
- Replacing the manual availability system entirely.
