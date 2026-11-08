import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { LOADING_MAX_MS, PlayerProvider, usePlayer } from './PlayerContext';
import { SOURCE_MODE_STORAGE_KEY } from './playbackSource';
import type { SourceMode } from './playbackSource';
import * as api from '../services/api';
import { absoluteUrl, fileUrlOf, servePlans } from '../test/playPlans';
import type { FileAt } from '../test/playPlans';
import type { YtPlayer, YtPlayerOptions } from './youtubeApi';
import type { AggregatedSong, NetworkKind } from '../types';

// Speed of play start (spec 2026-11-08-player-selection-and-filters-design §2, X6): the play plan and the video id of the
// NEXT song are asked for ahead of time (once per song; the video id only when the plan says the video), "Sto caricando…"
// lasts until the song really plays, and a song the plan sends to a file starts without the IFrame — no player, no video lookup.

vi.mock('../services/api', () => ({
  fetchPlayPlan: vi.fn(),
  fetchSongYoutube: vi.fn(),
  fetchSongState: vi.fn(),
  requestSongDownload: vi.fn(),
  patchSongMeta: vi.fn(),
  sendPlays: vi.fn().mockResolvedValue(200),
}));

const YT = { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 };

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
  getDuration = () => 200;
  getPlayerState = () => -1;
  constructor(_el: HTMLElement, opts: YtPlayerOptions) {
    this.events = opts.events;
    FakePlayer.instances.push(this);
    queueMicrotask(() => opts.events?.onReady?.({ target: this as unknown as YtPlayer }));
  }
  state(data: number) {
    this.events?.onStateChange?.({ data, target: this as unknown as YtPlayer });
  }
  error(code: number) {
    this.events?.onError?.({ data: code, target: this as unknown as YtPlayer });
  }
}

const song = (key: string, extra: Partial<AggregatedSong> = {}): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, ...extra };
};
const A = song('a::one');
const B = song('b::two');
const C = song('c::three');
const HOME1 = song('h::home one', { fs: false, mediaServer: true, inLibrary: true });
const HOME2 = song('h::home two', { fs: false, mediaServer: true, inLibrary: true });
/** Where the files really are for the fake server: the two home songs, on the media server. */
const HOME_FILES: Record<string, FileAt> = { [HOME1.songKey]: 'media-server', [HOME2.songKey]: 'media-server' };

let list: AggregatedSong[] = [];

function Harness() {
  const p = usePlayer();
  return (
    <div>
      {list.map((s, i) => (
        <button key={s.songKey} onClick={() => p.playSong(s.songKey, list, 'queue')}>{`play${i}`}</button>
      ))}
      <button onClick={() => void p.patchCurrent({ favorite: true })}>patch</button>
      <button onClick={p.cycleRepeatMode}>repeat</button>
      <button onClick={p.next}>next</button>
      <button onClick={() => p.setYoutubeMount(document.createElement('div'))}>remount</button>
      <button onClick={() => p.setSourceMode('media')}>mode-media</button>
      <output data-testid="loading">{String(p.loading)}</output>
      <output data-testid="playing">{String(p.playing)}</output>
      <output data-testid="from">{p.playingFrom ?? 'none'}</output>
      <output data-testid="repeat">{p.repeat}</output>
    </div>
  );
}

const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const out = (id: string) => screen.getByTestId(id).textContent;
const ytLookups = (): string[] => vi.mocked(api.fetchSongYoutube).mock.calls.map((c) => c[0]);
const planCalls = () => vi.mocked(api.fetchPlayPlan).mock.calls;
const lastPlayer = (): FakePlayer => FakePlayer.instances[FakePlayer.instances.length - 1];
const ytEvent = (data: number) => act(() => { lastPlayer().state(data); });

let played: string[] = [];
let audioPlay: (() => Promise<void>) | null = null;
const audios: HTMLAudioElement[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  FakePlayer.instances = [];
  played = [];
  audioPlay = null;
  audios.length = 0;
  list = [A, B, C];
  sessionStorage.clear();
  localStorage.clear();
  (window as unknown as { YT: unknown }).YT = { Player: FakePlayer, PlayerState: {} };
  // a browser whose default is "metadata": the player must ask for more by itself
  const preloads = new WeakMap<HTMLMediaElement, string>();
  Object.defineProperty(HTMLMediaElement.prototype, 'preload', {
    configurable: true,
    get(this: HTMLMediaElement) { return preloads.get(this) ?? 'metadata'; },
    set(this: HTMLMediaElement, value: string) { preloads.set(this, value); },
  });
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
    played.push(this.src);
    audios.push(this);
    return audioPlay ? audioPlay() : Promise.resolve();
  });
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => undefined);
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => undefined);
  servePlans('internal', HOME_FILES);
  vi.mocked(api.fetchSongYoutube).mockImplementation(async (key) => ({ videoId: `vid-${key}`, watchUrl: '', source: 'yt_search' }));
  vi.mocked(api.requestSongDownload).mockResolvedValue({ ok: true, state: 'preparing' });
  vi.mocked(api.fetchSongState).mockResolvedValue({ state: 'missing', source: null, version: null, bytes: null, error: null, inLibrary: false });
  vi.mocked(api.patchSongMeta).mockResolvedValue({} as Awaited<ReturnType<typeof api.patchSongMeta>>);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as { YT?: unknown }).YT;
});

