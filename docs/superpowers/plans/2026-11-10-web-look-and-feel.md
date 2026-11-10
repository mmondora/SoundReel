# The look and feel of the site: tokens, shell, views, per-user configuration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The site looks like Mondrop (yellow on black), uses the whole width (shell of the A direction), and every user can configure the view of the pages, the sections of the Home and the place of the Player, with Studio as the default view.

**Architecture:** One short file of design tokens (`tokens.css`) aligned with the app by a test; one layout route (`AppShell`: top bar, left rail, content, player bar) that every page lives in; the configuration is a small closed document per user, owned and validated by the server (`/api/me/prefs`), read by a provider on the client; the views (Studio, Bacheca, Home) are three renderings of the same data chosen from that document.

**Tech Stack:** React 18 + Vite + TypeScript (frontend, Vitest + Testing Library), Fastify + `pg` (backend, Vitest), plain CSS. No new dependency.

**Spec:** `docs/superpowers/specs/2026-11-10-web-look-and-feel-rethink-design.md` (§3.1 mockups, §3.2–3.3 Michele's answers L1–L6). ADR-0025 (tokens), ADR-0026 (configuration). The interactive mockup is the artifact linked in the spec (board E).

## Global Constraints

- Colours and forms are Mondrop's: accent `#FFD60A`, black `#000`, rows `#1C1C1E`, raised `#2C2C2E`, Home/Player gradient `#242945` → `#080911`, secondary text white at 72 %, pill fill white at 12 %, black text on the yellow, pill buttons, cards with corners 14–16 px. **No hex of the old green accent (`#3ddc97`, `rgba(61, 220, 151, …)`) in any stylesheet.** Dark only, no theme switch.
- Rule P: the client never decides a default or a list; the server answers the complete configuration. Texts in `i18n/translations.ts` (it + en). No new frontend dependency.
- Default view of every page: **Studio** (list on the left, detail on the right). Player default: **bottom**.
- Every phase ships with its tests; **no deploy without Michele's OK, one per deploy**; docs (CHANGELOG, ROADMAP, CLAUDE.md, spec) updated with each phase; the repo is public: no secret in any file.
- Backend and frontend suites stay green (baseline at the start: backend 2888, frontend 1053); `tsc --noEmit` clean on both.

## Review Focus

- A page that used to render `<Header />` must not render a second top bar inside the shell, and must not keep a `min-height: 100vh` that makes the shell scroll twice.
- The player bar must never start playback by itself and must not appear twice (hidden on `/player`).
- A saved configuration with a value the server no longer knows must fall back to the default, never break the page.
- The configuration of one user must never be readable or writable by another (`Remote-User` only, never a body or query field).
- A hand-written hex colour creeping back into a stylesheet (the green above, or any colour not made from the tokens).

---

## Phase P1 — tokens and shell

### Task 1: Design tokens and the test that keeps them aligned with the app

**Files:**
- Create: `frontend/src/styles/tokens.css`, `frontend/src/styles/tokens.consistency.test.ts`
- Modify: `frontend/src/styles/index.css` (`:root` legacy variables defined from the tokens), every stylesheet that hard-codes the old green (about 64 places).
- Test: `frontend/src/styles/tokens.consistency.test.ts`

**Interfaces:**
- Produces: custom properties `--mp-accent`, `--mp-on-accent`, `--mp-bg-top`, `--mp-bg-bottom`, `--mp-system-bg`, `--mp-system-bg-2`, `--mp-system-bg-3`, `--mp-error`, `--mp-secondary-opacity`, `--mp-pill-fill-opacity`, `--mp-card-fill-opacity`; the legacy variables (`--bg-primary`, `--bg-card`, `--bg-hover`, `--text-secondary`, `--accent`, `--accent-hover`, `--accent-soft`, `--border`…) defined from them.

- [ ] Test `tokens.consistency.test.ts`: reads `ios/MondropKit/MondropPalette.swift`, converts each `RGB(r, g, b)` of `accent`, `backgroundTop`, `backgroundBottom`, `error`, `onAccent`, `systemDarkBackgrounds` and the three opacities to hex, and expects the same value in `tokens.css` for the matching `--mp-*` property; expects every legacy variable of `:root` in `index.css` to be `var(--mp-…)`/`rgba(var…)` and no `--*: #hex` outside `tokens.css`; expects **no** `#3ddc97` or `61, 220, 151` in any file under `frontend/src/styles/`.
- [ ] Run it: FAIL (no `tokens.css`).
- [ ] Write `tokens.css` and redefine the legacy variables; replace the hard-coded greens in the stylesheets with `var(--accent)` / `rgba(255, 214, 10, α)` (success states keep `--success`).
- [ ] Run the test and the whole frontend suite: PASS. Commit.

### Task 2: The shell (top bar, rail, content, player bar)

**Files:**
- Create: `frontend/src/components/shell/AppShell.tsx`, `TopBar.tsx`, `Rail.tsx`, `PlayerBar.tsx`, `frontend/src/hooks/useJournalStats.ts`, `frontend/src/styles/shell.css`, tests `AppShell.test.tsx`, `PlayerBar.test.tsx`, `Rail.test.tsx`
- Modify: `frontend/src/App.tsx` (a layout route around every page), the ten pages that render `<Header />` (Admin, EntriesPage, FilmsPage, Home, LibraryPage, NotesPage, PlaylistManagerPage, SoftwarePage, SongsPage, StatsPage: remove it), `frontend/src/components/Header.tsx` (deleted once nothing imports it), `frontend/src/i18n/translations.ts`.

**Interfaces:**
- Consumes: `usePlayer()` (`current`, `playing`, `currentTime`, `duration`, `toggle`, `next`, `previous`, `seek`, `queueLabel`), `fetchJournalStats()`, `fetchMe()`.
- Produces: `<AppShell />` (layout route: top bar + rail + `<Outlet />` + player bar); `useJournalStats(): JournalStats | null` (reloads on route change, as the old header did); `<PlayerBar />` (bottom dock; hidden on `/player`).

- [ ] Tests (Testing Library, `MemoryRouter`, mocked `services/api`): the rail lists Inbox, Link, Canzoni, Film, Software, Note, Player, Playlist, Statistiche with the counts (`1,7k` format kept) and marks the current route; the top bar has the brand with the version, the search box that writes `?q=` and clears it, the paste-link button, the user badge and the menu (Console, Prompts, Admin, Settings); the player bar shows the title/artist/time of `current`, the play button calls `toggle`, next/previous call theirs, the progress calls `seek`, and shows «niente in riproduzione» with no track; it is not rendered on `/player`; it never calls `toggle` on mount.
- [ ] Implement; move the nav and the menu of `Header.tsx` into `Rail`/`TopBar`; give the layout route in `App.tsx`; delete the ten `<Header />` uses and the file.
- [ ] Layout: content area scrolls inside the shell; `.list-page`, `.main-content`, `.list-page-content` lose their `min-height: 100vh` and the 800/820/900 px caps (a readable cap of 1180 px for list pages remains); the master–detail Inbox fills the area.
- [ ] Phone: at ≤ 760 px the rail becomes a row at the top, the top bar wraps, the player bar shrinks to title + play.
- [ ] Update the existing page tests that looked for the old header; full frontend suite + `tsc`: green. Commit.

### Task 3: Look at it

- [ ] Build; run the local replica (`scratchpad/songsview/server.mjs`) with the headless browser; screenshots at 1440 and 390 px of the Inbox, Link, Canzoni, Film, Playlist manager, Settings; compare with the mockup (board E); fix what is wrong. Save the pictures in the scratchpad.

### Task 4: Release P1 (2.21.0)

- [ ] Version bump, CHANGELOG, ROADMAP, CLAUDE.md (rules: tokens, shell), spec status; mutation run on the new tests (a colour test, the shell route, the player bar); ask Michele for the OK; deploy and post-deploy checks (read-only) only with it.

## Phase P2 — the configuration of the user (backend, can run in parallel with P1)

### Task 5: Table, service and routes

**Files:**
- Create: `backend/src/db/migrations/023_user_prefs.sql` (+ `init.sql`), `backend/src/services/uiPrefs.ts`, `backend/src/routes/uiPrefs.ts`, tests `uiPrefs.test.ts`, `routes/uiPrefs.test.ts`, `uiPrefs.int.test.ts`
- Modify: `backend/src/server.ts` (register the routes), `docs/` (a section in `docs/share.md`-style: `docs/ui-prefs.md`).

**Interfaces:**
- Produces: `UiPrefs` (`{ v: 1; views: { inbox: 'studio'|'wall'|'home'; links: 'studio'|'wall' }; home: { sections: Array<{ id: 'resume'|'songs'|'playlists'|'collections'|'films'; visible: boolean }> }; player: { dock: 'bottom'|'float'|'side'|'hidden'; float: { x: number; y: number } } }`, floats 0..1, default `{ x: 1, y: 1 }`); `defaultUiPrefs(): UiPrefs` (every view `studio`, sections in the order above all visible, dock `bottom`); `getUiPrefs(userId): Promise<UiPrefs>` (stored over defaults; an unknown stored value falls back to the default); `saveUiPrefs(userId, patch): Promise<UiPrefs | { error: string }>`; `resetUiPrefs(userId)`.
- Routes: `GET /api/me/prefs` → `{ prefs }`; `PUT /api/me/prefs` (partial, merged) → `{ prefs }`; `DELETE /api/me/prefs` → `{ prefs }` (defaults). The user is `Remote-User` only; no user → `GET` answers the defaults, `PUT`/`DELETE` answer `401`.

- [ ] Tests: defaults (Studio everywhere, Player bottom, five sections visible in order); a stored value merged over the defaults; a stored value the code no longer knows falls back; `PUT` accepts a partial document and answers the complete one; **`400` with the key named** for an unknown top-level key, a view not allowed for that page (`links: 'home'`), a section list that is not a permutation of the five ids, a dock that does not exist, a float outside 0..1, a document over 4 KB; one user's save never changes another's; `DELETE` returns the defaults; no `Remote-User` → defaults / `401`; the user is never read from the body or the query.
- [ ] Integration test on a real Postgres (scratch database, `--no-file-parallelism`): upsert, merge, reset, two users, the migration applied twice.
- [ ] Implement; migration idempotent; `docs/ui-prefs.md` (the contract); CHANGELOG/ROADMAP/CLAUDE.md lines; mutation run on the validators.

## Phase P3 — views

### Task 6: The provider and the hook

**Files:** `frontend/src/services/api.ts` (`fetchUiPrefs`, `saveUiPrefs`, `resetUiPrefs`), `frontend/src/hooks/useUiPrefs.tsx` (`UiPrefsProvider`, `useUiPrefs()`), tests.
- Produces: `useUiPrefs(): { prefs: UiPrefs | null; loading: boolean; update(patch): Promise<void>; reset(): Promise<void> }`: reads once, draws the cached copy (`sessionStorage`, try/catch) while the answer is on its way, applies an `update` at once and rolls it back (with an error message) if the server refuses.
- [x] Tests: first paint from the cache, the server answer wins, optimistic update + rollback on `400`, no write when there is no user (anonymous). **Done 10 Nov (2.22.0):** also serial writes (one at a time, in order), a late answer never undoes a newer choice, `401` keeps the choice for the visit.

### Task 7: Studio, Bacheca and the switch

**Files:** `frontend/src/components/views/ViewSwitch.tsx`, `Wall.tsx` (the wall of cards + the closable detail panel), changes to `pages/Home.tsx` (Inbox) and `pages/EntriesPage.tsx` (Link), i18n, CSS, tests.
- The Studio view is the current master–detail restyled; the Bacheca is the grid of `CompactCard`-like cards with the media of the post in view; the switch is the segmented control of the mockup; choosing a view saves it (`update({ views: { inbox: 'wall' } })`).
- [x] Tests: the default is Studio; the switch changes the view and saves it; a saved `wall` opens as the wall; the wall's card opens the panel and the panel closes; both views show the same entries; the search and the filters work in both. **Done 10 Nov (2.22.0):** Inbox (Home · Studio · Bacheca) and Link page (Studio with the post on the right · Bacheca).

### Task 8: The Home view (sections) and its route

**Files:** `backend/src/services/webHome.ts`, `backend/src/routes/webHome.ts` (+ tests), `frontend/src/components/views/HomeSections.tsx` (+ tests).
- `GET /api/home` (Authelia user): ready-made sections `resume` (the latest posts), `songs` (new songs from the posts), `playlists` (the user's playlists, newest first, with `kind` and `origin`), `collections` (empty until ADR-0022 is built: the section is simply absent), `films`; the server decides what is in each and in which order of items; the client draws the sections in the order and visibility of the configuration (rule P). One failing section costs only itself.
- [x] Tests: each section's rules, an empty library, one section that fails, the user sees only what he can see (own + shared), the client skips an unknown section and keeps the order of the configuration. **Done 10 Nov (2.22.0):** `docs/web-home.md` is the contract.

### Task 9: Release P3 (2.22.0) — as Task 4. **Done 10 Nov, 15:26** (Michele's OK; rollback image `soundreel:2.21.0-rollback`; 229 read-only checks).

## Phase P4 — «Personalizza» and the movable Player

### Task 10: The panel — **done 10 Nov (2.23.0)**
- `PersonalizePanel.tsx`: where the Player is (four choices), the sections of the Home (switch + up/down), the memory of the views (read-only list), the colours (locked line). Saves through `update`. Tests: every control writes the right patch; the up/down order; the panel closes with Escape and returns focus.

### Task 11: The Player docks — **done 10 Nov (2.23.0)** (bottom, floating pill with grip + keyboard, right panel with the queue, hidden = a line in the menu; none on `/player`; bar on a phone for the pill and the panel)
- `PlayerBar` variants: bottom (done), side panel (cover, queue), floating pill dragged by its grip (pointer events, keyboard arrows move it, clamped to the window, saves `float` on release), hidden (one line in the rail). Tests: each dock renders in its place, drag saves a position within 0..1, the keyboard moves it, a window resize keeps it on screen.

### Task 12: Release P4 (2.23.0) — as Task 4. Built and tested 10 Nov; goes to production only with Michele's OK.
