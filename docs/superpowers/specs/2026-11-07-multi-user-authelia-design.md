# Multi-user SoundReel (Authelia) — Design

- **Date:** 2026-11-07
- **Status:** Approved direction (isolamento + condivisione)
- **Owner:** Michele

## Problem

SoundReel is single-tenant today. Authelia already authenticates `mike` / `archi` / `sara`, but the web app ignores `Remote-User`. All journal entries, playlists, and config are global. Mondrop can send a `user` field, but the web UI and most APIs do not scope by user.

## Goals

1. **Identity** = Authelia username (`Remote-User` on web; Mondrop user aligned to the same ids).
2. **Default isolation**: each user sees only their own entries, playlists, and settings.
3. **Explicit share**: owner can share an **entry** and/or a **playlist** with one or more family users.
4. **Backfill**: every existing row belongs to **`mike`** (Michele).
5. Mondrop / Telegram continue to write `owner_user` (and `input_user`) consistently.

## Non-goals (this phase)

- Full OIDC inside Mondrop (tracked in `docs/mondrop-auth.md`).
- Per-user media filesystem layout (media dirs can stay keyed by entry id).
- Billing / quotas.

## Identity source

| Client | How user is known |
|--------|-------------------|
| Web (Traefik + Authelia) | Header `Remote-User` (trusted only via Traefik) |
| Mondrop share | Body `user` (must be `mike`\|`archi`\|`sara`); later OIDC |
| Telegram | Map telegram username → Authelia id via claimed **proper name**; until mapped → `anonymous` |
| No Remote-User (loopback / unauthenticated) | User id **`anonymous`** |

Canonical family ids: **`mike`**, **`archi`**, **`sara`** (see `geekom-hub/authelia/config/users.yml`).

Special id: **`anonymous`** — used when identity is unknown. Admins (`Remote-Groups` contains `admins`) can **browse** anonymous-owned entries in addition to their own and shares.

## Data model

### entries

- Add `owner_user TEXT NOT NULL DEFAULT 'mike'`
- Backfill: `UPDATE entries SET owner_user = 'mike' WHERE owner_user IS NULL OR owner_user = ''`
- Also: if `input_user` already in (`mike`,`archi`,`sara`), prefer that on backfill only when currently null — **decision: force all historical to mike** (user request: “tutti i link attuali sono di michele”).
- Idempotency: `findEntryByUrl(url, ownerUser)` — same URL can exist once per owner.
- Index: `(owner_user, created_at DESC)`, `(owner_user, source_url)`

### entry_shares

```sql
CREATE TABLE entry_shares (
  entry_id TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  shared_with TEXT NOT NULL,  -- authelia username
  shared_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (entry_id, shared_with)
);
```

Visibility: `owner_user = $me OR EXISTS share for $me OR ($me is admin AND owner_user = 'anonymous')`.

### playlists

- Add `owner_user TEXT NOT NULL DEFAULT 'mike'`
- Backfill all existing → `mike`

### playlist_shares

Same shape as `entry_shares` (playlist_id, shared_with, shared_by).

### config → per-user

Replace global-only usage for user-facing settings:

```sql
CREATE TABLE user_config (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, key)
);
```

- Migrate current `config` rows that are personal (Spotify tokens, feature prefs, apiKeys stay **global/admin** or under `mike` — **apiKeys** remain global for Mondrop ingest until OIDC).
- Personal keys (spotify, UI prefs, retention UI): copy into `user_config` for `mike`, then read/write scoped.

### Derived catalogs (songs / films / notes)

No separate owner column in v1. Lists are built from entries **visible** to the current user (owned or shared). `song_meta` / ratings: scope by `song_key` appearing in visible entries; playlist membership already playlist-scoped.

## API

- `requireUser(req)` → `{ id: string }` from `Remote-User`, or 401 on browser API routes.
- Public exceptions (unchanged): Telegram webhook, `/api/share` (API key), OAuth callbacks, health.
- List/get/update/delete entries: filter by visibility.
- Create entry (analyze / share / telegram): set `owner_user` (+ `input_user`).
- `POST /api/entries/:id/share` `{ with: ['archi'] }` / `DELETE` unshare — owner only.
- Playlists: same pattern.
- `GET /api/me` → `{ user: 'mike', displayName: '…' }` for the web header.

## Frontend

- On load, `GET /api/me`; show current user.
- Journal/Home default = mine; optional chip **Condivisi con me** / **Famiglia** (union of owned + shared).
- Entry detail: **Condividi…** multi-select family users.
- Settings: load/save `user_config` for me (not global).

## Telegram identity (name claim)

1. Look up `telegram_identities` by telegram username or numeric id.
2. If mapped → `owner_user` = that Authelia id.
3. If not mapped and the message contains a URL → **do not analyze yet**; reply asking for the person's **proper name** in free text. **Do not suggest or list** family names.
4. On a plain-text reply while pending: match (case-insensitive, trim) against known display names (`Michele`/`Michele Mondora` → `mike`, `Archimede` → `archi`, `Sara`/`Sara Spini` → `sara`). On match, save mapping and confirm. On no match, keep `anonymous` and ask once more (or accept anonymous ownership).
5. Mapping table: `telegram_identities (telegram_key, owner_user, claimed_name, created_at)`.

## Mondrop

- Keep sending `user` + `sharedAt` + device.
- Web and Mondrop must use the same Authelia ids.
- After OIDC: `user` comes from token, not picker.

## Security notes

- Never trust `Remote-User` except via Traefik (existing admin hook pattern).
- `/api/share` remains key-gated; optional later: bind keys to a user id in `apiKeys` config.
- Sharing is allow-list only among known Authelia family ids.

## Rollout

1. Spec (this doc) + SQL migrate + `requireUser` helper.
2. Scope entry list/get/create + backfill mike.
3. Scope playlists + config.
4. Share APIs + UI.
5. Mondrop/Telegram owner alignment; deprecate ambiguous null owners.

## Open follow-ups

- Display names from Authelia (`Remote-Name`) if Traefik forwards them.
- Family group check via `Remote-Groups`.
- OIDC for Mondrop (`docs/mondrop-auth.md`).
