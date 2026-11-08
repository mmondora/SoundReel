import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer } from './PlayerContext';
import { PLAY_QUEUE_KEY } from './playEventQueue';
import * as api from '../services/api';
import type { YtPlayer, YtPlayerOptions } from './youtubeApi';
import type { AggregatedSong, PlayEvent } from '../types';

// Listening events of the web player (docs/mondrop-stats.md §1): real time listened, one event per session of at
// least 3 s, offline-safe outbox, a failure never touches the playback.

vi.mock('../services/api', () => ({
  fetchNetwork: vi.fn(),
  fetchSongYoutube: vi.fn(),
  fetchSongState: vi.fn(),
  requestSongDownload: vi.fn(),
  patchSongMeta: vi.fn(),
  sendPlays: vi.fn(),
}));

class FakePlayer {
  static instances: FakePlayer[] = [];
  events: YtPlayerOptions['events'];
  loadVideoById = vi.fn();
  cueVideoById = vi.fn();
  playVideo = vi.fn();
  pauseVideo = vi.fn();
  stopVideo = vi.fn();
  seekTo = vi.fn();
  destroy = vi.fn();
  getCurrentTime = () => 0;
  getDuration = () => 231;
  getPlayerState = () => -1;
  constructor(_el: HTMLElement, opts: YtPlayerOptions) {
    this.events = opts.events;
    FakePlayer.instances.push(this);
    queueMicrotask(() => opts.events?.onReady?.({ target: this as unknown as YtPlayer }));
  }
  /** What the IFrame API would report. */
  state(data: number) {
    this.events?.onStateChange?.({ data, target: this as unknown as YtPlayer });
  }
}
const YT = { PLAYING: 1, PAUSED: 2, BUFFERING: 3, ENDED: 0 };

const song = (key: string, extra: Partial<AggregatedSong> = {}): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, ...extra };
};
const LOCAL_A = song('a::one', { inLibrary: true });
const LOCAL_B = song('b::two', { inLibrary: true });
const REMOTE = song('c::three');

function Harness({ list }: { list: AggregatedSong[] }) {
  const p = usePlayer();
  return (
    <div>
      {list.map((s, i) => (
        <button key={s.songKey} onClick={() => p.playSong(s.songKey, list, 'queue', 'pl-1')}>{`play${i}`}</button>
      ))}
      <button onClick={() => p.playSong(list[0].songKey, list, 'queue', null)}>playNoPlaylist</button>
      <button onClick={() => p.playSong(list[1].songKey, list, 'queue')}>keepPlaylist</button>
      <output data-testid="error">{p.error ?? 'none'}</output>
    </div>
  );
}

let audios: HTMLAudioElement[] = [];
const audio = (): HTMLAudioElement => audios[audios.length - 1];
const fire = (el: EventTarget, name: string) => act(() => { el.dispatchEvent(new Event(name)); });
const tick = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const lastPlayer = (): FakePlayer => FakePlayer.instances[FakePlayer.instances.length - 1];
const sentEvents = (): PlayEvent[] => vi.mocked(api.sendPlays).mock.calls.flatMap(([events]) => events);
const pagehide = () => act(async () => { window.dispatchEvent(new Event('pagehide')); await vi.advanceTimersByTimeAsync(0); });
const stored = (): PlayEvent[] => JSON.parse(localStorage.getItem(PLAY_QUEUE_KEY) ?? '[]') as PlayEvent[];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-08T06:00:00.000Z'));
  vi.clearAllMocks();
  FakePlayer.instances = [];
  audios = [];
  localStorage.clear();
  sessionStorage.clear();
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer, PlayerState: {} };
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    if (!audios.includes(this as HTMLAudioElement)) audios.push(this as HTMLAudioElement);
    return Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  vi.mocked(api.fetchSongYoutube).mockResolvedValue({ videoId: 'vid1', watchUrl: '', source: 'yt_search' });
  vi.mocked(api.fetchNetwork).mockResolvedValue('internal'); // Auto → the file at home, like these tests expect
  vi.mocked(api.requestSongDownload).mockResolvedValue({ ok: true, state: 'preparing' });
  vi.mocked(api.fetchSongState).mockResolvedValue({ state: 'preparing', source: null, version: null, bytes: null, error: null, inLibrary: false });
  vi.mocked(api.sendPlays).mockResolvedValue(200);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

