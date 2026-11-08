import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({
  findEntryByUrl: vi.fn(),
  createEntry: vi.fn(),
  updateEntry: vi.fn(),
  appendActionLog: vi.fn(),
  createActionLog: vi.fn((action: string, details: unknown) => ({ action, details, timestamp: 't' })),
}));
vi.mock('../utils/jobQueue', () => ({ enqueueJob: vi.fn() }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logInfo: vi.fn(), logError: vi.fn(), createActionLog: vi.fn() }));
vi.mock('./spootyClient', async (orig) => ({
  ...(await orig<typeof import('./spootyClient')>()),
  addToSpooty: vi.fn(),
  findSpootyPlaylistByUrl: vi.fn(),
  listSpootyTracks: vi.fn(),
  retrySpootyTrack: vi.fn(),
}));
vi.mock('./spootyRequests', () => ({
  insertSpootyRequest: vi.fn(),
  getSpootyRequestByEntry: vi.fn(),
  patchSpootyRequest: vi.fn(),
}));
vi.mock('./songMeta', async (orig) => ({
  ...(await orig<typeof import('./songMeta')>()),
  setSongCoverIfMissing: vi.fn(),
}));
vi.mock('./songEnrichmentHook', () => ({ enqueueSongEnrichment: vi.fn() }));
vi.mock('./shazamLink', async (orig) => ({
  ...(await orig<typeof import('./shazamLink')>()),
  fetchShazamTrack: vi.fn(),
}));

import { classifyLink, ingestLink, IngestError, platformFromUrl } from './linkIngest';
import { createEntry, findEntryByUrl, updateEntry, appendActionLog } from '../utils/db';
import { enqueueJob } from '../utils/jobQueue';
import { addToSpooty, findSpootyPlaylistByUrl, listSpootyTracks, retrySpootyTrack } from './spootyClient';
import { getSpootyRequestByEntry, insertSpootyRequest, patchSpootyRequest } from './spootyRequests';
import { fetchShazamTrack, ShazamFetchError } from './shazamLink';
import { setSongCoverIfMissing } from './songMeta';
import { enqueueSongEnrichment } from './songEnrichmentHook';

const ID = '22kBlINGUYm2rc1Wd7RPfw';
const CANON = `https://open.spotify.com/track/${ID}`;
const SHARED = `${CANON}?si=6840D4mBRcW8-6xkWXS8wA&utm_source=copy-link`;

const playlist = { id: 38, name: "Say it Ain't So", spotifyUrl: SHARED, error: null, active: false, isTrack: true, coverUrl: 'https://i.scdn.co/cover' };
const track = (status: number, error: string | null = null) => ({
  id: 609, artist: 'PENNY', name: "Say it Ain't So", spotifyUrl: SHARED, youtubeUrl: null, status, error, coverUrl: 'https://i.scdn.co/cover',
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createEntry).mockResolvedValue('entry-1');
  vi.mocked(findEntryByUrl).mockResolvedValue(null);
  vi.mocked(enqueueJob).mockResolvedValue(1);
  vi.mocked(insertSpootyRequest).mockResolvedValue({} as never);
});

describe('classifyLink', () => {
  it.each([
    [SHARED, 'spotify', 'spotify'],
    [`https://open.spotify.com/intl-it/album/${ID}`, 'spotify', 'spotify'],
    [`spotify:playlist:${ID}`, 'spotify', 'spotify'],
    ['https://www.instagram.com/reel/abc/', 'generic', 'instagram'],
    ['https://vm.tiktok.com/xyz', 'generic', 'tiktok'],
    ['https://youtu.be/abc', 'generic', 'youtube'],
    ['https://x.com/a/status/1', 'generic', 'twitter'],
    ['https://open.spotify.com/artist/0TnOYISbd1XYRBk9myaseg', 'generic', 'spotify'],
    ['https://example.com/page', 'generic', 'other'],
    ['https://www.shazam.com/track/404798580?referrer=share', 'shazam', 'shazam'],
    ['https://www.shazam.com/it-it/song/1360212103/white-flag', 'shazam', 'shazam'],
    // Shazam pages that are not a readable song keep the Shazam badge but take the generic page flow.
    ['https://www.shazam.com/artist/bishop-briggs/1126808565', 'generic', 'shazam'],
    ['https://www.shazam.com/song/1360212103', 'generic', 'shazam'],
  ])('%s → %s / %s', (url, kind, platform) => {
    expect(classifyLink(url)).toMatchObject({ kind, platform });
  });

  it('matches hosts exactly (netflix.com is not x.com)', () => {
    expect(platformFromUrl('https://www.netflix.com/title/1')).toBe('other');
    expect(platformFromUrl('https://notinstagram.com/p/1')).toBe('other');
  });
});

