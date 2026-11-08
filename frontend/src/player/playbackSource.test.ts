import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SOURCE_MODE,
  SOURCE_MODE_STORAGE_KEY,
  effectiveSource,
  loadSourceMode,
  parseSourceMode,
  playsFromHome,
  saveSourceMode,
  sourceChoiceFor,
} from './playbackSource';
import type { SourceMode } from './playbackSource';
import type { NetworkKind, SongLocation } from '../types';

const NONE: SongLocation = { fs: false, mediaServer: false };
const FS: SongLocation = { fs: true, mediaServer: false };
const MS: SongLocation = { fs: false, mediaServer: true };
const BOTH: SongLocation = { fs: true, mediaServer: true };

describe('effectiveSource: Auto follows the network', () => {
  it('Auto + home network → the media server (when the song is there)', () => {
    expect(effectiveSource('auto', 'internal', MS)).toEqual({ choice: 'media', from: 'media-server', download: false });
  });

  it('Auto + internet → Internet (YouTube), even for a song that is on the media server', () => {
    expect(effectiveSource('auto', 'external', MS)).toEqual({ choice: 'internet', from: 'youtube', download: false });
  });

  it('GET /api/net failing or still pending counts as the internet', () => {
    expect(effectiveSource('auto', null, MS).from).toBe('youtube');
    expect(effectiveSource('auto', undefined, MS).from).toBe('youtube');
    expect(sourceChoiceFor('auto', null)).toBe('internet');
  });
});

describe('effectiveSource: a manual mode wins over the network', () => {
  it.each<[NetworkKind | null]>([['internal'], ['external'], [null]])('Internet is Internet on %s', (network) => {
    expect(effectiveSource('internet', network, BOTH).from).toBe('youtube');
    expect(effectiveSource('internet', network, BOTH).choice).toBe('internet');
  });

  it.each<[NetworkKind | null]>([['internal'], ['external'], [null]])('Media server is the home file on %s', (network) => {
    expect(effectiveSource('media', network, MS).from).toBe('media-server');
    expect(effectiveSource('media', network, MS).choice).toBe('media');
  });
});

describe('effectiveSource: which home file', () => {
  it('on both FS and MS the media server wins', () => {
    expect(effectiveSource('media', 'external', BOTH).from).toBe('media-server');
  });

  it('only on geekom’s disk (e.g. just downloaded, not on the Fritz yet) it plays from the disk', () => {
    expect(effectiveSource('media', 'internal', FS).from).toBe('disk');
    expect(effectiveSource('auto', 'internal', FS).from).toBe('disk');
  });

  it('Media server mode for a song that is on neither falls back to Internet and asks for the download', () => {
    expect(effectiveSource('media', 'internal', NONE)).toEqual({ choice: 'media', from: 'youtube', download: true });
    expect(effectiveSource('auto', 'internal', NONE)).toEqual({ choice: 'media', from: 'youtube', download: true });
  });
});

describe('effectiveSource: the parallel download does not depend on the switch (S6)', () => {
  const modes: SourceMode[] = ['auto', 'internet', 'media'];
  const nets: Array<NetworkKind | null> = ['internal', 'external', null];

  it('due in EVERY mode and network when the song is on neither FS nor MS', () => {
    for (const mode of modes) for (const net of nets) expect(effectiveSource(mode, net, NONE).download).toBe(true);
  });

  it('never due when the song is on FS or MS', () => {
    for (const mode of modes) for (const net of nets) {
      expect(effectiveSource(mode, net, FS).download).toBe(false);
      expect(effectiveSource(mode, net, MS).download).toBe(false);
      expect(effectiveSource(mode, net, BOTH).download).toBe(false);
    }
  });

  it('the switch says where it plays from, never whether to download', () => {
    expect(effectiveSource('internet', 'external', NONE)).toEqual({ choice: 'internet', from: 'youtube', download: true });
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
