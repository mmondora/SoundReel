import { describe, expect, it } from 'vitest';
import { SOURCE_MODES, choiceFor, parsePrefer, playPlan, type SourceMode } from './playPlan';
import type { NetworkKind } from '../utils/network';

// The rules the browser used to apply by itself (frontend/src/player/playbackSource.ts, up to 2.14.1), now the server's.
const NONE = { fs: false, mediaServer: false };
const FS = { fs: true, mediaServer: false };
const MS = { fs: false, mediaServer: true };
const BOTH = { fs: true, mediaServer: true };

describe('playPlan: Auto follows the network of the request', () => {
  it('at home the song plays from the media server when it is there', () => {
    expect(playPlan('auto', 'internal', MS)).toEqual({ choice: 'media', from: 'media-server', download: false });
  });

  it('from the internet it plays from YouTube, ALWAYS, even for a song that is on the media server (Michele)', () => {
    expect(playPlan('auto', 'external', MS)).toEqual({ choice: 'internet', from: 'youtube', download: false });
    expect(playPlan('auto', 'external', BOTH).from).toBe('youtube');
  });

  it('a network that is not known counts as the internet', () => {
    expect(playPlan('auto', null, MS).from).toBe('youtube');
    expect(playPlan('auto', undefined, MS).from).toBe('youtube');
    expect(choiceFor('auto', null)).toBe('internet');
  });

  it('at home, a song the server does not have yet starts from YouTube in the meantime and asks for the download (Michele)', () => {
    expect(playPlan('auto', 'internal', NONE)).toEqual({ choice: 'media', from: 'youtube', download: true });
  });
});

describe('playPlan: a manual preference wins over the network', () => {
  const nets: Array<NetworkKind | null> = ['internal', 'external', null];

  it.each(nets)('Internet is YouTube on %s', (network) => {
    expect(playPlan('internet', network, BOTH)).toEqual({ choice: 'internet', from: 'youtube', download: false });
  });

  it.each(nets)('Media server is the home file on %s', (network) => {
    expect(playPlan('media', network, MS)).toEqual({ choice: 'media', from: 'media-server', download: false });
  });
});

describe('playPlan: which home file', () => {
  it('on both the disk and the media server the media server wins', () => {
    expect(playPlan('media', 'external', BOTH).from).toBe('media-server');
  });

  it('only on geekom\'s disk (just downloaded, not on the Fritz yet) it plays from the disk', () => {
    expect(playPlan('media', 'internal', FS).from).toBe('disk');
    expect(playPlan('auto', 'internal', FS).from).toBe('disk');
  });

  it('Media server for a song that is on neither falls back to YouTube and asks for the download', () => {
    expect(playPlan('media', 'internal', NONE)).toEqual({ choice: 'media', from: 'youtube', download: true });
  });
});

describe('playPlan: the download does not depend on the switch', () => {
  const nets: Array<NetworkKind | null> = ['internal', 'external', null];

  it('is due in EVERY mode and network when the song is on neither the disk nor the media server', () => {
    for (const mode of SOURCE_MODES) for (const net of nets) expect(playPlan(mode, net, NONE).download).toBe(true);
  });

  it('is never due when the song is on the disk or the media server', () => {
    for (const mode of SOURCE_MODES) for (const net of nets) {
      for (const place of [FS, MS, BOTH]) expect(playPlan(mode, net, place).download).toBe(false);
    }
  });

  it('the switch says where it plays from, never whether to download', () => {
    expect(playPlan('internet', 'external', NONE)).toEqual({ choice: 'internet', from: 'youtube', download: true });
  });
});

describe('parsePrefer', () => {
  it('knows the three modes and takes everything else for Auto', () => {
    expect(SOURCE_MODES).toEqual(['auto', 'internet', 'media']);
    expect(parsePrefer('internet')).toBe('internet');
    expect(parsePrefer('media')).toBe('media');
    expect(parsePrefer('auto')).toBe('auto');
    for (const odd of [undefined, null, '', 'MEDIA', 'youtube', 7, ['media'], {}]) expect(parsePrefer(odd)).toBe('auto' as SourceMode);
  });
});