describe('ingestLink — generic links', () => {
  it('creates a stub, tags it and queues the job (adapter fields pass through)', async () => {
    const res = await ingestLink({
      url: 'https://www.instagram.com/reel/abc/?igsh=zzz',
      channel: 'telegram',
      inputUser: '@mike',
      ownerUser: 'mike',
      tags: ['#tesla'],
      chatId: 42,
      logs: { onNew: [{ action: 'url_received', details: {}, timestamp: 't' }], tagsAction: 'telegram_comment_tags' },
    });
    expect(res).toMatchObject({ kind: 'generic', platform: 'instagram', entryId: 'entry-1', existing: false, enqueued: true });
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      sourcePlatform: 'instagram', inputChannel: 'telegram', ownerUser: 'mike', status: 'processing',
      actionLog: [expect.objectContaining({ action: 'url_received' }), expect.objectContaining({ action: 'telegram_comment_tags' })],
    }));
    expect(enqueueJob).toHaveBeenCalledWith({
      entryId: 'entry-1', sourceUrl: 'https://www.instagram.com/reel/abc/?igsh=zzz', platform: 'instagram', chatId: 42, inputUser: '@mike',
    });
  });

  it('share style: no chat, notify off', async () => {
    await ingestLink({ url: 'https://example.com/a', channel: 'ios', inputUser: 'sara', ownerUser: 'sara', notify: false });
    expect(enqueueJob).toHaveBeenCalledWith(expect.objectContaining({ platform: 'other', chatId: 0, notify: false }));
  });

  it('existing entry: merges tags, appends adapter logs, does not create', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'old', results: { songs: [], films: [], notes: [], links: [], tags: ['#a'], summary: null },
    } as never);
    const res = await ingestLink({
      url: 'https://example.com/a', channel: 'ios', inputUser: 'mike', ownerUser: 'mike', tags: ['#b'],
      logs: { onExisting: [{ action: 'url_received', details: {}, timestamp: 't' }], tagsAction: 'share_comment_tags' },
    });
    expect(res).toMatchObject({ entryId: 'old', existing: true });
    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('old', { results: expect.objectContaining({ tags: expect.arrayContaining(['#a', '#b']) }) });
    expect(vi.mocked(appendActionLog).mock.calls.map((c) => c[1].action)).toEqual(['share_comment_tags', 'url_received']);
  });

  it('wraps failures: no entry → IngestError without id; enqueue failure keeps the entry id', async () => {
    vi.mocked(createEntry).mockRejectedValueOnce(new Error('db down'));
    await expect(ingestLink({ url: 'https://example.com/a', channel: 'ios', inputUser: null, ownerUser: 'anonymous' }))
      .rejects.toMatchObject({ name: 'IngestError', entryId: null });

    vi.mocked(enqueueJob).mockRejectedValueOnce(new Error('queue down'));
    const err = await ingestLink({ url: 'https://example.com/b', channel: 'ios', inputUser: null, ownerUser: 'anonymous' }).catch((e) => e);
    expect(err).toBeInstanceOf(IngestError);
    expect(err.entryId).toBe('entry-1');
  });
});

