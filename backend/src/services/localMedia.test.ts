import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

/**
 * These tests use a real directory rather than a mocked `fs`. Mocking the fs
 * module for a whole test file leaks into vitest's own worker teardown and
 * produces intermittent "Closing rpc while onUserConsoleLog was pending"
 * errors in unrelated files; a temp dir costs a few milliseconds and exercises
 * the real readdir, which is the only thing this module does.
 */
describe('rebuildLocalPaths', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'soundreel-localmedia-'));
    process.env.MEDIA_ROOT = root;
    // MEDIA_ROOT is read once at module load, so the module must be re-imported
    // after the env var is pointed at this test's directory.
    vi.resetModules();
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
    delete process.env.MEDIA_ROOT;
  });

  async function withDir(names: string[], entryId = 'e1') {
    const dir = path.join(root, entryId);
    await fs.mkdir(dir, { recursive: true });
    for (const name of names) await fs.writeFile(path.join(dir, name), '');
    const { rebuildLocalPaths } = await import('./localMedia');
    return rebuildLocalPaths(entryId);
  }

  const at = (...parts: string[]) => path.join(root, 'e1', ...parts);

  it('maps a full directory onto the pipeline shape', async () => {
    const out = await withDir([
      'audio.wav', 'video.mp4', 'thumbnail.jpg', 'thumbnail-source.jpg',
      'frame-001.jpg', 'frame-002.jpg',
    ]);
    expect(out?.audioPath).toBe(at('audio.wav'));
    expect(out?.videoPath).toBe(at('video.mp4'));
    expect(out?.thumbnailPath).toBe(at('thumbnail.jpg'));
    expect(out?.framePaths).toHaveLength(2);
    expect(out?.slidePaths).toEqual([]);
  });

  it('orders frames numerically, not by discovery order', async () => {
    const out = await withDir(['frame-010.jpg', 'frame-002.jpg', 'frame-001.jpg']);
    expect(out?.framePaths).toEqual([
      at('frame-001.jpg'),
      at('frame-002.jpg'),
      at('frame-010.jpg'),
    ]);
  });

  it('collects carousel slides in order', async () => {
    const out = await withDir(['slide-002.jpg', 'slide-001.jpg', 'thumbnail.jpg']);
    expect(out?.slidePaths).toEqual([at('slide-001.jpg'), at('slide-002.jpg')]);
  });

  it('falls back to the source thumbnail when the resized one is gone', async () => {
    const out = await withDir(['thumbnail-source.jpg']);
    expect(out?.thumbnailPath).toBe(at('thumbnail-source.jpg'));
  });

  it('returns null for an empty directory rather than an empty shape', async () => {
    expect(await withDir([])).toBeNull();
  });

  it('returns null when the directory does not exist', async () => {
    const { rebuildLocalPaths } = await import('./localMedia');
    expect(await rebuildLocalPaths('gone')).toBeNull();
  });

  it('ignores files that are not media', async () => {
    const out = await withDir(['audio.wav', 'notes.txt', 'frame-x.jpg', 'thumbnail.png']);
    expect(out?.framePaths).toEqual([]);
    expect(out?.thumbnailPath).toBeNull();
  });

  it('keeps every path inside the entry directory', async () => {
    const out = await withDir(['audio.wav', 'frame-001.jpg']);
    for (const p of [out?.audioPath, ...(out?.framePaths ?? [])]) {
      expect(p?.startsWith(path.join(root, 'e1') + path.sep)).toBe(true);
    }
  });
});
