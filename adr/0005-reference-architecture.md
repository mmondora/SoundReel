# ADR-0005: Reference Architecture for SoundReel + Mondrop (stack, data, identity, mobile)

## Status
Accepted for rows marked ✅ (late ADR — they record choices already in force). Rows marked ❓ are **Proposed** until Michele confirms them (see § 2.2).

## Date
2026-11-07

## Owners
Michele Mondora

## Related
- `CLAUDE.md` (stack + conventions), ADR-0001 … ADR-0004
- `docs/superpowers/specs/2026-11-07-multi-user-authelia-design.md`
- `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md`
- `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md`
- `docs/mondrop-auth.md`, `docs/share.md`, `ios/README.md`
- Hub-owned, outside this repo: `geekom-hub/traefik/dynamic/routers.yml`, `geekom-hub/authelia/config/configuration.yml`

---

## 1. Context
SoundReel started as a single-user web app. In a few weeks it grew a family-wide multi-user model (Authelia), a native mobile client (Mondrop: share extension + offline player), a Spooty-fed music library and a Tesla player. The stack was never written down as one decision: it lives in `CLAUDE.md`, in scattered specs and in hub config, and three questions (offline persistence on the phone, identity at steady state, platforms beyond Apple) were being settled implicitly in code.

This is a **late ADR** for everything already in force. It is the root document: it records the reference architecture, marks what is still open, and says which spec/ADR owns each layer, so new specs and ADRs are derived from here instead of re-deciding the stack.

## 2. Decision

### 2.1 Reference architecture (✅ in force)

| Layer | Choice | Notes |
|-------|--------|-------|
| Language (web + backend) | TypeScript, strict, no `any` | Shared shapes in `types/index.ts` |
| Backend | Node 20 + Fastify | Routes/services split; one `analyzeUrl` pipeline shared by web and Telegram; every step independent and logged in `actionLog` |
| Database | PostgreSQL 17, plain SQL via `pg` — **no ORM** | `backend/src/db/init.sql` + idempotent migrations in `backend/src/db/migrations`; settings in JSONB `config` rows; search = Postgres FTS (ADR-0001/0002), no vector DB |
| Web client | React + Vite SPA served by Fastify | Plain CSS, dark only, polling (no websockets) |
| AI | Self-hosted Ollama through gpu-router (vulcano → ArchiPC → GEEKOM) | Claude only as fallback when Ollama is down; OpenAI only for optional enrichment (ADR-0004); recognition via AudD / Shazam / Whisper |
| Runtime | Docker Compose on GEEKOM, behind Traefik | Deploy by `.rebuild` sentinel; routers and Authelia are hub-owned |
| Identity (web) | Authelia forward-auth (`auth-family`) → `Remote-User` | Ids `mike` / `archi` / `sara`; data scoped by `owner_user` |
| Identity (mobile, interim) | Per-device API key issued by the Authelia-gated page `/mondrop/connect` | Key bound to user + device; "Renew" revokes the previous one; `docs/share.md`, `docs/mondrop-auth.md` |
| Mobile client | Native Swift/SwiftUI (iOS 17+, macOS 14+), XcodeGen, Share Extension + App Group | Built and signed on vulcano (Xcode); `ios/project.yml` is the source of truth |
| Music files | Spooty (yt-dlp) writes into `/home/mike/Music`; SoundReel mounts it read-only | Filesystem is the truth (`inLibrary`); enqueue is fire-and-forget HTTP |
| Tests | Vitest (web, backend), XCTest (iOS) | Never call real external services |

### 2.2 Open decisions (❓ Proposed)

| # | Question | Proposal | Needs |
|---|----------|----------|-------|
| D1 | How does Mondrop persist the offline library? | **A**: files in App Group/Documents + a JSON manifest; the server stays the source of truth | Michele's confirmation |
| D2 | Mobile identity at steady state | **Keep per-device keys now; adopt OIDC Authorization Code + PKCE when Geeko enables the Authelia IdP**; keys stay as admin fallback | Geeko (IdP discovery was 404 on 2026-11-07) |
| D3 | Platforms beyond iOS/macOS | **LG TV (webOS) in the LAN → roadmap** (2026-11-07): first try plain DLNA from the media server, then a web/webOS app reusing the Mondrop API. Nothing else for now: the responsive web app covers the rest (Tesla, Android browsers) | Michele: still unknown which other platform "…e anche per o…" meant |

Decided with this ADR (✅): project ADRs live in `/adr`; hub infrastructure ADRs (Authelia IdP, Traefik routes) stay in `geekom-hub/decisions` and are only referenced here.

Decided by Michele on 2026-11-07 (✅, details in `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md`): the music store is the **Fritz!Box USB stick** (media server = Fritz for now) with **geekom as fallback**; downloads happen **server-side**, only for playlists and Sync; a song already present only on the Fritz is **served from there** (copied by SoundReel, not re-downloaded). On the roadmap: Navidrome, and moving the stick to geekom as the media server.