async function mount(mode: SourceMode = 'internet', network: NetworkKind = 'external', files: Record<string, FileAt> = HOME_FILES) {
  localStorage.setItem(SOURCE_MODE_STORAGE_KEY, mode);
  servePlans(network, files);
  render(
    <PlayerProvider>
      <Harness />
    </PlayerProvider>,
  );
  await flush();
}

async function play(index: number) {
  fireEvent.click(screen.getByText(`play${index}`));
  await flush();
}

describe('the next video id is asked for ahead of time', () => {
  it('not before the song plays; then ONCE, however often the queue or the state changes', async () => {
    await mount();
    await play(0);
    expect(ytLookups()).toEqual(['a::one']); // the song itself
    await flush(2000);
    expect(ytLookups()).toEqual(['a::one']); // still loading: nothing ahead of time yet

    expect(planCalls()).toEqual([['a::one', 'internet']]); // the plan of the song itself

    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one', 'b::two']);
    expect(planCalls()).toEqual([['a::one', 'internet'], ['b::two', 'internet']]); // and the plan of the next one, with the preference

    fireEvent.click(screen.getByText('patch')); // the queue changes (a favourite): same upcoming song
    await flush();
    await ytEvent(YT.PAUSED);
    await ytEvent(YT.PLAYING);
    await flush(10_000);
    expect(ytLookups()).toEqual(['a::one', 'b::two']);
    expect(planCalls()).toHaveLength(2); // once per song
  });

  it('the song that comes next starts from the id already known, and asks ahead for the one after it', async () => {
    await mount();
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    vi.mocked(api.fetchSongYoutube).mockClear();

    await play(1);
    expect(lastPlayer().loadVideoById).toHaveBeenLastCalledWith('vid-b::two'); // no lookup in the way
    expect(ytLookups()).toEqual([]);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['c::three']);
  });

  it('the last song of the queue has nothing ahead (repeat off)', async () => {
    await mount();
    await play(2);
    await ytEvent(YT.PLAYING);
    await flush(5000);
    expect(ytLookups()).toEqual(['c::three']);
  });

  it('with repeat all the last song looks ahead to the first', async () => {
    await mount();
    fireEvent.click(screen.getByText('repeat')); // off → all
    expect(out('repeat')).toBe('all');
    await play(2);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['c::three', 'a::one']);
  });

  it('with repeat one the same song comes again: nothing to ask for', async () => {
    await mount();
    fireEvent.click(screen.getByText('repeat'));
    fireEvent.click(screen.getByText('repeat')); // all → one
    expect(out('repeat')).toBe('one');
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one']);
  });

  it('a song whose plan sends it to the file is not worth a video id', async () => {
    list = [A, HOME1, C];
    await mount('media', 'internal');
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(planCalls()).toEqual([['a::one', 'media'], ['h::home one', 'media']]);
    expect(ytLookups()).toEqual(['a::one']); // HOME1 is next, but its plan says the media server
  });

  it('the plan decides, not the flags of the list: a next song the list says has no file, but the plan sends to the disk, needs no id', async () => {
    list = [A, B, C];
    await mount('media', 'internal', { [B.songKey]: 'disk' });
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one']);
  });

  it('…and the other way round: a next song the list says is at home, but the plan sends to the video, is looked up ahead', async () => {
    list = [A, HOME1, C];
    await mount('auto', 'external'); // from the internet the server answers the video, whatever the list says
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one', 'h::home one']);
  });

  it('a next song whose plan cannot be had: nothing is looked up now, the real play asks again', async () => {
    await mount();
    await play(0);
    vi.mocked(api.fetchPlayPlan).mockRejectedValueOnce(new Error('HTTP 500'));
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one']);
    expect(out('playing')).toBe('true');
    await play(1);
    expect(planCalls().map((c) => c[0])).toEqual(['a::one', 'b::two', 'b::two']);
    expect(lastPlayer().loadVideoById).toHaveBeenLastCalledWith('vid-b::two');
  });

  it('…unless the switch says Internet: then even a song at home plays from YouTube and is asked for ahead', async () => {
    list = [A, HOME1, C];
    await mount('internet', 'internal');
    await play(0);
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one', 'h::home one']);
  });

  it('a lookup that fails is no harm: the real play asks again, and the playback goes on', async () => {
    await mount();
    await play(0);
    vi.mocked(api.fetchSongYoutube).mockRejectedValueOnce(new Error('HTTP 500'));
    await ytEvent(YT.PLAYING);
    await flush();
    expect(ytLookups()).toEqual(['a::one', 'b::two']);
    expect(out('playing')).toBe('true');
    await play(1);
    expect(ytLookups()).toEqual(['a::one', 'b::two', 'b::two']); // asked again, now for real
    expect(lastPlayer().loadVideoById).toHaveBeenLastCalledWith('vid-b::two');
  });
});

