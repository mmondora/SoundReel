import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_TAG_BYTES,
  id3TagSize,
  parseId3Pictures,
  pickCover,
  readEmbeddedCoverFromFile,
  readEmbeddedCoverFromUrl,
  sniffImageMime,
} from './id3Cover';

// ---------------------------------------------------------------------------
// Tags built by hand: the same bytes a ripper or a downloader writes
// ---------------------------------------------------------------------------

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]), Buffer.from('JFIF-pretend-picture-data'), Buffer.from([0xff, 0xd9])]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('pretend-png-chunks')]);
const OTHER_JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xdb]), Buffer.from('the-back-of-the-sleeve'), Buffer.from([0xff, 0xd9])]);

const syncsafe = (n: number): Buffer => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
const be32 = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};

/** The body of an APIC frame: encoding, MIME, 0, picture type, description, 0, data. */
const apicBody = (mime: string, type: number, description: string, data: Buffer, encoding = 0): Buffer =>
  Buffer.concat([Buffer.from([encoding]), Buffer.from(mime, 'latin1'), Buffer.from([0]), Buffer.from([type]), Buffer.from(description, 'latin1'), Buffer.from([0]), data]);

const frame = (version: 3 | 4, id: string, body: Buffer, flags = 0): Buffer => {
  const f = Buffer.alloc(2);
  f.writeUInt16BE(flags);
  return Buffer.concat([Buffer.from(id, 'latin1'), version === 4 ? syncsafe(body.length) : be32(body.length), f, body]);
};

const tag = (version: 2 | 3 | 4, frames: Buffer[], opts: { flags?: number; padding?: number; extended?: Buffer } = {}): Buffer => {
  const body = Buffer.concat([opts.extended ?? Buffer.alloc(0), ...frames, Buffer.alloc(opts.padding ?? 0)]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([version, 0, opts.flags ?? 0]), syncsafe(body.length), body]);
};

/** «FF» → «FF 00»: what unsynchronisation does to a tag or a frame. */
const unsync = (data: Buffer): Buffer => {
  const out: number[] = [];
  for (const byte of data) {
    out.push(byte);
    if (byte === 0xff) out.push(0);
  }
  return Buffer.from(out);
};

/** A tag of the old format (v2.2): three-letter frame ids, three-byte sizes. */
const tag22 = (picture: Buffer, format = 'JPG', type = 3): Buffer => {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(format, 'latin1'), Buffer.from([type]), Buffer.from('cover', 'latin1'), Buffer.from([0]), picture]);
  const frame22 = Buffer.concat([Buffer.from('PIC', 'latin1'), Buffer.from([(body.length >> 16) & 0xff, (body.length >> 8) & 0xff, body.length & 0xff]), body]);
  return Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([2, 0, 0]), syncsafe(frame22.length), frame22]);
};

