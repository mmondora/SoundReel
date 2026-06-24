# Music List Extractor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a saved link is a music editorial page (ranking, playlist list, "best albums of 2026"), automatically extract all songs/artists and resolve each to a confirmed Spotify or YouTube URL, sending Spotify links to Spooty.

**Architecture:** Two-phase pipeline. Phase 1 (`musicListExtractor.ts`): fetch page via `extractPage` (Playwright-capable), ask Ollama to detect music list and extract `{title, artist}` pairs. Phase 2 (`songResolver.ts`): for each pair, call `searchTrack` (Spotify API) → if found POST to Spooty + record `spotifyUrl`; always generate `youtubeUrl` as fallback. A Fastify route `POST /api/music-list/process` orchestrates both phases for a given `entryId`. After `analyze.ts` completes an entry, it fires the route as a non-blocking background call.

**Tech Stack:** TypeScript strict, Fastify, `generateText` from `ollamaClient.ts` (`qwen2.5:3b`), `searchTrack` + `generateYoutubeSearchUrl` from `spotify.ts`, `extractPage` from `pageExtractor.ts`, Spooty HTTP POST, Vitest for tests.

## Global Constraints

- TypeScript strict — no `any`; define all types in the file or import from `../types/index.ts`
- No real calls to Ollama, Spotify, Spooty, or HTTP in tests — mock everything
- `OLLAMA_TEXT_MODEL` env var (default `qwen2.5:3b`) for all Ollama calls
- `SPOOTY_URL` env var (default `http://spooty:3000`) for Spooty
- Each pipeline step independent — failure logged to `actionLog`, never throws to caller
- No new npm packages — all tools already in codebase
- Commit after each task

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `backend/src/services/musicListExtractor.ts` | Create | Detect music list + extract song list from page text |
| `backend/src/services/songResolver.ts` | Create | Resolve `{title,artist}` → Spotify/YT URL + Spooty POST |
| `backend/src/routes/musicList.ts` | Create | `POST /api/music-list/process` orchestration route |
| `backend/src/server.ts` | Modify | Register `musicList` route |
| `backend/src/routes/analyze.ts` | Modify | Fire-and-forget call after entry saved |
| `backend/src/services/musicListExtractor.test.ts` | Create | Unit tests (mock Ollama + extractPage) |
| `backend/src/services/songResolver.test.ts` | Create | Unit tests (mock Spotify + fetch) |
| `backend/src/routes/musicList.test.ts` | Create | Route tests (mock DB + services) |

---

## Task 1: musicListExtractor.ts — Detect + Extract

**Files:**
- Create: `backend/src/services/musicListExtractor.ts`
- Test: `backend/src/services/musicListExtractor.test.ts`

**Interfaces:**
- Consumes: `generateText` from `./ollamaClient`, `extractPage` from `./pageExtractor`
- Produces:
  ```typescript
  export interface ExtractedSong { title: string; artist: string; }
  export async function detectMusicList(text: string): Promise<boolean>
  export async function extractSongsFromText(text: string): Promise<ExtractedSong[]>
  export async function extractSongsFromUrl(url: string): Promise<ExtractedSong[]>
  ```

- [ ] **Step 1: Write failing tests**

