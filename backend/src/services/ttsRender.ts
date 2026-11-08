/**
 * SoundReel-side TTS render: hash cache under MEDIA_ROOT/tts/<hash>.mp3,
 * optional multi-chunk synthesize via gpu-router.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DEFAULT_VOICE, synthesizeSpeech, TtsHttpError } from './ttsClient';

/** Soft limit per router call (adapter hard-caps at 6000). */
const CHUNK_MAX_CHARS = 5500;
const MAX_TOTAL_CHARS = 40_000;

function mediaRoot(): string {
  return process.env.MEDIA_ROOT || '/data/media';
}

export type TtsRenderRequest = {
  text: string;
  voice?: string;
  speed?: number;
  localOnly?: boolean;
  bookKey?: string;
  chapterId?: string;
};

export type TtsRenderReady = {
  status: 'ready';
  audioUrl: string;
  durationSec: number | null;
  hash: string;
  engine: string | null;
  servedBy: string | null;
  voice: string;
  cached: boolean;
};

export type TtsJobRecord =
  | { id: string; status: 'pending'; createdAt: string }
  | ({ id: string; status: 'ready'; createdAt: string } & Omit<TtsRenderReady, 'status'>)
  | { id: string; status: 'error'; createdAt: string; error: string; httpStatus?: number };

const jobs = new Map<string, TtsJobRecord>();

export function ttsCacheDir(): string {
  return path.resolve(mediaRoot(), 'tts');
}

export function progressDir(): string {
  return path.resolve(mediaRoot(), 'tts', 'progress');
}

export function hashTtsKey(parts: {
  text: string;
  voice: string;
  speed: number;
  localOnly: boolean;
  engineHint?: string;
}): string {
  const h = createHash('sha256');
  h.update(parts.text);
  h.update('\0');
  h.update(parts.voice);
  h.update('\0');
  h.update(String(parts.speed));
  h.update('\0');
  h.update(parts.localOnly ? 'local' : 'any');
  h.update('\0');
  h.update(parts.engineHint || '');
  return h.digest('hex').slice(0, 32);
}

