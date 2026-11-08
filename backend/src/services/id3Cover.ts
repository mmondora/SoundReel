/**
 * The cover that is INSIDE an MP3 (ID3v2 `APIC`, or `PIC` in v2.2): first choice for a song the server has no other cover for
 * (ADR-0019, spec 2026-11-08-player-cover-art-design.md C2). Ripped albums, Spotify/Apple downloads and most files of the NAS
 * carry one.
 *
 * Reading a tag costs one small read at the START of the file: the 10-byte header says how long the tag is, then the tag itself
 * is read. From the NAS that is two HTTP `Range` requests (never the whole song). Pure parsing is separate from the reading, so
 * it is tested with tags built by hand. Anything odd (no tag, a tag cut short, a size that is a lie) is «no cover», never an
 * error: a cover is a nicety.
 */
import { promises as fs } from 'node:fs';

export interface EmbeddedPicture {
  mime: string;
  data: Buffer;
  /** ID3 picture type: 3 = front cover, 0 = other. */
  pictureType: number;
}

/** A tag longer than this is not worth reading for a picture. */
export const MAX_TAG_BYTES = 8 * 1024 * 1024;
const HEADER_BYTES = 10;
const FRONT_COVER = 3;

const isId3 = (b: Buffer): boolean => b.length >= HEADER_BYTES && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33;

/** The «syncsafe» integer of ID3: 7 bits per byte. */
const syncsafe = (b: Buffer, at: number): number =>
  ((b[at] & 0x7f) << 21) | ((b[at + 1] & 0x7f) << 14) | ((b[at + 2] & 0x7f) << 7) | (b[at + 3] & 0x7f);

/** The whole length of the tag (header included) from the first 10 bytes of the file, or null when it is not an ID3v2 tag. */
export function id3TagSize(header: Buffer): number | null {
  if (!isId3(header)) return null;
  const major = header[3];
  if (major < 2 || major > 4) return null;
  // the size bytes must be syncsafe (high bit clear)
  if ((header[6] | header[7] | header[8] | header[9]) & 0x80) return null;
  const footer = major === 4 && (header[5] & 0x10) !== 0 ? 10 : 0;
  return HEADER_BYTES + syncsafe(header, 6) + footer;
}

/** «FF 00» → «FF»: undoes the unsynchronisation of a tag or a frame. */
function resync(data: Buffer): Buffer {
  const out: number[] = [];
  for (let i = 0; i < data.length; i++) {
    out.push(data[i]);
    if (data[i] === 0xff && data[i + 1] === 0x00) i++;
  }
  return Buffer.from(out);
}

/** The offset where a text field that starts at `at` ends (its terminator), and the length of that terminator. */
function endOfText(data: Buffer, at: number, encoding: number): { end: number; skip: number } {
  const wide = encoding === 1 || encoding === 2;
  if (wide) {
    for (let i = at; i + 1 < data.length; i += 2) if (data[i] === 0 && data[i + 1] === 0) return { end: i, skip: 2 };
    return { end: data.length, skip: 0 };
  }
  const nul = data.indexOf(0, at);
  return nul < 0 ? { end: data.length, skip: 0 } : { end: nul, skip: 1 };
}

const latin1 = (b: Buffer): string => b.toString('latin1');

/** What an image really is, by its first bytes: tags say «image/jpg» for PNGs, or nothing at all. */
export function sniffImageMime(data: Buffer): string | null {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg';
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (data.length >= 12 && latin1(data.subarray(0, 4)) === 'RIFF' && latin1(data.subarray(8, 12)) === 'WEBP') return 'image/webp';
  if (data.length >= 4 && latin1(data.subarray(0, 4)) === 'GIF8') return 'image/gif';
  return null;
}

/** The picture inside an `APIC` (v2.3 / v2.4) or `PIC` (v2.2) frame body. */
function pictureOfFrame(body: Buffer, v22: boolean): EmbeddedPicture | null {
  if (body.length < 4) return null;
  const encoding = body[0];
  // the declared MIME type is skipped, not trusted: tags say «image/jpg» for a PNG, or «-->» for a link; the bytes decide
  let at = 1;
  if (v22) {
    at = 4; // a 3-letter format: «JPG», «PNG»
  } else {
    const m = endOfText(body, 1, 0);
    at = m.end + m.skip;
  }
  if (at >= body.length) return null;
  const pictureType = body[at];
  at += 1;
  const description = endOfText(body, at, encoding);
  at = description.end + description.skip;
  if (at >= body.length) return null;
  const data = body.subarray(at);
  const real = sniffImageMime(data);
  if (!real) return null; // «a link» (MIME «-->») or a body that is not an image
  return { mime: real, data: Buffer.from(data), pictureType };
}

