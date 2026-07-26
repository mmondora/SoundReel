# Streaming Availability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Real per-film streaming availability (direct links, FREE/SUBSCRIPTION/RENTAL/PURCHASE + price) from Watchmode (primary) or Movie of the Night, stored in `film_meta`, rendered as direct-link badges with manual-dot override, with pipeline hook, on-demand refresh and TTL backfill.

**Architecture:** New `streamingAvailability` service with unified `StreamingPlatformOption[]` contract; three new `film_meta` columns; fetch orchestration mirrors the TMDb enrichment pattern (fire-and-forget hook + idempotent backfill). Spec: `docs/superpowers/specs/2026-07-26-streaming-availability-design.md` — the spec governs on any detail this plan omits.

**Tech Stack:** Fastify + pg raw SQL, React + Vite, Vitest (all HTTP mocked), TypeScript strict both sides.

## Global Constraints

- TypeScript strict, no `any`; shared shapes in `types/index.ts` both sides.
- No real API calls in tests — `vi.stubGlobal('fetch', …)`.
- Pipeline steps never block/fail analysis (fire-and-forget + `.catch(logError)`).
- Feature OFF when the selected provider's env key is missing: no fetches, UI falls back to search links.
- Env: `WATCHMODE_API_KEY`, `MOVIE_OF_THE_NIGHT_API_KEY`, `STREAMING_AVAILABILITY_PROVIDER` (default `watchmode`), `STREAMING_COUNTRY` (default `IT`), `STREAMING_TTL_DAYS` (default `30`).
- `streaming_options`/`streaming_checked_at`/`watchmode_title_id` written ONLY by the availability code path; user-state columns (`watched`,`rating`,`score`,`availability`) never touched by it.
- Scripts follow house style: header doc comment, `[streaming]` log prefix, `--dry-run`, per-item try/catch, `pool.end()`, `require.main` guard (mirror `backfillFilmMeta.ts`).

---

### Task 1: Migration + types + service

**Files:**
- Create: `backend/src/db/migrations/003_streaming_availability.sql`
- Modify: `backend/src/db/init.sql` (add columns to the film_meta CREATE — keep migration/init in sync)
- Modify: `backend/src/types/index.ts`, `frontend/src/types/index.ts`
- Create: `backend/src/services/streamingAvailability.ts`
- Create: `backend/src/services/streamingAvailability.test.ts`

**Interfaces:**
- Produces (backend + frontend types):

```ts
export type StreamingOptionType = 'FREE' | 'SUBSCRIPTION' | 'RENTAL' | 'PURCHASE';

export interface StreamingPlatformOption {
  platform: string;
  type: StreamingOptionType;
  is_free: boolean;
  price: number | null;
  url: string;
}
```

  `FilmMetaRecord` gains: `streamingOptions: StreamingPlatformOption[] | null; streamingCheckedAt: string | null; watchmodeTitleId: number | null;` (both sides; backend row mapper converts Date → ISO string).
- Produces (service):

```ts
export type StreamingProvider = 'watchmode' | 'movie_of_the_night';
export function activeProvider(): StreamingProvider;            // from env, default watchmode
export function streamingConfigured(): boolean;                  // key present for active provider
export interface StreamingLookupResult {
  options: StreamingPlatformOption[];
  watchmodeTitleId: number | null;  // set when watchmode resolved it (cache for later)
}
export async function getStreamingPlatforms(
  imdbId: string,
  countryCode: string,
  provider: StreamingProvider,
  cachedWatchmodeTitleId?: number | null
): Promise<StreamingLookupResult>;
```

Migration:

```sql
ALTER TABLE film_meta
  ADD COLUMN IF NOT EXISTS streaming_options JSONB,
  ADD COLUMN IF NOT EXISTS streaming_checked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS watchmode_title_id INTEGER;
```