function mount(list: AggregatedSong[] = [LOCAL_A, LOCAL_B, REMOTE]) {
  render(
    <PlayerProvider>
      <Harness list={list} />
    </PlayerProvider>,
  );
}

async function playLocal(index: number, seconds: number) {
  fireEvent.click(screen.getByText(`play${index}`));
  await tick();
  fire(audio(), 'playing');
  await tick(seconds * 1000);
}

describe('local file: only the time really listened counts', () => {
  it('pauses and seeks add nothing; the song end produces ONE event with the §1 fields', async () => {
    mount();
    fireEvent.click(screen.getByText('play0'));
    await tick();
    Object.defineProperty(audio(), 'duration', { value: 231, configurable: true });
    fire(audio(), 'loadedmetadata');
    const startedAt = Date.now();
    fire(audio(), 'playing');
    await tick(10_000);
    fire(audio(), 'pause');
    await tick(20_000); // paused for 20 s
    fire(audio(), 'playing');
    await tick(5_000);
    fire(audio(), 'seeking'); // a seek changes nothing…
    fire(audio(), 'seeked');
    await tick(2_000);
    fire(audio(), 'ended');
    await pagehide();

    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      songKey: 'a::one',
      startedAt: new Date(startedAt).toISOString(),
      tzOffsetMin: -new Date(startedAt).getTimezoneOffset(),
      listenedMs: 17_000,
      durationMs: 231_000,
      completed: true,
      origin: 'web',
      playlistId: 'pl-1',
    });
    expect(vi.mocked(api.sendPlays).mock.calls[0][1]).toEqual({ keepalive: true });
  });

  it('buffering ("waiting") stops the clock too', async () => {
    mount();
    await playLocal(0, 6);
    fire(audio(), 'waiting');
    await tick(15_000);
    fire(audio(), 'playing');
    await tick(4_000);
    fire(audio(), 'ended');
    await pagehide();
    expect(sentEvents()[0].listenedMs).toBe(10_000);
  });

  it('a session shorter than 3 s produces no event', async () => {
    mount();
    await playLocal(0, 2.9);
    fire(audio(), 'ended');
    await pagehide();
    expect(api.sendPlays).not.toHaveBeenCalled();
    expect(stored()).toEqual([]);
  });

  it('exactly 3 s does', async () => {
    mount();
    await playLocal(0, 3);
    fire(audio(), 'ended');
    await pagehide();
    expect(sentEvents()).toHaveLength(1);
  });

  it('the tz offset has the right sign: minutes EAST of UTC', async () => {
    vi.spyOn(Date.prototype, 'getTimezoneOffset').mockReturnValue(-120); // UTC+2 (summer, Italy)
    mount();
    await playLocal(0, 5);
    fire(audio(), 'ended');
    await pagehide();
    expect(sentEvents()[0].tzOffsetMin).toBe(120);
  });

  it('the playlist id comes from playSong (and is null when the queue has none)', async () => {
    mount();
    fireEvent.click(screen.getByText('playNoPlaylist'));
    await tick();
    fire(audio(), 'playing');
    await tick(5_000);
    fire(audio(), 'ended');
    await pagehide();
    expect(sentEvents()[0].playlistId).toBeNull();
  });

  it('switching song ends the previous session; each song gets its own event with a fresh id', async () => {
    mount();
    await playLocal(0, 5);
    fireEvent.click(screen.getByText('play1')); // jumps to the next song while the first is still playing
    await tick();
    fire(audio(), 'playing');
    await tick(4_000);
    await pagehide();
    const events = sentEvents();
    expect(events.map((e) => [e.songKey, e.listenedMs, e.completed])).toEqual([['a::one', 5_000, false], ['b::two', 4_000, false]]);
    expect(events[0].id).not.toBe(events[1].id);
  });
});