File: `backend/src/services/musicListExtractor.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./ollamaClient', () => ({ generateText: vi.fn() }));
vi.mock('./pageExtractor', () => ({ extractPage: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { detectMusicList, extractSongsFromText, extractSongsFromUrl } from './musicListExtractor';
import { generateText } from './ollamaClient';
import { extractPage } from './pageExtractor';

describe('detectMusicList', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when Ollama answers yes', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'yes', usageMetadata: null });
    expect(await detectMusicList('Top 10 albums of 2026')).toBe(true);
  });

  it('returns true for YES (case-insensitive)', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'YES\n', usageMetadata: null });
    expect(await detectMusicList('some text')).toBe(true);
  });

  it('returns false when Ollama answers no', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    expect(await detectMusicList('a recipe for pasta')).toBe(false);
  });

  it('returns false when Ollama throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('Ollama down'));
    expect(await detectMusicList('text')).toBe(false);
  });

  it('truncates input to 2000 chars', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    await detectMusicList('x'.repeat(5000));
    const call = vi.mocked(generateText).mock.calls[0][0] as string;
    expect(call).toContain('x'.repeat(2000));
    expect(call).not.toContain('x'.repeat(2001));
  });
});

describe('extractSongsFromText', () => {
  beforeEach(() => vi.clearAllMocks());

  it('parses valid JSON array', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[{"title":"Bohemian Rhapsody","artist":"Queen"},{"title":"Hotel California","artist":"Eagles"}]',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('some music text');
    expect(songs).toEqual([
      { title: 'Bohemian Rhapsody', artist: 'Queen' },
      { title: 'Hotel California', artist: 'Eagles' },
    ]);
  });

  it('extracts JSON embedded in prose', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: 'Here are the songs: [{"title":"One","artist":"Metallica"}] Hope that helps!',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('text');
    expect(songs).toEqual([{ title: 'One', artist: 'Metallica' }]);
  });

  it('filters entries missing title or artist', async () => {
    vi.mocked(generateText).mockResolvedValue({
      text: '[{"title":"Valid","artist":"Artist"},{"title":"","artist":"No Title"},{"title":"No Artist","artist":""}]',
      usageMetadata: null,
    });
    const songs = await extractSongsFromText('text');
    expect(songs).toEqual([{ title: 'Valid', artist: 'Artist' }]);
  });

  it('returns [] when no JSON array in response', async () => {
    vi.mocked(generateText).mockResolvedValue({ text: 'No songs found.', usageMetadata: null });
    expect(await extractSongsFromText('text')).toEqual([]);
  });

  it('returns [] when Ollama throws', async () => {
    vi.mocked(generateText).mockRejectedValue(new Error('fail'));
    expect(await extractSongsFromText('text')).toEqual([]);
  });
});

describe('extractSongsFromUrl', () => {
  beforeEach(() => vi.clearAllMocks());

  it('fetches page and extracts songs when music list detected', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: 'Top 10', description: null, mainText: 'Top 10 albums text',
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    vi.mocked(generateText)
      .mockResolvedValueOnce({ text: 'yes', usageMetadata: null }) // detect
      .mockResolvedValueOnce({ text: '[{"title":"Abbey Road","artist":"Beatles"}]', usageMetadata: null }); // extract
    const songs = await extractSongsFromUrl('https://example.com/top10');
    expect(songs).toEqual([{ title: 'Abbey Road', artist: 'Beatles' }]);
  });

  it('returns [] when page is not a music list', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: 'Recipe', description: null, mainText: 'pasta recipe text',
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    vi.mocked(generateText).mockResolvedValue({ text: 'no', usageMetadata: null });
    expect(await extractSongsFromUrl('https://example.com/recipe')).toEqual([]);
    expect(vi.mocked(generateText)).toHaveBeenCalledTimes(1); // detect only, no extract
  });

  it('returns [] when page has no mainText', async () => {
    vi.mocked(extractPage).mockResolvedValue({
      finalUrl: 'https://example.com', httpStatus: 200, contentType: 'text/html',
      title: null, description: null, mainText: null,
      representativeImageUrl: null, rawLinks: [], siteName: null, lang: null,
    });
    expect(await extractSongsFromUrl('https://example.com')).toEqual([]);
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });

  it('returns [] when extractPage throws', async () => {
    vi.mocked(extractPage).mockRejectedValue(new Error('Network error'));
    expect(await extractSongsFromUrl('https://example.com')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /home/mike/works/Soundreel/backend && npm test -- musicListExtractor
```

Expected: FAIL — "Cannot find module './musicListExtractor'"

- [ ] **Step 3: Implement musicListExtractor.ts**

