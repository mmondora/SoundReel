# Raccolte (collections): phase 0 and phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The library sorts itself into collections (types, discovered themes, places) and the site shows them with a chip rail on «Link», a «Raccolte» page, a collection page with the venues a post names and «Apri in Maps» links (SoundReel **2.21.0**, site only).

**Architecture:** After each analysis, a queued best-effort step gives the entry a vector (`nomic-embed-text`), its places and venues (one dedicated `glm-4.7-flash` call, literal check in the text). A nightly pass regroups ALL vectors (centred on the library mean, centroid grouping), matches groups to existing collections by member overlap (ids and names inherited), names new ones from a seed list with hygiene, and applies the user's corrections last. The server answers the already-decided list (types and places are computed, themes are rows); the site only draws.

**Tech Stack:** Node 20 + Fastify + TypeScript + raw SQL (`pg`), Vitest; React + Vite + TypeScript; local Ollama through the gpu-router (`OLLAMA_URL`, never Claude); Postgres 17 (`REAL[]`, no pgvector).

**Spec:** `docs/superpowers/specs/2026-11-09-library-collections-auto-topics-design.md` (decisions C1–C18, §3.1 trial parameters, §4–§9). ADR-0022. Mockup `docs/superpowers/specs/assets/2026-11-09-collections-proposal.html`. Related, already built: `services/autoPlaylists*.ts` (same «second call, never blocks the analysis» shape; copy its wiring, store/memory-store split, kill switch, mutation practice).

## Global Constraints

- **Local only:** `nomic-embed-text` (vectors) and `glm-4.7-flash:q4_K_M` (names, places, venues) through `OLLAMA_URL` (the gpu-router); never Claude; nothing leaves the house. Kill switch `COLLECTIONS_AUTO=0` (stops discovery; existing collections stay).
- **No pgvector** (ADR-0001): vectors are `REAL[]`, compared in memory.
- **Rule P:** clients only draw. The server returns collections already ordered, with `views`, `defaultView`, chips per entry and `mapsUrl`. No client computes a collection or builds a Maps address (a test forbids it).
- **Site only** (Michele Q2 «no»): nothing for Mondrop.
- **Numbers (spec §5, §4.3):** born at **5** entries, «watching» at 3–4, dies below **3**; a new group inherits id and name of the old collection holding at least **half of that old collection's members**; at most **2 themes per entry** plus the parent; places: facet at ≥ **2** entries, combination (theme × place) at ≥ **5**, virtual `place:*` collection at ≥ **8**; ≤ **20** venues per entry; «Nuova» for **7** days; the rail shows at most **12**; trial values to start from (task 1 re-measures them): group cosine **0.42**, merge cosine **0.54** (= 0.42 + 0.12), vectors **centred on the library mean**, text prefix `clustering: `, batches of 32.
- **Seed list** (~30 Italian names, spec §4.5) lives in ONE place, `SEED_COLLECTIONS`; a name must be 1–3 words, letters only, with one of its words in ≥ 30 % of the members, else the dominant tag (≥ 50 %), else not published.
- **The place must appear in the text of the entry** (literal check after cleaning) and be in the gazetteer; a venue name must appear in the text, ≤ 20, no generic names; no coordinates anywhere.
- **`mapsUrl(name, place)`** = `https://www.google.com/maps/search/?api=1&query=` + `encodeURIComponent("name, place")` (just `name` when there is no place). No key, no call to Google.
- **Derived data:** collections can be rebuilt; only corrections (rename, merge, hide, `user_add`, `user_remove`) are original and survive every recompute. Entries are never modified.
- **Per user:** a user's collections are built on his own entries plus those shared with him (use the visibility helper `GET /api/entries` already uses). One user never sees another's entries.
- **Tests never call a real external source** (no Ollama, no network): inject deps like `AutoPlaylistDeps`. DB tests against a real Postgres only behind `COLLECTIONS_INT=1` (scratch container `pg-scratch`, never `soundreel-db`; recipe in `autoPlaylistStore.int.test.ts`).
- **Process:** TDD; mutation harness (`scratchpad/mut/mut_backend.py`) on every rule; Italian UI strings in `translations.ts` for `it` and `en`; commits with explicit paths; `scratchpad/secret_scan.py` before committing (public repo); never commit `.mcp.json`; **no deploy and no TestFlight without Michele's explicit OK, each time**; `/verify` reports UNMAPPED (no pregate policy), the full suites are the evidence.

