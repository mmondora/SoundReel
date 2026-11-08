import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { PlayerProvider, usePlayer } from './PlayerContext';
import { SOURCE_MODE_STORAGE_KEY } from './playbackSource';
import type { SourceMode } from './playbackSource';
import * as api from '../services/api';
import { absoluteUrl, fileUrlOf, makePlan, servePlans, videoPlan } from '../test/playPlans';
import type { FileAt } from '../test/playPlans';
import type { YtPlayer, YtPlayerOptions } from './youtubeApi';
import type { AggregatedSong, NetworkKind, SongStateResponse } from '../types';

// What the web player plays is decided by the SERVER (rule P, ADR-0018, spec 2026-11-08-mondrop-search-spotify-style-design.md
// S9/S11): the browser sends its preference (the "Sorgente" switch) with `GET /api/songs/:key/play` and follows the answer. It
// makes no network test, reads no flag of the list to choose, and the parallel download is asked only when the plan says so.

vi.mock('../services/api', () => ({
  fetchPlayPlan: vi.fn(),
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
// The flags of the list (fs / mediaServer / inLibrary) are there to be IGNORED: what plays comes from the plan of the server.
const ON_MS = song('a::on ms', { fs: false, mediaServer: true, inLibrary: true });
const ON_FS = song('b::on fs', { fs: true, mediaServer: false, inLibrary: true });
const ON_BOTH = song('c::on both', { fs: true, mediaServer: true, inLibrary: true });
const NOWHERE = song('d::nowhere', { fs: false, mediaServer: false, inLibrary: false });
const LIST = [ON_MS, ON_FS, ON_BOTH, NOWHERE];
const IDX = { ms: 0, fs: 1, both: 2, nowhere: 3 };
/** Where the files really are, for the fake server. */
const FILES: Record<string, FileAt> = { [ON_MS.songKey]: 'media-server', [ON_FS.songKey]: 'disk', [ON_BOTH.songKey]: 'media-server' };

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
const planCalls = () => vi.mocked(api.fetchPlayPlan).mock.calls;

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
  servePlans('internal', FILES); // at home, the files where they are
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

async function mount(mode: SourceMode | null = null) {
  if (mode) localStorage.setItem(SOURCE_MODE_STORAGE_KEY, mode);
  const view = render(
    <PlayerProvider>
      <Harness />
    </PlayerProvider>,
  );
  await flush();
  return view;
}

async function play(index: number) {
  fireEvent.click(screen.getByText(`play${index}`));
  await flush();
}

describe('the browser follows the plan of the server', () => {
  it('at home with the file: audio from the address of the plan, the cover, badge "media-server"; nothing else is asked', async () => {
    await mount();
    await play(IDX.ms);
    expect(planCalls()).toEqual([['a::on ms', 'auto']]);
    expect(played).toEqual([absoluteUrl(fileUrlOf('a::on ms'))]);
    expect(played[0]).not.toContain('from='); // the backend picks the Fritz first, then the disk
    expect(ytLoads()).toEqual([]);
    expect(api.fetchSongYoutube).not.toHaveBeenCalled();
    expect(out('from')).toBe('media-server');
    expect(out('box')).toBe('cover');
    expect(api.fetchSongState).not.toHaveBeenCalled(); // no check of its own: the plan already says where the file is
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });

  it('plays exactly the address the plan gives, not one the browser makes up', async () => {
    vi.mocked(api.fetchPlayPlan).mockResolvedValue(makePlan('a::on ms', { fileUrl: '/api/songs/elsewhere/file' }));
    await mount();
    await play(IDX.ms);
    expect(played).toEqual([absoluteUrl('/api/songs/elsewhere/file')]);
  });

  it('the file only on geekom’s disk: the badge says "disk"', async () => {
    await mount();
    await play(IDX.fs);
    expect(played).toEqual([absoluteUrl(fileUrlOf('b::on fs'))]);
    expect([out('from'), out('box')]).toEqual(['disk', 'cover']);
  });

  it('from the internet the video plays, even for a song that has its file; the file is never asked for', async () => {
    servePlans('external', FILES);
    await mount();
    await play(IDX.ms);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
    expect([out('from'), out('box')]).toEqual(['youtube', 'video']);
    expect(api.requestSongDownload).not.toHaveBeenCalled(); // the file exists: nothing to fetch
  });

  it('at home with no file yet: the video plays meanwhile and the server is asked to fetch the song, once', async () => {
    await mount();
    await play(IDX.nowhere);
    expect(ytLoads()).toEqual(['vid1']);
    expect(played).toEqual([]);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
    expect(api.requestSongDownload).toHaveBeenCalledWith('d::nowhere', 'play');
    expect([out('from'), out('box')]).toEqual(['youtube', 'video']);
    expect(api.fetchSongState).not.toHaveBeenCalled(); // the first poll is 5 s away, and nothing is checked before the play
    await play(IDX.nowhere);
    await play(IDX.nowhere);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1); // once per song per session
  });

  it('the plan wins over the flags of the list, both ways', async () => {
    // the list says «on the media server», the plan says the video; the list says «nowhere», the plan says the disk
    vi.mocked(api.fetchPlayPlan).mockImplementation(async (key) =>
      key === 'a::on ms' ? videoPlan(key, { network: 'external', choice: 'internet' }) : makePlan(key, { from: 'disk' }));
    await mount();
    await play(IDX.ms);
    expect(ytLoads()).toEqual(['vid1']);
    expect(played).toEqual([]);
    await play(IDX.nowhere);
    expect(played).toEqual([absoluteUrl(fileUrlOf('d::nowhere'))]);
    expect(out('from')).toBe('disk');
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });

  it('a plan that names a file but gives no address is not played as a file', async () => {
    vi.mocked(api.fetchPlayPlan).mockResolvedValue(makePlan('a::on ms', { fileUrl: null }));
    await mount();
    await play(IDX.ms);
    expect(played).toEqual([]);
    expect(ytLoads()).toEqual(['vid1']);
  });

  it('asks the server again at every song start (the network and the file may have changed), with the key', async () => {
    await mount();
    await play(IDX.ms);
    await play(IDX.nowhere);
    await play(IDX.ms);
    expect(planCalls().map((c) => c[0])).toEqual(['a::on ms', 'd::nowhere', 'a::on ms']);
  });

  it('a plan that cannot be had: the video plays and NOTHING is downloaded', async () => {
    vi.mocked(api.fetchPlayPlan).mockRejectedValue(new Error('HTTP 500'));
    await mount();
    await play(IDX.nowhere);
    expect(ytLoads()).toEqual(['vid1']);
    expect(played).toEqual([]);
    expect(api.requestSongDownload).not.toHaveBeenCalled();
    expect(out('from')).toBe('youtube');
    await play(IDX.ms); // even for a song the list says is at home
    expect(ytLoads()).toEqual(['vid1', 'vid1']);
    expect(played).toEqual([]);
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });
});

describe('the "Sorgente" switch is only a preference sent to the server', () => {
  it.each<SourceMode>(['auto', 'internet', 'media'])('%s is sent as `prefer` with every song', async (mode) => {
    await mount(mode);
    await play(IDX.ms);
    await play(IDX.nowhere);
    expect(planCalls()).toEqual([['a::on ms', mode], ['d::nowhere', mode]]);
  });

  it.each<[SourceMode, NetworkKind, string, string]>([
    ['auto', 'internal', 'media-server', 'cover'],
    ['auto', 'external', 'youtube', 'video'],
    ['internet', 'internal', 'youtube', 'video'],
    ['media', 'external', 'media-server', 'cover'],
  ])('%s on the %s network: the browser plays what the server answers (%s)', async (mode, network, from, box) => {
    servePlans(network, FILES);
    await mount(mode);
    await play(IDX.ms);
    expect([out('from'), out('box')]).toEqual([from, box]);
    expect(played).toHaveLength(from === 'youtube' ? 0 : 1);
    expect(ytLoads()).toHaveLength(from === 'youtube' ? 1 : 0);
  });

  it.each<[string, NetworkKind, SourceMode]>([
    ['Auto at home', 'internal', 'auto'],
    ['Auto from the internet', 'external', 'auto'],
    ['Internet', 'internal', 'internet'],
    ['Media server', 'external', 'media'],
  ])('%s: a song with no file plays from the video and the server is asked to fetch it, once (the switch does not matter, S6)', async (_label, network, mode) => {
    servePlans(network, FILES);
    await mount(mode);
    await play(IDX.nowhere);
    expect(ytLoads()).toEqual(['vid1']);
    expect(played).toEqual([]);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
    expect(api.requestSongDownload).toHaveBeenCalledWith('d::nowhere', 'play');
    expect([out('from'), out('box')]).toEqual(['youtube', 'video']);
    await play(IDX.nowhere);
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
  });

  it.each<[NetworkKind, SourceMode]>([['internal', 'auto'], ['external', 'auto'], ['internal', 'internet'], ['external', 'media']])(
    'a song that has its file is never downloaded (%s, %s)',
    async (network, mode) => {
      servePlans(network, FILES);
      await mount(mode);
      for (const index of [IDX.ms, IDX.fs, IDX.both]) await play(index);
      expect(api.requestSongDownload).not.toHaveBeenCalled();
    },
  );

  it('is remembered by this browser and restored on the next visit', async () => {
    const first = await mount();
    expect(out('mode')).toBe('auto');
    fireEvent.click(screen.getByText('mode-internet'));
    expect(out('mode')).toBe('internet');
    expect(localStorage.getItem(SOURCE_MODE_STORAGE_KEY)).toBe('internet');
    first.unmount();
    await mount();
    expect(out('mode')).toBe('internet');
    fireEvent.click(screen.getByText('mode-auto'));
    expect(localStorage.getItem(SOURCE_MODE_STORAGE_KEY)).toBe('auto');
  });

  it('works when localStorage throws (private window): the choice just does not last', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await mount();
    expect(out('mode')).toBe('auto');
    fireEvent.click(screen.getByText('mode-media'));
    expect(out('mode')).toBe('media');
  });

  it('never interrupts the song in progress: it applies from the next song, which is asked with the new preference', async () => {
    await mount();
    await play(IDX.ms);
    expect(played).toHaveLength(1);
    expect(out('pending')).toBe('false');

    fireEvent.click(screen.getByText('mode-internet'));
    await flush();
    expect(planCalls()).toHaveLength(1); // no new question, no reload
    expect(played).toHaveLength(1);
    expect(ytLoads()).toEqual([]);
    expect(out('from')).toBe('media-server'); // the badge still tells the truth
    expect(out('box')).toBe('cover');
    expect(out('pending')).toBe('true');

    fireEvent.click(screen.getByText('next')); // ON_FS is next in the queue
    await flush();
    expect(planCalls()[planCalls().length - 1]).toEqual(['b::on fs', 'internet']);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('pending')).toBe('false');
  });

  it('a fallback is not a pending change: Media server for a song that has no file plays the video without a hint', async () => {
    await mount('media');
    await play(IDX.nowhere);
    expect(out('from')).toBe('youtube');
    expect(out('choice')).toBe('media');
    expect(out('pending')).toBe('false');
  });
});