describe('parseId3Pictures: the picture inside an MP3', () => {
  it('reads an APIC of a v2.3 tag', () => {
    const pictures = parseId3Pictures(tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 3, 'Front', JPEG))]));
    expect(pictures).toHaveLength(1);
    expect(pictures[0]).toMatchObject({ mime: 'image/jpeg', pictureType: 3 });
    expect(pictures[0].data.equals(JPEG)).toBe(true);
  });

  it('reads an APIC of a v2.4 tag (syncsafe frame sizes), after a text frame it does not care about', () => {
    const title = frame(4, 'TIT2', Buffer.concat([Buffer.from([3]), Buffer.from('Capirai', 'utf8')]));
    const pictures = parseId3Pictures(tag(4, [title, frame(4, 'APIC', apicBody('image/png', 3, '', PNG))], { padding: 64 }));
    expect(pictures.map((p) => p.mime)).toEqual(['image/png']);
    expect(pictures[0].data.equals(PNG)).toBe(true);
  });

  it('reads a PIC of the old v2.2 format', () => {
    const pictures = parseId3Pictures(tag22(JPEG));
    expect(pictures).toHaveLength(1);
    expect(pictures[0].data.equals(JPEG)).toBe(true);
  });

  it('believes the bytes, not the declared type: «image/jpg» for a PNG is a PNG', () => {
    const [picture] = parseId3Pictures(tag(3, [frame(3, 'APIC', apicBody('image/jpg', 3, '', PNG))]));
    expect(picture.mime).toBe('image/png');
  });

  it('skips a «link» picture (MIME «-->») and anything that is not an image', () => {
    const link = apicBody('-->', 3, '', Buffer.from('http://example.test/cover.jpg'));
    const junk = apicBody('image/jpeg', 3, '', Buffer.from('this is not an image at all'));
    expect(parseId3Pictures(tag(3, [frame(3, 'APIC', link), frame(3, 'APIC', junk)]))).toEqual([]);
  });

  it('keeps every picture in file order; pickCover prefers the FRONT cover, else the first one', () => {
    const pictures = parseId3Pictures(
      tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 4, 'Back', OTHER_JPEG)), frame(3, 'APIC', apicBody('image/jpeg', 3, 'Front', JPEG))]),
    );
    expect(pictures.map((p) => p.pictureType)).toEqual([4, 3]);
    expect(pickCover(pictures)?.data.equals(JPEG)).toBe(true);
    expect(pickCover(pictures.slice(0, 1))?.data.equals(OTHER_JPEG)).toBe(true);
    expect(pickCover([])).toBeNull();
  });

  it('understands a description in UTF-16 (a double zero ends it)', () => {
    const description = Buffer.from('﻿Copertina', 'utf16le');
    const body = Buffer.concat([Buffer.from([1]), Buffer.from('image/jpeg', 'latin1'), Buffer.from([0, 3]), description, Buffer.from([0, 0]), JPEG]);
    const [picture] = parseId3Pictures(tag(3, [frame(3, 'APIC', body)]));
    expect(picture.data.equals(JPEG)).toBe(true);
  });

  it('undoes the unsynchronisation of a whole v2.3 tag', () => {
    const body = Buffer.concat([frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG))]);
    const escaped = unsync(body);
    const unsynced = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0x80]), syncsafe(escaped.length), escaped]);
    const [picture] = parseId3Pictures(unsynced);
    expect(picture.data.equals(JPEG)).toBe(true);
  });

  it('undoes the unsynchronisation of one v2.4 frame, and skips the data length indicator', () => {
    const inner = unsync(apicBody('image/jpeg', 3, '', JPEG));
    const withIndicator = Buffer.concat([syncsafe(apicBody('image/jpeg', 3, '', JPEG).length), inner]);
    const [picture] = parseId3Pictures(tag(4, [frame(4, 'APIC', withIndicator, 0x0003)]));
    expect(picture.data.equals(JPEG)).toBe(true);
  });

  it('skips a compressed or encrypted frame instead of reading garbage', () => {
    expect(parseId3Pictures(tag(4, [frame(4, 'APIC', apicBody('image/jpeg', 3, '', JPEG), 0x0008)]))).toEqual([]);
    expect(parseId3Pictures(tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG), 0x0040)]))).toEqual([]);
  });

  it('steps over an extended header (v2.3 and v2.4)', () => {
    const picture = frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG));
    const ext3 = Buffer.concat([be32(6), Buffer.from([0, 0]), be32(0)]);                // size excludes itself
    expect(parseId3Pictures(tag(3, [picture], { flags: 0x40, extended: ext3 }))).toHaveLength(1);
    const picture4 = frame(4, 'APIC', apicBody('image/jpeg', 3, '', JPEG));
    const ext4 = Buffer.concat([syncsafe(6), Buffer.from([1, 0])]);                     // size includes itself
    expect(parseId3Pictures(tag(4, [picture4], { flags: 0x40, extended: ext4 }))).toHaveLength(1);
  });

  it('stops at the padding, and at a frame whose size does not fit (a tag cut short), keeping what it already read', () => {
    const good = frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG));
    const liar = Buffer.concat([Buffer.from('APIC', 'latin1'), be32(9_999_999), Buffer.alloc(2), Buffer.from('x')]);
    const pictures = parseId3Pictures(tag(3, [good, liar]));
    expect(pictures).toHaveLength(1);
    expect(parseId3Pictures(tag(3, [Buffer.alloc(30), good]))).toEqual([]); // padding first: nothing after it is a frame
  });

  it('is not fooled by something that is not a tag', () => {
    expect(parseId3Pictures(Buffer.from('RIFF....WAVEfmt '))).toEqual([]);
    expect(parseId3Pictures(Buffer.alloc(0))).toEqual([]);
    expect(parseId3Pictures(Buffer.from('ID3'))).toEqual([]);
  });
});