## Review Focus

- An entry with too little text (55 of 1698) gets no vector and no theme, and still shows in the type collections. (task 5, task 8)
- The embedding service or the router is down or cold: the analysis is untouched, the step retries, the nightly pass works with the vectors it has. (task 4)
- Two nightly passes on unchanged data give the same collections, ids and names (no flicker); a pass after one new entry changes only what it must. (task 5, task 7)
- A hidden collection stays hidden, a renamed one keeps its name, a removed entry does not come back, a merged collection stays merged, through every recompute. (task 7)
- A user with no entries, or a family user whose entries are few: empty answers, no crash, nothing from another user. (task 8)
- A venue named «Osteria dell'Orto & Co.» or with accents gives a correct `mapsUrl`; the same venue in two posts is ONE row with two post links. (task 3, task 8)
- `?raccolta=<unknown id>` on «Link» shows an empty state with a way back, not a blank page. (task 10)

---

## File structure

Backend (`backend/src/`): `db/migrations/022_collections.sql` (+ `db/init.sql`), `services/embeddings.ts`, `services/collectionsParams.ts`, `services/collectionsStore.ts`, `services/entryPlaces.ts`, `data/places.ts`, `services/collectionsCluster.ts`, `services/collectionsNaming.ts`, `services/collectionsEngine.ts`, `services/collectionsView.ts`, `services/collectionsWiring.ts`, `routes/collections.ts`, `scripts/calibrateCollections.ts`, `scripts/backfillCollectionInputs.ts`, `scripts/rebuildCollections.ts`; each with its `*.test.ts`. Modify: `routes/entries.ts` (chips, places, venues), `services/jobQueueWorker.ts` (hook), `server.ts` (register routes, timer), `types/index.ts`.
Frontend (`frontend/src/`): `types/index.ts`, `services/api.ts`, `hooks/useCollections.ts`, `components/CollectionRail.tsx`, `components/CollectionChips.tsx`, `components/VenueList.tsx`, `pages/CollectionsPage.tsx`, `pages/CollectionPage.tsx`, `styles/collections.css`, `collections/ruleP.test.ts`; modify `pages/EntriesPage.tsx`, `components/Header.tsx`, `App.tsx`, `components/EntryCard.tsx`, `components/CompactCard.tsx`, `i18n/translations.ts`.

---

### Task 1: Phase 0, calibration inside the code

**Files:**
- Create: `backend/src/services/embeddings.ts`, `backend/src/services/embeddings.test.ts`, `backend/src/services/collectionsParams.ts`, `backend/src/scripts/calibrateCollections.ts`, `backend/src/services/collectionsCluster.ts` (only `centerAndNormalize`, `cosine`, `groupVectors` for now; grown in task 5)

**Interfaces:**
- Produces: `entryEmbeddingText(entry: { caption: string | null; results: { summary?: string | null; tags?: string[] } }): string | null`; `embedTexts(texts: string[], deps?: { post: (url: string, body: unknown) => Promise<{ embeddings: number[][] }> }): Promise<number[][]>`; `centerAndNormalize(vectors: Float32Array[]): { vectors: Float32Array[]; mean: Float32Array }`; `cosine(a: Float32Array, b: Float32Array): number`; `groupVectors(items: Array<{ id: string; vector: Float32Array }>, p: { groupTau: number; mergeTau: number }): Array<{ members: string[]; centroid: Float32Array }>` (items in date order); `COLLECTION_PARAMS` in `collectionsParams.ts` (every constant of the Global Constraints, with `absorbTau` and `minCoherence` to be set by this task).