```typescript
import { generateText } from './ollamaClient';
import { extractPage } from './pageExtractor';
import { logInfo, logWarning, logError } from '../utils/logger';

export interface ExtractedSong {
  title: string;
  artist: string;
}

const MODEL = process.env.OLLAMA_TEXT_MODEL || 'qwen2.5:3b';

export async function detectMusicList(text: string): Promise<boolean> {
  const excerpt = text.slice(0, 2000);
  const prompt = `Is the following text a music list, ranking, chart, album collection, or playlist? Answer only "yes" or "no".\n\n${excerpt}`;
  try {
    const res = await generateText(prompt, undefined, MODEL);
    return res.text.trim().toLowerCase().startsWith('yes');
  } catch (err) {
    logWarning('detectMusicList failed', { err: String(err) });
    return false;
  }
}

export async function extractSongsFromText(text: string): Promise<ExtractedSong[]> {
  const excerpt = text.slice(0, 4000);
  const prompt = `Extract all songs and albums from the following text. Return a JSON array of objects with "title" and "artist" string fields. Return only the JSON array, no other text.\n\n${excerpt}`;
  try {
    const res = await generateText(prompt, undefined, MODEL);
    const match = res.text.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const parsed = JSON.parse(match[0]) as unknown[];
    return (parsed as Array<{ title?: unknown; artist?: unknown }>)
      .filter((s) => typeof s.title === 'string' && s.title.trim() && typeof s.artist === 'string' && s.artist.trim())
      .map((s) => ({ title: (s.title as string).trim(), artist: (s.artist as string).trim() }));
  } catch (err) {
    logWarning('extractSongsFromText failed', { err: String(err) });
    return [];
  }
}

export async function extractSongsFromUrl(url: string): Promise<ExtractedSong[]> {
  try {
    const page = await extractPage(url);
    if (!page.mainText) {
      logInfo('extractSongsFromUrl: no mainText', { url });
      return [];
    }
    const isMusicList = await detectMusicList(page.mainText);
    if (!isMusicList) {
      logInfo('extractSongsFromUrl: not a music list', { url });
      return [];
    }
    const songs = await extractSongsFromText(page.mainText);
    logInfo('extractSongsFromUrl: extracted songs', { url, count: songs.length });
    return songs;
  } catch (err) {
    logError('extractSongsFromUrl failed', { url, err: String(err) });
    return [];
  }
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /home/mike/works/Soundreel/backend && npm test -- musicListExtractor
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /home/mike/works/Soundreel add \
  backend/src/services/musicListExtractor.ts \
  backend/src/services/musicListExtractor.test.ts
git -C /home/mike/works/Soundreel commit -m "feat(music-list): Phase 1 — detect music list + extract songs from page"
```

---

## Task 2: songResolver.ts — Resolve + Spooty

**Files:**
- Create: `backend/src/services/songResolver.ts`
- Test: `backend/src/services/songResolver.test.ts`

**Interfaces:**
- Consumes: `searchTrack`, `generateYoutubeSearchUrl` from `./spotify`, `ExtractedSong` from `./musicListExtractor`
- Produces:
  ```typescript
  export interface ResolvedSong {
    title: string;
    artist: string;
    spotifyUrl: string | null;
    spotifyUri: string | null;
    youtubeUrl: string;
    sentToSpooty: boolean;
  }
  export async function resolveSong(song: ExtractedSong): Promise<ResolvedSong>
  export async function resolveSongs(songs: ExtractedSong[]): Promise<ResolvedSong[]>
  ```

- [ ] **Step 1: Write failing tests**

File: `backend/src/services/songResolver.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./spotify', () => ({
  searchTrack: vi.fn(),
  generateYoutubeSearchUrl: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

// Mock global fetch for Spooty calls
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { resolveSong, resolveSongs } from './songResolver';
import { searchTrack, generateYoutubeSearchUrl } from './spotify';

const SONG = { title: 'Bohemian Rhapsody', artist: 'Queen' };

describe('resolveSong', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=Bohemian+Rhapsody+Queen');
  });

  it('resolves with Spotify URL when track found', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockResolvedValue({ ok: true });

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
    expect(result.spotifyUri).toBe('spotify:track:123');
    expect(result.youtubeUrl).toBe('https://youtube.com/results?search_query=Bohemian+Rhapsody+Queen');
    expect(result.sentToSpooty).toBe(true);
  });

  it('sets spotifyUrl null when Spotify search returns nothing', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBeNull();
    expect(result.spotifyUri).toBeNull();
    expect(result.sentToSpooty).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('sets sentToSpooty false when Spooty POST fails', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => 'Server Error' });

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
    expect(result.sentToSpooty).toBe(false);
  });

  it('sets sentToSpooty false when fetch throws', async () => {
    vi.mocked(searchTrack).mockResolvedValue({
      uri: 'spotify:track:123', url: 'https://open.spotify.com/track/123',
      name: 'Bohemian Rhapsody', artist: 'Queen',
    });
    mockFetch.mockRejectedValue(new Error('Network error'));

    const result = await resolveSong(SONG);
    expect(result.sentToSpooty).toBe(false);
    expect(result.spotifyUrl).toBe('https://open.spotify.com/track/123');
  });

  it('always populates youtubeUrl regardless of Spotify result', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=test');

    const result = await resolveSong({ title: 'test', artist: 'artist' });
    expect(result.youtubeUrl).toBe('https://youtube.com/results?search_query=test');
  });

  it('returns failed resolve when searchTrack throws', async () => {
    vi.mocked(searchTrack).mockRejectedValue(new Error('Spotify API error'));

    const result = await resolveSong(SONG);
    expect(result.spotifyUrl).toBeNull();
    expect(result.sentToSpooty).toBe(false);
  });
});

describe('resolveSongs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(generateYoutubeSearchUrl).mockReturnValue('https://youtube.com/results?search_query=x');
  });

  it('resolves all songs in parallel', async () => {
    vi.mocked(searchTrack).mockResolvedValue(null);
    const songs = [SONG, { title: 'Hotel California', artist: 'Eagles' }];
    const results = await resolveSongs(songs);
    expect(results).toHaveLength(2);
    expect(vi.mocked(searchTrack)).toHaveBeenCalledTimes(2);
  });

  it('returns empty array for empty input', async () => {
    expect(await resolveSongs([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /home/mike/works/Soundreel/backend && npm test -- songResolver
```