describe('id3TagSize and sniffImageMime', () => {
  it('gives the whole length of the tag from the first ten bytes', () => {
    expect(id3TagSize(tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG))]).subarray(0, 10))).toBe(10 + 10 + apicBody('image/jpeg', 3, '', JPEG).length);
    const footer = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0x10]), syncsafe(100)]);
    expect(id3TagSize(footer)).toBe(120);
  });

  it('refuses what is not an ID3v2 tag: no ID3, an unknown version, a size that is not syncsafe, too few bytes', () => {
    expect(id3TagSize(Buffer.from('RIFFxxxxxxxxxxxx'))).toBeNull();
    expect(id3TagSize(Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([9, 0, 0]), syncsafe(10)]))).toBeNull();
    expect(id3TagSize(Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0, 0x80, 0, 0, 0])]))).toBeNull();
    expect(id3TagSize(Buffer.from('ID3'))).toBeNull();
  });

  it('knows an image by its first bytes', () => {
    expect(sniffImageMime(JPEG)).toBe('image/jpeg');
    expect(sniffImageMime(PNG)).toBe('image/png');
    expect(sniffImageMime(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]))).toBe('image/webp');
    expect(sniffImageMime(Buffer.from('GIF89a......'))).toBe('image/gif');
    expect(sniffImageMime(Buffer.from('<html>not an image</html>'))).toBeNull();
    expect(sniffImageMime(Buffer.alloc(2))).toBeNull();
  });
});

describe('readEmbeddedCoverFromFile', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'id3-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads the cover from the start of a song file, whatever follows the tag', async () => {
    const song = path.join(dir, 'song.mp3');
    await writeFile(song, Buffer.concat([tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG))], { padding: 100 }), Buffer.alloc(5000, 0xaa)]));
    const picture = await readEmbeddedCoverFromFile(song);
    expect(picture?.data.equals(JPEG)).toBe(true);
  });

  it('is null for a file with no tag, a file with a tag but no picture, a missing file and a tag too big to bother with', async () => {
    const plain = path.join(dir, 'plain.mp3');
    await writeFile(plain, Buffer.alloc(3000, 0x55));
    expect(await readEmbeddedCoverFromFile(plain)).toBeNull();

    const textOnly = path.join(dir, 'text.mp3');
    await writeFile(textOnly, tag(3, [frame(3, 'TIT2', Buffer.concat([Buffer.from([0]), Buffer.from('Capirai')]))]));
    expect(await readEmbeddedCoverFromFile(textOnly)).toBeNull();

    expect(await readEmbeddedCoverFromFile(path.join(dir, 'missing.mp3'))).toBeNull();

    const huge = path.join(dir, 'huge.mp3');
    await writeFile(huge, Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([3, 0, 0]), syncsafe(MAX_TAG_BYTES + 1), Buffer.alloc(100)]));
    expect(await readEmbeddedCoverFromFile(huge)).toBeNull();
  });
});

describe('readEmbeddedCoverFromUrl (the box): two small Range reads, never the whole song', () => {
  const song = Buffer.concat([tag(3, [frame(3, 'APIC', apicBody('image/jpeg', 3, '', JPEG))], { padding: 50 }), Buffer.alloc(100_000, 0x77)]);

  const serving = (opts: { honoursRange?: boolean; status?: number } = {}) => {
    const calls: Array<{ url: string; range: string | undefined }> = [];
    const fetchFn = vi.fn(async (url: string, init?: { headers?: Record<string, string> }) => {
      const range = init?.headers?.Range;
      calls.push({ url, range });
      const m = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
      const body = m && opts.honoursRange !== false ? song.subarray(Number(m[1]), Number(m[2]) + 1) : song;
      const ab = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
      return { ok: (opts.status ?? 206) < 400, status: opts.status ?? 206, arrayBuffer: async () => ab };
    });
    return { fetchFn, calls };
  };

  it('asks for the header, then for exactly the tag', async () => {
    const { fetchFn, calls } = serving();
    const picture = await readEmbeddedCoverFromUrl('http://box.test/Music/a.mp3', fetchFn);
    expect(picture?.data.equals(JPEG)).toBe(true);
    expect(calls.map((c) => c.range)).toEqual(['bytes=0-9', `bytes=0-${id3TagSize(song.subarray(0, 10))! - 1}`]);
  });

  it('still works when the server ignores Range and sends the whole file', async () => {
    const { fetchFn } = serving({ honoursRange: false, status: 200 });
    expect((await readEmbeddedCoverFromUrl('http://box.test/a.mp3', fetchFn))?.data.equals(JPEG)).toBe(true);
  });

  it('is null when the box answers an error, has no tag, or does not answer at all', async () => {
    expect(await readEmbeddedCoverFromUrl('http://box.test/a.mp3', serving({ status: 404 }).fetchFn)).toBeNull();
    const plain = vi.fn(async () => ({ ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(10) }));
    expect(await readEmbeddedCoverFromUrl('http://box.test/a.mp3', plain)).toBeNull();
    const down = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await readEmbeddedCoverFromUrl('http://box.test/a.mp3', down)).toBeNull();
  });
});