describe('"Sto caricando…" lasts until the song really plays', () => {
  it('YouTube: through buffering and the unstarted state, until it plays', async () => {
    await mount();
    await play(0);
    expect(out('loading')).toBe('true');
    await ytEvent(YT.UNSTARTED);
    await ytEvent(YT.BUFFERING);
    expect(out('loading')).toBe('true');
    await ytEvent(YT.PLAYING);
    expect(out('loading')).toBe('false');
  });

  it('a video that is only cued (autoplay refused) or paused ends it too', async () => {
    await mount();
    await play(0);
    await ytEvent(YT.CUED);
    expect(out('loading')).toBe('false');
    await play(1);
    expect(out('loading')).toBe('true');
    await ytEvent(YT.PAUSED);
    expect(out('loading')).toBe('false');
  });

  it('a video error ends it', async () => {
    await mount();
    await play(0);
    expect(out('loading')).toBe('true');
    act(() => lastPlayer().error(150));
    expect(out('loading')).toBe('false');
  });

  it('and so does the safety net, if nothing at all is heard', async () => {
    await mount();
    await play(0);
    await flush(LOADING_MAX_MS - 1);
    expect(out('loading')).toBe('true');
    await flush(2);
    expect(out('loading')).toBe('false');
  });

  it('the home file: from the press of play until it plays', async () => {
    list = [HOME1, HOME2];
    let start: () => void = () => undefined;
    audioPlay = () => new Promise<void>((resolve) => { start = resolve; });
    await mount('media', 'internal');
    fireEvent.click(screen.getByText('play0'));
    await flush();
    expect(out('loading')).toBe('true');
    await act(async () => { start(); });
    expect(out('loading')).toBe('false');
  });

  it('the home file that never answers is not waited for for ever', async () => {
    list = [HOME1, HOME2];
    audioPlay = () => new Promise<void>(() => undefined);
    await mount('media', 'internal');
    fireEvent.click(screen.getByText('play0'));
    await flush(LOADING_MAX_MS + 100);
    expect(out('loading')).toBe('false');
  });
});

describe('a song at home starts with no IFrame involved', () => {
  it('Media server (or Auto from the home network): the file is asked for at once, no player, no video lookup', async () => {
    list = [HOME1, HOME2];
    await mount('auto', 'internal');
    await play(0);
    expect(played).toEqual([absoluteUrl(fileUrlOf('h::home one'))]);
    expect(audios[0].preload).toBe('auto'); // fetch as soon as the source is set (whatever the browser defaults to)
    expect(FakePlayer.instances).toHaveLength(0);
    expect(api.fetchSongYoutube).not.toHaveBeenCalled();
    expect(out('from')).toBe('media-server');
    await flush(5000);
    expect(FakePlayer.instances).toHaveLength(0);
    expect(api.fetchSongYoutube).not.toHaveBeenCalled(); // and the next one is at home too: nothing prefetched
  });

  it('forced Media server from the internet is the same', async () => {
    list = [HOME1, HOME2];
    await mount('media', 'external');
    await play(0);
    expect(played).toHaveLength(1);
    expect(FakePlayer.instances).toHaveLength(0);
  });

  it('it does not wait for the IFrame API: with the API not there at all the song still starts', async () => {
    delete (window as unknown as { YT?: unknown }).YT; // loading it would hang: nothing may depend on it
    list = [HOME1];
    await mount('media', 'internal');
    await play(0);
    expect(played).toHaveLength(1);
    expect(out('loading')).toBe('false');
  });

  it('moving the video slot between pages does not wake the video up under a song that plays from the file', async () => {
    list = [HOME1, A];
    await mount('internet', 'external');
    await play(0); // Internet: YouTube — the id of the song is now known to the player
    await ytEvent(YT.PLAYING);
    expect(lastPlayer().loadVideoById).toHaveBeenCalledWith('vid-h::home one');
    fireEvent.click(screen.getByText('mode-media'));
    await play(0); // the same song, now from the file at home
    expect(played).toHaveLength(1);
    const before = FakePlayer.instances.length;
    const loads = FakePlayer.instances.flatMap((p) => p.loadVideoById.mock.calls).length;
    fireEvent.click(screen.getByText('remount'));
    await flush(1000);
    expect(FakePlayer.instances).toHaveLength(before);
    expect(FakePlayer.instances.flatMap((p) => p.loadVideoById.mock.calls)).toHaveLength(loads); // no second video under the file
  });
});