- [ ] **Step 1: Write the failing tests** (`embeddings.test.ts`): `entryEmbeddingText` uses the summary (else the caption cut at 400), adds at most 12 tags without `#tag`, `@utente`, `#fyp`, `#viral`, `#perte`, `#foryou`, `#foryoupage`, `#reels`, `#instagram`, `#explore`, `#trending`, `#x` and any `@…`, is cut at 1400 characters, and returns `null` under 25 characters; `embedTexts` posts to `/api/embed` with model `nomic-embed-text`, every text prefixed `clustering: `, in batches of 32 (70 texts = 3 calls, results in order); `centerAndNormalize` gives unit vectors with the mean subtracted; `groupVectors` on three synthetic clusters (planted around three directions, 6 + 7 + 5 vectors, small noise) returns three groups with those members, and two nearly identical clusters merge.
- [ ] **Step 2: Run to see them fail:** `cd backend && npx vitest run src/services/embeddings.test.ts` → FAIL (modules missing).
- [ ] **Step 3: Implement** the signatures above; `groupVectors` = spec §3.1 (in date order each vector joins the group with the most similar centre if cosine ≥ `groupTau`, else opens one; then 3 passes moving every vector to the nearest centre; then merge centres with cosine ≥ `mergeTau` until none).
- [ ] **Step 4: Run to see them pass.**
- [ ] **Step 5: `calibrateCollections.ts`** (read-only CLI, no writes, takes a JSONL export of entries like `scratchpad/autopl/export_all.sql` produces: id, createdAt, caption, tags, summary): embeds, centres, groups with a sweep of `groupTau` in {0.35, 0.38, 0.42, 0.45, 0.48} and prints per value: groups ≥ 5, coverage, largest, and for the **golden set** the group holding most of the keyword hits: «Vino» (≥ 12 entries mentioning vino/vitigni/cantina…), a restaurants group with ≥ 5 entries naming Milano, «Casa e design» ≥ 8. It also prints, for the three music-like groups the trial found (≈ 277, 164, 62 entries) and the film group (≈ 116), the cosine of their centres to the centre of the entries that have content songs, to choose `absorbTau`.
- [ ] **Step 6: Run it on the real library** (export read-only with `docker exec soundreel-db psql …`, never write): pick `groupTau`, `mergeTau`, `absorbTau`, `minCoherence` (mean cosine of members to their centre) so that the golden set holds and no pure-music group survives; write the chosen values into `collectionsParams.ts` and the measured table into spec §3.1 (a short «Calibrazione di fase 0» paragraph).
- [ ] **Step 7: Commit** `git add` the new files + the spec edit; `git commit -m "feat(backend): vectors, grouping and the calibration of the collections (phase 0)"`.

### Task 2: Migration 022 and the store

**Files:**
- Create: `backend/src/db/migrations/022_collections.sql`, `backend/src/services/collectionsStore.ts`, `backend/src/services/collectionsStore.int.test.ts`; Modify: `backend/src/db/init.sql` (append the same SQL)

**Interfaces:**
- Produces (spec §8 tables, exactly): `entry_vectors(entry_id PK → entries ON DELETE CASCADE, model, vector REAL[], text_hash, embedded_at)`, `entry_places(entry_id, place, kind, PK(entry_id, place))`, `entry_venues(entry_id, venue_key, name, kind, place, PK(entry_id, venue_key))`, `collections(id, owner_user, name, name_by, group_label, parent_id, state, origin, centroid REAL[], size, coherence, created_at, updated_at)`, `collection_entries(collection_id, entry_id, score, source, PK(collection_id, entry_id))`, all idempotent (`IF NOT EXISTS`). `interface CollectionsStore` with: `saveVector(entryId, model, vector: number[], textHash)`, `vectorsOf(userId): Promise<Array<{ entryId; createdAt; vector: Float32Array; textHash }>>`, `savePlacesAndVenues(entryId, places, venues)`, `placesOf(entryIds)`, `venuesOf(entryIds)`, `listCollections(userId)`, `saveCollections(userId, rows)` (transaction: replaces the auto rows, keeps corrections), `membersOf(collectionId)`, `corrections(userId)`, and the correction writers `rename`, `merge`, `hide`, `unhide`, `addEntry`, `removeEntry`.

- [ ] **Step 1:** write `collectionsStore.int.test.ts` (skipped unless `COLLECTIONS_INT=1`): vectors round-trip as `Float32Array` and are replaced only when `textHash` changes; `user_remove` rows survive `saveCollections` and `user_add` rows too; hiding a collection survives; deleting an entry removes its vector, places, venues and membership (cascade); the SQL applies twice on a scratch database.
- [ ] **Step 2:** write the SQL and mirror it in `init.sql`; apply to a scratch DB twice (recipe: create DB on `pg-scratch`, `init.sql`, every migration, again).
- [ ] **Step 3:** implement `PgCollectionsStore` (raw SQL, `REAL[]` ↔ `Float32Array`).
- [ ] **Step 4:** run `COLLECTIONS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=… DB_USER=postgres DB_PASSWORD=… npx vitest run src/services/collectionsStore.int.test.ts` → PASS.
- [ ] **Step 5: Commit** (`feat(backend): the tables of the collections (migration 022) and their store`).

