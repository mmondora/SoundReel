# Spotify Manual Add Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an inline Spotify search + add-to-playlist button to `SongItem` for songs where `addedToPlaylist=false`.

**Architecture:** Two new backend endpoints (search + persist), two new frontend API functions, `SongItem` rewritten with a 6-state local state machine, `EntryInspector` passes `entryId`+`songIndex` to each `SongItem`.

**Tech Stack:** Fastify (backend), React 18 + TypeScript (frontend), Spotify Web API, PostgreSQL JSONB update via `updateEntry`.

---

## File Map

| File | Change |
|------|--------|
| `backend/src/services/spotify.ts` | Add `searchTracks(q, limit)` function |
| `backend/src/routes/spotify.ts` | Add `GET /api/spotify/search` |
| `backend/src/routes/entries.ts` | Add `POST /api/entries/:entryId/songs/spotify` |
| `frontend/src/services/api.ts` | Add `SpotifyTrack` interface + `searchSpotifyTracks` + `addSongToSpotify` |
| `frontend/src/i18n/translations.ts` | Add 5 new translation keys |
| `frontend/src/components/SongItem.tsx` | Full rewrite with state machine |
| `frontend/src/styles/index.css` | Add CSS for search results + action-btn |
| `frontend/src/components/EntryInspector.tsx` | Pass `entryId` + `songIndex` to SongItem |

---

## Task 1: Add `searchTracks` to Spotify service

**Files:**
- Modify: `backend/src/services/spotify.ts`

- [ ] **Add `SpotifyTrackResult` interface and `searchTracks` function** after the existing `searchTrack` function (around line 157):

```typescript
export interface SpotifyTrackResult {
  uri: string;
  url: string;
  name: string;
  artist: string;
  albumName: string | null;
  albumImageUrl: string | null;
}

export async function searchTracks(
  q: string,
  limit: number = 5
): Promise<SpotifyTrackResult[]> {
  try {
    const accessToken = await refreshAccessToken();
    if (!accessToken) return [];

    const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(q)}&type=track&limit=${limit}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!response.ok) {
      logWarning('Spotify multi-search fallita', { status: response.status });
      return [];
    }

    const data = (await response.json()) as {
      tracks: {
        items: Array<{
          uri: string;
          external_urls: { spotify: string };
          name: string;
          artists: Array<{ name: string }>;
          album: { name: string; images: Array<{ url: string; height: number }> };
        }>;
      };
    };

    return data.tracks.items.map((item) => ({
      uri: item.uri,
      url: item.external_urls.spotify,
      name: item.name,
      artist: item.artists[0]?.name ?? '',
      albumName: item.album.name || null,
      albumImageUrl:
        item.album.images.find((i) => i.height <= 300)?.url ??
        item.album.images[0]?.url ??
        null,
    }));
  } catch (error) {
    logError('Errore searchTracks', error);
    return [];
  }
}
```

- [ ] **Commit:**

```bash
git add backend/src/services/spotify.ts
git commit -m "feat(backend): add searchTracks to spotify service"
```

---

## Task 2: Add `GET /api/spotify/search` route

**Files:**
- Modify: `backend/src/routes/spotify.ts`

- [ ] **Add import** at top of `routes/spotify.ts` (add `searchTracks` to the existing import from `../services/spotify`):

```typescript
import { exchangeAuthCode, getRedirectUri, searchTracks, SpotifyTrackResult } from '../services/spotify';
```

- [ ] **Add route** inside `registerSpotifyRoutes`, after the `/spotify/callback` handler:

```typescript
app.get<{ Querystring: { q?: string; limit?: string } }>('/api/spotify/search', async (req, reply) => {
  const q = (req.query.q ?? '').trim();
  const limit = Math.min(10, Math.max(1, Number(req.query.limit ?? 5)));

  if (!q) {
    reply.code(400).send({ error: 'q parameter required' });
    return;
  }

  const config = await getSpotifyConfig();
  if (!config) {
    reply.code(503).send({ error: 'spotify_not_connected' });
    return;
  }

  const tracks: SpotifyTrackResult[] = await searchTracks(q, limit);
  reply.send(tracks);
});
```

- [ ] **Verify:** `cd backend && npm run typecheck` — no errors.

- [ ] **Commit:**

```bash
git add backend/src/routes/spotify.ts
git commit -m "feat(backend): GET /api/spotify/search endpoint"
```

---

## Task 3: Add `POST /api/entries/:entryId/songs/spotify` route

**Files:**
- Modify: `backend/src/routes/entries.ts`

- [ ] **Update imports** at top of `routes/entries.ts`:

```typescript
import type { FastifyInstance } from 'fastify';
import { pool } from '../utils/db';
import { listEntries, getEntry, updateEntry, deleteEntry, deleteAllEntries } from '../utils/db';
import { addToPlaylist } from '../services/spotify';
import type { Entry } from '../types';
```

- [ ] **Add route** inside `registerEntriesRoutes`, after the SSE stream handler:

```typescript
interface AddSongToSpotifyBody {
  songIndex: number;
  spotifyUri: string;
  spotifyUrl: string;
  name: string;
  artist: string;
}

app.post<{ Params: { entryId: string }; Body: AddSongToSpotifyBody }>(
  '/api/entries/:entryId/songs/spotify',
  async (req, reply) => {
    const { entryId } = req.params;
    const { songIndex, spotifyUri, spotifyUrl } = req.body;

    const entry = await getEntry(entryId);
    if (!entry) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }

    const songs = entry.results.songs;
    if (songIndex < 0 || songIndex >= songs.length) {
      reply.code(409).send({ error: 'song_index_mismatch' });
      return;
    }

    const added = await addToPlaylist(spotifyUri);
    if (!added) {
      reply.code(400).send({ error: 'add_failed' });
      return;
    }

    const updatedSongs = songs.map((s, i) =>
      i === songIndex
        ? { ...s, spotifyUri, spotifyUrl, addedToPlaylist: true }
        : s
    );

    const updatedResults: Entry['results'] = { ...entry.results, songs: updatedSongs };
    await updateEntry(entryId, { results: updatedResults });

    const updated = await getEntry(entryId);
    reply.send(updated);
  }
);
```

- [ ] **Verify:** `cd backend && npm run typecheck` — no errors.

- [ ] **Commit:**

```bash
git add backend/src/routes/entries.ts
git commit -m "feat(backend): POST /api/entries/:id/songs/spotify — add song to playlist and persist"
```

---

## Task 4: Add API types and functions to frontend service

**Files:**
- Modify: `frontend/src/services/api.ts`

- [ ] **Add `SpotifyTrack` interface** after the existing `SpotifyStatus` interface (around line 167):

```typescript
export interface SpotifyTrack {
  uri: string;
  url: string;
  name: string;
  artist: string;
  albumName: string | null;
  albumImageUrl: string | null;
}
```

- [ ] **Add `searchSpotifyTracks` function** after `spotifyAuthorizeUrl`:

```typescript
export async function searchSpotifyTracks(q: string, limit = 5): Promise<SpotifyTrack[]> {
  const params = new URLSearchParams({ q, limit: String(limit) });
  const res = await fetch(url(`/api/spotify/search?${params}`));
  if (res.status === 503) return [];   // Spotify not connected — surface as empty results
  return json<SpotifyTrack[]>(res);
}

export async function addSongToSpotify(
  entryId: string,
  songIndex: number,
  track: SpotifyTrack
): Promise<Entry> {
  const res = await fetch(url(`/api/entries/${encodeURIComponent(entryId)}/songs/spotify`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      songIndex,
      spotifyUri: track.uri,
      spotifyUrl: track.url,
      name: track.name,
      artist: track.artist,
    }),
  });
  return json<Entry>(res);
}
```

- [ ] **Verify:** `cd frontend && npm run build` — no type errors.

- [ ] **Commit:**

```bash
git add frontend/src/services/api.ts
git commit -m "feat(frontend): add searchSpotifyTracks and addSongToSpotify API functions"
```

---

## Task 5: Add i18n translation strings

**Files:**
- Modify: `frontend/src/i18n/translations.ts`

- [ ] **Add to `Translations` interface** (after `searchOnSoundcloud`):

```typescript
searchOnSpotify: string;
addToPlaylistBtn: string;
addingToPlaylist: string;
noSpotifyResults: string;
spotifyNotConnected: string;
```

- [ ] **Add to `it` translations** (after `searchOnSoundcloud: ...`):

```typescript
searchOnSpotify: 'Cerca su Spotify',
addToPlaylistBtn: 'Aggiungi alla playlist',
addingToPlaylist: 'Aggiunta...',
noSpotifyResults: 'Nessun risultato su Spotify',
spotifyNotConnected: 'Connetti Spotify nelle impostazioni',
```

- [ ] **Add to `en` translations** (after `searchOnSoundcloud: ...`):

```typescript
searchOnSpotify: 'Search on Spotify',
addToPlaylistBtn: 'Add to playlist',
addingToPlaylist: 'Adding...',
noSpotifyResults: 'No results on Spotify',
spotifyNotConnected: 'Connect Spotify in settings',
```

