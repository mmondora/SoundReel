import { readFileSync } from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sf = vi.hoisted(() => ({
  listReadyUnpublished: vi.fn(),
  listPublishedOlderThan: vi.fn(),
  markPublished: vi.fn(),
  clearPublished: vi.fn(),
  resetToQueued: vi.fn(),
}));
vi.mock('./songFiles', () => sf);
const mi = vi.hoisted(() => ({ replaceMediaIndex: vi.fn(), countMediaIndex: vi.fn(), sampleMediaIndexPath: vi.fn() }));
vi.mock('./mediaIndex', async (orig) => ({ ...(await orig<typeof import('./mediaIndex')>()), ...mi }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  mediaServerConfig,
  mediaUrlForVolumePath,
  parseDlnaDuration,
  parseSearchResponse,
  reconcilePublished,
  refreshMediaIndex,
  replicaVolumePath,
  headMediaFile,
  getMediaServerStatus,
  mediaVolumePresent,
  scanMediaServer,
  toIndexItem,
  verifyMediaUrl,
  volumePathFromUrl,
} from './mediaServer';
import { replaceMediaIndex } from './mediaIndex';
import { logWarning } from '../utils/logger';

// Real capture of the FRITZ!Mediaserver (2026-11-07), see the fixture's own comment.
const SAMPLE = readFileSync(path.join(__dirname, '__fixtures__', 'dlna-search-sample.xml'), 'utf8');
const cfg = mediaServerConfig({} as NodeJS.ProcessEnv);

describe('configuration', () => {
  it('defaults to the home FRITZ!Box and can be switched off', () => {
    expect(cfg).toEqual({
      enabled: true,
      controlUrl: 'http://192.168.178.10:49000/MediaServer/ContentDirectory/Control',
      fileBase: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0',
      replicaRoot: 'Music/SoundReel',
    });
    expect(mediaServerConfig({ MEDIA_SERVER_ENABLED: '0' } as unknown as NodeJS.ProcessEnv).enabled).toBe(false);
    expect(mediaServerConfig({ MEDIA_SERVER_FILE_BASE: 'http://x/y/', MEDIA_REPLICA_ROOT: '/A/B/' } as unknown as NodeJS.ProcessEnv))
      .toMatchObject({ fileBase: 'http://x/y', replicaRoot: 'A/B' });
  });
});

describe('direct URLs', () => {
  it('derives exactly the URL the box itself reports for a replicated file', () => {
    // Taken from the real capture: the box lists this file under that URL.
    const real = 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/SoundReel/Artie%205ive%20-%20SWAG%20MUSIC.mp3';
    expect(mediaUrlForVolumePath(replicaVolumePath('Artie 5ive - SWAG MUSIC.mp3', cfg), cfg)).toBe(real);
    expect(SAMPLE).toContain(real);
  });

  it('round-trips awkward names and refuses foreign URLs', () => {
    const rel = replicaVolumePath("SoundReel/Guns N' Roses - Don't Cry (Live) #1?.mp3", cfg);
    const url = mediaUrlForVolumePath(rel, cfg);
    expect(url).not.toContain(' ');
    expect(url).toContain('%23'); // # would otherwise start a fragment
    expect(url).toContain('%3F'); // ? would otherwise start a query
    expect(volumePathFromUrl(url, cfg)).toBe(rel);
    expect(volumePathFromUrl('http://evil.example/AUDIO/DLNA-1-0/x.mp3', cfg)).toBeNull();
    expect(volumePathFromUrl(`${cfg.fileBase}/%E0%A4%A`, cfg)).toBeNull();
  });
});

describe('DIDL-Lite parsing (real box output)', () => {
  const page = parseSearchResponse(SAMPLE);

  it('reads the paging counters and every item', () => {
    expect(page.numberReturned).toBe(5);
    expect(page.totalMatches).toBe(6449);
    expect(page.items).toHaveLength(5);
  });

  it('takes the performer as artist, size as bytes and leaves unknown durations null', () => {
    expect(page.items[0]).toMatchObject({
      title: 'SWAG MUSIC', artist: 'Artie 5ive', album: null, bytes: 3345432, durationS: null,
      url: 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/SoundReel/Artie%205ive%20-%20SWAG%20MUSIC.mp3',
    });
    expect(page.items[1]).toMatchObject({ title: 'Bike', artist: 'Autechre' });
  });

  it('decodes the XML escapes the box applies to titles and albums', () => {
    expect(page.items[4]).toMatchObject({ title: 'Rock & Roll <3', album: 'Best & Worst', artist: 'AC/DC', durationS: 230, bytes: 5242880 });
  });

  it('parses DLNA durations and treats 0 as unknown', () => {
    expect(parseDlnaDuration('0:03:50.000')).toBe(230);
    expect(parseDlnaDuration('1:00:01')).toBe(3601);
    expect(parseDlnaDuration('0:00:00.000')).toBeNull();
    expect(parseDlnaDuration(undefined)).toBeNull();
    expect(parseDlnaDuration('garbage')).toBeNull();
  });

  it('turns usable items into index rows and drops macOS junk', () => {
    const rows = page.items.map((i) => toIndexItem(i, cfg));
    expect(rows[0]).toMatchObject({ store: 'fritz', relPath: 'Music/SoundReel/Artie 5ive - SWAG MUSIC.mp3', artist: 'Artie 5ive', title: 'SWAG MUSIC' });
    expect(rows[3]).toBeNull(); // ._Background1
    expect(rows[4]?.relPath).toBe('Music/SoundReel/AC DC - Rock & Roll (3).mp3');
    expect(toIndexItem({ ...page.items[0], url: 'http://other/x.mp3' }, cfg)).toBeNull();
    expect(toIndexItem({ ...page.items[0], artist: '' }, cfg)).toBeNull();
  });
});

describe('scanMediaServer', () => {
  const soap = (count: number, total: number, items = ''): string =>
    `<Envelope><Body><SearchResponse><Result>${items}</Result><NumberReturned>${count}</NumberReturned><TotalMatches>${total}</TotalMatches></SearchResponse></Body></Envelope>`;

  it('pages through the catalogue with the right SOAP request and stops at TotalMatches', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(SAMPLE, { status: 200 })) // 5 returned of 6449
      .mockResolvedValueOnce(new Response(soap(0, 6449), { status: 200 }));
    const items = await scanMediaServer(cfg, fetchImpl, { pageSize: 5 });
    expect(items).toHaveLength(5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(cfg.controlUrl);
    expect((init?.headers as Record<string, string>).SOAPAction).toContain('ContentDirectory:1#Search');
    expect(String(init?.body)).toContain('<StartingIndex>0</StartingIndex>');
    expect(String(fetchImpl.mock.calls[1][1]?.body)).toContain('<StartingIndex>5</StartingIndex>');
  });

  it('stops at TotalMatches and fails loudly on an HTTP error', async () => {
    const one = vi.fn<typeof fetch>().mockResolvedValue(new Response(soap(0, 0), { status: 200 }));
    expect(await scanMediaServer(cfg, one)).toEqual([]);
    expect(one).toHaveBeenCalledTimes(1);
    await expect(scanMediaServer(cfg, vi.fn<typeof fetch>().mockResolvedValue(new Response('no', { status: 500 })))).rejects.toThrow('HTTP 500');
  });

  it('refreshMediaIndex stores only the usable rows', async () => {
    mi.countMediaIndex.mockResolvedValue(0);
    vi.mocked(replaceMediaIndex).mockResolvedValue(4);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(SAMPLE.replace('<TotalMatches>6449<', '<TotalMatches>5<'), { status: 200 }));
    await expect(refreshMediaIndex(cfg, fetchImpl)).resolves.toBe(4);
    const [store, rows] = vi.mocked(replaceMediaIndex).mock.calls[0];
    expect(store).toBe('fritz');
    expect(rows).toHaveLength(4); // the junk item was dropped
  });

  describe('an unplugged USB drive must not erase what we know (the box keeps answering with a tiny catalogue)', () => {
    const tiny = () => vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(SAMPLE.replace('<TotalMatches>6449<', '<TotalMatches>5<'), { status: 200 }));
    beforeEach(() => vi.clearAllMocks());

    it('keeps the old index when the new catalogue collapsed, says why, and reports the volume as missing', async () => {
      mi.countMediaIndex.mockResolvedValue(3448); // 4 usable rows against 3448 known
      await expect(refreshMediaIndex(cfg, tiny())).resolves.toBe(3448);
      expect(replaceMediaIndex).not.toHaveBeenCalled();
      const status = getMediaServerStatus();
      expect(status).toMatchObject({ reachable: true, volumeMissing: true });
      expect(status.lastIndexError).toContain('chiavetta scollegata');
      expect(logWarning).toHaveBeenCalledWith(expect.stringContaining('NOT replaced'), expect.objectContaining({ usable: 4, previous: 3448 }));
    });

    it('a normal refresh (a few songs more or less) replaces the index and clears the warning', async () => {
      mi.countMediaIndex.mockResolvedValue(6);
      vi.mocked(replaceMediaIndex).mockResolvedValue(4);
      await expect(refreshMediaIndex(cfg, tiny())).resolves.toBe(4);
      expect(replaceMediaIndex).toHaveBeenCalledTimes(1);
      expect(getMediaServerStatus().volumeMissing).toBe(false);
    });

    it('a small or empty index is always replaced (a fresh install must be able to fill it)', async () => {
      mi.countMediaIndex.mockResolvedValue(40);
      vi.mocked(replaceMediaIndex).mockResolvedValue(4);
      await refreshMediaIndex(cfg, tiny());
      expect(replaceMediaIndex).toHaveBeenCalledTimes(1);
    });
  });
});

