import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  COVER_SIZE,
  NOT_FOUND_TTL_MS,
  biggerCoverUrls,
  isPrivateHost,
  resolveCover,
  songCoverPath,
  toCover,
  type CoverDeps,
} from './songCovers';
import type { EmbeddedPicture } from './id3Cover';
import type { OnlineCover } from './songEnrichment';

const image = async (width: number, height: number, color = '#336699', format: 'jpeg' | 'png' = 'jpeg'): Promise<Buffer> => {
  const base = sharp({ create: { width, height, channels: 3, background: color } });
  return format === 'png' ? base.png().toBuffer() : base.jpeg().toBuffer();
};

const metaOf = async (jpeg: Buffer) => sharp(jpeg).metadata();

describe('toCover: the image the app gets', () => {
  it('shrinks a big square cover to 800×800 JPEG and says it is square', async () => {
    const cover = await toCover(await image(1400, 1400));
    expect(cover?.squareish).toBe(true);
    expect(cover?.side).toBe(1400);
    const meta = await metaOf(cover!.jpeg);
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', COVER_SIZE, COVER_SIZE]);
  });

  it('does not enlarge a small one, and a PNG becomes a JPEG', async () => {
    const cover = await toCover(await image(300, 300, '#aa2222', 'png'));
    const meta = await metaOf(cover!.jpeg);
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 300, 300]);
  });

  it('crops a picture of a video (16:9) to a square at the centre and says it is NOT a square cover', async () => {
    const cover = await toCover(await image(640, 360));
    expect(cover?.squareish).toBe(false);
    const meta = await metaOf(cover!.jpeg);
    expect([meta.width, meta.height]).toEqual([360, 360]);
  });

  it('calls «almost square» a cover whose sides differ by 10 % or less', async () => {
    expect((await toCover(await image(600, 640)))?.squareish).toBe(true);
    expect((await toCover(await image(600, 700)))?.squareish).toBe(false);
  });

  it('refuses an icon, a tracking pixel and anything that is not an image', async () => {
    expect(await toCover(await image(60, 60))).toBeNull();
    expect(await toCover(await image(800, 40))).toBeNull();
    expect(await toCover(Buffer.from('<html>not an image</html>'))).toBeNull();
    expect(await toCover(Buffer.alloc(0))).toBeNull();
  });
});

describe('addresses', () => {
  it('knows a private address when it sees one', () => {
    for (const url of ['http://localhost/x.jpg', 'http://127.0.0.1/x', 'http://192.168.178.10:49200/x', 'http://10.0.0.5/x', 'http://172.20.1.1/x', 'http://169.254.1.1/x', 'http://printer.local/x', 'not a url']) {
      expect(isPrivateHost(url), url).toBe(true);
    }
    for (const url of ['https://is1-ssl.mzstatic.com/x.jpg', 'https://cdn-images.dzcdn.net/x.jpg', 'http://172.32.0.1/x', 'http://8.8.8.8/x']) {
      expect(isPrivateHost(url), url).toBe(false);
    }
  });

  it('asks for the bigger file of the same cover first, and keeps the one it was given as the last choice', () => {
    expect(biggerCoverUrls('https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg')).toEqual([
      'https://is1-ssl.mzstatic.com/image/thumb/Music/x/600x600bb.jpg',
      'https://is1-ssl.mzstatic.com/image/thumb/Music/x/100x100bb.jpg',
    ]);
    expect(biggerCoverUrls('https://cdn-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg')).toEqual([
      'https://cdn-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg',
      'https://cdn-images.dzcdn.net/images/cover/abc/250x250-000000-80-0-0.jpg',
    ]);
    expect(biggerCoverUrls('https://example.test/cover.jpg')).toEqual(['https://example.test/cover.jpg']);
  });

  it('has a path of its own for every song, key escaped', () => {
    expect(songCoverPath('bassi maestro::capirai')).toBe('/api/mondrop/songs/bassi%20maestro%3A%3Acapirai/cover');
  });
});