describe('YouTube fallback: best effort from the IFrame API state changes', () => {
  it('counts only the PLAYING stretches (pause and buffering excluded) and the end completes the song', async () => {
    mount();
    fireEvent.click(screen.getByText('play2'));
    await tick();
    expect(lastPlayer().loadVideoById).toHaveBeenCalledWith('vid1');
    const startedAt = Date.now();
    act(() => lastPlayer().state(YT.PLAYING));
    await tick(6_000);
    act(() => lastPlayer().state(YT.PAUSED));
    await tick(30_000);
    act(() => lastPlayer().state(YT.BUFFERING));
    await tick(8_000);
    act(() => lastPlayer().state(YT.PLAYING));
    await tick(3_000);
    act(() => lastPlayer().state(YT.ENDED));
    await pagehide();

    expect(sentEvents()).toEqual([
      expect.objectContaining({
        songKey: 'c::three', listenedMs: 9_000, completed: true, origin: 'web', playlistId: 'pl-1',
        durationMs: 231_000, startedAt: new Date(startedAt).toISOString(),
      }),
    ]);
  });
});

describe('the outbox', () => {
  it('flushes at 20 events without waiting for the page to close', async () => {
    mount();
    // 21 plays alternating between two local songs: each switch ends one 4 s session.
    for (let i = 0; i < 21; i += 1) {
      await playLocal(i % 2, 4);
    }
    await tick();
    expect(vi.mocked(api.sendPlays).mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(vi.mocked(api.sendPlays).mock.calls[0][0]).toHaveLength(20);
    expect(vi.mocked(api.sendPlays).mock.calls[0][1]).toEqual({ keepalive: false });
  });

  it('events are in localStorage at once and leave it only after a 200', async () => {
    vi.mocked(api.sendPlays).mockResolvedValueOnce(500);
    mount();
    await playLocal(0, 5);
    fire(audio(), 'ended');
    expect(stored()).toHaveLength(1); // persisted before any network attempt
    await pagehide();
    expect(api.sendPlays).toHaveBeenCalledTimes(1);
    expect(stored()).toHaveLength(1); // the server said 500: kept

    await pagehide(); // the next opportunity (keepalive ignores the backoff) — now the server answers 200
    expect(api.sendPlays).toHaveBeenCalledTimes(2);
    expect(stored()).toEqual([]);
  });

  it('a network failure never reaches the playback', async () => {
    vi.mocked(api.sendPlays).mockRejectedValue(new TypeError('Failed to fetch'));
    mount();
    await playLocal(0, 5);
    fire(audio(), 'ended');
    await pagehide();
    expect(screen.getByTestId('error')).toHaveTextContent('none');
    expect(stored()).toHaveLength(1);
    // and playback of the next song still works
    fireEvent.click(screen.getByText('play1'));
    await tick();
    expect(audios.length).toBeGreaterThan(0);
    expect(screen.getByTestId('error')).toHaveTextContent('none');
  });

  it('what a previous session left behind is sent at start-up', async () => {
    const leftover: PlayEvent = {
      id: 'old-1', songKey: 'x::y', startedAt: '2026-11-07T20:00:00.000Z', tzOffsetMin: 60, listenedMs: 40_000,
      durationMs: null, completed: false, origin: 'web', playlistId: null,
    };
    localStorage.setItem(PLAY_QUEUE_KEY, JSON.stringify([leftover]));
    mount();
    await tick();
    expect(sentEvents()).toEqual([leftover]);
    expect(stored()).toEqual([]);
  });

  it('every 5 minutes it tries again', async () => {
    mount();
    await playLocal(0, 5);
    fire(audio(), 'ended');
    expect(api.sendPlays).not.toHaveBeenCalled();
    await tick(5 * 60_000);
    expect(sentEvents()).toHaveLength(1);
  });

  it('a hidden tab sends what is finished (keepalive) but does not cut the song that keeps playing', async () => {
    mount();
    await playLocal(0, 5);
    fireEvent.click(screen.getByText('play1')); // first song's session ends → 1 event queued
    await tick();
    fire(audio(), 'playing');
    await tick(4_000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); await vi.advanceTimersByTimeAsync(0); });
    expect(sentEvents().map((e) => e.songKey)).toEqual(['a::one']);
    expect(vi.mocked(api.sendPlays).mock.calls[0][1]).toEqual({ keepalive: true });

    // the second song kept playing in the background: its session is still open and ends normally
    await tick(6_000);
    fire(audio(), 'ended');
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    await pagehide();
    expect(sentEvents().map((e) => [e.songKey, e.listenedMs])).toEqual([['a::one', 5_000], ['b::two', 10_000]]);
  });
});
