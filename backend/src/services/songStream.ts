/**
 * Serving a song's bytes from wherever they are (ADR-0010).
 *
 * A song can be a file on geekom's disk (`local`) and/or a file of the media server (`media`, plain HTTP on the
 * LAN, answering `Range`). The caller passes the origins in order of preference; the first that answers wins and
 * the next ones are the fallback while nothing has been sent yet. A `media` origin is a proxy: the browser (or the
 * phone) only ever talks to this backend, over HTTPS, from anywhere — the box is never exposed.
 */
import { createReadStream, promises as fsp } from 'node:fs';
import { Readable } from 'node:stream';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { logWarning } from '../utils/logger';

export type FileOrigin = { kind: 'local'; absPath: string } | { kind: 'media'; url: string };

export interface OpenedSongStream {
  origin: FileOrigin['kind'];
  status: 200 | 206 | 416;
  /** Headers describing THIS response (length, range); the caller adds name, type and caching. */
  headers: Record<string, string>;
  body: Readable | null;
}

export interface OpenOptions {
  fetchImpl?: typeof fetch;
  /** Time the box has to start answering (the body is not time-limited: a song is streamed for minutes). */
  headerTimeoutMs?: number;
  /** Aborts an upstream request when the client goes away. */
  signal?: AbortSignal;
}

const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/;

/** Only a plain single range is honoured (what `<audio>` seeking sends); anything else is a full 200. */
export function parseRange(header: string | undefined): { start: string; end: string } | null {
  const m = SINGLE_RANGE.exec(header ?? '');
  return m && (m[1] !== '' || m[2] !== '') ? { start: m[1], end: m[2] } : null;
}

async function openLocal(absPath: string, rangeHeader: string | undefined): Promise<OpenedSongStream | null> {
  let size: number;
  try {
    const st = await fsp.stat(absPath);
    if (!st.isFile()) return null;
    size = st.size;
  } catch {
    return null;
  }
  const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
  const range = parseRange(rangeHeader);
  let start = 0;
  let end = size - 1;
  let status: 200 | 206 = 200;
  if (range) {
    if (range.start === '') {
      start = Math.max(0, size - Number(range.end)); // "bytes=-N": the last N bytes
    } else {
      start = Number(range.start);
      if (range.end !== '') end = Math.min(end, Number(range.end));
    }
    if (start > end || start >= size) {
      return { origin: 'local', status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` }, body: null };
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(end - start + 1);
  return { origin: 'local', status, headers, body: createReadStream(absPath, { start, end }) };
}

async function openMedia(url: string, rangeHeader: string | undefined, options: OpenOptions): Promise<OpenedSongStream | null> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => controller.abort(), options.headerTimeoutMs ?? 10_000);
  try {
    const range = parseRange(rangeHeader);
    const res = await fetchImpl(url, { headers: range ? { Range: rangeHeader as string } : {}, signal: controller.signal });
    clearTimeout(timer);

    if (res.status === 416) {
      await res.body?.cancel().catch(() => undefined);
      const contentRange = res.headers.get('content-range');
      return { origin: 'media', status: 416, headers: contentRange ? { 'Content-Range': contentRange } : {}, body: null };
    }
    if ((res.status !== 200 && res.status !== 206) || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      return null; // 404 (the box lost the file), 5xx...: the next origin gets its turn
    }
    const headers: Record<string, string> = { 'Accept-Ranges': 'bytes' };
    const length = res.headers.get('content-length');
    const contentRange = res.headers.get('content-range');
    if (length) headers['Content-Length'] = length;
    if (res.status === 206 && contentRange) headers['Content-Range'] = contentRange;

    const body = Readable.fromWeb(res.body as never);
    // client gone → stop pulling from the box
    options.signal?.addEventListener('abort', () => body.destroy(), { once: true });
    body.once('close', () => controller.abort());
    return { origin: 'media', status: res.status as 200 | 206, headers, body };
  } catch (err) {
    clearTimeout(timer);
    logWarning('media server origin did not answer', { url, err: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

/** Open the first origin that answers, in the order given; null when none does. */
export async function openSongStream(
  origins: FileOrigin[],
  rangeHeader: string | undefined,
  options: OpenOptions = {},
): Promise<OpenedSongStream | null> {
  for (const origin of origins) {
    const opened =
      origin.kind === 'local' ? await openLocal(origin.absPath, rangeHeader) : await openMedia(origin.url, rangeHeader, options);
    if (opened) return opened;
  }
  return null;
}

export interface ServeOptions {
  filename: string;
  /** `inline` for a player, `attachment` for a download. */
  disposition: 'inline' | 'attachment';
  /** Identity of the file's content; with it a client that already has it gets a 304. */
  version?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Stream a song to the client with the right status and headers. Returns the reply (an async Fastify handler must
 * RETURN it, or the body comes out empty) or null when no origin could serve anything.
 */
export async function serveSong(
  req: FastifyRequest,
  reply: FastifyReply,
  origins: FileOrigin[],
  options: ServeOptions,
): Promise<{ reply: FastifyReply; origin: FileOrigin['kind']; status: number } | null> {
  const controller = new AbortController();
  reply.raw.once('close', () => controller.abort());

  if (options.version) {
    const etag = `"${options.version}"`;
    if (req.headers['if-none-match'] === etag && !req.headers.range) {
      reply.header('ETag', etag).header('Cache-Control', 'private, no-cache');
      return { reply: reply.code(304).send(), origin: origins[0]?.kind ?? 'local', status: 304 };
    }
  }

  const opened = await openSongStream(origins, req.headers.range, { fetchImpl: options.fetchImpl, signal: controller.signal });
  if (!opened) return null;

  reply
    .header('Content-Type', 'audio/mpeg')
    .header('Content-Disposition', `${options.disposition}; filename="${options.filename.replace(/["\r\n]/g, '')}"`);
  if (options.version) reply.header('ETag', `"${options.version}"`).header('Cache-Control', 'private, no-cache');
  for (const [name, value] of Object.entries(opened.headers)) reply.header(name, value);
  reply.code(opened.status);
  if (!opened.body) return { reply: reply.send(), origin: opened.origin, status: opened.status };
  opened.body.on('error', (err) => logWarning('song stream failed mid-transfer', { err: err instanceof Error ? err.message : String(err) }));
  return { reply: reply.send(opened.body), origin: opened.origin, status: opened.status };
}
