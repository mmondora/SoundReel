import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('./ttsClient', () => ({
  DEFAULT_VOICE: 'it-IT-DiegoNeural',
  TtsHttpError: class TtsHttpError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly body: string,
      readonly headers: Record<string, string> = {},
    ) {
      super(message);
      this.name = 'TtsHttpError';
    }
  },
  synthesizeSpeech: vi.fn(),
}));

import { synthesizeSpeech } from './ttsClient';
import {
  _resetTtsJobsForTests,
  chunkTextForTts,
  hashTtsKey,
  renderTtsSync,
  getReadingProgress,
  putReadingProgress,
} from './ttsRender';

describe('chunkTextForTts', () => {
  it('returns single chunk when short', () => {
    expect(chunkTextForTts('ciao mondo')).toEqual(['ciao mondo']);
  });

  it('splits long text near sentence boundaries', () => {
    const sentence = 'Frase di prova. ';
    const text = sentence.repeat(400); // well over 5500
    const chunks = chunkTextForTts(text, 200);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ').replace(/\s+/g, ' ').length).toBeGreaterThan(100);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(200);
  });
});

describe('hashTtsKey', () => {
  it('changes when voice or localOnly changes', () => {
    const a = hashTtsKey({ text: 'x', voice: 'A', speed: 1, localOnly: false });
    const b = hashTtsKey({ text: 'x', voice: 'B', speed: 1, localOnly: false });
    const c = hashTtsKey({ text: 'x', voice: 'A', speed: 1, localOnly: true });
    expect(a).not.toEqual(b);
    expect(a).not.toEqual(c);
  });
});

describe('renderTtsSync', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-tts-'));
    vi.stubEnv('MEDIA_ROOT', tmp);
    _resetTtsJobsForTests();
    vi.mocked(synthesizeSpeech).mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('synthesizes, caches, and returns cached on second call', async () => {
    vi.mocked(synthesizeSpeech).mockResolvedValue({
      audio: Buffer.from('ID3fake'),
      contentType: 'audio/mpeg',
      durationSec: 1.5,
      servedBy: 'edge-tts',
      engine: 'edge-tts',
      voice: 'it-IT-DiegoNeural',
    });

    const first = await renderTtsSync({ text: 'Prova voce' });
    expect(first.cached).toBe(false);
    expect(first.audioUrl).toMatch(/^\/media\/tts\/[a-f0-9]+\.mp3$/);
    expect(synthesizeSpeech).toHaveBeenCalledOnce();

    const second = await renderTtsSync({ text: 'Prova voce' });
    expect(second.cached).toBe(true);
    expect(second.hash).toBe(first.hash);
    expect(synthesizeSpeech).toHaveBeenCalledOnce();

    const file = path.join(tmp, 'tts', `${first.hash}.mp3`);
    expect(await fs.readFile(file)).toEqual(Buffer.from('ID3fake'));
  });

  it('rejects empty text', async () => {
    await expect(renderTtsSync({ text: '  ' })).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('reading progress', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'sr-prog-'));
    vi.stubEnv('MEDIA_ROOT', tmp);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('puts and gets progress', async () => {
    expect(await getReadingProgress('book:ch1')).toBeNull();
    const saved = await putReadingProgress('book:ch1', { positionSec: 12.5, durationSec: 90 });
    expect(saved.positionSec).toBe(12.5);
    const got = await getReadingProgress('book:ch1');
    expect(got?.positionSec).toBe(12.5);
    expect(got?.durationSec).toBe(90);
  });
});