/** Split on paragraph/sentence boundaries without exceeding CHUNK_MAX_CHARS. */
export function chunkTextForTts(text: string, maxChars = CHUNK_MAX_CHARS): string[] {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return [];
  if (cleaned.length <= maxChars) return [cleaned];

  const chunks: string[] = [];
  let rest = cleaned;
  while (rest.length > maxChars) {
    let cut = rest.lastIndexOf('\n\n', maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf('. ', maxChars);
    if (cut < maxChars * 0.4) cut = rest.lastIndexOf(' ', maxChars);
    if (cut < maxChars * 0.4) cut = maxChars;
    // include the delimiter when splitting on ". "
    if (rest.slice(cut, cut + 2) === '. ') cut += 1;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks.filter(Boolean);
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function renderTtsSync(req: TtsRenderRequest): Promise<TtsRenderReady> {
  const text = (req.text || '').trim();
  if (!text) {
    throw Object.assign(new Error('text required'), { statusCode: 400 });
  }
  if (text.length > MAX_TOTAL_CHARS) {
    throw Object.assign(new Error(`text too long (max ${MAX_TOTAL_CHARS} chars)`), { statusCode: 413 });
  }

  const voice = req.voice || DEFAULT_VOICE;
  const speed = req.speed ?? 1.0;
  const localOnly = !!req.localOnly;
  const hash = hashTtsKey({ text, voice, speed, localOnly });
  const dir = ttsCacheDir();
  await ensureDir(dir);
  const filePath = path.join(dir, `${hash}.mp3`);
  const audioUrl = `/media/tts/${hash}.mp3`;

  try {
    await fs.access(filePath);
    const metaPath = path.join(dir, `${hash}.json`);
    let meta: { durationSec?: number | null; engine?: string | null; servedBy?: string | null; voice?: string } = {};
    try {
      meta = JSON.parse(await fs.readFile(metaPath, 'utf8')) as typeof meta;
    } catch {
      /* optional */
    }
    return {
      status: 'ready',
      audioUrl,
      durationSec: meta.durationSec ?? null,
      hash,
      engine: meta.engine ?? null,
      servedBy: meta.servedBy ?? null,
      voice: meta.voice || voice,
      cached: true,
    };
  } catch {
    /* miss — synthesize */
  }

  const chunks = chunkTextForTts(text);
  const buffers: Buffer[] = [];
  let durationSec = 0;
  let servedBy: string | null = null;
  let engine: string | null = null;
  let usedVoice = voice;

  for (const chunk of chunks) {
    const result = await synthesizeSpeech({
      input: chunk,
      voice,
      speed,
      localOnly,
      pinBackend: servedBy || undefined,
    });
    buffers.push(result.audio);
    if (result.durationSec != null) durationSec += result.durationSec;
    if (!servedBy) servedBy = result.servedBy;
    if (!engine) engine = result.engine;
    if (result.voice) usedVoice = result.voice;
  }

  const audio = Buffer.concat(buffers);
  await fs.writeFile(filePath, audio);
  await fs.writeFile(
    path.join(dir, `${hash}.json`),
    JSON.stringify({
      durationSec: durationSec || null,
      engine,
      servedBy,
      voice: usedVoice,
      bookKey: req.bookKey ?? null,
      chapterId: req.chapterId ?? null,
      bytes: audio.length,
      createdAt: new Date().toISOString(),
    }),
    'utf8',
  );

  return {
    status: 'ready',
    audioUrl,
    durationSec: durationSec || null,
    hash,
    engine,
    servedBy,
    voice: usedVoice,
    cached: false,
  };
}

export function enqueueTtsJob(req: TtsRenderRequest): TtsJobRecord {
  const id = createHash('sha1')
    .update(`${Date.now()}:${Math.random()}:${(req.text || '').slice(0, 64)}`)
    .digest('hex')
    .slice(0, 16);
  const createdAt = new Date().toISOString();
  const pending: TtsJobRecord = { id, status: 'pending', createdAt };
  jobs.set(id, pending);

  void (async () => {
    try {
      const ready = await renderTtsSync(req);
      jobs.set(id, { id, createdAt, ...ready });
    } catch (err) {
      const httpStatus = err instanceof TtsHttpError ? err.status : (err as { statusCode?: number }).statusCode;
      jobs.set(id, {
        id,
        status: 'error',
        createdAt,
        error: err instanceof Error ? err.message : String(err),
        httpStatus: typeof httpStatus === 'number' ? httpStatus : undefined,
      });
    }
  })();

  return pending;
}

export function getTtsJob(id: string): TtsJobRecord | null {
  return jobs.get(id) ?? null;
}

export type ReadingProgress = {
  itemKey: string;
  positionSec: number;
  durationSec: number | null;
  updatedAt: string;
};

function safeProgressKey(itemKey: string): string {
  const cleaned = itemKey.replace(/[^A-Za-z0-9._:-]/g, '_').slice(0, 180);
  if (!cleaned) throw Object.assign(new Error('invalid itemKey'), { statusCode: 400 });
  return cleaned;
}

export async function getReadingProgress(itemKey: string): Promise<ReadingProgress | null> {
  const key = safeProgressKey(itemKey);
  const file = path.join(progressDir(), `${key}.json`);
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as ReadingProgress;
  } catch {
    return null;
  }
}

export async function putReadingProgress(
  itemKey: string,
  body: { positionSec: number; durationSec?: number | null },
): Promise<ReadingProgress> {
  const key = safeProgressKey(itemKey);
  if (!Number.isFinite(body.positionSec) || body.positionSec < 0) {
    throw Object.assign(new Error('positionSec must be >= 0'), { statusCode: 400 });
  }
  await ensureDir(progressDir());
  const record: ReadingProgress = {
    itemKey: key,
    positionSec: body.positionSec,
    durationSec: body.durationSec ?? null,
    updatedAt: new Date().toISOString(),
  };
  await fs.writeFile(path.join(progressDir(), `${key}.json`), JSON.stringify(record), 'utf8');
  return record;
}

/** Test helper */
export function _resetTtsJobsForTests(): void {
  jobs.clear();
}