### Task 3: Places, venues and the Maps address

**Files:**
- Create: `backend/src/services/entryPlaces.ts`, `backend/src/services/entryPlaces.test.ts`, `backend/src/data/places.ts`

**Interfaces:**
- Produces: `PLACES: ReadonlyArray<{ name: string; kind: 'city' | 'region' | 'country'; aliases: string[] }>` (the Italian regions, the 107 provincial capitals, ~150 other big Italian towns, the countries and ~60 major world cities; aliases like «Milan» → «Milano»); `canonicalPlace(raw: unknown, text: string): string | null`; `isGrounded(name: string, text: string): boolean` (the same folding as `softwareExtraction.isGrounded`: case, accents, punctuation, spaces; a name of fewer than 4 letters must be a whole word); `parsePlacesAndVenues(raw: string, text: string): { place: { name: string; kind: string } | null; venues: Array<{ name: string; kind: string; place: string | null; key: string }> }` (≤ 20 venues, no generic names such as «il locale», «ristorante», no duplicate key); `venueKey(name: string, place: string | null): string`; `mapsUrl(name: string, place?: string | null): string`; `generatePlacesAndVenues(source: { caption; summary; tags; notes; transcript?; ocr? }, deps?): Promise<{ place; venues } | null>` (one call, `PLACES_SCHEMA`, `think: false`, never throws).

- [ ] **Step 1: Tests:** «Milan» → «Milano»; «#Milano» → «Milano»; a place the model returns but the text does not contain («Montagne de Reims») → `null`; a place outside the gazetteer → `null`; broken JSON → no place, no venues; a venue name not in the text is dropped; «un ristorante» and «il locale» are dropped; 25 venues → 20; the same venue twice → one; `mapsUrl("Trattoria dei Navigli", "Milano")` equals `https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano`; `mapsUrl("Osteria dell'Orto & Co.", null)` encodes `'` and `&`; `venueKey` is the same for «Caffè  della Stazione» and «caffe della stazione», different for another city.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement (prompt in Italian, two examples: a post «ecco i ristoranti nuovi da provare su Milano» with three names → place Milano + three venues; a post that names a place and no venues → venues `[]`). **Step 4:** run → PASS.
- [ ] **Step 5: Commit** (`feat(backend): places and venues read from the text, and the Maps address`).

### Task 4: The inputs after every analysis, and the backfill

**Files:**
- Create: `backend/src/services/collectionsWiring.ts`, `backend/src/services/collectionsWiring.test.ts`, `backend/src/scripts/backfillCollectionInputs.ts` (+ `.test.ts`); Modify: `backend/src/services/jobQueueWorker.ts`

**Interfaces:**
- Consumes: `entryEmbeddingText`, `embedTexts` (task 1), `generatePlacesAndVenues` (task 3), `CollectionsStore` (task 2).
- Produces: `processEntryInputs(entryId: string, deps: InputsDeps): Promise<'done' | 'no_text' | 'pending'>` (vector when the text hash changed, places and venues once per text hash; any failure → `pending`, never throws); `onEntryAnalyzedForCollections(entryId: string, deps?): Promise<void>` (serialised chain, `COLLECTIONS_AUTO=0` → nothing, never rejects, never awaited by the worker).

- [ ] **Step 1: Tests:** an entry under 25 characters → `no_text`, nothing stored; the same text twice embeds once; a changed text embeds again; the embedding service throwing → `pending`, places still attempted, no exception escapes; `COLLECTIONS_AUTO=0` does nothing; two calls overlap never; the worker hook is called once after a good analysis and **not awaited** (copy the three tests of `jobQueueWorker.autoPlaylists.test.ts`, including «a model that never answers does not hold the Instagram slot»).
- [ ] **Step 2:** run → FAIL. **Step 3:** implement; add the hook in the worker next to `onEntryAnalyzed`. **Step 4:** run → PASS.
- [ ] **Step 5: `backfillCollectionInputs.ts`:** resumable (skips entries whose hash matches), `--dry-run` default prints counts only, `--apply` writes, `--limit N`; ~30 minutes for 1700 entries, in the container after deploy.
- [ ] **Step 6: Commit** (`feat(backend): vector, places and venues for every analysed entry`).

