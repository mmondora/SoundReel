# Music Library Sync, Music-List Persistence & Filter Panel Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Checkbox steps.

**Goal:** (1) Songs from the music-list flows are persisted into entry `results.songs` (closing the orphan gap); (2) the `downloaded` flag reflects reality — a song present in the Spooty music share (`/home/mike/Music`, 500 MP3s, `Artist - Title.mp3`, subdirs = playlist/album) is auto-checked via normalized title/artist(/album) matching; (3) Films and Songs pages get the approved compact filter bar + panel GUI (search text, "Filtri (n)" button opening a panel with sections, removable active-filter chips).

**Architecture:** Backend: `musicLibrary.ts` service (scan + normalize + match), sync wired into GET /api/songs (throttled) + explicit endpoint; music-list persistence in `musicList.ts` route and `analyze.ts` auto block via a shared helper. Docker: `/home/mike/Music` mounted read-only at `/music` (env `MUSIC_LIBRARY_PATH`). Frontend: shared `FilterPanel` component used by both pages.

**Tech Stack:** as previous features. Templates: film/music code shipped this week.

## Global Constraints

- TS strict, no `any`; no ORM; mocked externals in tests (fs mocked via temp dirs or memfs-style stubs — node:fs allowed with tmp dirs in tests).
- Pipeline never blocked: persistence/sync failures logged, not fatal.
- `downloaded` remains user-togglable; library sync only ever sets false→true (never unsets a manual true).
- Song identity: existing `songKey`. Library matching normalization: lowercase, trim, collapse whitespace, strip trailing parenthetical suffixes `\s*\(.*\)$` and bracket suffixes `\s*\[.*\]$` from title for comparison (both sides), compare artist with containment either direction (filenames often list a single artist, tags may list several separated by `,`/`&`/`feat.`).
- i18n both locales for all new UI strings. Dark theme plain CSS.

---

### Task 1: Music-list persistence (backend)

**Files:** Modify `backend/src/routes/musicList.ts`, `backend/src/routes/analyze.ts` (music_list_auto block), `backend/src/types/index.ts` both sides (extend `Song['source']` union with `'music_list'` — check existing `source` usages with grep and update any exhaustive switch/labels), extend `backend/src/routes/musicList.test.ts`. Create shared helper in `backend/src/services/songPersistence.ts`.

**Interfaces:**
```ts
// songPersistence.ts
export function resolvedToSongs(resolved: ResolvedSong[]): Song[]; // maps to Song shape, source 'music_list', album null, addedToPlaylist false
export async function appendSongsToEntry(entryId: string, songs: Song[]): Promise<number>; // reads entry, dedupes by songKey against existing results.songs, appends, updateEntry; returns number appended; throws on db errors (callers catch/log)
```
- Both call sites: after `resolveSongs`, `appendSongsToEnry` → actionLog gains `songsPersisted: n`; then fire the SAME per-song enrichment hook used in analyze (extract that block into `backend/src/services/songEnrichmentHook.ts` `export function enqueueSongEnrichment(songs: Array<{artist: string|null, title: string}>): void` and reuse in all three places — analyze main flow, music_list_auto, musicList route).
- Tests: resolvedToSongs mapping; appendSongsToEntry dedup (existing song same key not duplicated, new appended, malformed results tolerated); musicList route now calls appendSongsToEntry (mocked) and logs count.

- [ ] TDD → full backend suite + tsc both sides → commit `feat(music): persist music-list songs into entries`.

---

### Task 2: Music library sync (backend + compose)

**Files:** Create `backend/src/services/musicLibrary.ts` + test; modify `backend/src/routes/songs.ts` (+test), `docker-compose.yml` (soundreel service: volume `/home/mike/Music:/music:ro`, env `MUSIC_LIBRARY_PATH: /music`).