describe('ingestLink — Spotify links', () => {
  it('real shared link: entry in the library + Spooty enqueue, canonical URL, metadata from Spooty', async () => {
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValueOnce(null).mockResolvedValueOnce(playlist);
    vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
    vi.mocked(listSpootyTracks).mockResolvedValue([track(1)]);

    const res = await ingestLink({ url: SHARED, channel: 'telegram', inputUser: '@mike', ownerUser: 'mike', chatId: 7, tags: ['#nuova'] });

    expect(addToSpooty).toHaveBeenCalledTimes(1);
    expect(addToSpooty).toHaveBeenCalledWith(CANON); // no ?si= / utm
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: CANON,
      sourcePlatform: 'spotify',
      inputChannel: 'telegram',
      ownerUser: 'mike',
      caption: 'PENNY – Say it Ain\'t So',
      thumbnailUrl: 'https://i.scdn.co/cover',
      status: 'processing',
      results: expect.objectContaining({
        tags: ['#nuova'],
        songs: [expect.objectContaining({ title: "Say it Ain't So", artist: 'PENNY', source: 'spotify_link', spotifyUrl: CANON })],
      }),
    }));
    expect(insertSpootyRequest).toHaveBeenCalledWith(expect.objectContaining({
      entryId: 'entry-1', spotifyUrl: CANON, kind: 'track', spootyPlaylistId: 38, chatId: 7, status: 'tracking',
    }));
    expect(enqueueJob).not.toHaveBeenCalled(); // Spotify never goes through page analysis
    expect(res).toMatchObject({
      kind: 'spotify', platform: 'spotify', entryId: 'entry-1', existing: false,
      spotify: { title: "Say it Ain't So", artist: 'PENNY', coverUrl: 'https://i.scdn.co/cover', trackCount: 1, spootyAccepted: true, spootyPlaylistId: 38 },
    });
  });

  it('reuses a playlist Spooty already has (no duplicate POST)', async () => {
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValue(playlist);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(4)]);
    await ingestLink({ url: CANON, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(addToSpooty).not.toHaveBeenCalled();
    expect(createEntry).toHaveBeenCalledTimes(1);
  });

  it('Spooty down: the link is still stored and retried later (never lost)', async () => {
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValue(null);
    vi.mocked(addToSpooty).mockResolvedValue({ ok: false, error: 'ECONNREFUSED' });
    const res = await ingestLink({ url: SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      caption: null,
      actionLog: expect.arrayContaining([expect.objectContaining({ action: 'spooty_enqueue_failed', details: { error: 'ECONNREFUSED' } })]),
    }));
    expect(insertSpootyRequest).toHaveBeenCalledWith(expect.objectContaining({ status: 'queued', spootyPlaylistId: null }));
    expect(res.spotify).toMatchObject({ spootyAccepted: false, error: 'ECONNREFUSED' });
  });

  it('short links are resolved before classification', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: SHARED } })));
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValueOnce(null).mockResolvedValueOnce(playlist);
    vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
    vi.mocked(listSpootyTracks).mockResolvedValue([track(1)]);
    const res = await ingestLink({ url: 'https://spotify.link/abc', channel: 'web', inputUser: null, ownerUser: 'mike' });
    expect(res.kind).toBe('spotify');
    expect(addToSpooty).toHaveBeenCalledWith(CANON);
    vi.unstubAllGlobals();
  });

  it('same link again: idempotent, merges tags, no second download', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'e9', caption: 'PENNY – Say it Ain\'t So', thumbnailUrl: 'c',
      results: { songs: [{ title: "Say it Ain't So", artist: 'PENNY', source: 'spotify_link' }], films: [], notes: [], links: [], tags: [], summary: null },
    } as never);
    vi.mocked(getSpootyRequestByEntry).mockResolvedValue({ id: 3, status: 'tracking', spootyPlaylistId: 38 } as never);
    const res = await ingestLink({ url: SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike', tags: ['#x'] });
    expect(res).toMatchObject({ existing: true, entryId: 'e9', spotify: { title: "Say it Ain't So", artist: 'PENNY', trackCount: 1 } });
    expect(createEntry).not.toHaveBeenCalled();
    expect(addToSpooty).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('e9', { results: expect.objectContaining({ tags: ['#x'] }) });
  });

  it('sharing a FAILED link again retries the failed tracks', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'e9', caption: 'c', thumbnailUrl: null,
      results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
    } as never);
    vi.mocked(getSpootyRequestByEntry).mockResolvedValue({ id: 3, status: 'failed', spootyPlaylistId: 38 } as never);
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValue(playlist);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(5, 'HTTP Error 403')]);
    await ingestLink({ url: CANON, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(retrySpootyTrack).toHaveBeenCalledWith(609);
    expect(patchSpootyRequest).toHaveBeenCalledWith(3, expect.objectContaining({ status: 'tracking', attempts: 0, lastError: null }));
    expect(updateEntry).toHaveBeenCalledWith('e9', { status: 'processing' });
  });

  it('adopts a legacy entry created by the generic flow (no request row yet)', async () => {
    vi.mocked(findEntryByUrl).mockResolvedValue({
      id: 'old', caption: null, thumbnailUrl: null,
      results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
    } as never);
    vi.mocked(getSpootyRequestByEntry).mockResolvedValue(null);
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValue(playlist);
    vi.mocked(listSpootyTracks).mockResolvedValue([track(2)]);
    await ingestLink({ url: CANON, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(insertSpootyRequest).toHaveBeenCalledWith(expect.objectContaining({ entryId: 'old', status: 'tracking', spootyPlaylistId: 38 }));
    expect(updateEntry).toHaveBeenCalledWith('old', expect.objectContaining({
      caption: 'PENNY – Say it Ain\'t So',
      results: expect.objectContaining({ songs: [expect.objectContaining({ source: 'spotify_link' })] }),
    }));
  });

  it('albums: one entry, many songs, album name as caption', async () => {
    const album = { ...playlist, id: 40, name: 'Moon Safari', isTrack: false, spotifyUrl: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3' };
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValue(album);
    vi.mocked(listSpootyTracks).mockResolvedValue([
      { ...track(2), id: 1, artist: 'Air', name: 'La femme d\'argent', spotifyUrl: 'https://open.spotify.com/track/AAAAAAAAAAAAAAAAAAAAAA' },
      { ...track(2), id: 2, artist: 'Air', name: 'Sexy Boy', spotifyUrl: 'https://open.spotify.com/track/BBBBBBBBBBBBBBBBBBBBBB' },
    ]);
    const res = await ingestLink({ url: 'https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3?si=q', channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      caption: 'Moon Safari',
      results: expect.objectContaining({ songs: [expect.objectContaining({ album: 'Moon Safari' }), expect.objectContaining({ title: 'Sexy Boy' })] }),
    }));
    expect(res.spotify).toMatchObject({ trackCount: 2, caption: 'Moon Safari' });
  });
});