/** Every picture of a whole ID3v2 tag (header included), in file order. */
export function parseId3Pictures(tag: Buffer): EmbeddedPicture[] {
  const size = id3TagSize(tag.subarray(0, HEADER_BYTES));
  if (size === null) return [];
  const major = tag[3];
  const flags = tag[5];
  let body = tag.subarray(HEADER_BYTES, Math.min(tag.length, size));
  if (major <= 3 && (flags & 0x80) !== 0) body = resync(body); // whole-tag unsynchronisation (v2.2 / v2.3)
  let at = 0;
  if (major >= 3 && (flags & 0x40) !== 0 && body.length >= 4) {
    // extended header: v2.3 size excludes itself (plain integer), v2.4 includes itself (syncsafe)
    const ext = major === 4 ? syncsafe(body, 0) : body.readUInt32BE(0) + 4;
    if (ext < 4 || ext > body.length) return [];
    at = ext;
  }
  const out: EmbeddedPicture[] = [];
  const idLength = major === 2 ? 3 : 4;
  const headLength = major === 2 ? 6 : 10;
  while (at + headLength <= body.length) {
    if (body[at] === 0) break; // padding: no more frames
    const id = latin1(body.subarray(at, at + idLength));
    let frameSize: number;
    let frameFlags = 0;
    if (major === 2) {
      frameSize = (body[at + 3] << 16) | (body[at + 4] << 8) | body[at + 5];
    } else {
      frameSize = major === 4 ? syncsafe(body, at + 4) : body.readUInt32BE(at + 4);
      frameFlags = body.readUInt16BE(at + 8);
    }
    const start = at + headLength;
    const end = start + frameSize;
    if (frameSize <= 0 || end > body.length) break; // a size that does not fit: the rest cannot be trusted
    if (id === 'APIC' || id === 'PIC') {
      let frame = body.subarray(start, end);
      let readable = true;
      if (major === 4) {
        if ((frameFlags & 0x000c) !== 0) readable = false;                // compressed / encrypted
        if (readable && (frameFlags & 0x0001) !== 0) frame = frame.subarray(4); // data length indicator
        if (readable && (frameFlags & 0x0002) !== 0) frame = resync(frame);     // per-frame unsynchronisation
      } else if (major === 3 && (frameFlags & 0x00c0) !== 0) {
        readable = false;                                                  // compressed / encrypted
      }
      if (readable) {
        const picture = pictureOfFrame(frame, major === 2);
        if (picture) out.push(picture);
      }
    }
    at = end;
  }
  return out;
}

/** The front cover if there is one, else the first picture. */
export function pickCover(pictures: EmbeddedPicture[]): EmbeddedPicture | null {
  return pictures.find((p) => p.pictureType === FRONT_COVER) ?? pictures[0] ?? null;
}

/** The cover of an MP3 on the disk: one read of the header, one of the tag. null when the file has none. */
export async function readEmbeddedCoverFromFile(absPath: string): Promise<EmbeddedPicture | null> {
  let handle: fs.FileHandle | null = null;
  try {
    handle = await fs.open(absPath, 'r');
    const header = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0);
    if (bytesRead < HEADER_BYTES) return null;
    const size = id3TagSize(header);
    if (size === null || size > MAX_TAG_BYTES) return null;
    const tag = Buffer.alloc(size);
    const read = await handle.read(tag, 0, size, 0);
    return pickCover(parseId3Pictures(tag.subarray(0, read.bytesRead)));
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

type FetchLike = (url: string, init?: { headers?: Record<string, string>; signal?: AbortSignal }) => Promise<{
  ok: boolean;
  status: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

/** The cover of an MP3 behind an HTTP address (the box): `Range` for the header, then for the tag. */
export async function readEmbeddedCoverFromUrl(
  url: string,
  fetchFn: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 8000,
): Promise<EmbeddedPicture | null> {
  const get = async (from: number, length: number): Promise<Buffer | null> => {
    const signal = AbortSignal.timeout(timeoutMs);
    const res = await fetchFn(url, { headers: { Range: `bytes=${from}-${from + length - 1}` }, signal });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    // a server that ignores Range sends the whole file with 200: keep only what was asked for
    return bytes.subarray(0, length);
  };
  try {
    const header = await get(0, HEADER_BYTES);
    if (!header || header.length < HEADER_BYTES) return null;
    const size = id3TagSize(header);
    if (size === null || size > MAX_TAG_BYTES) return null;
    const tag = await get(0, size);
    if (!tag) return null;
    return pickCover(parseId3Pictures(tag));
  } catch {
    return null;
  }
}
