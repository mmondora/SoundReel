/**
 * Parity: the same link must produce the same effects whichever channel it arrives from
 * (Telegram webhook, Mondrop `/api/share`, web `/api/analyze`). Only the response format
 * may differ. This is the regression net for "Mondrop = Telegram".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';

vi.mock('../utils/db', () => {
  const base: Record<string, unknown> = {
    countEntries: vi.fn().mockResolvedValue(0),
    listEntries: vi.fn().mockResolvedValue([]),
    findEntryByUrl: vi.fn(),
    createEntry: vi.fn(),
    updateEntry: vi.fn(),
    appendActionLog: vi.fn(),
    getEntry: vi.fn(),
    createActionLog: vi.fn((action: string, details: unknown) => ({ action, details, timestamp: 't' })),
    getApiKeysConfig: vi.fn(),
    updateApiKeysConfig: vi.fn(),
  };
  // analyze.ts touches a few db exports at import time (`void getInstagramConfig;`) and imports dozens of others
  // it never reaches on the Spotify path: answer anything we did not define with an inert function.
  return new Proxy(base, {
    // vitest rejects reads of exports a factory does not declare: declare them all.
    has: (_target, prop) => prop !== 'then',
    get: (target, prop) => (prop in target ? target[prop as string] : prop === 'then' ? undefined : vi.fn()),
  });
});
vi.mock('../utils/jobQueue', () => ({ enqueueJob: vi.fn() }));
// Parity is about the entry and the job each channel creates. What only Mondrop adds afterwards (the playlist, the
// family, the inbox: docs/mondrop-inbox.md) is covered by share.options.test.ts and shareFlow.test.ts.
vi.mock('../services/shareFlow', async (orig) => ({
  ...(await orig<typeof import('../services/shareFlow')>()),
  registerShare: vi.fn(async () => ({ playlist: null, sharedWith: [] })),
  recordShareError: vi.fn(),
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn(), createActionLog: vi.fn() }));
vi.mock('../services/debugLogger', () => ({
  Logger: vi.fn().mockImplementation(function () {
    return { startTimer: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), endTimer: vi.fn() };
  }),
}));
vi.mock('../services/promptLoader', () => ({ getPrompt: vi.fn().mockRejectedValue(new Error('x')), renderTemplate: vi.fn() }));
vi.mock('../services/telegramIdentity', () => ({
  resolveTelegramOwner: vi.fn().mockResolvedValue({ mapped: true, ownerUser: 'mike' }),
  isPendingName: vi.fn().mockReturnValue(false),
  markPendingName: vi.fn(),
  clearPendingName: vi.fn(),
  claimTelegramName: vi.fn(),
  ASK_NAME_MESSAGE: 'ask-name',
}));
vi.mock('../services/spootyClient', async (orig) => ({
  ...(await orig<typeof import('../services/spootyClient')>()),
  addToSpooty: vi.fn(),
  findSpootyPlaylistByUrl: vi.fn(),
  listSpootyTracks: vi.fn(),
  retrySpootyTrack: vi.fn(),
}));
vi.mock('../services/spootyRequests', () => ({
  insertSpootyRequest: vi.fn(),
  getSpootyRequestByEntry: vi.fn(),
  patchSpootyRequest: vi.fn(),
}));
vi.mock('../services/songMeta', async (orig) => ({
  ...(await orig<typeof import('../services/songMeta')>()),
  setSongCoverIfMissing: vi.fn(),
}));
// The Shazam page reader is the only network edge of a Shazam link; parsing/canonical forms stay real.
vi.mock('../services/shazamLink', async (orig) => ({
  ...(await orig<typeof import('../services/shazamLink')>()),
  fetchShazamTrack: vi.fn(),
}));

// The web adapter lives inside the (huge) analysis route. Everything it imports for the
// analysis pipeline is irrelevant to link ingest: stub it so the route can be registered.
vi.mock('../services/aiRequestContext', () => ({ setAiRequestMode: vi.fn() }));
vi.mock('../services/contentExtractor', () => ({ extractContent: vi.fn(), detectPlatform: vi.fn(), setLogger: vi.fn() }));
for (const mod of [
  'aiAnalysis', 'aiAnalysisWebPage', 'entryLock', 'filmMeta', 'filmSearch', 'frameSelector', '_legacy/audioRecognition',
  '_legacy/mediaDownloader', '_legacy/transcribeAudioStub', 'localMedia', 'musicListExtractor', 'noteEnrichmentHook',
  'noteMeta', 'ocrClient', 'ollamaClient', 'openaiEnrich', 'pageExtractor', 'resultMerger', 'shazamClient', 'slideAnalysis',
  'songEnrichmentHook', 'songPersistence', 'songResolver', 'spotify', 'ssrfGuard', 'streamingAvailability',
  'streamingRefresher', 'thumbnailSaver', 'transcriptSource', 'visualContextSource',
]) {
  vi.doMock(`../services/${mod}`, () => ({}));
}

import { registerTelegramRoute } from './telegram';
import { registerShareRoute } from './share';
import { createEntry, findEntryByUrl, getEntry, getApiKeysConfig } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';
import { addToSpooty, findSpootyPlaylistByUrl, listSpootyTracks } from '../services/spootyClient';
import { insertSpootyRequest } from '../services/spootyRequests';
import { fetchShazamTrack, ShazamFetchError } from '../services/shazamLink';

const KEY = 'sr_parity_key_1234567890ab';
const ID = '22kBlINGUYm2rc1Wd7RPfw';
const ALBUM_ID = '1DFixLWuPkv3KT3TnV35m3';

const SHARED_TRACK = `https://open.spotify.com/track/${ID}?si=6840D4mBRcW8-6xkWXS8wA&utm_source=copy-link`;
const trackPlaylist = (url: string) => ({ id: 38, name: "Say it Ain't So", spotifyUrl: url, error: null, active: false, isTrack: true, coverUrl: 'https://i.scdn.co/c' });
const trackRows = [{ id: 609, artist: 'PENNY', name: "Say it Ain't So", spotifyUrl: `https://open.spotify.com/track/${ID}`, youtubeUrl: null, status: 1, error: null, coverUrl: 'https://i.scdn.co/c' }];
const albumPlaylist = (url: string) => ({ id: 40, name: 'Moon Safari', spotifyUrl: url, error: null, active: false, isTrack: false, coverUrl: 'https://i.scdn.co/a' });
const albumRows = [
  { id: 1, artist: 'Air', name: 'Sexy Boy', spotifyUrl: 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA', youtubeUrl: null, status: 2, error: null, coverUrl: null },
  { id: 2, artist: 'Air', name: 'Kelly Watch the Stars', spotifyUrl: 'https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB', youtubeUrl: null, status: 2, error: null, coverUrl: null },
];

type Adapter = 'telegram' | 'share' | 'web';
const ADAPTERS: Adapter[] = ['telegram', 'share', 'web'];

function buildApp() {
  const app = Fastify();
  registerTelegramRoute(app);
  registerShareRoute(app);
  return app;
}

async function send(app: ReturnType<typeof buildApp>, adapter: Adapter, url: string) {
  if (adapter === 'telegram') {
    return app.inject({
      method: 'POST', url: '/telegram/webhook',
      payload: { update_id: 1, message: { message_id: 1, chat: { id: 555 }, from: { username: 'mike' }, text: url } },
    });
  }
  if (adapter === 'share') {
    return app.inject({ method: 'POST', url: '/api/share', headers: { 'x-soundreel-key': KEY }, payload: { url, user: 'mike' } });
  }
  return app.inject({ method: 'POST', url: '/api/analyze', headers: { 'remote-user': 'mike' }, payload: { url } });
}

/** Everything observable about what a channel did, minus transport-specific fields. */
function effects() {
  const entry = vi.mocked(createEntry).mock.calls[0]?.[0];
  return {
    entry: entry
      ? {
          sourceUrl: entry.sourceUrl,
          sourcePlatform: entry.sourcePlatform,
          ownerUser: entry.ownerUser,
          status: entry.status,
          caption: entry.caption,
          tags: entry.results.tags,
          songs: entry.results.songs.map((s) => `${s.artist}|${s.title}|${s.source}|${s.spotifyUrl ?? ''}`),
        }
      : null,
    spooty: vi.mocked(addToSpooty).mock.calls.map((c) => c[0]),
    requests: vi.mocked(insertSpootyRequest).mock.calls.map((c) => ({
      spotifyUrl: c[0].spotifyUrl, kind: c[0].kind, status: c[0].status, spootyPlaylistId: c[0].spootyPlaylistId, ownerUser: c[0].ownerUser,
    })),
    jobs: vi.mocked(enqueueJob).mock.calls.map((c) => ({ platform: c[0].platform, sourceUrl: c[0].sourceUrl })),
  };
}

