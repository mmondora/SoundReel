import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./songMeta', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./songMeta')>();
  return {
    songKey: actual.songKey,
    getSongMeta: vi.fn(),
    upsertSongEnrichment: vi.fn(),
  };
});
vi.mock('./songEnrichment', () => ({ enrichSong: vi.fn() }));
vi.mock('./streamingRefresher', () => ({ isStale: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import { enqueueSongEnrichment } from './songEnrichmentHook';
import { getSongMeta, upsertSongEnrichment, songKey } from './songMeta';
import { enrichSong } from './songEnrichment';
import { isStale } from './streamingRefresher';
import { logError } from '../utils/logger';

// Flush the fire-and-forget microtask/promise chain kicked off inside enqueueSongEnrichment.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('enqueueSongEnrichment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('skips songs with a blank title', async () => {
    enqueueSongEnrichment([{ artist: 'Daft Punk', title: '   ' }]);
    await flush();
    expect(getSongMeta).not.toHaveBeenCalled();
  });

  it('looks up existing meta by songKey(artist, title) and enriches when missing', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(null);
    vi.mocked(enrichSong).mockResolvedValue({
      deezerId: 1, itunesId: null, genres: ['Electronic'], album: 'Discovery',
      coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null,
    });
    enqueueSongEnrichment([{ artist: 'Daft Punk', title: 'One More Time' }]);
    await flush();
    expect(getSongMeta).toHaveBeenCalledWith(songKey('Daft Punk', 'One More Time'));
    expect(enrichSong).toHaveBeenCalledWith('Daft Punk', 'One More Time');
    expect(upsertSongEnrichment).toHaveBeenCalledWith(expect.objectContaining({
      songKey: songKey('Daft Punk', 'One More Time'),
      deezerId: 1,
    }));
  });

  it('skips enrichment when existing meta is fresh (not stale)', async () => {
    vi.mocked(getSongMeta).mockResolvedValue({
      songKey: songKey('Daft Punk', 'One More Time'),
      enrichedAt: '2026-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(isStale).mockReturnValue(false);
    enqueueSongEnrichment([{ artist: 'Daft Punk', title: 'One More Time' }]);
    await flush();
    expect(enrichSong).not.toHaveBeenCalled();
  });

  it('re-enriches when existing meta is stale', async () => {
    vi.mocked(getSongMeta).mockResolvedValue({
      songKey: songKey('Daft Punk', 'One More Time'),
      enrichedAt: '2020-01-01T00:00:00.000Z',
    } as never);
    vi.mocked(isStale).mockReturnValue(true);
    vi.mocked(enrichSong).mockResolvedValue(null);
    enqueueSongEnrichment([{ artist: 'Daft Punk', title: 'One More Time' }]);
    await flush();
    expect(enrichSong).toHaveBeenCalled();
    expect(upsertSongEnrichment).not.toHaveBeenCalled();
  });

  it('treats a null artist as empty string for the songKey and enrichSong call', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(null);
    vi.mocked(enrichSong).mockResolvedValue(null);
    enqueueSongEnrichment([{ artist: null, title: 'Unknown Track' }]);
    await flush();
    expect(getSongMeta).toHaveBeenCalledWith(songKey('', 'Unknown Track'));
    expect(enrichSong).toHaveBeenCalledWith('', 'Unknown Track');
  });

  it('is fire-and-forget: returns synchronously without awaiting the enrichment', () => {
    vi.mocked(getSongMeta).mockReturnValue(new Promise(() => {})); // never resolves
    const result = enqueueSongEnrichment([{ artist: 'Daft Punk', title: 'One More Time' }]);
    expect(result).toBeUndefined();
  });

  it('logs and swallows errors instead of throwing', async () => {
    vi.mocked(getSongMeta).mockRejectedValue(new Error('db down'));
    enqueueSongEnrichment([{ artist: 'Daft Punk', title: 'One More Time' }]);
    await flush();
    expect(logError).toHaveBeenCalledWith('song enrichment failed', expect.objectContaining({ err: expect.stringContaining('db down') }));
  });

  it('processes multiple songs independently', async () => {
    vi.mocked(getSongMeta).mockResolvedValue(null);
    vi.mocked(enrichSong).mockResolvedValue(null);
    enqueueSongEnrichment([
      { artist: 'Daft Punk', title: 'One More Time' },
      { artist: 'The Weeknd', title: 'Blinding Lights' },
    ]);
    await flush();
    expect(getSongMeta).toHaveBeenCalledTimes(2);
  });
});
