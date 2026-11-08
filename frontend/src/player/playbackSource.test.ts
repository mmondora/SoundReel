import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SOURCE_MODE,
  SOURCE_MODES,
  SOURCE_MODE_STORAGE_KEY,
  loadSourceMode,
  parseSourceMode,
  playsFromHome,
  saveSourceMode,
} from './playbackSource';

// Where a song plays from is decided by the SERVER now (rule P, ADR-0018: `GET /api/songs/:key/play`); its rule is
// tested in backend/src/services/playPlan.test.ts and the browser's obedience in PlayerContext.source.test.tsx.
// What is left here is the vocabulary and the preference this browser remembers.

describe('the modes', () => {
  it('are Auto, Internet and Media server, in the order of the switch', () => {
    expect(SOURCE_MODES).toEqual(['auto', 'internet', 'media']);
  });
});

describe('playsFromHome', () => {
  it('is true for the media server and the disk only', () => {
    expect(playsFromHome('media-server')).toBe(true);
    expect(playsFromHome('disk')).toBe(true);
    expect(playsFromHome('youtube')).toBe(false);
    expect(playsFromHome(null)).toBe(false);
  });
});

describe('the remembered mode', () => {
  const fakeStorage = (initial: Record<string, string> = {}) => {
    const data = { ...initial };
    return {
      data,
      getItem: (k: string) => data[k] ?? null,
      setItem: (k: string, v: string) => { data[k] = v; },
    };
  };

  it('defaults to Auto; anything that is not a mode is Auto', () => {
    expect(DEFAULT_SOURCE_MODE).toBe('auto');
    expect(loadSourceMode(fakeStorage())).toBe('auto');
    expect(parseSourceMode('nonsense')).toBe('auto');
    expect(parseSourceMode(null)).toBe('auto');
    expect(parseSourceMode('internet')).toBe('internet');
    expect(parseSourceMode('media')).toBe('media');
  });

  it('round-trips a manual choice through storage', () => {
    const storage = fakeStorage();
    saveSourceMode('media', storage);
    expect(storage.data[SOURCE_MODE_STORAGE_KEY]).toBe('media');
    expect(loadSourceMode(storage)).toBe('media');
  });

  it('survives storage that throws on read and on write (private window, blocked site data)', () => {
    const broken = {
      getItem: vi.fn(() => { throw new Error('denied'); }),
      setItem: vi.fn(() => { throw new Error('denied'); }),
    };
    expect(loadSourceMode(broken)).toBe('auto');
    expect(() => saveSourceMode('internet', broken)).not.toThrow();
  });

  it('works with no storage at all', () => {
    expect(loadSourceMode(null)).toBe('auto');
    expect(() => saveSourceMode('media', null)).not.toThrow();
  });
});