**Interfaces:**
```ts
export interface LibraryTrack { artist: string; title: string; album: string | null; }
export async function scanLibrary(root?: string): Promise<LibraryTrack[]>; // recursive *.mp3; filename `Artist - Title.mp3` split on FIRST ' - '; files without ' - ' → title-only (artist ''); album = parent dir name when not root
export function normalizeForMatch(s: string): string; // lowercase, collapse ws, strip trailing (...) and [...]
export function libraryHasSong(tracks: LibraryTrack[], artist: string, title: string): boolean; // title normalized-equal AND (artist empty on either side OR containment either direction on normalized artists)
export async function syncDownloadedFlags(): Promise<{ scanned: number; matched: number; updated: number }>; // scan → aggregate songs (reuse songs.ts aggregation or listSongMeta+entries) → for each not-yet-downloaded song matching library → patchSongUserMeta(key, { downloaded: true }); never unsets
```
- `scanLibrary` returns [] with a logWarning when `MUSIC_LIBRARY_PATH` unset or unreadable (feature off).
- `routes/songs.ts`: GET /api/songs triggers `void syncDownloadedFlags()` fire-and-forget, throttled module-level to once per 10 minutes; plus `POST /api/songs/sync-library` → runs sync, returns counts (for the UI/manual trigger).
- Tests: scanLibrary against a tmp dir fixture (nested dirs, weird names, no ' - '); normalizeForMatch cases ('Where Is My Mind? (2007 Remaster)' ≡ 'Where Is My Mind?'); libraryHasSong artist containment ('Kanye West' vs 'Kanye West, Pusha T'); syncDownloadedFlags with mocked deps (sets only false→true); route throttle (module reset helper) + sync endpoint counts.

- [ ] TDD → full backend suite + tsc → commit `feat(music): auto-detect downloaded songs from the music share`.

---

### Task 3: Filter panel redesign (frontend, both pages)

**Files:** Create `frontend/src/components/FilterPanel.tsx`; modify `frontend/src/pages/FilmsPage.tsx`, `frontend/src/pages/SongsPage.tsx`, `frontend/src/utils/filmFilters.ts` + `songFilters.ts` (+tests: add `text` search field), `frontend/src/i18n/translations.ts`, `frontend/src/styles/index.css`.

Approved GUI (user-selected mockup):
- Top bar: 🔍 text input (searches title/artist/director/cast/album as available per page), visible result count, `Filtri (n)` button (n = active non-default filters).
- Active filters shown as removable chips (`[Thriller ×] [Non visti ×]`) under the bar; click × removes that one filter.
- Panel (overlay drawer, closes on × / backdrop click / Esc): sections with uppercase labels — Films: GENERE (chips multi), VISTO (radio Tutti/Visti/Non visti), DOVE (radio Tutti/Gratis/Non gratis); Songs: GENERE, ASCOLTO (Tutte/Ascoltate/Da ascoltare), PREFERITE (toggle), SCARICATE (Tutte/Sì/No). Buttons: Azzera (reset all) + Applica (apply & close). Filters apply live on change too — Applica just closes (keep it simple and honest: label it Chiudi if apply-on-change; decide: apply-on-change + single "Azzera" + close ×; drop Applica).
- `FilterPanel` is generic: props `{ open, onClose, sections: FilterSection[] }` with section types `{ kind: 'chips', options, selected, onToggle }` | `{ kind: 'radio', options, value, onChange }` | `{ kind: 'toggle', label, value, onChange }` — both pages compose it. Keep it dumb/presentational; state stays in pages.
- filterFilms/filterSongs gain `text: string` (case-insensitive containment over title+director+cast+genres / title+artist+album); tests updated.
- Films page keeps the Watchmode attribution footer. Old inline segments/chips rows removed.
- i18n: search placeholder, `Filtri`, `Azzera`, section labels (reuse existing where possible).

- [ ] TDD filters text-search → implement → frontend vitest + tsc → commit `feat(ui): compact filter bar with panel for films and songs`.

---

### Task 4: Verify + deploy

- [ ] Full suites + tsc both sides; merge to main; bump patch (2.4.1 — no schema change) — NOTE docker-compose.yml changed: deploy requires container recreate picking up the new volume (compose up -d does it via .rebuild flow; verify /music visible in container).
- [ ] Deploy, verify revision; POST /api/songs/sync-library → expect matched>0 given ~500 files; spot-check a known downloaded song shows ✓.
