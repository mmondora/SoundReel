import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ reconcilePublished: vi.fn(), enabled: true }));
vi.mock('./mediaServer', () => ({
  mediaServerConfig: () => ({ enabled: m.enabled }),
  reconcilePublished: m.reconcilePublished,
}));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import {
  PUBLISH_DEBOUNCE_MS,
  PUBLISH_FOLLOW_UPS_MS,
  PUBLISH_MIN_INTERVAL_MS,
  PUBLISH_SENTINEL,
  _resetMediaPublishForTest,
  publishSentinelPath,
  requestMediaPublish,
  touchPublishSentinel,
} from './mediaPublish';

let lib: string;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  m.enabled = true;
  m.reconcilePublished.mockResolvedValue({ verified: 0, dropped: 0, pending: 0 });
  lib = await mkdtemp(path.join(tmpdir(), 'pub-lib-'));
  process.env.MUSIC_LIBRARY_PATH = lib;
  delete process.env.MUSIC_STORE_DIR;
  _resetMediaPublishForTest();
});
afterEach(async () => {
  _resetMediaPublishForTest();
  vi.useRealTimers();
  delete process.env.MUSIC_LIBRARY_PATH;
  await rm(lib, { recursive: true, force: true });
});

const sentinel = (): Promise<string> => readFile(path.join(lib, 'SoundReel', PUBLISH_SENTINEL), 'utf8');
// the write is real I/O: wait for it to land (vi.waitFor nudges the fake clock by a few ms per check, nothing more)
const sentinelAppears = (): Promise<string> => vi.waitFor(() => sentinel(), { timeout: 2_000, interval: 5 });

describe('publish request (ADR-0010)', () => {
  it('the sentinel lives in the store folder, which the mirror never sends to the box', () => {
    expect(publishSentinelPath()).toBe(path.join(lib, 'SoundReel', '.publish-request'));
  });

  it('touching it writes a fresh timestamp each time (the path unit fires on change)', async () => {
    expect(await touchPublishSentinel(new Date('2026-11-08T10:00:00Z'))).toBe(true);
    expect(await sentinel()).toBe('2026-11-08T10:00:00.000Z\n');
    await touchPublishSentinel(new Date('2026-11-08T10:05:00Z'));
    expect(await sentinel()).toBe('2026-11-08T10:05:00.000Z\n');
  });

  it('several downloads in a burst make ONE request after the debounce, then follow-up checks of the box', async () => {
    requestMediaPublish();
    requestMediaPublish();
    requestMediaPublish();
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS - 1);
    await expect(sentinel()).rejects.toThrow(); // not yet
    await vi.advanceTimersByTimeAsync(2);
    expect(await sentinelAppears()).toMatch(/^\d{4}-\d\d-\d\dT/);

    expect(m.reconcilePublished).not.toHaveBeenCalled();
    for (const delay of PUBLISH_FOLLOW_UPS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(m.reconcilePublished).toHaveBeenCalledTimes(PUBLISH_FOLLOW_UPS_MS.length);
  });

  it('never asks more often than the minimum interval', async () => {
    requestMediaPublish();
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS + 1);
    const first = await sentinelAppears();

    requestMediaPublish(); // ~20 s after the first push: too early for a second one
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS + 1);
    expect(await sentinel()).toBe(first);
    await vi.advanceTimersByTimeAsync(PUBLISH_MIN_INTERVAL_MS);
    await vi.waitFor(async () => expect(await sentinel()).not.toBe(first), { timeout: 2_000, interval: 5 });
  });

  it('does nothing when the media server is switched off or there is no library to write into', async () => {
    m.enabled = false;
    requestMediaPublish();
    await vi.advanceTimersByTimeAsync(PUBLISH_DEBOUNCE_MS * 2);
    await expect(sentinel()).rejects.toThrow();

    m.enabled = true;
    delete process.env.MUSIC_LIBRARY_PATH;
    expect(publishSentinelPath()).toBeNull();
    expect(await touchPublishSentinel()).toBe(false);
  });
});