Expected: FAIL — "Cannot find module './songResolver'"

- [ ] **Step 3: Implement songResolver.ts**

```typescript
import { searchTrack, generateYoutubeSearchUrl } from './spotify';
import { logInfo, logWarning, logError } from '../utils/logger';
import type { ExtractedSong } from './musicListExtractor';

export interface ResolvedSong {
  title: string;
  artist: string;
  spotifyUrl: string | null;
  spotifyUri: string | null;
  youtubeUrl: string;
  sentToSpooty: boolean;
}

async function postToSpooty(spotifyUrl: string): Promise<boolean> {
  const base = process.env.SPOOTY_URL || 'http://spooty:3000';
  try {
    const res = await fetch(`${base}/api/playlist`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ spotifyUrl }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logWarning('Spooty POST failed', { status: res.status, body: body.slice(0, 200) });
      return false;
    }
    return true;
  } catch (err) {
    logWarning('Spooty POST error', { err: String(err) });
    return false;
  }
}

export async function resolveSong(song: ExtractedSong): Promise<ResolvedSong> {
  const youtubeUrl = generateYoutubeSearchUrl(song.title, song.artist);
  try {
    const track = await searchTrack(song.title, song.artist);
    if (!track) {
      logInfo('resolveSong: no Spotify result', { title: song.title, artist: song.artist });
      return { title: song.title, artist: song.artist, spotifyUrl: null, spotifyUri: null, youtubeUrl, sentToSpooty: false };
    }
    logInfo('resolveSong: Spotify found', { title: track.name, artist: track.artist });
    const sentToSpooty = await postToSpooty(track.url);
    return {
      title: song.title,
      artist: song.artist,
      spotifyUrl: track.url,
      spotifyUri: track.uri,
      youtubeUrl,
      sentToSpooty,
    };
  } catch (err) {
    logError('resolveSong failed', { title: song.title, err: String(err) });
    return { title: song.title, artist: song.artist, spotifyUrl: null, spotifyUri: null, youtubeUrl, sentToSpooty: false };
  }
}

export async function resolveSongs(songs: ExtractedSong[]): Promise<ResolvedSong[]> {
  return Promise.all(songs.map((s) => resolveSong(s)));
}
```

- [ ] **Step 4: Run tests — confirm PASS**

```bash
cd /home/mike/works/Soundreel/backend && npm test -- songResolver
```

Expected: all tests PASS

- [ ] **Step 5: Commit**

```bash
git -C /home/mike/works/Soundreel add \
  backend/src/services/songResolver.ts \
  backend/src/services/songResolver.test.ts
git -C /home/mike/works/Soundreel commit -m "feat(music-list): Phase 2 — resolve songs to Spotify/YT URLs + Spooty"
```

---

## Task 3: Route + Server Registration + analyze.ts Integration

**Files:**
- Create: `backend/src/routes/musicList.ts`
- Modify: `backend/src/server.ts` (line ~17 imports + ~42 `registerSearchRoute` area)
- Modify: `backend/src/routes/analyze.ts` (after entry saved — find `appendActionLog` final call)
- Test: `backend/src/routes/musicList.test.ts`

**Interfaces:**
- Consumes: `extractSongsFromUrl` from `../services/musicListExtractor`, `resolveSongs` from `../services/songResolver`, `getEntry`, `appendActionLog`, `createActionLog` from `../utils/db`
- Route: `POST /api/music-list/process` body `{entryId: string}` → response `{detected: boolean, songs: ResolvedSong[], spooty: number}`

