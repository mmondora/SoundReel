import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer } from './PlayerContext';
import * as api from '../services/api';
import type { YtPlayer, YtPlayerOptions } from './youtubeApi';
import type { AggregatedSong, SongStateResponse } from '../types';

// First play of the web player: a song without a server-side MP3 starts on the YouTube fallback AT ONCE, the
// server is asked to download it in parallel (priority "play"), and the NEXT play uses the file.

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
const ONE = song('a::one');
const TWO = song('b::two', { inLibrary: true });

function Harness({ list }: { list: AggregatedSong[] }) {
  const p = usePlayer();
  return (
    <div>
      {list.map((s, i) => (
        <button key={s.songKey} onClick={() => p.playSong(s.songKey, list, 'queue')}>{`play${i}`}</button>
      ))}
      <output data-testid="states">{JSON.stringify(p.downloadStates)}</output>
      <output data-testid="current">{p.currentDownload?.phase ?? 'none'}</output>
      <output data-testid="queue-local">{p.queue.map((s) => `${s.songKey}:${s.inLibrary === true}`).join(',')}</output>
    </div>
  );
}

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const stateOf = (state: SongStateResponse['state']): SongStateResponse => ({ state, source: null, version: null, bytes: null, error: null, inLibrary: state === 'ready' });
const phaseOf = (key: string): string | undefined =>
  (JSON.parse(screen.getByTestId('states').textContent ?? '{}') as Record<string, { phase: string }>)[key]?.phase;

let played: string[] = [];
const lastPlayer = (): FakePlayer | undefined => FakePlayer.instances[FakePlayer.instances.length - 1];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakePlayer.instances = [];
  played = [];
  sessionStorage.clear();
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer, PlayerState: {} };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.mocked(api.fetchSongYoutube).mockResolvedValue({ videoId: 'vid1', watchUrl: '', source: 'yt_search' });
  vi.mocked(api.fetchNetwork).mockResolvedValue('internal');
  vi.mocked(api.requestSongDownload).mockResolvedValue({ ok: true, state: 'preparing' });
  vi.mocked(api.fetchSongState).mockResolvedValue(stateOf('preparing'));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

function mount(list: AggregatedSong[] = [ONE, TWO]) {
  render(
    <PlayerProvider>
      <Harness list={list} />
    </PlayerProvider>,
  );
}

describe('first play of a song without a file', () => {
  it('plays through YouTube and asks the server to download it in parallel (priority play)', async () => {
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();

    // the server is asked, fresh, whether the song is on FS or on the media server
    expect(api.fetchSongState).toHaveBeenCalledWith('a::one');
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
    expect(api.requestSongDownload).toHaveBeenCalledWith('a::one', 'play');
    expect(lastPlayer()?.loadVideoById).toHaveBeenCalledWith('vid1');
    expect(played).toEqual([]); // no local file yet
    expect(phaseOf('a::one')).toBe('downloading');
    expect(screen.getByTestId('current')).toHaveTextContent('downloading');
  });

  it('never makes the playback wait for the download request', async () => {
    vi.mocked(api.requestSongDownload).mockReturnValue(new Promise(() => { /* never answers */ }));
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(lastPlayer()?.loadVideoById).toHaveBeenCalledWith('vid1');
    expect(phaseOf('a::one')).toBe('requesting');
  });

  it('asks once per song per session, however often it is played', async () => {
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
  });

  it('polls the state every ~5 s; when the file is ready the NEXT play uses it, and the current one is not interrupted', async () => {
    vi.mocked(api.fetchSongState)
      .mockResolvedValueOnce(stateOf('missing')) // the check before the first play: no file anywhere
      .mockResolvedValueOnce(stateOf('preparing'))
      .mockResolvedValue(stateOf('ready'));
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(api.fetchSongState).toHaveBeenCalledTimes(1); // only the check; polling starts 5 s later

    await flush(5000);
    expect(api.fetchSongState).toHaveBeenCalledTimes(2);
    expect(phaseOf('a::one')).toBe('downloading');
    await flush(5000);
    expect(api.fetchSongState).toHaveBeenCalledTimes(3);
    expect(phaseOf('a::one')).toBe('ready');
    expect(screen.getByTestId('queue-local')).toHaveTextContent('a::one:true');

    // the running YouTube playback was left alone
    const yt = FakePlayer.instances.flatMap((p) => [...p.loadVideoById.mock.calls]);
    expect(yt).toHaveLength(1);
    expect(FakePlayer.instances.flatMap((p) => p.pauseVideo.mock.calls)).toHaveLength(0);
    expect(played).toEqual([]);

    // next play: straight from the file, no state round trip, no second download request
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(api.fetchSongState).toHaveBeenCalledTimes(3);
    expect(played).toHaveLength(1);
    expect(played[0]).toContain(`/api/songs/${encodeURIComponent('a::one')}/file`);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);

    // polling stopped for good
    await flush(60_000);
    expect(api.fetchSongState).toHaveBeenCalledTimes(3);
  });

  it('a failed download request is shown, playback still goes on, and the next play may try again', async () => {
    vi.mocked(api.requestSongDownload).mockRejectedValueOnce(new Error('{"error":"unauthorized"}'));
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(phaseOf('a::one')).toBe('failed');
    expect(lastPlayer()?.loadVideoById).toHaveBeenCalledWith('vid1');

    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(api.requestSongDownload).toHaveBeenCalledTimes(2);
    expect(phaseOf('a::one')).toBe('downloading');
  });

  it('no_source from the server is reported as unavailable (and not polled forever)', async () => {
    vi.mocked(api.requestSongDownload).mockResolvedValue({ ok: true, state: 'no_source' });
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(phaseOf('a::one')).toBe('unavailable');
    await flush(30_000);
    expect(api.fetchSongState).toHaveBeenCalledTimes(1); // only the check before the play: nothing is polled
  });

  it('when the server cannot even say whether there is a file, nothing is downloaded', async () => {
    vi.mocked(api.fetchSongState).mockRejectedValue(new Error('HTTP 500'));
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(api.requestSongDownload).not.toHaveBeenCalled();
    expect(lastPlayer()?.loadVideoById).toHaveBeenCalledWith('vid1');
  });
});

describe('a song that already has its file', () => {
  it('plays from the file: no YouTube, no download request, no state call', async () => {
    mount();
    fireEvent.click(screen.getByText('play1'));
    await flush();
    expect(played).toHaveLength(1);
    expect(played[0]).toContain(`/api/songs/${encodeURIComponent('b::two')}/file`);
    expect(api.fetchSongState).not.toHaveBeenCalled();
    expect(api.fetchSongYoutube).not.toHaveBeenCalled();
    expect(api.requestSongDownload).not.toHaveBeenCalled();
    expect(screen.getByTestId('current')).toHaveTextContent('none');
  });

  it('a file the server reports through the song state (location) is played as well, without a download', async () => {
    vi.mocked(api.fetchSongState).mockResolvedValue({
      ...stateOf('ready'),
      location: { fs: false, mediaServer: true, fsPath: null, mediaUrl: 'http://fritz/Music/x.mp3', streamUrl: null },
    });
    mount();
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(played).toHaveLength(1);
    expect(api.requestSongDownload).not.toHaveBeenCalled();
    expect(api.fetchSongYoutube).not.toHaveBeenCalled();
  });
});