### 2.3 Which document owns which layer

| Layer | Owner |
|-------|-------|
| Search | ADR-0001, ADR-0002, ADR-0003 |
| Enrichment | ADR-0004 |
| Multi-user / Authelia | `docs/superpowers/specs/2026-11-07-multi-user-authelia-design.md` |
| Mobile identity + keys | `docs/mondrop-auth.md`, `docs/share.md` |
| Offline sync, Spooty, library | `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md` |
| Player (web / Tesla) | `docs/superpowers/specs/2026-11-05-player-hub-proposals.md` |
| TTS, MCP | `docs/tts.md`, `docs/mcp.md` |

## 3. Drivers
- Personal, family-scale app (3 users, one home server): operational simplicity and low maintenance beat scalability.
- Privacy: AI and data stay self-hosted; external models are fallback only.
- Devices are Apple (+ the Tesla browser): native features (Share Extension, background audio, App Group) matter more than code sharing.
- Reuse hub infrastructure (Authelia, Traefik, gpu-router) instead of building parallel ones.
- One developer plus AI agents: written decisions, specs and tests are the safety net.

## 4. Options Considered (open decisions)

### D1 — Offline persistence in Mondrop
- **A: files + JSON manifest (proposed)** — Pros: no schema or migrations on the device; AVPlayer plays file URLs directly; easy to inspect and delete; matches "sync playlist → files". Cons: no local queries (offline ratings/play counts would need extra handling); consistency code is hand-written. Cost: none.
- **B: SwiftData** — Pros: native relational store. Cons: duplicates the server data model; migrations and model churn; sharing a store with the Share Extension through the App Group is fiddly.
- **C: SQLite via GRDB** — Pros: full SQL, matches the backend mindset. Cons: a new dependency for no current need.

### D2 — Mobile identity at steady state
- **A: per-device keys via the Authelia-gated page (in force)** — Pros: works today, no IdP dependency. Cons: bearer secret without expiry; the key returns inside a custom URL scheme that iOS does not guarantee unique; no revocation UI.
- **B: OIDC Authorization Code + PKCE (`ASWebAuthenticationSession`), tokens in Keychain, JWT validated through JWKS** — Pros: standard, expiring, revocable. Cons: blocked until the IdP exists; more backend work.

### D3 — Platforms beyond iOS/macOS
- **A: Apple + responsive web, with the LG webOS TV app on the roadmap (proposed)** — no second *mobile* codebase; a webOS app is HTML/JS and can reuse the web player and the Mondrop API.
- **B: native Android** — a second codebase and share-intent work, with no concrete need today.
- **C: cross-platform rewrite (Flutter / React Native)** — rewrite cost and weaker Share Extension / App Group fidelity.

## 5. Decision Rationale
Same principle as ADR-0003 and ADR-0004: minimal footprint for a personal app. The ✅ rows are what already works in production and in the repo; rewriting them has no payoff. For the ❓ rows the proposals pick the smallest thing that satisfies today's needs (files + manifest, keys until an IdP exists, no extra platforms) and keep the upgrade path open (PKCE client, a local database) instead of building it speculatively.

## 6. Consequences

### Positive
- One root document: new specs and ADRs start from §2 and §2.3.
- Open questions are explicit and have an owner, instead of being decided implicitly in code.

### Negative
- Late ADR: it can drift from reality unless the tables are updated whenever a layer changes.
- D1–D3 stay Proposed until confirmed.

### Follow-ups
- Spin out ADRs: (1) per-device API keys and the Traefik constraint (`/mondrop/connect` must stay behind `auth-family`, never under `/api/mondrop` or `/api/share`); (2) offline persistence once D1 is confirmed; (3) OIDC PKCE when the IdP is live.
- Spooty coupling has known gaps: no failure feedback to SoundReel, and `song_meta.downloaded` means "queued", not "downloaded" (the filesystem scan is the truth). Candidate for its own ADR.
- Hub follow-up (not this repo): Authelia OIDC client `mondrop`, see `docs/mondrop-auth.md`.

## 7. Guardrails
- `CLAUDE.md` conventions (strict TypeScript, no ORM, no real external calls in tests).
- Backend: `backend/src/routes/mondropConnect.ts` documents the Traefik constraint in its header and is covered by tests (cross-site POST blocked, identity from `Remote-User`, rotation).
- iOS: `ios/project.yml` keeps asset catalogs under `sources` (a target-level `resources:` key is ignored by XcodeGen).
- Update §2 and §2.3 in the same change that alters a layer.

## 8. Migration Plan
None — this ADR documents the current state. Rows D1–D3 will get their own plans once confirmed.

## 9. Rollback
Not applicable (documentation). A row is changed by a superseding ADR, not by editing history.