### Task 5: Grouping rules: ids, birth and death, themes per entry, music absorption

**Files:**
- Modify: `backend/src/services/collectionsCluster.ts`; Create: `backend/src/services/collectionsCluster.test.ts`

**Interfaces:**
- Consumes: `groupVectors`, `cosine`, `COLLECTION_PARAMS` (task 1).
- Produces: `matchToExisting(groups: Group[], existing: Array<{ id: string; memberIds: string[] }>): Array<{ group: Group; inheritsId: string | null }>` (a group inherits the id of the old collection with which it shares most members, when those are ≥ 50 % of the OLD members; each old id inherited once); `decideState(size: number, previous: 'watching' | 'active' | null): 'watching' | 'active' | 'gone'` (born at 5, `watching` at 3–4, `gone` below 3, an `active` one stays active at 3–4); `assignThemes(vector: Float32Array, centroids: Array<{ id: string; centroid: Float32Array }>, tau: number): string[]` (≤ 2, best first, only those ≥ `tau`); `isTypeLike(centroid: Float32Array, typeCentroids: { music: Float32Array | null; films: Float32Array | null }, absorbTau: number): 'music' | 'films' | null`; `isCoherent(group, minCoherence): boolean`; `splitInChildren(group, p): Group[]` (≥ 60 members and sub-groups of ≥ 8) and `mergeSame(collections)`.

- [ ] **Step 1: Tests (pure, synthetic vectors):** 4 members → `watching`, 5 → `active`, an active one with 4 stays `active`, with 2 is `gone`; unchanged data twice → identical ids; a group that gained two members keeps its id; a group sharing 40 % of an old collection does not inherit, 50 % does; a split into two groups: the larger overlap keeps the id, the other is new; an entry near two centroids gets both (and never three); a group close to the music centre is `'music'` (not a theme), one far away is `null`; an incoherent blob is not coherent; a group of 70 with two sub-groups of 20 splits into children, one of 70 without structure does not.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement. **Step 4:** run → PASS. **Step 5:** add the mutation spec `scratchpad/mut/muts_collections.json` (birth 5→4, death 3→2, overlap 0.5→0.3, themes 2→3, absorption off, hysteresis off) and run `python3 mut_backend.py muts_collections.json` → every mutation KILLED.
- [ ] **Step 6: Commit** (`feat(backend): the rules that make a collection be born, stay and die`).

### Task 6: Names

**Files:**
- Create: `backend/src/services/collectionsNaming.ts`, `backend/src/services/collectionsNaming.test.ts`

**Interfaces:**
- Produces: `SEED_COLLECTIONS: ReadonlyArray<{ name: string; group: string }>` (spec §4.5, 30 names with their headings; `Tipi (virtuali)` names excluded from naming); `canonicalName(raw: unknown): string | null` (strips `#@"*`, maps `Intelligenza_artificiale` / `IntelligenzaArtificiale` to the exact seed name); `chooseName(candidate: string | null, members: Array<{ text: string; tags: string[] }>): { name: string; fromSeed: boolean } | null` (seed → accepted; new name accepted only if 1–3 words, letters only, one of its words in ≥ 30 % of the members, not «Post»/«Contenuti»/«Varie»; else the tag shared by ≥ 50 % of the members; else `null`); `buildNamingPrompt(sample: string[], tags: string[], existing: string[]): string`; `parseNaming(raw: string): { label: string | null; parent: string | null }`; `nameGroup(group, deps): Promise<{ name: string; group: string | null } | null>` (never throws).

- [ ] **Step 1: Tests with the real failures of the trial:** `#Vini italiani` → «Vino» when the model picked it from the list; `Intelligenza_artificiale` → «Intelligenza artificiale»; `Modafair` (invented, no word in the members) → `null`, then the dominant tag `#vino` → «Vino»; `Tinitus` and a JSON-broken answer → `null`; a user-renamed collection is never named again (`name_by = 'user'`).
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5: Commit** (`feat(backend): names for the collections: a seed list, hygiene, evidence`).