describe('what the player says about the network comes from the plans', () => {
  it('nothing is asked and nothing known before the first song; then the network the server saw and what it chose', async () => {
    await mount();
    expect(planCalls()).toEqual([]); // the browser tests no network at page load
    expect(out('net')).toBe('pending');
    expect(out('choice')).toBe('internet'); // Auto before the server has said anything: the safe side
    await play(IDX.ms);
    expect(out('net')).toBe('internal');
    expect(out('choice')).toBe('media');
  });

  it('from the internet: external, and the video', async () => {
    servePlans('external', FILES);
    await mount();
    await play(IDX.ms);
    expect(out('net')).toBe('external');
    expect(out('choice')).toBe('internet');
  });

  it('it follows the network the server sees at every song (Wi-Fi, then mobile data)', async () => {
    await mount();
    await play(IDX.ms);
    expect([out('net'), out('from')]).toEqual(['internal', 'media-server']);
    servePlans('external', FILES);
    await play(IDX.fs);
    expect([out('net'), out('choice'), out('from')]).toEqual(['external', 'internet', 'youtube']);
  });

  it('a plan that cannot be had is «failed»: the video plays, Auto counts as the video', async () => {
    vi.mocked(api.fetchPlayPlan).mockRejectedValue(new Error('HTTP 500'));
    await mount();
    await play(IDX.ms);
    expect(out('net')).toBe('failed');
    expect(out('choice')).toBe('internet');
    expect(out('from')).toBe('youtube');
  });

  it('a manual mode is its own choice; Auto is the last word of the server on Auto', async () => {
    await mount();
    await play(IDX.ms);
    expect(out('choice')).toBe('media');
    fireEvent.click(screen.getByText('mode-internet'));
    expect(out('choice')).toBe('internet');
    fireEvent.click(screen.getByText('mode-auto'));
    expect(out('choice')).toBe('media');
  });
});

