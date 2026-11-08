# Multi-user Authelia — Implementation Plan

**Goal:** Scope SoundReel data by Authelia user (`mike`/`archi`/`sara`), backfill existing data to Michele, allow sharing entries and playlists.

**Architecture:** `owner_user` on entries/playlists; `entry_shares` / `playlist_shares`; `user_config` for personal settings; `requireUser()` from `Remote-User` on web APIs. Spec: `docs/superpowers/specs/2026-11-07-multi-user-authelia-design.md`.

**Tech Stack:** Postgres migrations (idempotent SQL), Fastify, React.

---

### Task 1: SQL migration + init.sql

**Files:**
- Create: `backend/src/db/migrations/2026-11-07-multi-user.sql`
- Modify: `backend/src/db/init.sql`

Columns/tables per spec; backfill `owner_user = 'mike'`.

### Task 2: Auth helper + `/api/me`

**Files:**
- Create: `backend/src/utils/requestUser.ts` (+ test)
- Modify: `backend/src/server.ts` / routes to expose `GET /api/me`

### Task 3: Scope entries CRUD + idempotency by owner

**Files:**
- Modify: `backend/src/utils/db.ts` (`findEntryByUrl`, `listEntries`, `createEntry`)
- Modify: analyze / share / telegram / entries routes

### Task 4: Scope playlists + user_config

### Task 5: Share APIs (entry + playlist)

### Task 6: Frontend — me badge, filters, share UI

### Task 7: Mondrop/Telegram owner alignment + docs/memory