### Task 7: The engine, the corrections and the rebuild script

**Files:**
- Create: `backend/src/services/collectionsEngine.ts`, `backend/src/services/collectionsEngine.test.ts`, `backend/src/scripts/rebuildCollections.ts` (+ `.test.ts`); Modify: `backend/src/services/collectionsWiring.ts` (nightly timer, `COLLECTIONS_AUTO`)

**Interfaces:**
- Consumes: tasks 1, 2, 5, 6. Produces: `consolidate(userId: string, deps: EngineDeps): Promise<ConsolidationResult>` (loads vectors of the user's visible entries, centres, groups, absorbs music/film-like groups, matches ids, decides states, names the new ones, splits and merges, assigns ≤ 2 themes per entry, then applies corrections: `hidden` stays hidden, `merged` stays merged, `name_by='user'` keeps the name, `user_remove` rows never rejoin, `user_add` rows never leave; saves); `assignOne(userId, entryId, deps): Promise<string[]>` (the fast path: add to existing collections, never removes); `rebuildPreview(userId, deps): Promise<Array<{ id: string | null; name: string; size: number; state: string; memberIds: string[] }>>` (no write; this is what the golden check reads).

- [ ] **Step 1: Tests with an in-memory store:** two passes on unchanged data → identical result (ids, names, members); one new entry near the «Vino» centroid joins it (fast path) and the next pass keeps the id; a renamed collection keeps its name after a pass; a hidden one stays hidden; a removed entry does not come back; an added entry stays after the group changes; a user with no vectors → empty result, no crash; a naming failure leaves the group `watching` (not published) and the next pass retries; collections of two users never mix.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5:** `rebuildCollections.ts`: `--dry-run` default prints the preview and the golden-set checks of spec §9 as PASS/FAIL lines (Vino ≥ 12, a Ristoranti theme with place Milano ≥ 5, Casa e design ≥ 8, no theme mostly Musica/Film, no name with `#@"*`, no place missing from its text); `--apply` writes. **Step 6:** extend the mutation spec (corrections ignored, hysteresis, user_remove rejoin) → KILLED. **Step 7: Commit** (`feat(backend): the nightly consolidation of the collections and its corrections`).

### Task 8: The view layer and the routes

**Files:**
- Create: `backend/src/services/collectionsView.ts` (+ `.test.ts`), `backend/src/routes/collections.ts` (+ `.test.ts`); Modify: `backend/src/routes/entries.ts`, `backend/src/server.ts`, `backend/src/types/index.ts`

**Interfaces:**
- Produces (spec §8): `GET /api/collections` → `{ collections: Array<{ id; name; kind: 'type' | 'theme' | 'place'; group: string | null; parentId: string | null; count: number; isNew: boolean; thumbs: string[]; views: Array<'grid' | 'list' | 'play'>; defaultView: 'grid' | 'list' | 'play' }> }` (server order: new first, then active in the last 14 days, then size; types `type:music|films|software|places|books` computed from `results`; `place:<slug>` at ≥ 8); `GET /api/collections/:id?dove&fonte&q&offset&limit` → `{ collection; why: { words: string[]; entryIds: string[] }; facets: { places: Array<{ name; count }>; sources: Array<{ platform; count }>; months: Array<{ month; count }> }; entries: EntrySummaryRow[] (+ `collections: Array<{ id; name }>`); venues: Array<{ key; name; kind; place: string | null; mapsUrl: string; posts: Array<{ entryId; sourceUrl; sourcePlatform; createdAt }> }>; total }`; `POST /api/collections/:id/{rename,merge,hide,unhide}`; `POST|DELETE /api/collections/:id/entries/:entryId`; `GET /api/entries?view=summary` rows carry `collections` (≤ 2 theme chips + the place); `GET /api/entries/:id` carries `places` and `venues` (with `mapsUrl`); `POST /api/admin/collections/rebuild?dry=1` (admin only, the preview of task 7).
- `defaultView`: `grid` when ≥ 60 % of the entries have a thumbnail, `list` otherwise, `play` for `type:music`; `views` adds nothing the data cannot fill (`play` only for music).

- [ ] **Step 1: Tests (deps injected like `HomeDeps`):** a user with no entries → `{ collections: [] }`; a family user sees only his; types count from `results` (719-style fixture: entries with songs → `type:music`); a theme row with 4 members is not listed (`watching`), with 5 it is; `isNew` true for 7 days; `place:milano` appears at 8 entries and not at 7; facet «Dove» lists places named by ≥ 2 entries; the same venue (same `venueKey`) in two posts is ONE row with two `posts`; `mapsUrl` on every venue; `hide` then list → gone, `unhide` → back; `merge` moves members and keeps the target's name; 401/404/400 shapes like the other routes; placeholder tags `#tag`, `@utente`, `#hashtag` are not in the chips.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5:** run the whole backend suite + `tsc` (no regressions in `entries.test.ts`). **Step 6: Commit** (`feat(backend): the collections routes: the list, a collection, corrections, venues with Maps`).

### Task 9: The binario (A) on «Link»

**Files:**
- Modify: `frontend/src/types/index.ts`, `frontend/src/services/api.ts`, `frontend/src/pages/EntriesPage.tsx`, `frontend/src/i18n/translations.ts`; Create: `frontend/src/hooks/useCollections.ts`, `frontend/src/components/CollectionRail.tsx`, `frontend/src/components/CollectionRail.test.tsx`, `frontend/src/styles/collections.css`

**Interfaces:**
- Produces: `fetchCollections(): Promise<CollectionListItem[]>`, `fetchCollection(id, query): Promise<CollectionPage>`, the correction calls; `useCollections(): { collections; loading; failed }`; `<CollectionRail collections selected onSelect />` (chips with name and count, «Nuova» pill, «Altre ▾» opens the page, ≤ 12 shown); `EntriesPage` reads `?raccolta=<id>&dove=<place>` and shows the entries of that collection via `fetchCollection` (otherwise the page as today), with the facet row «Dove / Fonte / Quando» when a theme is selected.

- [ ] **Step 1: Tests** (Italian forced with `localStorage.setItem('soundreel-language','it')`): the rail lists the chips in the server's order with counts; a tap sets `?raccolta=`; a second chip (a place) sets `&dove=`; tapping the selected chip clears it; «Nuova» shows on new ones; an unknown `?raccolta=` shows «Questa raccolta non c'è più» with a link back to «Tutte»; the existing text filter of «Link» still works; no network call for the rail on a phone-width render beyond the one list.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS), `npx tsc --noEmit`. **Step 5: Commit** (`feat(site): the rail of collections on «Link»`).