Service implementation notes (the spec's mapping section governs):
- Watchmode: skip search step when `cachedWatchmodeTitleId` provided. Search result rows: pick first with matching `imdb_id`; none → `{ options: [], watchmodeTitleId: null }`. Sources: filter `region === countryCode`, map `free/sub/rent/buy`, ignore others, dedupe platform+type keeping lowest price, `web_url`→url.
- Movie of the Night: RapidAPI headers `x-rapidapi-key`, `x-rapidapi-host: streaming-availability.p.rapidapi.com`; 404 → empty result; `streamingOptions[country.toLowerCase()]`, map `free|ads`→FREE, `subscription`→SUBSCRIPTION, `rent`→RENTAL, `buy`→PURCHASE, `addon`→SUBSCRIPTION, else ignore.
- `is_free = type === 'FREE'`; price null unless RENTAL/PURCHASE numeric.
- Non-OK HTTP (except the documented not-found cases) → `throw new Error(\`<provider> <status>: <body snippet>\`)`.

Tests (fetch stubbed): watchmode 2-step happy path incl. mapping+ignored `tv_everywhere`+price dedupe; cached title_id skips search (assert single fetch); imdb miss → empty; sources 500 → throws with status; MotN mapping incl. ads/addon; 404 → empty; provider selection + `streamingConfigured()` false when key missing.

- [ ] Steps: migration+init.sql → types both sides → failing tests → service → `npx vitest run src/services/streamingAvailability.test.ts` PASS → `npx tsc --noEmit` both sides → commit `feat(streaming): availability service with watchmode and motn providers`.

---

### Task 2: Persistence + routes + pipeline hook

**Files:**
- Modify: `backend/src/services/filmMeta.ts` (+ test)
- Create: `backend/src/services/streamingRefresher.ts` (+ test)
- Modify: `backend/src/routes/films.ts` (+ test), `backend/src/routes/analyze.ts`, `backend/src/server.ts` (no change expected — routes already registered)

**Interfaces:**
- `filmMeta.ts` adds:

```ts
export async function upsertStreamingOptions(input: {
  filmKey: string;
  options: StreamingPlatformOption[];
  watchmodeTitleId: number | null;   // null preserves existing value (COALESCE)
}): Promise<void>;
```

  SQL: ensure-row INSERT … ON CONFLICT DO NOTHING, then `UPDATE film_meta SET streaming_options = $2::jsonb, streaming_checked_at = now(), watchmode_title_id = COALESCE($3, watchmode_title_id), updated_at = now() WHERE film_key = $1`. Row mapper + `SELECT_COLS` extended with the three new columns.
- `streamingRefresher.ts` (single choke point used by hook, route, backfill):

```ts
export interface RefreshInput { filmKey: string; imdbId: string; cachedTitleId?: number | null; }
export async function refreshStreamingForFilm(input: RefreshInput): Promise<StreamingPlatformOption[]>;
// throws when provider not configured or API fails; caller decides logging
export function extractImdbId(imdbUrl: string | null): string | null; // /tt\d+/ from the URL
export function isStale(checkedAt: string | null, ttlDays: number): boolean;
```

- `films.ts`:
  - GET response meta now carries the three new fields (comes free from the extended row mapper — verify test).
  - New `POST /api/films/:filmKey/refresh-streaming`: aggregate lookup for the film's `imdbUrl` (reuse the same aggregation helper or a targeted entries scan), 404 `{error}` when film unknown or no IMDb id, 503 when `!streamingConfigured()`, else `refreshStreamingForFilm` → `{ meta }` (fresh record via existing fetch). 500 with logError on API failure.
- `analyze.ts` both film sites: after the existing `hasEnrichmentData(tmdbResult)` upsert block, when `tmdbResult?.imdbId && streamingConfigured()` fire-and-forget `refreshStreamingForFilm({ filmKey: key, imdbId: tmdbResult.imdbId }).catch(err => logError('streaming refresh failed', { err: String(err) }))`. No TTL check needed here (film just analyzed; upsert is idempotent).

Tests: upsertStreamingOptions never touches user-state columns + COALESCE param shape; refresher happy path (mocks service + filmMeta) and not-configured throw; extractImdbId cases (`https://www.imdb.com/title/tt0405296/` → `tt0405296`, null, garbage); isStale (null → true, fresh → false, old → true); route: 404 no film, 404 no imdb, 503 unconfigured, 200 happy (mocked refresher), meta fields present in GET.

- [ ] Steps: failing tests → implement → scoped vitest PASS → full backend `npx vitest run` + `npx tsc --noEmit` → commit `feat(streaming): persistence, refresh endpoint and pipeline hook`.

---

### Task 3: Backfill/refresh script

**Files:**
- Create: `backend/src/scripts/backfillStreaming.ts`

Mirror `backfillFilmMeta.ts` structure exactly (header doc, `[streaming]` prefix, `--dry-run`, per-item try/catch, `pool.end()`, `require.main` guard). Logic: exit early with clear message when `!streamingConfigured()`. Targets: aggregate films from `listEntries(10000)` (dedupe by filmKey, capture imdbUrl) joined with `listFilmMeta()`; keep films with an IMDb id whose `streamingCheckedAt` is null or `isStale(…, STREAMING_TTL_DAYS)`. 1000ms sleep between films. Pass `cachedTitleId` from meta. Summary: enriched / empty / errors / API mode + provider. `--dry-run` lists targets without calls.

- [ ] Steps: implement → `npx tsc --noEmit` → commit `feat(streaming): TTL backfill script`.

---

### Task 4: Frontend

**Files:**
- Modify: `frontend/src/components/FilmCard.tsx`, `frontend/src/utils/filmFilters.ts` (+ test), `frontend/src/services/api.ts`, `frontend/src/i18n/translations.ts`, `frontend/src/styles/index.css`, `frontend/src/pages/FilmsPage.tsx`

**Interfaces:**
- `api.ts`: `refreshFilmStreaming(filmKey: string): Promise<FilmMetaRecord>` (POST, returns `data.meta`).
- `filmFilters.ts`: availability filter uses manual marks where any exist for the film, else API data: film is "free" when any manual mark is `free` OR (no manual marks AND any `streamingOptions[].is_free`); "notfree" when it has signal (manual marks or non-empty streamingOptions) and none free. Add/adjust tests for mixed cases.
- `FilmCard.tsx`:
  - When `meta.streamingOptions` non-null: render one badge per option — direct `url`, label = platform name, class by `type` (`stream-free` green / `stream-sub` neutral / `stream-paid` yellow), suffix `€ {price.toFixed(2)}` for RENTAL/PURCHASE with price. Platforms absent from the data get no badge. Keep the manual dot next to each rendered badge (keyed by a best-effort service match: lowercase platform name contains the service key's label — when no match, dot omitted); manual dot state, when set, overrides the badge color class.
  - When null: existing six search-link badges + dots unchanged.
  - Add small `↻` button (class `stream-refresh`) → `onRefreshStreaming` prop; disabled while in flight (local state); hidden when a `data-streaming-enabled` flag from the films payload is false — simpler: always show; on 503 response show nothing changed (toast pattern doesn't exist — silently no-op is acceptable, log to console).
- `FilmsPage.tsx`: wire `onRefreshStreaming={() => void refreshStreaming(film.filmKey)}` — implement `refreshStreaming` like `applyPatch` (seq-guarded server-meta replace; no optimistic change since nothing local changes until data arrives).
- i18n: `filmsRefreshStreaming` (it: 'Aggiorna disponibilità', en: 'Refresh availability'), `filmsStreamFree` (it: 'Gratis', en: 'Free') if needed for title attrs.
- CSS: `.stream-free { color/border green }`, `.stream-paid { yellow }`, `.stream-refresh` small ghost button.

- [ ] Steps: failing filter tests → implement all → `npx vitest run` + `npx tsc --noEmit` frontend → commit `feat(streaming): direct-link badges, refresh affordance, filter integration`.

---

### Task 5: Verification + deploy

- [ ] Full suites + tsc both sides.
- [ ] Merge to main, bump version (minor), push.
- [ ] Apply migration: `docker exec -i soundreel-db psql -U soundreel -d soundreel < backend/src/db/migrations/003_streaming_availability.sql`
- [ ] `touch .rebuild`, verify GIT_REVISION + version live.
- [ ] Backfill: requires `WATCHMODE_API_KEY` in `.env` + container restart — if absent, verify the script's graceful "not configured" exit inside the container and report to the user that the key unlocks the data.
