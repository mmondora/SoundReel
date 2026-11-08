import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer } from './PlayerContext';
import * as api from '../services/api';
import { servePlans } from '../test/playPlans';
import type { AggregatedSong } from '../types';

// The saved queue (sessionStorage) can hold songs that are only FILES: the playlist manager and «Scegli cosa suonare» offer
// everything. The journal's catalog does not know them: rebuilding from it would drop them AND save the shorter queue over
// the real one. So the player asks for the full catalog when something is missing (spec 2026-11-08-playlist-search-everything-design.md).

vi.mock('../services/api', () => ({
  fetchPlayPlan: vi.fn(),
  fetchSongYoutube: vi.fn(),
  fetchSongState: vi.fn(),
  requestSongDownload: vi.fn(),
  patchSongMeta: vi.fn(),
  sendPlays: vi.fn(),
}));

const STORAGE_KEY = 'soundreel.player.v2';

const song = (key: string, extra: Partial<AggregatedSong> = {}): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, ...extra };
};
const A = song('a::one', { inLibrary: true });
const B = song('b::two', { inLibrary: true });
const FILE = song('bassi maestro::capirai', { inLibrary: true, libraryOnly: true, mediaServer: true });
const OTHER = song('c::other', { inLibrary: true });

function Harness({ catalog, loadFull }: { catalog: AggregatedSong[]; loadFull?: () => Promise<AggregatedSong[]> }) {
  const p = usePlayer();
  return (
    <div>
      <button onClick={() => p.hydrateQueue(catalog, loadFull)}>hydrate</button>
      <button onClick={() => p.playSong(OTHER.songKey, [OTHER], 'mine', null)}>start</button>
      <output data-testid="queue">{p.queue.map((s) => s.songKey).join('|')}</output>
      <output data-testid="index">{String(p.index)}</output>
      <output data-testid="label">{p.queueLabel ?? ''}</output>
    </div>
  );
}

const save = (songKeys: string[], songKey: string | null = songKeys[0] ?? null) =>
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ songKey, songKeys, queueLabel: 'Mix', playlistId: 'p1', shuffle: false, repeat: 'off' }));
const saved = () => JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as { songKeys?: string[]; songKey?: string | null };
const queue = () => screen.getByTestId('queue').textContent;
const hydrate = () => act(async () => { fireEvent.click(screen.getByText('hydrate')); await Promise.resolve(); });

function mount(catalog: AggregatedSong[], loadFull?: () => Promise<AggregatedSong[]>) {
  return render(<PlayerProvider><Harness catalog={catalog} loadFull={loadFull} /></PlayerProvider>);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  localStorage.clear();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  servePlans('internal', { [OTHER.songKey]: 'media-server' }); // the song the user starts plays from its file: no download is asked
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('hydrateQueue', () => {
  it('a saved queue the catalog knows entirely is restored at once, and the full catalog is never asked for', async () => {
    save([A.songKey, B.songKey], B.songKey);
    const loadFull = vi.fn(async () => [A, B, FILE]);
    mount([A, B], loadFull);
    await hydrate();
    expect(queue()).toBe('a::one|b::two');
    expect(screen.getByTestId('index')).toHaveTextContent('1');
    expect(screen.getByTestId('label')).toHaveTextContent('Mix');
    expect(loadFull).not.toHaveBeenCalled();
  });

  it('a saved queue with a song that is only a file waits for the FULL catalog and is restored from it, nothing dropped, nothing shortened', async () => {
    save([A.songKey, FILE.songKey, B.songKey], FILE.songKey);
    let release: (list: AggregatedSong[]) => void = () => undefined;
    const loadFull = vi.fn(() => new Promise<AggregatedSong[]>((resolve) => { release = resolve; }));
    mount([A, B], loadFull);
    await hydrate();
    expect(loadFull).toHaveBeenCalledTimes(1);
    expect(queue()).toBe(''); // nothing yet: no half queue
    expect(saved().songKeys).toEqual([A.songKey, FILE.songKey, B.songKey]); // and the saved one is still whole
    await act(async () => { release([A, B, FILE]); await Promise.resolve(); });
    expect(queue()).toBe('a::one|bassi maestro::capirai|b::two');
    expect(screen.getByTestId('index')).toHaveTextContent('1'); // the file-only song that was playing
    expect(saved().songKeys).toEqual([A.songKey, FILE.songKey, B.songKey]);
    expect(saved().songKey).toBe(FILE.songKey);
  });

  it('a queue made only of songs the journal does not know is restored too (the journal alone would give nothing)', async () => {
    save([FILE.songKey]);
    mount([A, B], async () => [A, B, FILE]);
    await hydrate();
    await act(async () => { await Promise.resolve(); });
    expect(queue()).toBe('bassi maestro::capirai');
  });

  it('if the full catalog cannot be had, the queue is rebuilt from what the journal knows', async () => {
    save([A.songKey, FILE.songKey, B.songKey], A.songKey);
    mount([A, B], () => Promise.reject(new Error('offline')));
    await hydrate();
    await act(async () => { await Promise.resolve(); });
    expect(queue()).toBe('a::one|b::two');
  });

  it('with no way to get the full catalog (an older caller) it behaves as it always did', async () => {
    save([A.songKey, FILE.songKey, B.songKey], A.songKey);
    mount([A, B]);
    await hydrate();
    expect(queue()).toBe('a::one|b::two');
  });

  it('if the user starts something else while the full catalog is coming, that wins', async () => {
    save([A.songKey, FILE.songKey, B.songKey], A.songKey);
    let release: (list: AggregatedSong[]) => void = () => undefined;
    const loadFull = vi.fn(() => new Promise<AggregatedSong[]>((resolve) => { release = resolve; }));
    mount([A, B], loadFull);
    await hydrate();
    await act(async () => { fireEvent.click(screen.getByText('start')); await Promise.resolve(); });
    expect(queue()).toBe('c::other');
    await act(async () => { release([A, B, FILE]); await Promise.resolve(); });
    expect(queue()).toBe('c::other'); // not replaced by the old queue
  });

  it('nothing saved: nothing to restore and nothing asked', async () => {
    const loadFull = vi.fn(async () => [A, B, FILE]);
    mount([A, B], loadFull);
    await hydrate();
    expect(queue()).toBe('');
    expect(loadFull).not.toHaveBeenCalled();
    expect(api.fetchPlayPlan).not.toHaveBeenCalled();
  });
});