describe('verifyMediaUrl', () => {
  const head = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers });

  it('accepts a replica that is there and as big as our file', async () => {
    expect(await verifyMediaUrl('u', 100, vi.fn<typeof fetch>().mockResolvedValue(head(200, { 'content-length': '100' })))).toEqual({ ok: true });
    expect(await verifyMediaUrl('u', null, vi.fn<typeof fetch>().mockResolvedValue(head(200, { 'content-length': '7' })))).toEqual({ ok: true });
  });

  it('rejects a copy that is still being written (size differs) and a missing one', async () => {
    expect(await verifyMediaUrl('u', 100, vi.fn<typeof fetch>().mockResolvedValue(head(200, { 'content-length': '40' })))).toEqual({ ok: false, reason: 'size' });
    expect(await verifyMediaUrl('u', 100, vi.fn<typeof fetch>().mockResolvedValue(head(404)))).toEqual({ ok: false, reason: 'missing' });
  });

  it('falls back to a one-byte range request when HEAD is refused', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(head(405))
      .mockResolvedValueOnce(head(206, { 'content-range': 'bytes 0-0/100' }));
    expect(await verifyMediaUrl('u', 100, fetchImpl)).toEqual({ ok: true });
    expect((fetchImpl.mock.calls[1][1]?.headers as Record<string, string>).Range).toBe('bytes=0-0');
  });

  it('reports a dead box as a network problem, not as a missing file', async () => {
    expect(await verifyMediaUrl('u', 1, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).toEqual({ ok: false, reason: 'network' });
    expect(await verifyMediaUrl('u', 1, vi.fn<typeof fetch>().mockResolvedValue(head(503)))).toEqual({ ok: false, reason: 'network' });
  });
});