describe('ingestLink — Shazam links', () => {
  const SHAZAM_SHARED = 'https://www.shazam.com/track/404798580?referrer=share';
  const SHAZAM_CANON = 'https://www.shazam.com/track/404798580';
  const page = {
    title: 'White Flag',
    artist: 'Bishop Briggs',
    album: 'Church of Scars',
    coverUrl: 'https://is1-ssl.mzstatic.com/cover/800x800cc.jpg',
    pageUrl: 'https://www.shazam.com/song/1360212103/white-flag',
  };
  const emptyResults = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
  const stored = (over: Record<string, unknown> = {}) => ({
    id: 'e-sz', sourcePlatform: 'shazam', status: 'completed', caption: 'Bishop Briggs – White Flag', thumbnailUrl: 'cover',
    results: { ...emptyResults, songs: [{ title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', source: 'shazam_link' }] },
    ...over,
  });

  it('real shared link: library entry read from the Shazam page, canonical URL, nothing queued', async () => {
    vi.mocked(fetchShazamTrack).mockResolvedValue(page);

    const res = await ingestLink({
      url: SHAZAM_SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike', tags: ['#sera'],
      logs: { onNew: [{ action: 'url_received', details: {}, timestamp: 't' }], tagsAction: 'share_comment_tags' },
    });

    expect(fetchShazamTrack).toHaveBeenCalledWith(expect.objectContaining({ kind: 'track', id: '404798580', url: SHAZAM_CANON }));
    expect(createEntry).toHaveBeenCalledTimes(1);
    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: SHAZAM_CANON,
      sourcePlatform: 'shazam',
      inputChannel: 'ios',
      ownerUser: 'mike',
      caption: 'Bishop Briggs – White Flag',
      thumbnailUrl: page.coverUrl,
      status: 'completed',
      results: expect.objectContaining({
        tags: ['#sera'],
        songs: [{
          title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', source: 'shazam_link',
          spotifyUri: null, spotifyUrl: null,
          youtubeUrl: 'https://youtube.com/results?search_query=Bishop%20Briggs%20White%20Flag',
          soundcloudUrl: null, addedToPlaylist: false,
        }],
      }),
      actionLog: [
        expect.objectContaining({ action: 'url_received' }),
        expect.objectContaining({ action: 'shazam_link_received', details: expect.objectContaining({ kind: 'track', id: '404798580' }) }),
        expect.objectContaining({ action: 'share_comment_tags' }),
        expect.objectContaining({ action: 'shazam_resolved', details: expect.objectContaining({ title: 'White Flag', artist: 'Bishop Briggs' }) }),
      ],
    }));
    expect(setSongCoverIfMissing).toHaveBeenCalledWith('bishop briggs::white flag', page.coverUrl, 'Church of Scars');
    // A Shazam page has no Spotify link and needs no analysis: no Spooty, no job.
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(addToSpooty).not.toHaveBeenCalled();
    expect(insertSpootyRequest).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      kind: 'shazam', platform: 'shazam', entryId: 'entry-1', existing: false,
      shazam: { title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', caption: 'Bishop Briggs – White Flag', error: null },
    });
  });

  it('page unreadable (e.g. the generic fallback page): the link is stored as an error, never as a wrong song', async () => {
    vi.mocked(fetchShazamTrack).mockRejectedValue(new ShazamFetchError('mismatch', 'Shazam ha risposto con la pagina di un altro brano'));

    const res = await ingestLink({ url: SHAZAM_SHARED, channel: 'telegram', inputUser: '@mike', ownerUser: 'mike' });

    expect(createEntry).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: SHAZAM_CANON, sourcePlatform: 'shazam', status: 'error', caption: null, thumbnailUrl: null,
      results: expect.objectContaining({ songs: [] }),
      actionLog: [
        expect.objectContaining({ action: 'shazam_link_received' }),
        expect.objectContaining({ action: 'shazam_failed', details: { code: 'mismatch', error: 'Shazam ha risposto con la pagina di un altro brano' } }),
      ],
    }));
    expect(setSongCoverIfMissing).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      kind: 'shazam', entryId: 'entry-1', existing: false,
      shazam: { title: null, artist: null, error: 'Shazam ha risposto con la pagina di un altro brano' },
    });
  });

  it('a database failure is an IngestError (the entry could not be stored); an unreadable page is not', async () => {
    vi.mocked(fetchShazamTrack).mockResolvedValue(page);
    vi.mocked(createEntry).mockRejectedValueOnce(new Error('db down'));
    await expect(ingestLink({ url: SHAZAM_SHARED, channel: 'ios', inputUser: null, ownerUser: 'mike' }))
      .rejects.toMatchObject({ name: 'IngestError', entryId: null });
  });

  it('same link again, already in the library: no fetch, no duplicate, tags merged, adapter logs written', async () => {
    vi.mocked(findEntryByUrl).mockImplementation(async (url) => (url === SHAZAM_CANON ? (stored() as never) : null));

    const res = await ingestLink({
      url: 'https://www.shazam.com/it-it/track/404798580/white-flag?referrer=share', channel: 'telegram', inputUser: '@mike', ownerUser: 'mike',
      tags: ['#b'], logs: { onExisting: [{ action: 'telegram_message', details: {}, timestamp: 't' }], tagsAction: 'telegram_comment_tags' },
    });

    expect(fetchShazamTrack).not.toHaveBeenCalled();
    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('e-sz', { results: expect.objectContaining({ tags: ['#b'] }) });
    expect(vi.mocked(appendActionLog).mock.calls.map((c) => c[1].action)).toEqual(['telegram_comment_tags', 'telegram_message']);
    expect(res).toMatchObject({
      kind: 'shazam', entryId: 'e-sz', existing: true,
      shazam: { title: 'White Flag', artist: 'Bishop Briggs', caption: 'Bishop Briggs – White Flag', error: null },
    });
  });

  it('adopts the error entries saved before Shazam links were understood (found by the raw shared URL)', async () => {
    const legacy = {
      id: 'legacy', sourcePlatform: 'other', status: 'error', sourceUrl: SHAZAM_SHARED, caption: null, thumbnailUrl: null,
      results: { ...emptyResults, tags: ['#vecchio'] },
    };
    // The canonical URL is unknown, the raw (normalised) one is the legacy entry.
    vi.mocked(findEntryByUrl).mockImplementation(async (url) => (url === SHAZAM_SHARED ? (legacy as never) : null));
    vi.mocked(fetchShazamTrack).mockResolvedValue(page);

    const res = await ingestLink({
      url: SHAZAM_SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike',
      logs: { onExisting: [{ action: 'url_received', details: {}, timestamp: 't' }] },
    });

    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('legacy', expect.objectContaining({
      sourceUrl: SHAZAM_CANON, sourcePlatform: 'shazam', status: 'completed',
      caption: 'Bishop Briggs – White Flag', thumbnailUrl: page.coverUrl,
      results: expect.objectContaining({ tags: ['#vecchio'], songs: [expect.objectContaining({ source: 'shazam_link', title: 'White Flag' })] }),
    }));
    expect(vi.mocked(appendActionLog).mock.calls.map((c) => c[1].action)).toEqual(['url_received', 'shazam_link_received', 'shazam_resolved']);
    expect(res).toMatchObject({ kind: 'shazam', entryId: 'legacy', existing: true, shazam: { error: null } });
  });

  it('sharing a failed Shazam link again retries it in place (no second entry)', async () => {
    vi.mocked(findEntryByUrl).mockImplementation(async (url) =>
      url === SHAZAM_CANON ? (stored({ status: 'error', caption: null, thumbnailUrl: null, results: emptyResults }) as never) : null);
    vi.mocked(fetchShazamTrack).mockResolvedValue(page);

    await ingestLink({ url: SHAZAM_SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });

    expect(createEntry).not.toHaveBeenCalled();
    expect(updateEntry).toHaveBeenCalledWith('e-sz', expect.objectContaining({
      status: 'completed', results: expect.objectContaining({ songs: [expect.objectContaining({ title: 'White Flag' })] }),
    }));
  });

  it('a failed retry keeps an entry that already completed (generic analysis) and never wipes its songs', async () => {
    const analysed = {
      id: 'ana', sourcePlatform: 'other', status: 'completed', caption: 'page caption', thumbnailUrl: 't',
      results: { ...emptyResults, songs: [{ title: 'Other', artist: 'Someone', source: 'ai_analysis' }] },
    };
    vi.mocked(findEntryByUrl).mockImplementation(async (url) => (url === SHAZAM_SHARED ? (analysed as never) : null));
    vi.mocked(fetchShazamTrack).mockRejectedValue(new ShazamFetchError('status', 'Shazam ha risposto HTTP 503'));

    const res = await ingestLink({ url: SHAZAM_SHARED, channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });

    expect(updateEntry).toHaveBeenCalledWith('ana', expect.objectContaining({
      status: 'completed', caption: 'page caption', thumbnailUrl: 't',
      results: expect.objectContaining({ songs: [expect.objectContaining({ source: 'ai_analysis' })] }),
    }));
    expect(res.shazam?.error).toBe('Shazam ha risposto HTTP 503');
  });
});

