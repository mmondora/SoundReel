/**
 * Client for the gpu-router TTS pool (OpenAI-compat speech endpoint).
 * TTS_URL should be the pool prefix, e.g. http://gpu-router:9000/tts
 */

export type TtsSpeechRequest = {
  input: string;
  voice?: string;
  speed?: number;
  responseFormat?: 'mp3';
  /** Skip SaaS backends (edge-tts). Today → 503 until a local backend exists. */
  localOnly?: boolean;
  /** Pin backend after first chunk (x-served-by). */
  pinBackend?: string;
  signal?: AbortSignal;
};

export type TtsSpeechResult = {
  audio: Buffer;
  contentType: string;
  durationSec: number | null;
  servedBy: string | null;
  engine: string | null;
  voice: string | null;
};

export class TtsHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
    readonly headers: Record<string, string>,
  ) {
    super(message);
    this.name = 'TtsHttpError';
  }
}

const DEFAULT_VOICE = 'it-IT-DiegoNeural';
const DEFAULT_TIMEOUT_MS = 60_000;

export function getTtsBaseUrl(): string {
  return (process.env.TTS_URL || 'http://gpu-router:9000/tts').replace(/\/$/, '');
}

export async function synthesizeSpeech(req: TtsSpeechRequest): Promise<TtsSpeechResult> {
  const base = getTtsBaseUrl();
  const url = `${base}/v1/audio/speech`;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'audio/mpeg',
  };
  if (req.localOnly) headers['X-TTS-Local-Only'] = '1';
  if (req.pinBackend) headers['X-GPU-Backend'] = req.pinBackend;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  req.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        input: req.input,
        voice: req.voice || DEFAULT_VOICE,
        speed: req.speed ?? 1.0,
        response_format: req.responseFormat || 'mp3',
      }),
      signal: controller.signal,
    });

    const headerMap: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headerMap[k.toLowerCase()] = v;
    });

    if (!res.ok) {
      const body = await res.text();
      throw new TtsHttpError(
        `TTS ${res.status}: ${body.slice(0, 200)}`,
        res.status,
        body,
        headerMap,
      );
    }

    const ab = await res.arrayBuffer();
    const durationRaw = headerMap['x-duration-sec'];
    const durationSec = durationRaw ? Number(durationRaw) : null;

    return {
      audio: Buffer.from(ab),
      contentType: headerMap['content-type'] || 'audio/mpeg',
      durationSec: Number.isFinite(durationSec) ? durationSec : null,
      servedBy: headerMap['x-served-by'] || null,
      engine: headerMap['x-tts-engine'] || null,
      voice: headerMap['x-tts-voice'] || req.voice || DEFAULT_VOICE,
    };
  } finally {
    clearTimeout(timer);
    req.signal?.removeEventListener('abort', onAbort);
  }
}

export { DEFAULT_VOICE };