### Task 10: The «Raccolte» page (B) and the menu

**Files:**
- Create: `frontend/src/pages/CollectionsPage.tsx` (+ `.test.tsx`); Modify: `frontend/src/App.tsx` (`/collections`), `frontend/src/components/Header.tsx` (item «Raccolte» between Inbox and Link), `frontend/src/i18n/translations.ts`

**Interfaces:**
- Consumes: `useCollections` (task 9). Produces: cards with a 2×2 mosaic of `thumbs`, name, count, «Nuova»; grouped by `group` (the heading; no group → «Altre»); a strip «Nuove» (7 days); a field that filters the cards; «Nascoste» (to unhide) at the bottom.

- [ ] **Step 1: Tests:** headings come from `group`; a collection without `group` lands under «Altre»; the «Nuove» strip shows only `isNew`; the field filters by name without accents/case; fewer than 4 thumbs fill the mosaic with neutral tiles; an empty list shows «Nessuna raccolta ancora» and how they appear (5 posts on the same subject); the nav item is present and active on `/collections`.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5: Commit** (`feat(site): the «Raccolte» page`).

### Task 11: A collection (grid, list, play, venues, «why», corrections)

**Files:**
- Create: `frontend/src/pages/CollectionPage.tsx` (+ `.test.tsx`), `frontend/src/components/VenueList.tsx` (+ `.test.tsx`); Modify: `frontend/src/App.tsx` (`/collections/:id`)

**Interfaces:**
- Consumes: `fetchCollection`. Produces: header (name, count, «Nuova», menu ⋯: rename, merge into…, hide), `<details>` «Perché è qui?» (the `why` words and two entries), facet buttons from `facets`, a view switch drawn **only** from `views` (default `defaultView`), `<VenueList venues />` with one row per venue (name, kind, the posts that cite it, **«Apri in Maps»** = a plain `<a href={venue.mapsUrl} target="_blank" rel="noopener noreferrer">`).

