import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { openSongStream, parseRange, type FileOrigin } from './songStream';

let dir: string;
let file: string;
const DATA = Buffer.from('0123456789ABCDEFGHIJ'); // 20 bytes

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'stream-'));
  file = path.join(dir, 'a.mp3');
  await writeFile(file, DATA);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const read = async (s: Readable | null): Promise<string> => {
  const parts: Buffer[] = [];
  for await (const c of s ?? []) parts.push(Buffer.from(c));
  return Buffer.concat(parts).toString();
};
const local: FileOrigin = { kind: 'local', absPath: '' };
const localOf = (): FileOrigin => ({ kind: 'local', absPath: file });
const media = (url = 'http://box/x.mp3'): FileOrigin => ({ kind: 'media', url });

/** A box that honours Range like the real FRITZ!Box (verified with curl: 206 + Content-Range, suffix ranges too). */
const box = (): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>(async (_url, init) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(String((init?.headers as Record<string, string> | undefined)?.Range ?? ''));
    if (!range) return new Response(DATA, { status: 200, headers: { 'content-length': '20' } });
    const start = range[1] === '' ? 20 - Number(range[2]) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : 19;
    if (start >= 20) return new Response(null, { status: 416, headers: { 'content-range': 'bytes */20' } });
    return new Response(DATA.subarray(start, end + 1), {
      status: 206,
      headers: { 'content-length': String(end - start + 1), 'content-range': `bytes ${start}-${end}/20` },
    });
  });

describe('parseRange', () => {
  it('honours one plain range and nothing else', () => {
    expect(parseRange('bytes=0-')).toEqual({ start: '0', end: '' });
    expect(parseRange('bytes=5-9')).toEqual({ start: '5', end: '9' });
    expect(parseRange('bytes=-4')).toEqual({ start: '', end: '4' });
    expect(parseRange('bytes=0-1,5-6')).toBeNull();
    expect(parseRange('bytes=-')).toBeNull();
    expect(parseRange('items=0-1')).toBeNull();
    expect(parseRange(undefined)).toBeNull();
  });
});

describe('local origin', () => {
  it('sends the whole file as 200 with its length', async () => {
    const out = await openSongStream([localOf()], undefined);
    expect(out).toMatchObject({ origin: 'local', status: 200, headers: { 'Content-Length': '20', 'Accept-Ranges': 'bytes' } });
    expect(await read(out!.body)).toBe(DATA.toString());
  });

  it('answers ranges: open-ended, closed and suffix, with Content-Range', async () => {
    const a = await openSongStream([localOf()], 'bytes=5-');
    expect(a).toMatchObject({ status: 206, headers: { 'Content-Range': 'bytes 5-19/20', 'Content-Length': '15' } });
    expect(await read(a!.body)).toBe('56789ABCDEFGHIJ');
    const b = await openSongStream([localOf()], 'bytes=2-4');
    expect(await read(b!.body)).toBe('234');
    const c = await openSongStream([localOf()], 'bytes=-3');
    expect(c).toMatchObject({ status: 206, headers: { 'Content-Range': 'bytes 17-19/20' } });
    expect(await read(c!.body)).toBe('HIJ');
  });

  it('416 when the range starts after the end, and a missing file is not an origin', async () => {
    expect(await openSongStream([localOf()], 'bytes=30-')).toMatchObject({ status: 416, headers: { 'Content-Range': 'bytes */20' }, body: null });
    expect(await openSongStream([local], undefined)).toBeNull();
  });
});

describe('media origin (the proxy: the browser never talks to the box)', () => {
  it('relays a full response with the box\'s length and no Content-Range', async () => {
    const out = await openSongStream([media()], undefined, { fetchImpl: box() });
    expect(out).toMatchObject({ origin: 'media', status: 200, headers: { 'Content-Length': '20', 'Accept-Ranges': 'bytes' } });
    expect(out!.headers['Content-Range']).toBeUndefined();
    expect(await read(out!.body)).toBe(DATA.toString());
  });

  it('forwards the Range header and relays 206 + Content-Range (seek and resume work from the internet)', async () => {
    const fetchImpl = box();
    const out = await openSongStream([media()], 'bytes=10-14', { fetchImpl });
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>).Range).toBe('bytes=10-14');
    expect(out).toMatchObject({ status: 206, headers: { 'Content-Range': 'bytes 10-14/20', 'Content-Length': '5' } });
    expect(await read(out!.body)).toBe('ABCDE');
  });

  it('never forwards a header it does not understand', async () => {
    const fetchImpl = box();
    await openSongStream([media()], 'bytes=0-1,5-6', { fetchImpl });
    expect(fetchImpl.mock.calls[0][1]?.headers).toEqual({});
  });

  it('relays 416 from the box', async () => {
    expect(await openSongStream([media()], 'bytes=99-', { fetchImpl: box() })).toMatchObject({ status: 416, headers: { 'Content-Range': 'bytes */20' }, body: null });
  });
});

describe('order and fallback', () => {
  it('uses the first origin in the order given', async () => {
    const fetchImpl = box();
    expect((await openSongStream([media(), localOf()], undefined, { fetchImpl }))?.origin).toBe('media');
    expect((await openSongStream([localOf(), media()], undefined, { fetchImpl }))?.origin).toBe('local');
    expect(fetchImpl).toHaveBeenCalledTimes(1); // the second call never touched the box
  });

  it.each([
    ['answers 404', () => vi.fn<typeof fetch>().mockResolvedValue(new Response('nope', { status: 404 }))],
    ['answers 503', () => vi.fn<typeof fetch>().mockResolvedValue(new Response('busy', { status: 503 }))],
    ['is unreachable', () => vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))],
  ])('falls back to the disk when the box %s', async (_name, make) => {
    const out = await openSongStream([media(), localOf()], undefined, { fetchImpl: make() });
    expect(out?.origin).toBe('local');
    expect(await read(out!.body)).toBe(DATA.toString());
  });

  it('falls back when the box does not start answering in time, and gives up with null when nothing works', async () => {
    const hang = vi.fn<typeof fetch>((_url, init) => new Promise((_res, rej) => init?.signal?.addEventListener('abort', () => rej(new Error('aborted')))));
    expect((await openSongStream([media(), localOf()], undefined, { fetchImpl: hang, headerTimeoutMs: 20 }))?.origin).toBe('local');
    expect(await openSongStream([media()], undefined, { fetchImpl: hang, headerTimeoutMs: 20 })).toBeNull();
    expect(await openSongStream([], undefined)).toBeNull();
  });

  it('stops pulling from the box when the client goes away', async () => {
    const ac = new AbortController();
    const out = await openSongStream([media()], undefined, { fetchImpl: box(), signal: ac.signal });
    ac.abort();
    await new Promise((r) => setImmediate(r));
    expect(out!.body!.destroyed).toBe(true);
  });
});
