/**
 * The cover of a song, found by the SERVER and kept (ADR-0019, spec 2026-11-08-player-cover-art-design.md C1–C4). The app asks
 * SoundReel (`GET /api/mondrop/songs/:key/cover`) and nothing else: it never talks to iTunes or Deezer (rule P).
 *
 * Where it comes from, in order:
 *   1. the cover the journal already knows for the song (Deezer / iTunes, `song_meta`), at a larger size when the address allows;
 *   2. the picture INSIDE the MP3 (ID3), when it is almost square AND big enough (300 px). A picture of a video is not an album
 *      cover, and neither is the 160×160 photo of the artist that downloaders write into every file;
 *   3. the Internet: iTunes, then Deezer, only with a STRONG match of artist and title (better no cover than the wrong one);
 *   4. the picture inside the MP3 anyway (small, or not square: cropped);
 *   5. the thumbnail of the video the file was downloaded from, cropped;
 *   6. nothing: the app draws its own.
 * The result is resized to at most 800×800 and kept on disk; «nothing» is remembered for three days (and an outage of the
 * providers is NOT remembered: it is not an answer). Two requests for one song share one search.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { logInfo, logWarning } from '../utils/logger';
import type { EmbeddedPicture } from './id3Cover';
import { findCoverOnline, largeItunesArtwork, type OnlineCover } from './songEnrichment';

export const COVER_SIZE = 800;
/** Smaller than this is an icon or a tracking pixel, not a cover. */
export const MIN_COVER_SIDE = 100;
export const NOT_FOUND_TTL_MS = 3 * 24 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 12 * 1024 * 1024;
/** «Almost square»: the sides differ by at most 10 %. */
const SQUARE_TOLERANCE = 0.1;
/**
 * The picture inside a file is trusted over the Internet only from this size up: a ripped album carries its cover at 500 px or
 * more, while the artist photos that downloaders embed are 160 px (measured on the library of 8 November: the same 160×160 face
 * in every file of an artist).
 */
export const GOOD_EMBEDDED_SIDE = 300;

export type CoverSource = 'known' | 'file' | 'itunes' | 'deezer' | 'file-fallback' | 'thumbnail';

export interface CoverBytes {
  bytes: Buffer;
  contentType: 'image/jpeg';
  etag: string;
  source: CoverSource;
}

export interface CoverInput {
  artist: string;
  title: string;
  /** The cover the journal already has for the song (a Deezer or iTunes address). */
  knownUrl?: string | null;
  /** The thumbnail of the video the file was downloaded from: the last resort. */
  thumbnailUrl?: string | null;
  /** Reads the picture inside the audio file; asked only when it is needed. */
  embedded?: () => Promise<EmbeddedPicture | null>;
}

export interface CoverDeps {
  dir: string;
  online: (artist: string, title: string) => Promise<OnlineCover>;
  fetchImage: (url: string) => Promise<Buffer | null>;
  now: () => number;
}

export const coversDir = (): string => process.env.COVERS_DIR || path.join(process.env.MEDIA_ROOT || '/data/media', '_covers');

export const songCoverPath = (songKey: string): string => `/api/mondrop/songs/${encodeURIComponent(songKey)}/cover`;

const hashOf = (songKey: string): string => createHash('sha1').update(songKey).digest('hex');

// ---------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------

/** A private address is never fetched for a cover (the addresses come from our own database, but a cover is not worth a probe of the LAN). */
export function isPrivateHost(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '[::1]') return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  return false;
}

/** The same cover at a bigger size when the address says its size: iTunes «…/100x100bb.jpg», Deezer «…/250x250-000000-80-0-0.jpg». */
export function biggerCoverUrls(url: string): string[] {
  const out: string[] = [];
  const itunes = largeItunesArtwork(url);
  if (itunes !== url) out.push(itunes);
  const deezer = url.replace(/\/(\d{2,4})x\1-(\d{6}-\d+-\d+-\d+\.(?:jpg|png))/i, '/1000x1000-$2');
  if (deezer !== url) out.push(deezer);
  out.push(url);
  return [...new Set(out)];
}

