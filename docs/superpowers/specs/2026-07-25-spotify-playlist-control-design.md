# Spotify Playlist Control and Relevance Rule Design

**Date:** 2026-07-25
**Status:** Rejected — not implemented (see "Why this was abandoned")
**Scope:** Let the user choose which Spotify playlist receives tracks (from the web UI or Telegram), and stop adding background music that the post never actually talks about.

---

## Why this was abandoned

The integration was wired up end to end and verified as far as Spotify allows:
the neutral callback host, the PKCE flow, the code exchange and token storage
all work — `/api/spotify/status` reported `connected: true` with a valid token.

Every API call then returned HTTP 403 with:

> *Active premium subscription required for the owner of the app. When the
> subscription status changes, it can take a few hours before requests are
> allowed again.*

Spotify requires the account that **owns the developer app** to hold an active
Premium subscription before the Web API will serve any request — including
`/v1/me` and plain search, which need no scopes. There is no code-side
workaround.

The user chose to drop the integration rather than take out a subscription for
it. Songs keep the YouTube and SoundCloud search links the pipeline already
generates, which need no account at all, and Spotify *links* found in posts are
still forwarded to Spooty as before.

Cleanup applied: the leaked client credentials were blanked from `.env` and the
stored OAuth tokens deleted, so the pipeline skips Spotify instead of
collecting a 403 per detected song.

**If this is ever revived**, the design below still holds; only the account
problem needs solving first (Premium on the owning account, or recreating the
app under one that has it — only the client id/secret would change).

The relevance rule in particular is worth keeping in mind: `Song.source`
already distinguishes a track the content *talks about* (`ai_analysis`) from
the background audio Instagram attaches (`audio_fingerprint`), which is the
same signal that revealed 128 entries whose failed analysis was masked by a
stray song.

---

## Problem

The Spotify integration is fully built but has never been connected: `SPOTIFY_CLIENT_ID` and `SPOTIFY_CLIENT_SECRET` are present in `.env` as empty strings, so `/api/spotify/authorize` cannot start a flow. 338 detected songs sit with `spotifyUri: null` and none are in a playlist.

Two design gaps block the user's intent even once credentials are supplied:

1. **No playlist choice.** `addToPlaylist()` auto-creates a private playlist hardcoded as `'SoundReel'` when `playlistId` is null, and nothing can ever change it — no endpoint writes `playlistId`, and Settings displays the name as a literal `'SoundReel'` string rather than reading it back.

2. **Auto-add is unconditional.** Every song found in every analyzed link is pushed to the playlist (`analyze.ts:627`, `:666`). Instagram attaches a background track to most reels, so a post about, say, MCP architecture contributes its incidental soundtrack to the user's music library. The user wants tracks added only when the post is genuinely about music.

## Goal

- Pick or create the destination playlist from Settings, and see which one is active.
- Add only tracks the post actually discusses.
- Check and switch the active playlist from Telegram.

---

## Approach

### The relevance rule already exists in the data

Every `Song` carries a `source` field:

| source | Meaning | Add? |
|---|---|---|
| `audio_fingerprint` | Background track supplied by Instagram metadata or matched from the audio | No |
| `ai_analysis` | The model extracted it because the caption, OCR or transcript names it | Yes |
| `both` | Detected in the audio *and* named in the content | Yes |

So "is this post relevant to music?" is answered by "did anything other than the raw audio identify this track?". This is the same distinction that, earlier today, revealed 128 entries whose failed analysis was masked by a stray background song — it is a reliable signal in this dataset, not a new heuristic invented for this feature.

Rejected alternative: classify post relevance with the model (a "is this about music?" call per entry). Slower, costs a call, and would frequently disagree with the per-track evidence already available for free.

The mode is a setting rather than a hardcoded rule, since the current behaviour is a legitimate preference for someone who wants to collect every soundtrack:

```ts
type SpotifyAutoAddMode = 'relevant' | 'all' | 'off';
```

Default `'relevant'`. `'all'` reproduces today's behaviour; `'off'` disables auto-add entirely, leaving the existing manual per-song button as the only path.

### Playlist selection

`playlist-read-private` is already among the requested scopes, so listing playlists needs no re-authorization.

Auto-creation stays as the fallback when nothing is selected, so a first-time user still gets a working playlist without visiting Settings.

---

## Backend changes