- [ ] **Step 1: Tests:** the view switch shows exactly the views the server sent; `play` appears for `type:music` only; every venue link has the server's `mapsUrl` untouched and `rel="noopener noreferrer"`; a venue cited by two posts shows two post links; rename calls the API and updates the header; hide returns to «Raccolte»; «non è questo» on a chip removes the chip and keeps it removed after a reload (API call asserted); empty venues → no «Locali» section.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5: Commit** (`feat(site): a collection with its venues and «Apri in Maps»`).

### Task 12: The chips on the cards, and the rule that the client computes nothing

**Files:**
- Create: `frontend/src/components/CollectionChips.tsx` (+ `.test.tsx`), `frontend/src/collections/ruleP.test.ts`; Modify: `frontend/src/components/EntryCard.tsx`, `frontend/src/components/CompactCard.tsx`, `frontend/src/pages/EntriesPage.tsx`

**Interfaces:**
- Produces: `<CollectionChips entry onRemove />`: ≤ 2 theme chips + the place, then the real tags, at most 4 in all; the placeholder tags `#tag`, `@utente`, `#hashtag` never shown; `×` calls the remove-entry API.

- [ ] **Step 1: Tests:** placeholders hidden, real tags kept; the order (collection chips first); `×` removes only that chip; the tag filter of «Link» still matches a real tag. `ruleP.test.ts` reads every file under `frontend/src` (like `player/ruleP.test.ts`) and fails if one contains `google.com/maps`, builds a `maps/search` URL, or imports a clustering/embedding module.
- [ ] **Step 2–4:** run (FAIL), implement, run (PASS). **Step 5:** whole frontend suite + `tsc`. **Step 6: Commit** (`feat(site): collection chips on the cards, and a test that the site computes nothing`).

### Task 13: Release 2.21.0

**Files:**
- Modify: `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, spec status lines, `adr/0022-…md`, `adr/README.md`, `backend/package*.json`, `frontend/package*.json`, `README.md` badge (via `./scripts/bump-version.sh 2.21.0`, never piped into `head`); `scratchpad/postdeploy_check.py` (read-only checks)

- [ ] **Step 1:** full suites (backend, site) + `tsc` + `npx vite build`; mutation specs of tasks 5 and 7 all KILLED; `/verify` (UNMAPPED is expected, say so).
- [ ] **Step 2:** `scratchpad/secret_scan.py`, commit with explicit paths (code, then docs), no push yet.
- [ ] **Step 3: Ask Michele for the deploy OK** (`AskUserQuestion`). On yes: warm build (`docker compose build soundreel`), rollback image of the deployed commit, `touch .rebuild`, `scratchpad/postdeploy_check.py` (new read-only checks: migration 022 objects, `GET /api/collections` shape, `?sort` style 400s, a corrections round trip is NOT done in production), `history_scan.py` then push.
- [ ] **Step 4:** in the container: `node dist/scripts/backfillCollectionInputs.js --apply` (≈ 30 min), then `node dist/scripts/rebuildCollections.js` (preview: the golden-set lines must PASS), then `--apply` with Michele's OK for the first publication («Ho trovato N raccolte»); post-deploy docs commit and push.

---

## Self-review (done against the spec)

- Coverage: §3.1 and C0 → task 1; §8 data → tasks 2, 8; §4.3 places and §4.6 venues + Maps → tasks 3, 8, 11; §5 cycle → tasks 4–7; §5.5 names → task 6; §5.8 corrections → tasks 7, 8, 11, 12; §6.1 A → task 9; §6.2 B → task 10; §6.4 collection page → task 11; §6.5 chips and tags → task 12; §9 tests and golden set → tasks 5, 7, 12, 13; §10 phase 1 → all. Phase 2 (shelves C on the Home, search section, «Salvato in…», Telegram) and Mondrop are **out of this plan** (Michele: Mondrop no; C after A and B).
- Types: `Group`, `CollectionListItem`, `CollectionsStore`, `mapsUrl`, `venueKey`, `SEED_COLLECTIONS`, `COLLECTION_PARAMS` are defined once (tasks 1–3, 5, 6) and used under the same names later.
- Proportion: the plan is shorter than the spec; bodies are left to the implementer wherever the signature and the tests decide them.
