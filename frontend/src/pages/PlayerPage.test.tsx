import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerPage } from './PlayerPage';
import { MiniPlayer } from '../components/MiniPlayer';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryThumbnailCache } from '../hooks/useEntryThumbnail';
import * as api from '../services/api';
import { scheduleYoutubeWarmUp } from '../player/preload';
import type { AggregatedSong } from '../types';

const { playerMock } = vi.hoisted(() => ({ playerMock: { current: {} as Record<string, unknown> } }));

vi.mock('../player/PlayerContext', () => ({ usePlayer: () => playerMock.current }));
vi.mock('../player/preload', () => ({ scheduleYoutubeWarmUp: vi.fn() }));

vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  getEntry: vi.fn(),
  fetchPlaylists: vi.fn().mockResolvedValue([]),
  fetchPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
}));

function song(n: number, extra: Partial<AggregatedSong> = {}): AggregatedSong {
  return {
    songKey: `artist::song ${n}`, title: `Song ${n}`, artist: 'Artist', album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e${n}`, createdAt: '2026-01-01T00:00:00Z' }], meta: null, ...extra,
  };
}
const songs = (count: number): AggregatedSong[] => Array.from({ length: count }, (_, i) => song(i + 1));

const fns = {
  playSong: vi.fn(), hydrateQueue: vi.fn(), toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(),
  toggleShuffle: vi.fn(), cycleRepeatMode: vi.fn(), patchCurrent: vi.fn(), setYoutubeMount: vi.fn(),
  setSourceMode: vi.fn(),
};

function makePlayer(queue: AggregatedSong[], index: number, extra: Record<string, unknown> = {}) {
  return {
    queue, index, current: queue[index] ?? null, queueLabel: 'Road trip', playing: true, shuffle: false, repeat: 'off',
    currentTime: 0, duration: 200, loading: false, error: null, downloadStates: {}, currentDownload: null,
    locationOverrides: {}, mediaBox: 'cover', playingFrom: null,
    sourceMode: 'auto', networkStatus: 'internal', sourceChoice: 'media', sourceChangePending: false,
    ...fns, ...extra,
  };
}

function renderPage() {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={['/player']}>
        <PlayerPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

const queueList = () => within(screen.getByRole('region', { name: 'Queue' })).getAllByRole('listitem');
const nowPlaying = () => within(screen.getByRole('region', { name: 'Now playing' }));

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setStoredLanguage('en');
  resetEntryThumbnailCache();
  vi.mocked(api.fetchSongs).mockResolvedValue([]);
  vi.mocked(api.getEntry).mockRejectedValue(new Error('not needed'));
  vi.mocked(scheduleYoutubeWarmUp).mockReturnValue(() => undefined);
});

describe('queue window (rule W3)', () => {
  it('a queue of 57 shows 20, the one in play first, with the status row', async () => {
    const queue = songs(57);
    playerMock.current = makePlayer(queue, 14);
    renderPage();
    const items = queueList();
    expect(items).toHaveLength(20);
    expect(items[0]).toHaveTextContent('Song 15'); // index 14 = the song in play, always on top
    expect(items[19]).toHaveTextContent('Song 34');
    expect(screen.getByTestId('queue-window')).toHaveTextContent('20 of 57 · 14 already played hidden');
    expect(screen.queryByText('Song 1', { exact: true })).toBeNull(); // played ones left the top
  });

  it('exactly 20 stays complete with no status row; 21 starts cutting', () => {
    playerMock.current = makePlayer(songs(20), 7);
    const first = renderPage();
    expect(queueList()).toHaveLength(20);
    expect(screen.queryByTestId('queue-window')).toBeNull();
    first.unmount();

    playerMock.current = makePlayer(songs(21), 0);
    renderPage();
    expect(queueList()).toHaveLength(20);
    expect(screen.getByTestId('queue-window')).toHaveTextContent('20 of 21');
    expect(screen.getByTestId('queue-window')).not.toHaveTextContent('already played');
  });

  it('near the end the window is short (or completed from the start when repeat is on)', () => {
    playerMock.current = makePlayer(songs(57), 50);
    const first = renderPage();
    expect(queueList()).toHaveLength(7);
    expect(screen.getByTestId('queue-window')).toHaveTextContent('7 of 57 · 50 already played hidden');
    first.unmount();

    playerMock.current = makePlayer(songs(57), 50, { repeat: 'all' });
    renderPage();
    expect(queueList()).toHaveLength(20);
    expect(queueList()[7]).toHaveTextContent('Song 1');
  });

  it('a song picked in the window starts inside the FULL queue; next/previous are the player’s', () => {
    const queue = songs(57);
    playerMock.current = makePlayer(queue, 14);
    renderPage();
    fireEvent.click(within(queueList()[3]).getByRole('button'));
    expect(fns.playSong).toHaveBeenCalledTimes(1);
    const [key, list, label] = fns.playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(key).toBe('artist::song 18');
    expect(list).toBe(queue);
    expect(list).toHaveLength(57);
    expect(label).toBe('Road trip');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(fns.next).toHaveBeenCalledTimes(1);
    expect(fns.previous).toHaveBeenCalledTimes(1);
  });
});

describe('where the file is, and where the song plays from', () => {
  const located = [
    song(1, { fs: true, mediaServer: false, inLibrary: true }),
    song(2, { fs: false, mediaServer: true, inLibrary: true }),
    song(3, { fs: true, mediaServer: true, inLibrary: true }),
    song(4),
  ];

  it('badges FS / MS / FS+MS next to each song of the queue; none for a streaming-only song', () => {
    playerMock.current = makePlayer(located, 3);
    renderPage();
    const items = queueList();
    expect(within(items[0]).getByText('FS')).toBeInTheDocument();
    expect(within(items[1]).getByText('MS')).toBeInTheDocument();
    expect(within(items[2]).getByText('FS+MS')).toBeInTheDocument();
    expect(items[3].querySelector('.loc-badge')).toBeNull();
  });

  it('the song in play shows its badge, and a song of this session’s finished download shows FS', () => {
    playerMock.current = makePlayer(located, 1);
    const first = renderPage();
    expect(nowPlaying().getByText('MS')).toBeInTheDocument();
    first.unmount();

    playerMock.current = makePlayer(located, 3, { locationOverrides: { 'artist::song 4': { fs: true } } });
    renderPage();
    expect(within(queueList()[3]).getByText('FS')).toBeInTheDocument();
  });

  it.each([
    ['media-server', 'Media server'],
    ['disk', 'Home disk'],
    ['youtube', 'Internet (YouTube)'],
  ])('says it plays from %s', (from, label) => {
    playerMock.current = makePlayer(located, 1, { playingFrom: from });
    renderPage();
    const chip = nowPlaying().getByTitle(`Playing from: ${label}`);
    expect(chip).toHaveAttribute('data-from', from);
    expect(chip).toHaveTextContent(`Playing from${label}`);
  });

  it('says nothing about the source while it is not decided', () => {
    playerMock.current = makePlayer(located, 1, { playingFrom: null });
    renderPage();
    expect(document.querySelector('.from-chip')).toBeNull();
  });

  it('a song that is on the media server can still say "Internet": the badge is where it IS, the chip where it PLAYS', () => {
    playerMock.current = makePlayer(located, 1, { playingFrom: 'youtube' });
    renderPage();
    expect(nowPlaying().getByText('MS')).toBeInTheDocument();
    expect(nowPlaying().getByTitle('Playing from: Internet (YouTube)')).toBeInTheDocument();
  });
});

describe('the picture box (rule W4)', () => {
  const box = () => document.querySelector('.player-car-picture') as HTMLElement;

  it('the video mode shows the video layer, the cover mode the cover', () => {
    const withCover = [song(1, { meta: { coverUrl: 'https://c/1.jpg' } as AggregatedSong['meta'] })];
    playerMock.current = makePlayer(withCover, 0, { mediaBox: 'video' });
    const first = renderPage();
    expect(box()).toHaveAttribute('data-mode', 'video');
    expect(box().querySelector('.player-car-picture-video')).toHaveAttribute('aria-hidden', 'false');
    first.unmount();

    playerMock.current = makePlayer(withCover, 0, { mediaBox: 'cover' });
    renderPage();
    expect(box()).toHaveAttribute('data-mode', 'cover');
    expect(box().querySelector('img')).toHaveAttribute('src', 'https://c/1.jpg');
    expect(box().querySelector('.player-car-picture-video')).toHaveAttribute('aria-hidden', 'true');
  });

  it('registers the one YouTube slot with the player', () => {
    playerMock.current = makePlayer(songs(1), 0);
    renderPage();
    expect(fns.setYoutubeMount).toHaveBeenCalledWith(expect.any(HTMLDivElement));
  });

  it('cover order: the song’s own cover, then the entry thumbnail, then a neutral placeholder', async () => {
    vi.mocked(api.getEntry).mockResolvedValue({ thumbnailUrl: 'https://t/e1.jpg' } as Awaited<ReturnType<typeof api.getEntry>>);
    playerMock.current = makePlayer(songs(1), 0, { mediaBox: 'cover' });
    renderPage();
    await waitFor(() => expect(box().querySelector('img')).toHaveAttribute('src', 'https://t/e1.jpg'));
    // a broken image falls through to the placeholder; the box never collapses
    fireEvent.error(box().querySelector('img') as HTMLImageElement);
    await waitFor(() => expect(box().querySelector('img')).toBeNull());
    expect(box().querySelector('.player-car-picture-cover')).toHaveTextContent('🎵');
  });

  it('the song’s own cover wins and the entry is not even asked for', async () => {
    const withCover = [song(1, { meta: { coverUrl: 'https://c/1.jpg' } as AggregatedSong['meta'] })];
    playerMock.current = makePlayer(withCover, 0);
    renderPage();
    await act(async () => { await Promise.resolve(); });
    expect(api.getEntry).not.toHaveBeenCalled();
  });
});

describe('the "Sorgente" switch on the player page (rule W5)', () => {
  const group = () => screen.getByRole('group', { name: 'Source' });

  it('is a labelled radio group: Auto · Internet · Media server, Auto by default', () => {
    playerMock.current = makePlayer(songs(3), 0);
    renderPage();
    const radios = within(group()).getAllByRole('radio');
    expect(radios.map((r) => (r as HTMLInputElement).labels?.[0]?.textContent)).toEqual(['Auto', 'Internet', 'Media server']);
    expect(screen.getByRole('radio', { name: 'Auto' })).toBeChecked();
  });

  it('is there even before anything is playing', () => {
    playerMock.current = makePlayer([], 0, { current: null });
    renderPage();
    expect(group()).toBeInTheDocument();
  });

  it('choosing a mode tells the player', () => {
    playerMock.current = makePlayer(songs(3), 0);
    renderPage();
    fireEvent.click(screen.getByRole('radio', { name: 'Media server' }));
    expect(fns.setSourceMode).toHaveBeenCalledWith('media');
    fireEvent.click(screen.getByRole('radio', { name: 'Internet' }));
    expect(fns.setSourceMode).toHaveBeenLastCalledWith('internet');
  });

  it('shows the chosen mode', () => {
    playerMock.current = makePlayer(songs(3), 0, { sourceMode: 'internet' });
    renderPage();
    expect(screen.getByRole('radio', { name: 'Internet' })).toBeChecked();
  });

  it.each([
    ['internal', 'Auto: home network → media server'],
    ['external', 'Auto: from the internet → Internet'],
    ['failed', 'Auto: network not detected → Internet'],
  ])('Auto says what it resolved to (network %s)', (network, hint) => {
    playerMock.current = makePlayer(songs(3), 0, { networkStatus: network });
    renderPage();
    expect(document.querySelector('.source-switch-hint')).toHaveTextContent(hint);
  });

  it('says nothing while the network is still being asked, nor for a manual mode', () => {
    playerMock.current = makePlayer(songs(3), 0, { networkStatus: 'pending' });
    const first = renderPage();
    expect(document.querySelector('.source-switch-hint')).toHaveTextContent('');
    first.unmount();
    playerMock.current = makePlayer(songs(3), 0, { sourceMode: 'media', networkStatus: 'internal' });
    renderPage();
    expect(document.querySelector('.source-switch-hint')).toHaveTextContent('');
  });

  it('tells that a change applies from the next song', () => {
    playerMock.current = makePlayer(songs(3), 0, { sourceMode: 'internet', sourceChangePending: true });
    renderPage();
    expect(document.querySelector('.source-switch-hint')).toHaveTextContent('Applies from the next song');
  });
});

describe('the "Sorgente" switch and the badge in the mini player', () => {
  function renderMini(path = '/') {
    return render(
      <LanguageProvider>
        <MemoryRouter initialEntries={[path]}>
          <MiniPlayer />
        </MemoryRouter>
      </LanguageProvider>,
    );
  }

  it('is a labelled select with the three sources, and changing it tells the player', () => {
    playerMock.current = makePlayer(songs(3), 0);
    renderMini();
    const select = screen.getByRole('combobox', { name: 'Source' });
    expect(select).toHaveValue('auto');
    expect(within(select).getAllByRole('option').map((o) => o.textContent)).toEqual(['Auto', 'Internet', 'Media server']);
    fireEvent.change(select, { target: { value: 'media' } });
    expect(fns.setSourceMode).toHaveBeenCalledWith('media');
  });

  it('describes the resolved Auto to a screen reader', () => {
    playerMock.current = makePlayer(songs(3), 0, { networkStatus: 'external' });
    renderMini();
    const select = screen.getByRole('combobox', { name: 'Source' });
    expect(select).toHaveAccessibleDescription('Auto: from the internet → Internet');
  });

  it('says where the song plays from (short) next to the location badge', () => {
    const located = [song(1, { fs: false, mediaServer: true, inLibrary: true })];
    playerMock.current = makePlayer(located, 0, { playingFrom: 'media-server' });
    renderMini();
    expect(screen.getByText('MS')).toBeInTheDocument();
    const chip = document.querySelector('.from-chip') as HTMLElement;
    expect(chip).toHaveTextContent('Media server');
    expect(chip).not.toHaveTextContent('Playing from');
    expect(chip).toHaveAttribute('title', 'Playing from: Media server');
  });

  it('is not shown on the player page itself (the page has the full switch), nor with nothing in play', () => {
    playerMock.current = makePlayer(songs(3), 0);
    const first = renderMini('/player');
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
    first.unmount();
    playerMock.current = makePlayer([], 0, { current: null });
    renderMini('/');
    expect(screen.queryByRole('combobox', { name: 'Source' })).toBeNull();
  });
});

describe('speed of the first play (spec 2026-11-08, X6)', () => {
  it('warms up the YouTube side once when the page mounts, and cancels it if the page goes away first', () => {
    const cancel = vi.fn();
    vi.mocked(scheduleYoutubeWarmUp).mockReturnValue(cancel);
    playerMock.current = makePlayer(songs(3), 0);
    const view = renderPage();
    expect(scheduleYoutubeWarmUp).toHaveBeenCalledTimes(1);
    expect(cancel).not.toHaveBeenCalled();
    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('does not warm up again when the page re-renders', () => {
    playerMock.current = makePlayer(songs(3), 0);
    const view = renderPage();
    view.rerender(
      <LanguageProvider>
        <MemoryRouter initialEntries={['/player']}>
          <PlayerPage />
        </MemoryRouter>
      </LanguageProvider>,
    );
    expect(scheduleYoutubeWarmUp).toHaveBeenCalledTimes(1);
  });

  it('a song that is starting says "Loading…"; the play button is not blocked while it does', () => {
    playerMock.current = makePlayer(songs(3), 0, { loading: true });
    renderPage();
    const status = document.querySelector('.player-car-loading') as HTMLElement;
    expect(status).toHaveAttribute('role', 'status');
    expect(status).toHaveTextContent('Loading…');
    const play = screen.getByRole('button', { name: /^(Play|Pause)$/ });
    expect(play).toBeEnabled();
    expect(play).toHaveAttribute('aria-busy', 'true');
  });

  it('says nothing when it is not starting anything', () => {
    playerMock.current = makePlayer(songs(3), 0, { loading: false });
    renderPage();
    expect(document.querySelector('.player-car-loading')).toBeEmptyDOMElement();
    expect(screen.getByRole('button', { name: /^(Play|Pause)$/ })).toHaveAttribute('aria-busy', 'false');
  });

  it('says it in Italian: "Sto caricando…"', () => {
    setStoredLanguage('it');
    playerMock.current = makePlayer(songs(3), 0, { loading: true });
    renderPage();
    expect(document.querySelector('.player-car-loading')).toHaveTextContent('Sto caricando…');
  });

  it('the mini player shows it too (a dotted button and a status for screen readers)', () => {
    playerMock.current = makePlayer(songs(3), 0, { loading: true });
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={['/']}>
          <MiniPlayer />
        </MemoryRouter>
      </LanguageProvider>,
    );
    const toggle = screen.getByRole('button', { name: /^(Play|Pause)$/ });
    expect(toggle).toHaveTextContent('…');
    expect(toggle).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByText('Loading…', { selector: '.sr-only' })).toBeInTheDocument();
  });
});