describe('songs that arrive from a link are enriched like every other song (cover, GENRES, links)', () => {
  it('a Spotify link: the track Spooty reports', async () => {
    vi.mocked(findSpootyPlaylistByUrl).mockResolvedValueOnce(null).mockResolvedValueOnce(playlist);
    vi.mocked(addToSpooty).mockResolvedValue({ ok: true });
    vi.mocked(listSpootyTracks).mockResolvedValue([track(1)]);
    await ingestLink({ url: SHARED, channel: 'telegram', inputUser: '@mike', ownerUser: 'mike', chatId: 7 });
    expect(enqueueSongEnrichment).toHaveBeenCalledWith([{ artist: 'PENNY', title: "Say it Ain't So" }]);
  });

  it('a Shazam link: the song read from the Shazam page (so the manager\'s genre filter finds it)', async () => {
    vi.mocked(fetchShazamTrack).mockResolvedValue({ title: 'White Flag', artist: 'Bishop Briggs', album: 'Church of Scars', coverUrl: 'c', pageUrl: 'https://www.shazam.com/song/1/white-flag' });
    await ingestLink({ url: 'https://www.shazam.com/track/404798580', channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    expect(enqueueSongEnrichment).toHaveBeenCalledWith([{ artist: 'Bishop Briggs', title: 'White Flag' }]);
  });

  it('nothing to enrich when the Shazam page could not be read, and for generic links', async () => {
    vi.mocked(fetchShazamTrack).mockRejectedValue(new ShazamFetchError('mismatch', 'wrong song'));
    await ingestLink({ url: 'https://www.shazam.com/track/404798580', channel: 'ios', inputUser: 'mike', ownerUser: 'mike' });
    await ingestLink({ url: 'https://www.instagram.com/reel/abc/', channel: 'telegram', inputUser: '@mike', ownerUser: 'mike', chatId: 1 });
    expect(enqueueSongEnrichment).not.toHaveBeenCalled();
  });
});
