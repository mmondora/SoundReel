# Spotify Manual Add — Design Spec

**Date:** 2026-06-02  
**Status:** Approved  
**Scope:** Add manual Spotify search + add-to-playlist flow inline in SongItem

---

## Problem

The analysis pipeline auto-adds recognized songs to the Spotify playlist at analysis time. If Spotify was not connected, or `addToPlaylist` failed silently, the song has `addedToPlaylist=false` with no way to fix it from the GUI. Users also have no way to manually search Spotify when the auto-search found the wrong track or found nothing.

---

## Solution

Inline search-and-add flow inside `SongItem`. Songs with `addedToPlaylist=false` show a `[S+]` button. Clicking it searches Spotify and shows 3–5 results inline. User picks one; it is added to the playlist and the result is persisted back to Postgres.

---

## Backend

### New endpoint: Spotify search

```
GET /api/spotify/search?q=<string>&limit=5
```

- Calls Spotify `/v1/search?type=track&limit=<limit>`
- Reuses existing `refreshAccessToken()` in `services/spotify.ts`
- Returns:
  ```json
  [
    {
      "uri": "spotify:track:...",
      "url": "https://open.spotify.com/track/...",
      "name": "Track Name",
      "artist": "Artist Name",
      "albumName": "Album Name",
      "albumImageUrl": "https://..."
    }
  ]
  ```
- If Spotify not connected → `503 { "error": "spotify_not_connected" }`
- If no results → `200 []`

Registered in `backend/src/routes/spotify.ts`.

### New endpoint: Add song to playlist and persist

```
POST /api/entries/:entryId/songs/spotify
Content-Type: application/json

{
  "songIndex": 0,
  "spotifyUri": "spotify:track:...",
  "spotifyUrl": "https://open.spotify.com/track/...",
  "name": "Track Name",
  "artist": "Artist Name"
}
```

Steps:
1. Fetch entry from Postgres
2. Validate `songIndex` is in range
3. Call `addToPlaylist(spotifyUri)` — reuses existing function
4. If `addToPlaylist` returns false → `400 { "error": "add_failed" }`
5. Mutate `entry.results.songs[songIndex]`: set `addedToPlaylist=true`, `spotifyUri`, `spotifyUrl`
6. Write back full `results` JSONB via `updateEntry(entryId, { results: updatedResults })`
7. Return updated entry

Strategy for JSONB update: read entry → mutate songs array in JS → write full `results` object. Simpler than dynamic `jsonb_set` path.

If `songIndex` is out of range (entry changed concurrently) → `409 { "error": "song_index_mismatch" }`.

Registered in `backend/src/routes/entries.ts`.

---

## Frontend

### `services/api.ts` additions

```typescript
export interface SpotifyTrack {
  uri: string;
  url: string;
  name: string;
  artist: string;
  albumName: string | null;
  albumImageUrl: string | null;
}

export async function searchSpotifyTracks(q: string, limit = 5): Promise<SpotifyTrack[]>
export async function addSongToSpotify(entryId: string, songIndex: number, track: SpotifyTrack): Promise<Entry>
```

### `SongItem` changes

New props:
```typescript
interface SongItemProps {
  song: Song;
  entryId?: string;      // optional — if absent, no manual-add button shown
  songIndex?: number;
}
```

State machine (local `useState`):

```
idle → loading → results → adding → done
                          ↘ error
```

UI per state:

| State | UI |
|-------|----|
| `idle` | `[S+]` button visible if `!song.addedToPlaylist && entryId != null` |
| `loading` | Spinner inline, button disabled |
| `results` | Compact list under song-info; each result has `[+]` button |
| `adding` | Spinner on selected result row |
| `done` | Green `+` badge, `[S+]` button hidden |
| `error` | Inline error text, retry button |

Results list item:
```
♫  Artist – Track Name  (Album)    [+]
```

If 0 results: show "Nessun risultato" + editable query field (pre-filled with `artist title`) for manual retry.

### `EntryInspector` changes

Pass `entryId` and `songIndex` to each `SongItem`:

```tsx
{entry.results.songs.map((song, i) => (
  <SongItem key={i} song={song} entryId={entry.id} songIndex={i} />
))}
```

Same for `SongsPage` and any other place that renders `SongItem`.

---

## Data flow

```
User clicks [S+]
  → GET /api/spotify/search?q=<artist+title>&limit=5
  → Show results inline

User clicks [+] on a result
  → POST /api/entries/:id/songs/spotify
  → Backend: addToPlaylist() + updateEntry(results)
  → Frontend: update local song state → show green +
  → SSE notify fires → useJournal reloads (entry updated in DB)
```

---

## Error handling

| Case | Behavior |
|------|----------|
| Spotify not connected | 503 → inline message "Connetti Spotify nelle impostazioni" with link to `/settings` |
| 0 search results | Empty list + editable query field for retry |
| `addToPlaylist` fails | 400 → error state, retry button |
| `songIndex` out of range | 409 → frontend reloads entry, shows error |
| Network error | Error state, retry button |

---

## Out of scope

- Remove from playlist
- Audio preview (Spotify removed preview URLs from free API tier)
- YouTube playlist add (YouTube API requires paid quota)
- Bulk "add all missing songs" button
- Deduplication check before adding to playlist (Spotify natively allows duplicates)

---

## Files changed

| File | Change |
|------|--------|
| `backend/src/routes/spotify.ts` | Add `GET /api/spotify/search` |
| `backend/src/routes/entries.ts` | Add `POST /api/entries/:entryId/songs/spotify` |
| `frontend/src/services/api.ts` | Add `searchSpotifyTracks`, `addSongToSpotify` |
| `frontend/src/components/SongItem.tsx` | State machine + inline results UI |
| `frontend/src/components/EntryInspector.tsx` | Pass `entryId` + `songIndex` to SongItem |
| `frontend/src/pages/SongsPage.tsx` | Pass `entryId` + `songIndex` to SongItem |
| `frontend/src/types/index.ts` | Add `SpotifyTrack` interface |