### `backend/src/services/spotify.ts`

```ts
export interface SpotifyPlaylistSummary {
  id: string;
  name: string;
  trackCount: number;
  isPublic: boolean;
  owned: boolean;
}

/** Playlists the user can write to (owned or collaborative). */
export async function listPlaylists(): Promise<SpotifyPlaylistSummary[]>

/** Create a playlist and make it the active destination. */
export async function createNamedPlaylist(name: string): Promise<SpotifyPlaylistSummary>
```

`listPlaylists` pages `GET /v1/me/playlists` (limit 50) and filters to playlists the user owns or that are collaborative — adding to someone else's playlist would fail at write time, so offering it would be a trap. The existing private `createPlaylist()` is refactored to delegate to `createNamedPlaylist('SoundReel')` so the auto-create path and the explicit one cannot diverge.

### `backend/src/routes/spotify.ts`

| Endpoint | Purpose |
|---|---|
| `GET /api/spotify/playlists` | List writable playlists; 503 `spotify_not_connected` when there is no token, matching the existing `/search` behaviour |
| `POST /api/spotify/playlist` | Body `{ playlistId }` to select an existing one, or `{ name }` to create and select |
| `GET /api/spotify/status` | Extended with `playlistName` and `trackCount`, so the UI stops fabricating the label |

### `backend/src/utils/db.ts`

`FeaturesConfig` gains `spotifyAutoAddMode: SpotifyAutoAddMode` (default `'relevant'`). Existing rows without the key inherit the default through the established `mergeConfig` merge, so no migration is needed.

### `backend/src/services/playlistRule.ts` (new)

```ts
export function shouldAddToPlaylist(song: Song, mode: SpotifyAutoAddMode): boolean
```

One tested predicate, used by both auto-add call sites in `analyze.ts` so the rule cannot drift between the main song loop and the carousel-slide loop. The manual per-song button deliberately bypasses it: an explicit click is a decision, not a guess.

The `spotify_search` action log gains `skippedByRule: true` when the rule suppressed an add, so the Activity timeline explains the absence rather than staying silent.

---

## Frontend changes

`frontend/src/pages/Settings.tsx`, Spotify section:

- Show the real active playlist (name + track count) from the extended status.
- Dropdown listing writable playlists, loaded on demand; selecting one calls `POST /api/spotify/playlist`.
- Inline "create new" field taking a name.
- Three-way control for the auto-add mode, each option labelled with what it does in plain language rather than the raw enum.

New i18n keys (IT + EN) for the playlist picker, the create field, and the three mode labels.

---

## Telegram

`backend/src/routes/telegram.ts` follows a `text === '/cmd'` equality pattern; the new command needs an argument, so it is matched with a prefix check placed before the existing exact-match block.

- `/playlist` — active playlist, its track count, and a numbered list of the others.
- `/playlist <n>` — switch to the n-th playlist from that list.

The numbering is derived from the same ordering `listPlaylists()` returns, so a `/playlist` immediately followed by `/playlist 3` is consistent. An out-of-range or non-numeric argument replies with the list again rather than failing silently.

---

## Configuration (user action, outside this change)

The integration cannot be exercised until the Spotify dashboard app has `https://soundreel.casamon.dev/spotify/callback` registered as a redirect URI and `.env` carries a real `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET`.

## Error handling

Per the project's resilience convention: a Spotify failure (not connected, expired refresh token, rate limit, deleted playlist) is logged to `actionLog` and never fails the analysis. `listPlaylists` returning empty is rendered as an empty picker with a hint, not an error.

A playlist deleted on Spotify's side is a real case: `addToPlaylist` treats a 404 on the stored `playlistId` as "no playlist selected", clearing it so the next add auto-creates rather than failing forever.

## Testing

- `playlistRule.test.ts`: every source × mode combination, including that `'all'` reproduces today's behaviour and `'off'` blocks everything.
- `spotify.test.ts`: `listPlaylists` filtering (owned/collaborative kept, others dropped) and paging, with `fetch` mocked — no real Spotify calls, per the CLAUDE.md testing rule.
- `spotifyRoutes.test.ts`: the new endpoints' happy path, 503 when disconnected, and validation of `{ playlistId }` vs `{ name }`.
- Telegram: `/playlist` and `/playlist <n>` parsing, including out-of-range input.