describe('headMediaFile (what the box says about a file)', () => {
  const head = (status: number, headers: Record<string, string> = {}): Response => new Response(null, { status, headers });

  it('reads size and modification date, the two things a file version is made of', async () => {
    const res = await headMediaFile('u', vi.fn<typeof fetch>().mockResolvedValue(head(200, {
      'content-length': '6109100', 'last-modified': 'Sun, 21 Jun 2026 14:58:45 GMT',
    })));
    expect(res).toEqual({ kind: 'ok', bytes: 6109100, lastModifiedMs: Date.parse('2026-06-21T14:58:45Z') });
  });

  it('knows "there" even when the box does not say how big or how old', async () => {
    expect(await headMediaFile('u', vi.fn<typeof fetch>().mockResolvedValue(head(200)))).toEqual({ kind: 'ok', bytes: null, lastModifiedMs: null });
  });

  it('tells "gone" (404/410) from "cannot tell" (dead box, odd answer)', async () => {
    expect(await headMediaFile('u', vi.fn<typeof fetch>().mockResolvedValue(head(404)))).toEqual({ kind: 'missing' });
    expect(await headMediaFile('u', vi.fn<typeof fetch>().mockResolvedValue(head(410)))).toEqual({ kind: 'missing' });
    expect(await headMediaFile('u', vi.fn<typeof fetch>().mockResolvedValue(head(500)))).toEqual({ kind: 'unreachable' });
    expect(await headMediaFile('u', vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).toEqual({ kind: 'unreachable' });
  });
});

describe('mediaVolumePresent (is the box\'s USB drive there?)', () => {
  const head = (status: number): Response => new Response(null, { status, headers: { 'content-length': '100' } });
  beforeEach(() => vi.clearAllMocks());

  it('yes when a file the catalogue lists answers', async () => {
    mi.sampleMediaIndexPath.mockResolvedValue('Music/Control/c.mp3');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(head(200));
    expect(await mediaVolumePresent(cfg, fetchImpl)).toBe(true);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Control/c.mp3');
  });

  it('no when that file is gone, when the box does not answer, and when there is nothing to ask (cannot tell = absent)', async () => {
    mi.sampleMediaIndexPath.mockResolvedValue('Music/Control/c.mp3');
    expect(await mediaVolumePresent(cfg, vi.fn<typeof fetch>().mockResolvedValue(head(404)))).toBe(false);
    expect(await mediaVolumePresent(cfg, vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed')))).toBe(false);
    mi.sampleMediaIndexPath.mockResolvedValue(null);
    const fetchImpl = vi.fn<typeof fetch>();
    expect(await mediaVolumePresent(cfg, fetchImpl)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('reconcilePublished', () => {
  const file = (songKey: string, relPath: string, bytes = 100) => ({ songKey, relPath, bytes }) as never;
  beforeEach(() => {
    vi.clearAllMocks();
    sf.listReadyUnpublished.mockResolvedValue([]);
    sf.listPublishedOlderThan.mockResolvedValue([]);
    // the control file the reconciler HEADs to tell "this file is gone" from "the whole volume is gone"
    mi.sampleMediaIndexPath.mockResolvedValue('Music/Control/c.mp3');
  });

  it('publishes what the box really has, with the URL it will serve', async () => {
    sf.listReadyUnpublished.mockResolvedValue([file('a::b', 'SoundReel/A - B.mp3'), file('c::d', 'SoundReel/C - D.mp3')]);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('A%20-%20B') ? new Response(null, { status: 200, headers: { 'content-length': '100' } }) : new Response(null, { status: 404 }));
    const res = await reconcilePublished(cfg, fetchImpl);
    expect(res).toEqual({ verified: 1, dropped: 0, pending: 1 });
    expect(sf.markPublished).toHaveBeenCalledTimes(1);
    expect(sf.markPublished).toHaveBeenCalledWith('a::b', 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/SoundReel/SoundReel/A%20-%20B.mp3');
  });

  it('a file copied FROM the box is verified at its original path, not at a replica path', async () => {
    sf.listReadyUnpublished.mockResolvedValue([{ songKey: 'k::n', relPath: 'SoundReel/Kavinsky - Nightcall.mp3', bytes: 6109100, mediaRelPath: 'Music/Kavinsky/Nightcall/01 - 2-01 Nightcall.mp3' } as never]);
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200, headers: { 'content-length': '6109100' } }));
    await reconcilePublished(cfg, fetchImpl);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Kavinsky/Nightcall/01%20-%202-01%20Nightcall.mp3');
    expect(sf.markPublished).toHaveBeenCalledWith('k::n', expect.stringContaining('Music/Kavinsky/Nightcall/'));
  });

  it('a song that IS a file of the box (no local file) is verified at its own path and turns back into a job when the file is gone', async () => {
    const onlyOnBox = (songKey: string, mediaRelPath: string) => ({ songKey, relPath: null, bytes: 100, mediaRelPath }) as never;
    sf.listPublishedOlderThan.mockResolvedValue([onlyOnBox('gone::x', 'Music/Gone/x.mp3'), onlyOnBox('here::y', 'Music/Here/y.mp3')]);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('Gone') ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-length': '100' } }));
    const res = await reconcilePublished(cfg, fetchImpl);
    expect(res).toEqual({ verified: 0, dropped: 1, pending: 0 });
    expect(sf.resetToQueued).toHaveBeenCalledWith('gone::x'); // nothing else backs it: the worker looks again
    expect(sf.clearPublished).not.toHaveBeenCalled();
    expect(sf.markPublished).toHaveBeenCalledWith('here::y', 'http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/Here/y.mp3');
  });

  describe('unplugged USB drive: the box answers 404 for EVERYTHING (spec 2026-11-07-web-player-ux-design.md, ADR-0010)', () => {
    const onlyOnBox = (songKey: string, mediaRelPath: string) => ({ songKey, relPath: null, bytes: 100, mediaRelPath }) as never;
    const allGone = () => vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }));

    it('drops nothing when the control file is missing too: replicas stay published, songs that are the box\'s files stay ready', async () => {
      sf.listPublishedOlderThan.mockResolvedValue([file('a::1', 'SoundReel/A - 1.mp3'), onlyOnBox('b::2', 'Music/B/2.mp3'), onlyOnBox('c::3', 'Music/C/3.mp3')]);
      const res = await reconcilePublished(cfg, allGone());
      expect(res).toEqual({ verified: 0, dropped: 0, pending: 3 });
      expect(sf.clearPublished).not.toHaveBeenCalled();
      expect(sf.resetToQueued).not.toHaveBeenCalled(); // no mass re-download of everything the box holds
      expect(getMediaServerStatus().volumeMissing).toBe(true);
    });

    it('with no control to ask (the catalogue is empty) it cannot tell, so it keeps everything', async () => {
      mi.sampleMediaIndexPath.mockResolvedValue(null);
      sf.listPublishedOlderThan.mockResolvedValue([onlyOnBox('b::2', 'Music/B/2.mp3')]);
      const res = await reconcilePublished(cfg, allGone());
      expect(res.dropped).toBe(0);
      expect(sf.resetToQueued).not.toHaveBeenCalled();
    });

    it('asks the control only once per run, and a file that verified OK in the run is the control (no catalogue query)', async () => {
      sf.listPublishedOlderThan.mockResolvedValue([file('here::y', 'SoundReel/Here - Y.mp3'), file('g1::x', 'SoundReel/Gone1.mp3'), file('g2::x', 'SoundReel/Gone2.mp3')]);
      const fetchImpl = vi.fn<typeof fetch>(async (url) =>
        String(url).includes('Gone') ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-length': '100' } }));
      const res = await reconcilePublished(cfg, fetchImpl);
      expect(res.dropped).toBe(2); // the volume is there (Here - Y answered): the two really are gone
      expect(mi.sampleMediaIndexPath).not.toHaveBeenCalled();
      expect(getMediaServerStatus().volumeMissing).toBe(false);
    });
  });

  it('a row with neither a local file nor a media path is skipped, never guessed at', async () => {
    sf.listReadyUnpublished.mockResolvedValue([{ songKey: 'x::y', relPath: null, bytes: 1, mediaRelPath: null } as never]);
    const fetchImpl = vi.fn<typeof fetch>();
    await reconcilePublished(cfg, fetchImpl);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('drops a published replica that left the stick, and keeps one that is still there', async () => {
    sf.listPublishedOlderThan.mockResolvedValue([file('gone::x', 'SoundReel/Gone - X.mp3'), file('here::y', 'SoundReel/Here - Y.mp3')]);
    const fetchImpl = vi.fn<typeof fetch>(async (url) =>
      String(url).includes('Gone') ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { 'content-length': '100' } }));
    const res = await reconcilePublished(cfg, fetchImpl);
    expect(res).toEqual({ verified: 0, dropped: 1, pending: 0 });
    expect(sf.clearPublished).toHaveBeenCalledWith('gone::x');
    expect(sf.markPublished).toHaveBeenCalledWith('here::y', expect.stringContaining('Here%20-%20Y.mp3')); // refreshes the check time
  });

  it('stops knocking after three network failures in a row (box asleep) and never un-publishes on them', async () => {
    sf.listReadyUnpublished.mockResolvedValue(Array.from({ length: 8 }, (_, i) => file(`k${i}`, `SoundReel/S${i}.mp3`)));
    sf.listPublishedOlderThan.mockResolvedValue([file('old::p', 'SoundReel/Old.mp3')]);
    const fetchImpl = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'));
    const res = await reconcilePublished(cfg, fetchImpl);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(res.pending).toBe(8);
    expect(sf.markPublished).not.toHaveBeenCalled();
    expect(sf.clearPublished).not.toHaveBeenCalled();
  });
});