async function fetchImageDefault(url: string): Promise<Buffer | null> {
  if (!/^https?:\/\//i.test(url) || isPrivateHost(url)) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { 'User-Agent': 'SoundReel (cover lookup)' } });
    if (!res.ok) return null;
    if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('image/')) return null;
    if (Number(res.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    return bytes.length > 0 && bytes.length <= MAX_DOWNLOAD_BYTES ? bytes : null;
  } catch {
    return null;
  }
}

const defaultDeps = (): CoverDeps => ({ dir: coversDir(), online: findCoverOnline, fetchImage: fetchImageDefault, now: () => Date.now() });

// ---------------------------------------------------------------------------
// The image
// ---------------------------------------------------------------------------

export interface NormalizedCover {
  jpeg: Buffer;
  /** The sides differ by at most 10 %: it is an album cover, not a picture of a video. */
  squareish: boolean;
  /** The shorter side of the picture as it was found, before it was shrunk. */
  side: number;
}

/** A square JPEG of at most 800×800 (cropped at the centre when it is not square), or null when it is not a usable image. */
export async function toCover(input: Buffer): Promise<NormalizedCover | null> {
  try {
    const meta = await sharp(input, { failOn: 'none' }).metadata();
    const width = meta.width ?? 0;
    const height = meta.height ?? 0;
    if (width < MIN_COVER_SIDE || height < MIN_COVER_SIDE) return null;
    const side = Math.min(width, height);
    const jpeg = await sharp(input, { failOn: 'none' })
      .flatten({ background: '#ffffff' })
      .extract({ left: Math.floor((width - side) / 2), top: Math.floor((height - side) / 2), width: side, height: side })
      .resize(Math.min(side, COVER_SIZE), Math.min(side, COVER_SIZE))
      .jpeg({ quality: 84 })
      .toBuffer();
    return { jpeg, squareish: Math.abs(width / height - 1) <= SQUARE_TOLERANCE, side };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// What is kept
// ---------------------------------------------------------------------------

const etagOf = (jpeg: Buffer): string => `"c-${createHash('sha1').update(jpeg).digest('hex').slice(0, 16)}"`;

async function readKept(dir: string, hash: string, now: number): Promise<CoverBytes | 'none' | null> {
  try {
    const bytes = await fs.readFile(path.join(dir, `${hash}.jpg`));
    const source = ((await fs.readFile(path.join(dir, `${hash}.src`), 'utf8').catch(() => 'known')).trim() || 'known') as CoverSource;
    return { bytes, contentType: 'image/jpeg', etag: etagOf(bytes), source };
  } catch {
    // no cover kept: is «nothing» remembered, and still fresh?
  }
  try {
    const st = await fs.stat(path.join(dir, `${hash}.none`));
    if (now - st.mtimeMs < NOT_FOUND_TTL_MS) return 'none';
  } catch {
    // never looked for
  }
  return null;
}

async function keep(dir: string, hash: string, jpeg: Buffer, source: CoverSource): Promise<CoverBytes> {
  await fs.mkdir(dir, { recursive: true });
  const target = path.join(dir, `${hash}.jpg`);
  const tmp = `${target}.${process.pid}.tmp`;
  await fs.writeFile(tmp, jpeg);
  await fs.rename(tmp, target);
  await fs.writeFile(path.join(dir, `${hash}.src`), source).catch(() => undefined);
  await fs.rm(path.join(dir, `${hash}.none`), { force: true }).catch(() => undefined);
  return { bytes: jpeg, contentType: 'image/jpeg', etag: etagOf(jpeg), source };
}

async function keepNothing(dir: string, hash: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${hash}.none`), '');
  } catch (err) {
    logWarning('copertina: impossibile ricordare «non c\'è»', { err: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Finding it
// ---------------------------------------------------------------------------

async function firstUsable(urls: string[], deps: CoverDeps): Promise<NormalizedCover | null> {
  for (const url of urls) {
    const bytes = await deps.fetchImage(url);
    if (!bytes) continue;
    const cover = await toCover(bytes);
    if (cover) return cover;
  }
  return null;
}

const inFlight = new Map<string, Promise<CoverBytes | null>>();

async function find(songKey: string, input: CoverInput, deps: CoverDeps): Promise<CoverBytes | null> {
  const hash = hashOf(songKey);
  const kept = await readKept(deps.dir, hash, deps.now());
  if (kept === 'none') return null;
  if (kept) return kept;

  // 1. what the journal already knows
  if (input.knownUrl) {
    const known = await firstUsable(biggerCoverUrls(input.knownUrl), deps);
    if (known) return keep(deps.dir, hash, known.jpeg, 'known');
  }

  // 2. the picture inside the file, when it looks like an album cover
  let embedded: NormalizedCover | null = null;
  if (input.embedded) {
    try {
      const picture = await input.embedded();
      embedded = picture ? await toCover(picture.data) : null;
    } catch (err) {
      logWarning('copertina: lettura del file fallita', { songKey, err: String(err) });
    }
  }
  if (embedded?.squareish && embedded.side >= GOOD_EMBEDDED_SIDE) return keep(deps.dir, hash, embedded.jpeg, 'file');

  // 3. the Internet, only with a strong match
  let answered = true;
  try {
    const online = await deps.online(input.artist, input.title);
    answered = online.answered;
    if (online.url && online.source) {
      const cover = await firstUsable([online.url], deps);
      if (cover) {
        logInfo('copertina trovata su Internet', { songKey, source: online.source });
        return keep(deps.dir, hash, cover.jpeg, online.source);
      }
    }
  } catch (err) {
    answered = false;
    logWarning('copertina: ricerca su Internet fallita', { songKey, err: String(err) });
  }

  // 4. the picture of the file anyway (small, or cropped to a square), 5. the thumbnail of the video
  if (embedded) return keep(deps.dir, hash, embedded.jpeg, 'file-fallback');
  if (input.thumbnailUrl) {
    const thumbnail = await firstUsable([input.thumbnailUrl], deps);
    if (thumbnail) return keep(deps.dir, hash, thumbnail.jpeg, 'thumbnail');
  }

  // 6. nothing; remembered only if the providers really answered
  if (answered) await keepNothing(deps.dir, hash);
  return null;
}

/** The cover of a song (kept, or found now), or null when there is none. Never throws. */
export function resolveCover(songKey: string, input: CoverInput, deps: CoverDeps = defaultDeps()): Promise<CoverBytes | null> {
  const running = inFlight.get(songKey);
  if (running) return running;
  const run = find(songKey, input, deps)
    .catch((err) => {
      logWarning('copertina: errore', { songKey, err: String(err) });
      return null;
    })
    .finally(() => inFlight.delete(songKey));
  inFlight.set(songKey, run);
  return run;
}