- [ ] **Step 1: Write failing tests**

File: `backend/src/routes/musicList.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

vi.mock('../../utils/db', () => ({ getEntry: vi.fn(), appendActionLog: vi.fn(), createActionLog: vi.fn() }));
vi.mock('../../services/musicListExtractor', () => ({ extractSongsFromUrl: vi.fn() }));
vi.mock('../../services/songResolver', () => ({ resolveSongs: vi.fn() }));
vi.mock('../../utils/logger', () => ({ logInfo: vi.fn(), logError: vi.fn() }));

import { registerMusicListRoute } from './musicList';
import { getEntry, appendActionLog, createActionLog } from '../../utils/db';
import { extractSongsFromUrl } from '../../services/musicListExtractor';
import { resolveSongs } from '../../services/songResolver';

function buildApp() {
  const app = Fastify();
  registerMusicListRoute(app);
  return app;
}

const MOCK_ENTRY = {
  id: 'entry-1', sourceUrl: 'https://example.com/top10',
  caption: 'Top 10 albums', results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
};

describe('POST /api/music-list/process', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(createActionLog).mockReturnValue({ action: 'test', details: {}, timestamp: '2026-01-01T00:00:00.000Z' });
  });

  it('returns 400 when entryId missing', async () => {
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: {} });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/entryId/i);
  });

  it('returns 404 when entry not found', async () => {
    vi.mocked(getEntry).mockResolvedValue(null);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'missing' } });
    expect(res.statusCode).toBe(404);
  });

  it('returns detected:false when no songs extracted', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(extractSongsFromUrl).mockResolvedValue([]);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ detected: false, songs: [], spooty: 0 });
    expect(resolveSongs).not.toHaveBeenCalled();
  });

  it('returns detected:true with resolved songs', async () => {
    vi.mocked(getEntry).mockResolvedValue(MOCK_ENTRY as never);
    vi.mocked(extractSongsFromUrl).mockResolvedValue([{ title: 'Abbey Road', artist: 'Beatles' }]);
    vi.mocked(resolveSongs).mockResolvedValue([{
      title: 'Abbey Road', artist: 'Beatles',
      spotifyUrl: 'https://open.spotify.com/track/123', spotifyUri: 'spotify:track:123',
      youtubeUrl: 'https://youtube.com/results?search_query=Abbey+Road+Beatles',
      sentToSpooty: true,
    }]);
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.detected).toBe(true);
    expect(body.songs).toHaveLength(1);
    expect(body.spooty).toBe(1);
    expect(appendActionLog).toHaveBeenCalled();
  });

  it('returns 500 on unexpected error', async () => {
    vi.mocked(getEntry).mockRejectedValue(new Error('DB down'));
    const app = buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/music-list/process', payload: { entryId: 'entry-1' } });
    expect(res.statusCode).toBe(500);
  });
});
```

- [ ] **Step 2: Run tests — confirm FAIL**

```bash
cd /home/mike/works/Soundreel/backend && npm test -- musicList
```

Expected: FAIL — "Cannot find module './musicList'"

- [ ] **Step 3: Implement musicList.ts route**

Read `backend/src/utils/db.ts` to find `getEntry` signature before implementing. The function returns an `Entry | null`.

```typescript
import type { FastifyInstance } from 'fastify';
import { getEntry, appendActionLog, createActionLog } from '../utils/db';
import { extractSongsFromUrl } from '../services/musicListExtractor';
import { resolveSongs } from '../services/songResolver';
import type { ResolvedSong } from '../services/songResolver';
import { logInfo, logError } from '../utils/logger';

interface ProcessBody { entryId?: string; }
interface ProcessReply { detected: boolean; songs: ResolvedSong[]; spooty: number; }

export function registerMusicListRoute(app: FastifyInstance): void {
  app.post<{ Body: ProcessBody }>('/api/music-list/process', async (req, reply) => {
    const { entryId } = req.body;
    if (!entryId || typeof entryId !== 'string') {
      return reply.code(400).send({ error: 'entryId is required' });
    }

    try {
      const entry = await getEntry(entryId);
      if (!entry) {
        return reply.code(404).send({ error: 'Entry not found' });
      }

      logInfo('music-list process start', { entryId, url: entry.sourceUrl });

      const extracted = await extractSongsFromUrl(entry.sourceUrl);
      if (!extracted.length) {
        await appendActionLog(entryId, createActionLog('music_list_process', {
          detected: false, songsFound: 0,
        }));
        return reply.send({ detected: false, songs: [], spooty: 0 });
      }

      const resolved = await resolveSongs(extracted);
      const spooty = resolved.filter((s) => s.sentToSpooty).length;

      await appendActionLog(entryId, createActionLog('music_list_process', {
        detected: true,
        songsFound: extracted.length,
        songsResolved: resolved.length,
        sentToSpooty: spooty,
      }));

      logInfo('music-list process done', { entryId, songsFound: extracted.length, spooty });
      const result: ProcessReply = { detected: true, songs: resolved, spooty };
      return reply.send(result);
    } catch (err) {
      logError('music-list process error', { entryId, err: String(err) });
      return reply.code(500).send({ error: 'Processing failed' });
    }
  });
}
```