let telegramTexts: string[] = [];

beforeEach(async () => {
  vi.clearAllMocks();
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  telegramTexts = [];
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).includes('api.telegram.org')) {
      telegramTexts.push((JSON.parse(String(init?.body)) as { text: string }).text);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${String(input)}`);
  }));
  vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: [KEY] });
  vi.mocked(findEntryByUrl).mockResolvedValue(null);
  vi.mocked(createEntry).mockResolvedValue('entry-1');
  vi.mocked(enqueueJob).mockResolvedValue(1);
  vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
  vi.mocked(getEntry).mockResolvedValue({ id: 'entry-1', status: 'processing' } as never);
  vi.mocked(insertSpootyRequest).mockResolvedValue({} as never);
  // The web adapter is registered lazily: it needs the module mocks above to be in place first.
  const { registerAnalyzeRoute } = await import('./analyze');
  (globalThis as { __registerAnalyze?: typeof registerAnalyzeRoute }).__registerAnalyze = registerAnalyzeRoute;
});

async function appWithWeb() {
  const app = buildApp();
  (globalThis as { __registerAnalyze?: (a: typeof app) => void }).__registerAnalyze?.(app);
  return app;
}

function primeSpooty(kind: 'track' | 'album', url: string) {
  const playlist = kind === 'track' ? trackPlaylist(url) : albumPlaylist(url);
  // find-before-add: nothing yet, then the playlist Spooty created from our POST.
  vi.mocked(findSpootyPlaylistByUrl).mockReset();
  vi.mocked(findSpootyPlaylistByUrl).mockResolvedValueOnce(null).mockResolvedValueOnce(playlist);
  vi.mocked(listSpootyTracks).mockResolvedValue(kind === 'track' ? trackRows : albumRows);
}

describe('Spotify links: Telegram = Mondrop share = web', () => {
  const SPOTIFY_CASES: Array<{ name: string; url: string; kind: 'track' | 'album' }> = [
    { name: 'track as copied from the app (si + utm)', url: SHARED_TRACK, kind: 'track' },
    { name: 'track with locale prefix', url: `https://open.spotify.com/intl-it/track/${ID}`, kind: 'track' },
    { name: 'album', url: `https://open.spotify.com/album/${ALBUM_ID}?si=abc`, kind: 'album' },
  ];

  it.each(SPOTIFY_CASES)('$name → identical effects on every channel', async ({ url, kind }) => {
    const seen = {} as Record<Adapter, ReturnType<typeof effects>>;
    for (const adapter of ADAPTERS) {
      vi.clearAllMocks();
      vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: [KEY] });
      vi.mocked(findEntryByUrl).mockResolvedValue(null);
      vi.mocked(createEntry).mockResolvedValue('entry-1');
      vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
      vi.mocked(getEntry).mockResolvedValue({ id: 'entry-1', status: 'processing' } as never);
      vi.mocked(insertSpootyRequest).mockResolvedValue({} as never);
      primeSpooty(kind, url);

      const app = await appWithWeb();
      const res = await send(app, adapter, url);
      expect(res.statusCode, `${adapter}: ${res.body}`).toBe(200);
      seen[adapter] = effects();
    }

    // Same effects, whichever door the link came through.
    expect(seen.share).toEqual(seen.telegram);
    expect(seen.web).toEqual(seen.telegram);

    // And those effects are the ones Mondrop must have: library entry + Spooty, no page analysis.
    const e = seen.telegram;
    const canonical = kind === 'track'
      ? `https://open.spotify.com/track/${ID}`
      : `https://open.spotify.com/album/${ALBUM_ID}`;
    expect(e.entry).toMatchObject({ sourceUrl: canonical, sourcePlatform: 'spotify', ownerUser: 'mike', status: 'processing' });
    expect(e.entry?.songs.length).toBeGreaterThan(0);
    expect(e.entry?.songs.every((s) => s.includes('|spotify_link|'))).toBe(true);
    expect(e.spooty).toEqual([canonical]);
    expect(e.requests).toEqual([{ spotifyUrl: canonical, kind, status: 'tracking', spootyPlaylistId: kind === 'track' ? 38 : 40, ownerUser: 'mike' }]);
    expect(e.jobs).toEqual([]);
  });

  it('replies in each channel’s own format (and only the format differs)', async () => {
    const app = await appWithWeb();

    primeSpooty('track', SHARED_TRACK);
    await send(app, 'telegram', SHARED_TRACK);
    expect(telegramTexts).toHaveLength(1);
    expect(telegramTexts[0]).toContain("PENNY – Say it Ain't So");
    expect(telegramTexts[0]).toContain('In coda su Spooty');
    expect(telegramTexts[0]).toContain('/?entry=entry-1');

    vi.clearAllMocks();
    vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: [KEY] });
    vi.mocked(findEntryByUrl).mockResolvedValue(null);
    vi.mocked(createEntry).mockResolvedValue('entry-1');
    vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
    vi.mocked(insertSpootyRequest).mockResolvedValue({} as never);
    primeSpooty('track', SHARED_TRACK);
    const share = await send(app, 'share', SHARED_TRACK);
    expect(share.json()).toMatchObject({ success: true, entryId: 'entry-1', status: 'queued', kind: 'spotify', title: "Say it Ain't So", artist: 'PENNY' });

    vi.mocked(getEntry).mockResolvedValue({ id: 'entry-1', status: 'processing' } as never);
    vi.mocked(findEntryByUrl).mockResolvedValue(null);
    primeSpooty('track', SHARED_TRACK);
    const web = await send(app, 'web', SHARED_TRACK);
    expect(web.json()).toMatchObject({ success: true, entryId: 'entry-1', existing: false, entry: { id: 'entry-1' } });
  });

  it('the same link from two channels is stored and sent to Spooty only once', async () => {
    const app = await appWithWeb();
    primeSpooty('track', SHARED_TRACK);
    await send(app, 'telegram', SHARED_TRACK);
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(addToSpooty).toHaveBeenCalledTimes(1);

    // Second channel: the entry now exists.
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'entry-1', caption: "PENNY – Say it Ain't So", thumbnailUrl: 'c',
      results: { songs: [{ title: "Say it Ain't So", artist: 'PENNY', source: 'spotify_link' }], films: [], notes: [], links: [], tags: [], summary: null },
    } as never);
    const { getSpootyRequestByEntry } = await import('../services/spootyRequests');
    vi.mocked(getSpootyRequestByEntry).mockResolvedValue({ id: 1, status: 'tracking', spootyPlaylistId: 38 } as never);

    const res = await send(app, 'share', SHARED_TRACK);
    expect(res.statusCode).toBe(200);
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(addToSpooty).toHaveBeenCalledTimes(1);
  });
});