describe('after the first-play download (W1)', () => {
  const READY = stateOf('ready', { location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/d - nowhere.mp3', mediaUrl: null, streamUrl: null } });

  /** The song has no file until the download finishes; from then on the server's plan names geekom's disk. */
  async function playUntilDownloaded(mode: SourceMode) {
    let downloaded = false;
    servePlans('internal', (key) => (key === 'd::nowhere' && downloaded ? 'disk' : null));
    vi.mocked(api.fetchSongState).mockImplementation(async () => { downloaded = true; return READY; }); // every poll
    await mount(mode);
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
    expect(planCalls()).toHaveLength(1); // the download finishing does not make the player ask again
  });

  it('Media server: the NEXT play gets the file from the plan (geekom’s disk, not yet on the Fritz), the box shows the cover', async () => {
    await playUntilDownloaded('media');
    await play(IDX.nowhere);
    expect(played).toEqual([absoluteUrl(fileUrlOf('d::nowhere'))]);
    expect(out('from')).toBe('disk');
    expect(out('box')).toBe('cover');
    expect(api.requestSongDownload).toHaveBeenCalledTimes(1);
  });

  it('Internet: the next play is still the video, because that is what the server answers to that preference', async () => {
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
    await mount();
    await play(IDX.ms);
    expect([out('from'), out('box')]).toEqual(['media-server', 'cover']);
    await play(IDX.nowhere);
    expect([out('from'), out('box')]).toEqual(['youtube', 'video']);
    await play(IDX.fs);
    expect([out('from'), out('box')]).toEqual(['disk', 'cover']);
  });

  it('a home file that cannot play falls through to YouTube: video and "youtube", and no download (the file exists)', async () => {
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.reject(new Error('NotSupportedError')));
    await mount();
    await play(IDX.ms);
    expect(ytLoads()).toEqual(['vid1']);
    expect(out('from')).toBe('youtube');
    expect(out('box')).toBe('video');
    expect(api.requestSongDownload).not.toHaveBeenCalled();
  });

  it('no video found for the song: back to the cover and no badge', async () => {
    vi.mocked(api.fetchSongYoutube).mockRejectedValue(new Error('HTTP 404'));
    servePlans('external', FILES);
    await mount();
    await play(IDX.ms);
    expect(out('box')).toBe('cover');
    expect(out('from')).toBe('none');
  });
});