- [ ] **Step 4: Register route in server.ts**

In `backend/src/server.ts`, after the import for `registerSearchRoute`:

```typescript
import { registerMusicListRoute } from './routes/musicList';
```

After the `registerSearchRoute(app)` call:

```typescript
registerMusicListRoute(app);
```

- [ ] **Step 5: Add fire-and-forget trigger in analyze.ts**

Find the point in `analyze.ts` where the entry status is set to `'completed'` and the final `appendActionLog` is called. After that block (inside a `try/catch` so it never throws), add:

```typescript
// Fire-and-forget: detect and resolve music list in background
(async () => {
  try {
    const { extractSongsFromUrl } = await import('./musicListExtractor'); // adjust relative path
    const { resolveSongs } = await import('./songResolver');
    const extracted = await extractSongsFromUrl(normalizedUrl);
    if (extracted.length) {
      const resolved = await resolveSongs(extracted);
      const spooty = resolved.filter((s) => s.sentToSpooty).length;
      await appendActionLog(entryId, createActionLog('music_list_auto', {
        songsFound: extracted.length, sentToSpooty: spooty,
      }));
    }
  } catch (_err) {
    // non-blocking: failure logged by inner functions
  }
})();
```

**Note:** The import paths for `extractSongsFromUrl` and `resolveSongs` in analyze.ts are `'../services/musicListExtractor'` and `'../services/songResolver'` (one level up from routes). Use static imports at the top of the file instead of dynamic imports to match the existing pattern:

```typescript
import { extractSongsFromUrl } from '../services/musicListExtractor';
import { resolveSongs } from '../services/songResolver';
```

Add both imports at the top of `analyze.ts` alongside the other service imports.

- [ ] **Step 6: Run all tests**

```bash
cd /home/mike/works/Soundreel/backend && npm test
```

Expected: all tests PASS (including musicList route tests)

- [ ] **Step 7: Commit**

```bash
git -C /home/mike/works/Soundreel add \
  backend/src/routes/musicList.ts \
  backend/src/routes/musicList.test.ts \
  backend/src/server.ts \
  backend/src/routes/analyze.ts
git -C /home/mike/works/Soundreel commit -m "feat(music-list): route + server wiring + auto-trigger in analyze pipeline"
```

---

## Self-Review

**Spec coverage:**
- [x] Phase 1: detect music list from URL → `extractSongsFromUrl` (Task 1)
- [x] Phase 1: extract `{title, artist}` pairs → `detectMusicList` + `extractSongsFromText` (Task 1)
- [x] Phase 2: Spotify search → confirmed URL → `searchTrack` (Task 2)
- [x] Phase 2: YouTube fallback URL → `generateYoutubeSearchUrl` (Task 2)
- [x] Phase 2: POST to Spooty → `postToSpooty` (Task 2)
- [x] Trigger from analyze pipeline → fire-and-forget in Task 3
- [x] Standalone endpoint for manual/programmatic use → `POST /api/music-list/process` (Task 3)
- [x] All steps resilient: errors logged, never throw to caller
- [x] No real network calls in tests

**Placeholder scan:** None found.

**Type consistency:**
- `ExtractedSong` defined in Task 1, consumed in Task 2 (`resolveSong(song: ExtractedSong)`) ✓
- `ResolvedSong` defined in Task 2, returned in Task 3 route ✓
- `registerMusicListRoute` exported from Task 3, imported in server.ts ✓