describe('Shazam links: Telegram = Mondrop share = web', () => {
  const PAGE = {
    title: 'White Flag',
    artist: 'Bishop Briggs',
    album: 'Church of Scars',
    coverUrl: 'https://is1-ssl.mzstatic.com/cover/800x800cc.jpg',
    pageUrl: 'https://www.shazam.com/song/1360212103/white-flag',
  };
  const SHAZAM_CASES: Array<{ name: string; url: string; canonical: string }> = [
    {
      name: 'link as the iOS Shazam app shares it (key + referrer)',
      url: 'https://www.shazam.com/track/404798580?referrer=share',
      canonical: 'https://www.shazam.com/track/404798580',
    },
    {
      name: 'track link with locale prefix and slug',
      url: 'https://www.shazam.com/it-it/track/404798580/white-flag',
      canonical: 'https://www.shazam.com/track/404798580',
    },
    {
      name: 'song link as copied from the browser',
      url: 'https://www.shazam.com/song/1360212103/white-flag?referrer=share',
      canonical: 'https://www.shazam.com/song/1360212103/white-flag',
    },
  ];
  const resetFor = (): void => {
    vi.clearAllMocks();
    vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: [KEY] });
    vi.mocked(findEntryByUrl).mockResolvedValue(null);
    vi.mocked(createEntry).mockResolvedValue('entry-1');
    vi.mocked(getEntry).mockResolvedValue({ id: 'entry-1', status: 'completed' } as never);
    vi.mocked(fetchShazamTrack).mockResolvedValue(PAGE);
  };

  it.each(SHAZAM_CASES)('$name → identical effects on every channel', async ({ url, canonical }) => {
    const seen = {} as Record<Adapter, ReturnType<typeof effects>>;
    for (const adapter of ADAPTERS) {
      resetFor();
      const app = await appWithWeb();
      const res = await send(app, adapter, url);
      expect(res.statusCode, `${adapter}: ${res.body}`).toBe(200);
      seen[adapter] = effects();
    }

    expect(seen.share).toEqual(seen.telegram);
    expect(seen.web).toEqual(seen.telegram);

    // The effects Mondrop must have: a finished library entry, no page analysis, no Spooty.
    const e = seen.telegram;
    expect(e.entry).toMatchObject({
      sourceUrl: canonical, sourcePlatform: 'shazam', ownerUser: 'mike', status: 'completed', caption: 'Bishop Briggs – White Flag',
      songs: ['Bishop Briggs|White Flag|shazam_link|'],
    });
    expect(e.jobs).toEqual([]);
    expect(e.spooty).toEqual([]);
    expect(e.requests).toEqual([]);
  });

  it('replies in each channel’s own format (and only the format differs)', async () => {
    const app = await appWithWeb();
    const url = SHAZAM_CASES[0].url;

    resetFor();
    await send(app, 'telegram', url);
    expect(telegramTexts).toHaveLength(1);
    expect(telegramTexts[0]).toContain('Bishop Briggs – White Flag');
    expect(telegramTexts[0]).toContain('Brano Shazam in libreria');
    expect(telegramTexts[0]).toContain('/?entry=entry-1');

    resetFor();
    const share = await send(app, 'share', url);
    expect(share.json()).toMatchObject({ success: true, entryId: 'entry-1', status: 'completed', kind: 'shazam', title: 'White Flag', artist: 'Bishop Briggs' });

    resetFor();
    const web = await send(app, 'web', url);
    expect(web.json()).toMatchObject({ success: true, entryId: 'entry-1', existing: false, entry: { id: 'entry-1' } });
  });

  it('page unreadable: stored as an error on every channel, and each channel says so in its own way', async () => {
    const app = await appWithWeb();
    const url = SHAZAM_CASES[0].url;
    const failure = new ShazamFetchError('mismatch', 'Shazam ha risposto con la pagina di un altro brano');

    resetFor();
    vi.mocked(fetchShazamTrack).mockRejectedValue(failure);
    await send(app, 'telegram', url);
    expect(vi.mocked(createEntry).mock.calls[0][0]).toMatchObject({ status: 'error', sourcePlatform: 'shazam', caption: null });
    expect(telegramTexts[0]).toContain('non riesco a leggere il brano');
    expect(telegramTexts[0]).toContain('Rimandalo per riprovare');

    // The share sheet must show the problem (success:false keeps it open); the entry id is still returned.
    resetFor();
    vi.mocked(fetchShazamTrack).mockRejectedValue(failure);
    const share = await send(app, 'share', url);
    expect(share.statusCode).toBe(200);
    expect(share.json()).toMatchObject({
      success: false, entryId: 'entry-1', status: 'error', kind: 'shazam', error: 'Shazam: Shazam ha risposto con la pagina di un altro brano',
    });
    expect(vi.mocked(createEntry).mock.calls[0][0]).toMatchObject({ status: 'error' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('the same link from two channels is read and stored only once', async () => {
    const app = await appWithWeb();
    resetFor();
    await send(app, 'telegram', SHAZAM_CASES[0].url);
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(fetchShazamTrack).toHaveBeenCalledTimes(1);

    // Second channel: the entry now exists and is complete.
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'entry-1', sourcePlatform: 'shazam', status: 'completed', caption: 'Bishop Briggs – White Flag', thumbnailUrl: 'c',
      results: { songs: [{ title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', source: 'shazam_link' }], films: [], notes: [], links: [], tags: [], summary: null },
    } as never);
    const res = await send(app, 'share', SHAZAM_CASES[0].url);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, entryId: 'entry-1', kind: 'shazam', title: 'White Flag' });
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(fetchShazamTrack).toHaveBeenCalledTimes(1);
  });
});

describe('Other links: Telegram = Mondrop share (stub + analysis job)', () => {
  const CASES: Array<[string, string, string]> = [
    ['Instagram reel', 'https://www.instagram.com/reel/abc123/', 'instagram'],
    ['TikTok', 'https://www.tiktok.com/@a/video/1', 'other'],
    ['YouTube', 'https://www.youtube.com/watch?v=abc', 'other'],
    ['generic page', 'https://example.com/article', 'other'],
    ['netflix.com is not X', 'https://www.netflix.com/title/80100172', 'other'],
  ];

  it.each(CASES)('%s → same stub entry and the same job on both channels', async (_name, url, jobPlatform) => {
    const app = await appWithWeb();
    const seen = {} as Record<'telegram' | 'share', ReturnType<typeof effects>>;
    for (const adapter of ['telegram', 'share'] as const) {
      vi.clearAllMocks();
      vi.mocked(getApiKeysConfig).mockResolvedValue({ keys: [KEY] });
      vi.mocked(findEntryByUrl).mockResolvedValue(null);
      vi.mocked(createEntry).mockResolvedValue('entry-1');
      vi.mocked(enqueueJob).mockResolvedValue(1);
      const res = await send(app, adapter, url);
      expect(res.statusCode).toBe(200);
      seen[adapter] = effects();
    }
    expect(seen.share).toEqual(seen.telegram);
    expect(seen.telegram.entry).toMatchObject({ ownerUser: 'mike', status: 'processing' });
    expect(seen.telegram.jobs).toEqual([{ platform: jobPlatform, sourceUrl: url }]);
    expect(seen.telegram.spooty).toEqual([]);
  });
});