describe('resolveCover: where the cover comes from', () => {
  let dir: string;
  let clock: number;
  let net: Map<string, Buffer>;
  let fetched: string[];
  let online: ReturnType<typeof vi.fn>;
  let deps: CoverDeps;

  const onlineAnswer = (over: Partial<OnlineCover> = {}): void => {
    online.mockResolvedValue({ answered: true, url: null, source: null, ...over });
  };

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'covers-'));
    clock = Date.now(); // the markers on the disk have the real time of the machine: the fake clock starts from it
    net = new Map();
    fetched = [];
    online = vi.fn();
    onlineAnswer();
    deps = {
      dir,
      online: online as unknown as CoverDeps['online'],
      fetchImage: async (url) => {
        fetched.push(url);
        return net.get(url) ?? null;
      },
      now: () => clock,
    };
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const embeddedOf = (data: Buffer): (() => Promise<EmbeddedPicture | null>) => async () => ({ mime: 'image/jpeg', data, pictureType: 3 });

  it('1. the cover the journal already knows wins, at the bigger size, and the file and the Internet are never asked', async () => {
    net.set('https://is1.test/x/600x600bb.jpg', await image(600, 600, '#112233'));
    const embedded = vi.fn(embeddedOf(await image(500, 500)));
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', knownUrl: 'https://is1.test/x/100x100bb.jpg', embedded }, deps);
    expect(cover?.source).toBe('known');
    expect(cover?.contentType).toBe('image/jpeg');
    expect(fetched).toEqual(['https://is1.test/x/600x600bb.jpg']);
    expect(embedded).not.toHaveBeenCalled();
    expect(online).not.toHaveBeenCalled();
  });

  it('1b. when the bigger file does not exist it falls back to the one it was given', async () => {
    net.set('https://is1.test/x/100x100bb.jpg', await image(300, 300));
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', knownUrl: 'https://is1.test/x/100x100bb.jpg' }, deps);
    expect(cover?.source).toBe('known');
    expect(fetched).toEqual(['https://is1.test/x/600x600bb.jpg', 'https://is1.test/x/100x100bb.jpg']);
  });

  it('2. with no known cover, the picture inside the file is used when it is square and big enough: the Internet is not asked', async () => {
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', embedded: embeddedOf(await image(500, 500)) }, deps);
    expect(cover?.source).toBe('file');
    expect(online).not.toHaveBeenCalled();
    const edge = await resolveCover('a::edge', { artist: 'A', title: 'B', embedded: embeddedOf(await image(300, 300)) }, deps);
    expect(edge?.source).toBe('file');
  });

  it('2c. the 160×160 photo of the artist that downloaders write into every file is NOT a cover: the Internet is asked first', async () => {
    net.set('https://itunes.test/600.jpg', await image(600, 600, '#cc0000'));
    onlineAnswer({ url: 'https://itunes.test/600.jpg', source: 'itunes' });
    const cover = await resolveCover('bassi maestro::capirai', { artist: 'Bassi Maestro', title: 'Capirai', embedded: embeddedOf(await image(160, 160)) }, deps);
    expect(cover?.source).toBe('itunes');
    expect(online).toHaveBeenCalledTimes(1);
  });

  it('2d. ...and when the Internet has nothing, that small picture is still better than none', async () => {
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', embedded: embeddedOf(await image(160, 160)) }, deps);
    expect(cover?.source).toBe('file-fallback');
    expect((await metaOf(cover!.bytes)).width).toBe(160);
  });

  it('2b. a dead address of the journal does not stop it: the file is next', async () => {
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', knownUrl: 'https://dead.test/x.jpg', embedded: embeddedOf(await image(500, 500)) }, deps);
    expect(cover?.source).toBe('file');
  });

  it('3. no known cover and no picture in the file: the Internet, with the artist and the title', async () => {
    net.set('https://itunes.test/600.jpg', await image(600, 600));
    onlineAnswer({ url: 'https://itunes.test/600.jpg', source: 'itunes' });
    const cover = await resolveCover('bassi maestro::capirai', { artist: 'Bassi Maestro', title: 'Capirai' }, deps);
    expect(cover?.source).toBe('itunes');
    expect(online).toHaveBeenCalledWith('Bassi Maestro', 'Capirai');
  });

  it('3b. a picture of a VIDEO inside the file (16:9) does not beat the real cover of the Internet', async () => {
    net.set('https://dz.test/xl.jpg', await image(1000, 1000));
    onlineAnswer({ url: 'https://dz.test/xl.jpg', source: 'deezer' });
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', embedded: embeddedOf(await image(640, 360)) }, deps);
    expect(cover?.source).toBe('deezer');
  });

  it('4. the picture of the file is used, cropped, when the Internet has nothing', async () => {
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', embedded: embeddedOf(await image(640, 360)) }, deps);
    expect(cover?.source).toBe('file-fallback');
    expect((await metaOf(cover!.bytes)).width).toBe(360);
  });

  it('5. the thumbnail of the video the song came from is the last resort', async () => {
    net.set('https://yt.test/thumb.jpg', await image(480, 360));
    const cover = await resolveCover('a::b', { artist: 'A', title: 'B', thumbnailUrl: 'https://yt.test/thumb.jpg' }, deps);
    expect(cover?.source).toBe('thumbnail');
  });

  it('a file that cannot be read, or an answer of the Internet that is not an image, only means the next source', async () => {
    net.set('https://itunes.test/x.jpg', Buffer.from('<html>captcha</html>'));
    onlineAnswer({ url: 'https://itunes.test/x.jpg', source: 'itunes' });
    const boom = async (): Promise<EmbeddedPicture | null> => {
      throw new Error('EACCES');
    };
    expect(await resolveCover('a::b', { artist: 'A', title: 'B', embedded: boom }, deps)).toBeNull();
  });

  it('6. nothing found: null, and the Internet is NOT asked again for three days', async () => {
    expect(await resolveCover('a::b', { artist: 'A', title: 'B' }, deps)).toBeNull();
    expect(await resolveCover('a::b', { artist: 'A', title: 'B' }, deps)).toBeNull();
    expect(online).toHaveBeenCalledTimes(1);

    clock += NOT_FOUND_TTL_MS - 60_000;      // two days and 23 hours later: still remembered
    await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    expect(online).toHaveBeenCalledTimes(1);

    clock += 120_000;                         // more than three days: asked again
    await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    expect(online).toHaveBeenCalledTimes(2);
  });

  it('an outage of the providers is NOT «no cover»: the next play asks again', async () => {
    onlineAnswer({ answered: false });
    expect(await resolveCover('a::b', { artist: 'A', title: 'B' }, deps)).toBeNull();
    onlineAnswer({ answered: false });
    await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    expect(online).toHaveBeenCalledTimes(2);
    expect((await readdir(dir)).some((f) => f.endsWith('.none'))).toBe(false);

    online.mockRejectedValue(new Error('network down'));
    expect(await resolveCover('a::b', { artist: 'A', title: 'B' }, deps)).toBeNull();
    expect((await readdir(dir)).some((f) => f.endsWith('.none'))).toBe(false);
  });

  it('a cover found is kept: the second ask is answered from the disk, with the same ETag and source, and no network', async () => {
    net.set('https://itunes.test/600.jpg', await image(600, 600));
    onlineAnswer({ url: 'https://itunes.test/600.jpg', source: 'itunes' });
    const first = await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    const second = await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    expect(second?.etag).toBe(first?.etag);
    expect(second?.source).toBe('itunes');
    expect(second?.bytes.equals(first!.bytes)).toBe(true);
    expect(online).toHaveBeenCalledTimes(1);
    expect(fetched).toEqual(['https://itunes.test/600.jpg']);
    expect(first?.etag).toMatch(/^"c-[0-9a-f]{16}"$/);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('a cover found after «no cover» replaces the marker', async () => {
    await resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    expect((await readdir(dir)).some((f) => f.endsWith('.none'))).toBe(true);
    clock += NOT_FOUND_TTL_MS + 10_000;
    net.set('https://itunes.test/600.jpg', await image(600, 600));
    onlineAnswer({ url: 'https://itunes.test/600.jpg', source: 'itunes' });
    expect((await resolveCover('a::b', { artist: 'A', title: 'B' }, deps))?.source).toBe('itunes');
    expect((await readdir(dir)).some((f) => f.endsWith('.none'))).toBe(false);
  });

  it('two asks at the same time make ONE search', async () => {
    net.set('https://itunes.test/600.jpg', await image(600, 600));
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    online.mockImplementation(async () => {
      await gate;
      return { answered: true, url: 'https://itunes.test/600.jpg', source: 'itunes' };
    });
    const a = resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    const b = resolveCover('a::b', { artist: 'A', title: 'B' }, deps);
    release();
    const [first, second] = await Promise.all([a, b]);
    expect(online).toHaveBeenCalledTimes(1);
    expect(first?.etag).toBe(second?.etag);
  });

  it('every song has its own cover on the disk (two songs, two files)', async () => {
    net.set('https://x.test/1.jpg', await image(500, 500, '#ff0000'));
    net.set('https://x.test/2.jpg', await image(500, 500, '#00ff00'));
    const one = await resolveCover('a::one', { artist: 'A', title: 'One', knownUrl: 'https://x.test/1.jpg' }, deps);
    const two = await resolveCover('a::two', { artist: 'A', title: 'Two', knownUrl: 'https://x.test/2.jpg' }, deps);
    expect(one?.etag).not.toBe(two?.etag);
    expect((await readdir(dir)).filter((f) => f.endsWith('.jpg'))).toHaveLength(2);
  });
});
