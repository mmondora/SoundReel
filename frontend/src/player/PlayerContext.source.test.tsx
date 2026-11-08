import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer } from './PlayerContext';
import { SOURCE_MODE_STORAGE_KEY } from './playbackSource';
import type { SourceMode } from './playbackSource';
import * as api from '../services/api';
import type { YtPlayer, YtPlayerOptions } from './youtubeApi';
import type { AggregatedSong, NetworkKind, SongStateResponse } from '../types';

// The "Sorgente" switch of the web player (rules W5–W7, spec 2026-11-07-web-player-ux-design.md): Auto follows the
// network, Internet and Media server force the choice; the parallel download does not depend on it; the picture box
// and the badge follow what is REALLY playing.

vi.mock('../services/api', () => ({
  fetchNetwork: vi.fn(),
  fetchSongYoutube: vi.fn(),
  fetchSongState: vi.fn(),
  requestSongDownload: vi.fn(),
  patchSongMeta: vi.fn(),
  sendPlays: vi.fn().mockResolvedValue(200),
}));

class FakePlayer {
  static instances: FakePlayer[] = [];
  loadVideoById = vi.fn();
  cueVideoById = vi.fn();
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  stopVideo = vi.fn();
  seekTo = vi.fn();
  destroy = vi.fn();
  getCurrentTime = () => 0;
  getDuration = () => 180;
  getPlayerState = () => -1;
  constructor(_el: HTMLElement, opts: YtPlayerOptions) {
    FakePlayer.instances.push(this);
    queueMicrotask(() => opts.events?.onReady?.({ target: this as unknown as YtPlayer }));
  }
}

const song = (key: string, extra: Partial<AggregatedSong> = {}): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, ...extra };
};
const ON_MS = song('a::on ms', { fs: false, mediaServer: true, inLibrary: true });
const ON_FS = song('b::on fs', { fs: true, mediaServer: false, inLibrary: true });
const ON_BOTH = song('c::on both', { fs: true, mediaServer: true, inLibrary: true });
const NOWHERE = song('d::nowhere', { fs: false, mediaServer: false, inLibrary: false });
const LIST = [ON_MS, ON_FS, ON_BOTH, NOWHERE];
const IDX = { ms: 0, fs: 1, both: 2, nowhere: 3 };

function Harness() {
  const p = usePlayer();
  return (
    <div>
      {LIST.map((s, i) => (
        <button key={s.songKey} onClick={() => p.playSong(s.songKey, LIST, 'queue')}>{`play${i}`}</button>
      ))}
      <button onClick={() => p.setSourceMode('auto')}>mode-auto</button>
      <button onClick={() => p.setSourceMode('internet')}>mode-internet</button>
      <button onClick={() => p.setSourceMode('media')}>mode-media</button>
      <button onClick={p.next}>next</button>
      <output data-testid="mode">{p.sourceMode}</output>
      <output data-testid="net">{p.networkStatus}</output>
      <output data-testid="choice">{p.sourceChoice}</output>
      <output data-testid="from">{p.playingFrom ?? 'none'}</output>
      <output data-testid="box">{p.mediaBox}</output>
      <output data-testid="pending">{String(p.sourceChangePending)}</output>
      <output data-testid="states">{JSON.stringify(p.downloadStates)}</output>
    </div>
  );
}

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const out = (id: string) => screen.getByTestId(id).textContent;
const stateOf = (state: SongStateResponse['state'], extra: Partial<SongStateResponse> = {}): SongStateResponse =>
  ({ state, source: null, version: null, bytes: null, error: null, inLibrary: state === 'ready', ...extra });
const ytLoads = (): string[] => FakePlayer.instances.flatMap((p) => p.loadVideoById.mock.calls.map((c) => String(c[0])));

