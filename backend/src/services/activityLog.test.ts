import { beforeEach, describe, expect, it, vi } from 'vitest';

const info = vi.hoisted(() => vi.fn());
const ctor = vi.hoisted(() => vi.fn());
vi.mock('./debugLogger', () => ({
  Logger: function Logger(name: string) {
    ctor(name);
    return { info };
  },
}));

import {
  _resetActivityThrottleForTest,
  describeActor,
  formatBytes,
  logActivity,
  shouldLogOnce,
  songLabel,
  SYSTEM_ACTOR,
} from './activityLog';

beforeEach(() => {
  vi.clearAllMocks();
  _resetActivityThrottleForTest();
});

describe('logActivity', () => {
  it('writes one console line under the category with action and actor in the data', () => {
    logActivity('playlist', 'create', 'mike ha creato la playlist «Road trip»', { user: 'mike', channel: 'web' }, { playlistId: 'p1' });
    expect(ctor).toHaveBeenCalledWith('playlist');
    expect(info).toHaveBeenCalledWith('mike ha creato la playlist «Road trip»', {
      action: 'create',
      actor: { user: 'mike', device: null, channel: 'web' },
      playlistId: 'p1',
    });
  });

  it('keeps the device label of a Mondrop key', () => {
    logActivity('sync', 'prepare', 'm', { user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
    expect(info.mock.calls[0][1].actor).toEqual({ user: 'mike', device: 'iPhone di Michele', channel: 'mondrop' });
  });

  it('never throws, even if the logger itself blows up', () => {
    info.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    expect(() => logActivity('download', 'request', 'm', SYSTEM_ACTOR)).not.toThrow();
  });
});

describe('labels', () => {
  it('describes who: user, with the device when there is one', () => {
    expect(describeActor({ user: 'mike', channel: 'web' })).toBe('mike');
    expect(describeActor({ user: 'mike', device: ' iPhone di Michele ', channel: 'mondrop' })).toBe('mike (iPhone di Michele)');
    expect(describeActor({ user: 'mike', device: '  ', channel: 'mondrop' })).toBe('mike');
    expect(describeActor(SYSTEM_ACTOR)).toBe('sistema');
  });

  it('labels a song "Title – Artist", falling back to its key', () => {
    expect(songLabel({ title: 'White Flag', artist: 'Bishop Briggs' })).toBe('White Flag – Bishop Briggs');
    expect(songLabel({ title: 'Intro', artist: '' })).toBe('Intro');
    expect(songLabel(null, 'bishop briggs::white flag')).toBe('white flag – bishop briggs');
    expect(songLabel(undefined, 'weird key')).toBe('weird key');
    expect(songLabel(undefined)).toBe('brano sconosciuto');
  });

  it('formats sizes the way the console reader expects', () => {
    expect(formatBytes(0)).toBe('0 MB');
    expect(formatBytes(5_720_510)).toBe('5,5 MB');
    expect(formatBytes(312_000_000)).toBe('298 MB');
    expect(formatBytes(1_300_000_000)).toBe('1,2 GB');
  });
});

describe('shouldLogOnce (a device polling must leave one line)', () => {
  it('is true once per key per window, per key independently, and again after the window', () => {
    expect(shouldLogOnce('a', 1000, 0)).toBe(true);
    expect(shouldLogOnce('a', 1000, 500)).toBe(false);
    expect(shouldLogOnce('b', 1000, 500)).toBe(true);
    expect(shouldLogOnce('a', 1000, 1001)).toBe(true);
  });
});