- [ ] **Verify:** `cd frontend && npm run build` — no type errors.

- [ ] **Commit:**

```bash
git add frontend/src/i18n/translations.ts
git commit -m "feat(frontend): add i18n strings for Spotify manual add"
```

---

## Task 6: Add CSS for Spotify search results

**Files:**
- Modify: `frontend/src/styles/index.css`

- [ ] **Add CSS block** after the `.playlist-badge` rule (around line 1260):

```css
/* Action button (button element matching action-link style) */
.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.25rem;
  height: 2.25rem;
  border-radius: var(--radius-sm);
  background: var(--bg-hover);
  color: var(--text-secondary);
  font-size: 0.75rem;
  font-weight: 700;
  border: none;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--accent);
  color: white;
}

.action-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.action-btn.spotify-search-btn {
  background: rgba(29, 185, 84, 0.1);
  color: var(--spotify);
}

.action-btn.spotify-search-btn:hover {
  background: var(--spotify);
  color: white;
}

/* Spotify inline search results */
.song-item {
  flex-wrap: wrap;  /* allow results row to go below */
}

.spotify-results {
  width: 100%;
  margin-top: 0.5rem;
  border-top: 1px solid var(--border-light);
  padding-top: 0.5rem;
}

.spotify-results-query {
  display: flex;
  gap: 0.4rem;
  margin-bottom: 0.4rem;
}

.spotify-results-input {
  flex: 1;
  padding: 0.3rem 0.5rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-input);
  color: var(--text-primary);
  font-size: 0.85rem;
}

.spotify-result-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.3rem 0;
  border-bottom: 1px solid var(--border-light);
}

.spotify-result-row:last-child {
  border-bottom: none;
}

.spotify-result-thumb {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  object-fit: cover;
  flex-shrink: 0;
}

.spotify-result-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}

.spotify-result-name {
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.spotify-result-artist {
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.spotify-no-results {
  font-size: 0.85rem;
  color: var(--text-muted);
  padding: 0.3rem 0;
}
```

- [ ] **Commit:**

```bash
git add frontend/src/styles/index.css
git commit -m "feat(frontend): CSS for Spotify inline search results"
```

---

## Task 7: Rewrite SongItem with state machine

**Files:**
- Modify: `frontend/src/components/SongItem.tsx`

- [ ] **Replace entire file** with:

```typescript
import { useState } from 'react';
import type { Song } from '../types';
import { searchSpotifyTracks, addSongToSpotify } from '../services/api';
import type { SpotifyTrack } from '../services/api';
import { useLanguage } from '../i18n';

type SearchState = 'idle' | 'loading' | 'results' | 'adding' | 'done' | 'error';

interface SongItemProps {
  song: Song;
  entryId?: string;
  songIndex?: number;
}

export function SongItem({ song, entryId, songIndex }: SongItemProps) {
  const { t } = useLanguage();
  const [state, setState] = useState<SearchState>(
    song.addedToPlaylist ? 'done' : 'idle'
  );
  const [results, setResults] = useState<SpotifyTrack[]>([]);
  const [addingUri, setAddingUri] = useState<string | null>(null);
  const [query, setQuery] = useState(`${song.artist} ${song.title}`);

  const canManualAdd = !!entryId && songIndex !== undefined && !song.addedToPlaylist;

  const handleSearch = async (): Promise<void> => {
    setState('loading');
    try {
      const tracks = await searchSpotifyTracks(query);
      setResults(tracks);
      setState('results');
    } catch {
      setState('error');
    }
  };

  const handleAdd = async (track: SpotifyTrack): Promise<void> => {
    if (!entryId || songIndex === undefined) return;
    setAddingUri(track.uri);
    setState('adding');
    try {
      await addSongToSpotify(entryId, songIndex, track);
      setState('done');
    } catch {
      setAddingUri(null);
      setState('error');
    }
  };

  return (
    <div className="song-item">
      <div className="song-info">
        <span className="song-title">{song.title}</span>
        <span className="song-artist">{song.artist}</span>
        {song.album && <span className="song-album">{song.album}</span>}
      </div>

      <div className="song-actions">
        {song.spotifyUrl && (
          <a href={song.spotifyUrl} target="_blank" rel="noopener noreferrer"
             className="action-link spotify" title={t.openOnSpotify}>
            <span className="icon">S</span>
          </a>
        )}
        {song.youtubeUrl && (
          <a href={song.youtubeUrl} target="_blank" rel="noopener noreferrer"
             className="action-link youtube" title={t.searchOnYoutube}>
            <span className="icon">Y</span>
          </a>
        )}
        {song.soundcloudUrl && (
          <a href={song.soundcloudUrl} target="_blank" rel="noopener noreferrer"
             className="action-link soundcloud" title={t.searchOnSoundcloud}>
            <span className="icon">SC</span>
          </a>
        )}
        {(state === 'done') && (
          <span className="playlist-badge" title={t.addedToPlaylist}>+</span>
        )}
        {canManualAdd && state === 'idle' && (
          <button className="action-btn spotify-search-btn"
                  onClick={() => void handleSearch()}
                  title={t.searchOnSpotify}>
            S+
          </button>
        )}
        {state === 'loading' && <span className="compact-spinner" />}
        {state === 'error' && (
          <button className="action-btn spotify-search-btn"
                  onClick={() => void handleSearch()}
                  title={t.errorGeneric}>
            ↺
          </button>
        )}
      </div>

      {(state === 'results' || state === 'adding') && (
        <div className="spotify-results">
          <div className="spotify-results-query">
            <input
              className="spotify-results-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void handleSearch(); }}
            />
            <button className="action-btn" onClick={() => void handleSearch()}>🔍</button>
          </div>
          {results.length === 0 ? (
            <p className="spotify-no-results">{t.noSpotifyResults}</p>
          ) : (
            results.map((track) => (
              <div key={track.uri} className="spotify-result-row">
                {track.albumImageUrl && (
                  <img src={track.albumImageUrl} alt="" className="spotify-result-thumb"
                       width={32} height={32} />
                )}
                <div className="spotify-result-info">
                  <span className="spotify-result-name">{track.name}</span>
                  <span className="spotify-result-artist">{track.artist}</span>
                </div>
                <button
                  className="action-btn"
                  onClick={() => void handleAdd(track)}
                  disabled={state === 'adding'}
                  title={state === 'adding' && addingUri === track.uri
                    ? t.addingToPlaylist
                    : t.addToPlaylistBtn}
                >
                  {state === 'adding' && addingUri === track.uri ? '…' : '+'}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Verify:** `cd frontend && npm run build` — no type errors.

- [ ] **Commit:**

```bash
git add frontend/src/components/SongItem.tsx
git commit -m "feat(frontend): SongItem with inline Spotify search state machine"
```

---

## Task 8: Wire EntryInspector to pass entryId + songIndex

**Files:**
- Modify: `frontend/src/components/EntryInspector.tsx`

- [ ] **Find the songs render block** (around line 237) and change:

```tsx
{entry.results.songs.map((song, i) => (
  <SongItem key={i} song={song} />
))}
```

to:

```tsx
{entry.results.songs.map((song, i) => (
  <SongItem key={i} song={song} entryId={entry.id} songIndex={i} />
))}
```

- [ ] **Verify:** `cd frontend && npm run build` — no errors.

- [ ] **Manual test:**
  1. Start backend: `cd backend && npm run dev`
  2. Start frontend: `cd frontend && npm run dev`
  3. Open an entry with a song where `addedToPlaylist=false`
  4. Verify `S+` button appears next to the song
  5. Click `S+` → spinner → list of 3-5 Spotify tracks appears inline
  6. Click `+` on a track → spinner on that row → green `+` badge replaces button
  7. Reload page → song still shows `+` badge (persisted to DB)
  8. If Spotify not connected: `S+` click shows empty list (503 returns `[]`)

- [ ] **Commit:**

```bash
git add frontend/src/components/EntryInspector.tsx
git commit -m "feat(frontend): wire entryId+songIndex into SongItem for manual Spotify add"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement | Task |
|-----------------|------|
| GET /api/spotify/search | Task 2 ✓ |
| POST /api/entries/:id/songs/spotify | Task 3 ✓ |
| SpotifyTrack type + API functions | Task 4 ✓ |
| i18n strings | Task 5 ✓ |
| SongItem state machine (idle/loading/results/adding/done/error) | Task 7 ✓ |
| Editable query field with retry | Task 7 ✓ |
| 0 results message | Task 7 ✓ |
| 503 → empty list (Spotify not connected) | Task 4 ✓ (returns []) |
| Persist spotifyUri/spotifyUrl/addedToPlaylist to DB | Task 3 ✓ |
| songIndex out of range → 409 | Task 3 ✓ |
| EntryInspector wiring | Task 8 ✓ |
| SongsPage | Not included — SongsPage uses its own inline renderer (not SongItem); adding there would duplicate logic. Out of scope per YAGNI. |
