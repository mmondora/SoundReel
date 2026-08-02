import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { archiveFilmFilename, downloadArchiveFilm } from './archiveDownloader';

const originalFetch = global.fetch;

function bodyResponse(bytes: Buffer, contentLength?: string) {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-length' ? contentLength ?? String(bytes.length) : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  } as unknown as Response;
}

describe('archiveFilmFilename', () => {
  it('formats title and year', () => {
    expect(archiveFilmFilename('Metropolis', '1927')).toBe('Metropolis (1927).mp4');
  });

  it('omits the year when absent', () => {
    expect(archiveFilmFilename('Metropolis', null)).toBe('Metropolis.mp4');
  });

  it('strips path separators and control characters', () => {
    expect(archiveFilmFilename('A/B: the\\film', '1970')).toBe('A-B- the-film (1970).mp4');
  });

  it('truncates an absurdly long title', () => {
    const name = archiveFilmFilename('x'.repeat(400), '1970');
    expect(name.length).toBeLessThanOrEqual(160);
    expect(name.endsWith('.mp4')).toBe(true);
  });
});

describe('downloadArchiveFilm', () => {
  let dir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dir = await fs.mkdtemp(join(tmpdir(), 'soundreel-films-'));
    process.env.FILMS_LIBRARY_PATH = dir;
  });

  afterEach(async () => {
    global.fetch = originalFetch;
    delete process.env.FILMS_LIBRARY_PATH;
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('writes the file and returns its path', async () => {
    global.fetch = vi.fn().mockResolvedValue(bodyResponse(Buffer.from('video-bytes')));
    const path = await downloadArchiveFilm({
      fileUrl: 'https://archive.org/download/metropolis/m.mp4',
      title: 'Metropolis',
      year: '1927',
    });
    expect(path).toBe(join(dir, 'Metropolis (1927).mp4'));
    expect(await fs.readFile(path, 'utf8')).toBe('video-bytes');
  });

  it('refuses a file larger than the ceiling before downloading it', async () => {
    global.fetch = vi.fn().mockResolvedValue(bodyResponse(Buffer.from('x'), String(20 * 1024 * 1024 * 1024)));
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'Huge', year: null })
    ).rejects.toThrow(/too large/i);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('throws and leaves no partial file when the response is not ok', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'Gone', year: null })
    ).rejects.toThrow();
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('throws when FILMS_LIBRARY_PATH is not configured', async () => {
    delete process.env.FILMS_LIBRARY_PATH;
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://archive.org/download/x/x.mp4', title: 'X', year: null })
    ).rejects.toThrow(/FILMS_LIBRARY_PATH/);
  });

  it('rejects a non-archive.org URL', async () => {
    await expect(
      downloadArchiveFilm({ fileUrl: 'https://evil.example.com/x.mp4', title: 'X', year: null })
    ).rejects.toThrow(/archive\.org/);
  });
});