let played: string[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakePlayer.instances = [];
  played = [];
  sessionStorage.clear();
  localStorage.clear();
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer, PlayerState: {} };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.mocked(api.fetchNetwork).mockResolvedValue('internal');
  vi.mocked(api.fetchSongYoutube).mockResolvedValue({ videoId: 'vid1', watchUrl: '', source: 'yt_search' });
  vi.mocked(api.requestSongDownload).mockResolvedValue({ ok: true, state: 'preparing' });
  vi.mocked(api.fetchSongState).mockResolvedValue(stateOf('missing'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

function mount() {
  return render(
    <PlayerProvider>
      <Harness />
    </PlayerProvider>,
  );
}

async function play(index: number) {
  fireEvent.click(screen.getByText(`play${index}`));
  await flush();
}

async function withNetwork(network: NetworkKind | 'fails', mode: SourceMode | null = null) {
  if (network === 'fails') vi.mocked(api.fetchNetwork).mockRejectedValue(new Error('HTTP 500'));
  else vi.mocked(api.fetchNetwork).mockResolvedValue(network);
  if (mode) localStorage.setItem(SOURCE_MODE_STORAGE_KEY, mode);
  mount();
  await flush();
}

describe('Auto follows the network', () => {
  it('home network → the media server: the file through the backend, the cover, badge "media-server"', async () => {
    await withNetwork('internal');
    expect(out('mode')).toBe('auto');
    expect(out('net')).toBe('internal');
    expect(out('choice')).toBe('media');
    await play(IDX.ms);
    expect(played).toEqual([expect.stringContaining(`/api/songs/${encodeURIComponent('a::on ms')}/file`)]);
    expect(played[0]).not.toContain('from='); // the backend picks the Fritz first, then the disk
    expect(ytLoads()).toEqual([]);
    expect(api.fetchSongYoutube).not.toHaveBeenCalled();
    expect(out('from')).toBe('media-server');
    expect(out('box')).toBe('cover');
    expect(api.fetchSongState).not.toHaveBeenCalled(); // the list already said it is at home
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });

  it('from the internet → Internet: YouTube and the video, even for a song that is on the media server', async () => {
    await withNetwork('external');
    expect(out('choice')).toBe('internet');
    await play(IDX.ms);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
    expect(api.requestSongDownload).not.toHaveBeenCalled(); // it is at home: nothing to download
  });

  it('GET /api/net failing counts as the internet', async () => {
    await withNetwork('fails');
    expect(out('net')).toBe('failed');
    expect(out('choice')).toBe('internet');
    await play(IDX.ms);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
  });

  it('asks the network once per page load, and again for a new page load (Auto is re-evaluated)', async () => {
    const first = mount();
    await flush();
    await play(IDX.ms);
    await play(IDX.both);
    await play(IDX.ms);
    expect(api.fetchNetwork).toHaveBeenCalledTimes(1);
    first.unmount();
    mount();
    await flush();
    expect(api.fetchNetwork).toHaveBeenCalledTimes(2);
  });

  it('the very first play waits for a slow /api/net answer instead of guessing the internet', async () => {
    let answer: (n: NetworkKind) => void = () => undefined;
    vi.mocked(api.fetchNetwork).mockReturnValue(new Promise<NetworkKind>((resolve) => { answer = resolve; }));
    mount();
    await flush();
    expect(out('net')).toBe('pending');
    fireEvent.click(screen.getByText(`play${IDX.ms}`));
    await flush(400);
    expect(played).toEqual([]); // still waiting for the network
    expect(ytLoads()).toEqual([]);
    answer('internal');
    await flush();
    expect(played).toHaveLength(1);
    expect(out('from')).toBe('media-server');
  });

  it('an answer that never comes is the internet after 1.5 s', async () => {
    vi.mocked(api.fetchNetwork).mockReturnValue(new Promise<NetworkKind>(() => undefined));
    mount();
    await flush();
    fireEvent.click(screen.getByText(`play${IDX.ms}`));
    await flush(1000);
    expect(ytLoads()).toEqual([]);
    await flush(600);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
  });
});

describe('a manual choice wins over the network', () => {
  it('Media server from the internet: the home file (also from outside, through the backend)', async () => {
    await withNetwork('external', 'media');
    expect(out('mode')).toBe('media');
    expect(out('choice')).toBe('media');
    await play(IDX.ms);
    expect(played).toHaveLength(1);
    expect(ytLoads()).toEqual([]);
    expect(out('from')).toBe('media-server');
    expect(out('box')).toBe('cover');
  });

  it('Internet on the home network: YouTube, even for a song that is on both FS and MS', async () => {
    await withNetwork('internal', 'internet');
    await play(IDX.both);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
  });

  it('Media server: on both FS and MS the media server is said to be the source; on FS only, the disk', async () => {
    await withNetwork('external', 'media');
    await play(IDX.both);
    expect(out('from')).toBe('media-server');
    await play(IDX.fs);
    expect(out('from')).toBe('disk');
    expect(out('box')).toBe('cover');
  });
});

describe('the parallel download does not depend on the switch (W1, S6)', () => {
  it.each<[string, NetworkKind, SourceMode]>([
    ['Auto at home', 'internal', 'auto'],
    ['Auto from the internet', 'external', 'auto'],
    ['Internet', 'internal', 'internet'],
    ['Media server', 'external', 'media'],
  ])('%s: a song on neither FS nor MS plays from YouTube and the server is asked to fetch it, once', async (_label, network, mode) => {
    await withNetwork(network, mode);
    await play(IDX.nowhere);
    expect(ytLoads()).toEqual(['vid1']);
    expect(played).toEqual([]);
    expect(api.fetchSongState).toHaveBeenCalledWith('d::nowhere'); // the check: positively "no file"
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
    expect(api.requestSongDownload).toHaveBeenCalledWith('d::nowhere', 'play');
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
    await play(IDX.nowhere);
    await play(IDX.nowhere);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
  });

  it.each<[NetworkKind, SourceMode]>([['internal', 'auto'], ['external', 'auto'], ['internal', 'internet'], ['external', 'media']])(
    'a song at home is never downloaded (%s, %s)',
    async (network, mode) => {
      await withNetwork(network, mode);
      for (const index of [IDX.ms, IDX.fs, IDX.both]) await play(index);
      expect(api.requestSongDownload).not.toHaveBeenCalled();
    },
  );

  it('the server not being able to say whether there is a file: the video plays, nothing is downloaded', async () => {
    vi.mocked(api.fetchSongState).mockRejectedValue(new Error('HTTP 500'));
    await withNetwork('internal', 'media');
    await play(IDX.nowhere);
    expect(ytLoads()).toEqual(['vid1']);
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });

  it('the list says "nowhere" but the server knows better (a download finished meanwhile): it plays the file', async () => {
    vi.mocked(api.fetchSongState).mockResolvedValue(stateOf('ready', { location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/d - nowhere.mp3', mediaUrl: null, streamUrl: null } }));
    await withNetwork('internal', 'media');
    await play(IDX.nowhere);
    expect(played).toHaveLength(1);
    expect(out('from')).toBe('disk');
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });
});

describe('after the first-play download (W1)', () => {
  const READY = stateOf('ready', { location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/d - nowhere.mp3', mediaUrl: null, streamUrl: null } });

  async function playUntilDownloaded(mode: SourceMode) {
    vi.mocked(api.fetchSongState)
      .mockResolvedValueOnce(stateOf('missing')) // the check before the play
      .mockResolvedValue(READY); // every poll afterwards
    await withNetwork('internal', mode);
    await play(IDX.nowhere);
    expect(out('from')).toBe('youtube');
    await flush(5000);
    expect(JSON.parse(out('states') ?? '{}')['d::nowhere'].phase).toBe('ready');
  }

  it('the song in progress keeps playing from the video: neither the box nor the badge switch', async () => {
    await playUntilDownloaded('media');
    expect(out('box')).toBe('video');
    expect(out('from')).toBe('youtube');
    expect(played).toEqual([]);
    expect(FakePlayer.instances.flatMap((p) => p.pauseVideo.mock.calls)).toHaveLength(0);
  });

  it('Media server: the NEXT play comes from geekom’s disk (not yet on the Fritz), the box shows the cover', async () => {
    await playUntilDownloaded('media');
    await play(IDX.nowhere);
    expect(played).toHaveLength(1);
    expect(played[0]).toContain(`/api/songs/${encodeURIComponent('d::nowhere')}/file`);
    expect(out('from')).toBe('disk');
    expect(out('box')).toBe('cover');
  });

  it('Internet: the next play is still YouTube, because that is what the switch says', async () => {
    await playUntilDownloaded('internet');
    await play(IDX.nowhere);
    expect(played).toEqual([]);
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
  });
});

describe('the picture box and the badge follow the song that is really playing', () => {
  it('cover for the home file → video for the YouTube fallback → cover again', async () => {
    await withNetwork('internal');
    await play(IDX.ms);
    expect([out('from'), out('box')]).toEqual(['media-server', 'cover']);
    await play(IDX.nowhere);
    expect([out('from'), out('box')]).toEqual(['youtube', 'video']);
    await play(IDX.fs);
    expect([out('from'), out('box')]).toEqual(['disk', 'cover']);
  });

  it('a home file that cannot play falls through to YouTube: video and "youtube"', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new Error('NotSupportedError')));
    await withNetwork('internal');
    await play(IDX.ms);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
  });

  it('no video found for the song: back to the cover and no badge', async () => {
    vi.mocked(api.fetchSongYoutube).mockRejectedValue(new Error('HTTP 404'));
    await withNetwork('external');
    await play(IDX.ms);
    expect(out('box')).toBe('cover');
    expect(out('from')).toBe('none');
  });
});

describe('changing the switch', () => {
  it('is remembered by this browser and restored on the next visit', async () => {
    const first = mount();
    await flush();
    expect(out('mode')).toBe('auto');
    fireEvent.click(screen.getByText('mode-internet'));
    expect(out('mode')).toBe('internet');
    expect(localStorage.getItem(SOURCE_MODE_STORAGE_KEY)).toBe('internet');
    first.unmount();
    mount();
    await flush();
    expect(out('mode')).toBe('internet');
    fireEvent.click(screen.getByText('mode-auto'));
    expect(localStorage.getItem(SOURCE_MODE_STORAGE_KEY)).toBe('auto');
  });

  it('works when localStorage throws (private window): the choice just does not last', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    mount();
    await flush();
    expect(out('mode')).toBe('auto');
    fireEvent.click(screen.getByText('mode-media'));
    expect(out('mode')).toBe('media');
  });

  it('never interrupts the song in progress: it applies from the next song, and says so', async () => {
    await withNetwork('internal');
    await play(IDX.ms);
    expect(played).toHaveLength(1);
    expect(out('pending')).toBe('false');

    fireEvent.click(screen.getByText('mode-internet'));
    await flush();
    expect(played).toHaveLength(1); // no reload
    expect(ytLoads()).toEqual([]);
    expect(out('from')).toBe('media-server'); // the badge still tells the truth
    expect(out('box')).toBe('cover');
    expect(out('pending')).toBe('true');

    fireEvent.click(screen.getByText('next')); // ON_FS is next in the queue
    await flush();
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('pending')).toBe('false');
  });

  it('a fallback is not a pending change: Media server for a song that is nowhere plays YouTube without a hint', async () => {
    await withNetwork('internal', 'media');
    await play(IDX.nowhere);
    expect(out('from')).toBe('youtube');
    expect(out('choice')).toBe('media');
    expect(out('pending')).toBe('false');
  });
});
