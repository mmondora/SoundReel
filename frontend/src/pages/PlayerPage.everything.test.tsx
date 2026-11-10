import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlayerPage } from './PlayerPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryThumbnailCache } from '../hooks/useEntryThumbnail';
import * as api from '../services/api';
import { choosePlaylist, servePlaylistPages } from '../testing/managerPicker';
import type { AggregatedSong, PlaylistDetail, PlaylistSummary } from '../types';

// Michele, 8 November: «anche la creazione delle playlist, la ricerca deve prendere da tutto e non solo dalla libreria», and «Sì,
// anche il player» (spec 2026-11-08-playlist-search-everything-design.md): «Scegli cosa suonare» and the playlists take from
// EVERYTHING (the journal and the songs that are only files); the plain shelves and the list the page opens on stay the journal's.

const { playerMock } = vi.hoisted(() => ({ playerMock: { current: {} as Record<string, unknown> } }));

vi.mock('../player/PlayerContext', () => ({ usePlayer: () => playerMock.current }));
vi.mock('../player/preload', () => ({ scheduleYoutubeWarmUp: vi.fn(() => () => undefined) }));
vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  getEntry: vi.fn(),
  fetchPlaylists: vi.fn(),
  fetchPlaylistsPage: vi.fn(),
  fetchPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
}));

function posted(artist: string, title: string, favorite = false): AggregatedSong {
  const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt: '2026-05-01T00:00:00Z' }],
    meta: {
      songKey: key, deezerId: null, itunesId: null, genres: [], album: null, releaseYear: null, coverUrl: null, previewUrl: null,
      deezerUrl: null, itunesUrl: null, enrichedAt: null, listened: false, favorite, downloaded: false, rating: null, score: null,
    },
    inLibrary: false, platforms: ['instagram'], tags: [],
  };
}

/** A song that exists only as a file (what `GET /api/songs?scope=everything` adds). */
function file(artist: string, title: string): AggregatedSong {
  return {
    songKey: `${artist.toLowerCase()}::${title.toLowerCase()}`, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [], meta: null, inLibrary: true, fs: false, mediaServer: true, libraryOnly: true, sources: [], platforms: [], tags: [],
  };
}

const JOURNAL = [posted('Michael Jackson', 'Billie Jean', true), posted('Madonna', 'Like a Prayer')];
const FILES = [file('Bassi Maestro', 'Capirai'), file('Bassi Maestro', 'Foto di gruppo'), file('El Raton', 'Una noche')];
const EVERY = [...JOURNAL, ...FILES];

const fns = {
  playSong: vi.fn(), hydrateQueue: vi.fn(), toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(),
  toggleShuffle: vi.fn(), cycleRepeatMode: vi.fn(), patchCurrent: vi.fn(), setYoutubeMount: vi.fn(), setSourceMode: vi.fn(),
};

function makePlayer(extra: Record<string, unknown> = {}) {
  return {
    queue: [], index: 0, current: null, queueLabel: null, playing: false, shuffle: false, repeat: 'off',
    currentTime: 0, duration: 0, loading: false, error: null, downloadStates: {}, currentDownload: null,
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

const listTitles = () => Array.from(document.querySelectorAll('.player-car-track-title')).map((e) => e.textContent);
const toggleButton = () => screen.getByRole('button', { name: /^🎚 (Choose what to play|Scegli cosa suonare)/ });
const panel = () => screen.getByTestId('choose-panel');
const askedEverything = () => vi.mocked(api.fetchSongs).mock.calls.filter(([scope]) => scope === 'everything').length;

async function openPanel() {
  fireEvent.click(toggleButton());
  await screen.findByTestId('choose-panel');
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setStoredLanguage('en');
  resetEntryThumbnailCache();
  playerMock.current = makePlayer();
  vi.mocked(api.fetchSongs).mockImplementation(async (scope) => (scope === 'everything' ? EVERY : JOURNAL));
  vi.mocked(api.fetchPlaylists).mockResolvedValue([]);
  vi.mocked(api.getEntry).mockRejectedValue(new Error('not needed'));
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('the page opens on the journal and asks for everything only when it is wanted', () => {
  it('the first visit loads the journal alone: nothing heavy, and the list is the journal\'s', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Like a Prayer']));
    expect(vi.mocked(api.fetchSongs).mock.calls).toEqual([[]]);
    expect(askedEverything()).toBe(0);
  });

  it('opening «Scegli cosa suonare» asks for everything, ONCE (closing and opening again does not ask again)', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(askedEverything()).toBe(1));
    fireEvent.click(within(panel()).getByRole('button', { name: /Close|Chiudi/ }));
    await waitFor(() => expect(screen.queryByTestId('choose-panel')).toBeNull());
    await openPanel();
    expect(askedEverything()).toBe(1);
  });

  it('if everything cannot be had the panel still works on the journal, and it asks again the next time', async () => {
    vi.mocked(api.fetchSongs).mockImplementation(async (scope) => {
      if (scope === 'everything') throw new Error('offline');
      return JOURNAL;
    });
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(askedEverything()).toBe(1));
    expect(listTitles()).toEqual(['Billie Jean', 'Like a Prayer']);
    fireEvent.click(within(panel()).getByRole('button', { name: /Close|Chiudi/ }));
    await openPanel();
    await waitFor(() => expect(askedEverything()).toBe(2));
  });
});

describe('«Scegli cosa suonare» takes from everything', () => {
  it('with the panel open the list has the songs that are only files too', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(listTitles()).toHaveLength(5));
    expect(listTitles()).toEqual(expect.arrayContaining(['Capirai', 'Foto di gruppo', 'Una noche']));
  });

  it('«bassi maestro» finds the files nobody ever posted, and a click plays them as the queue', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(listTitles()).toHaveLength(5));
    fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Search songs' }), { target: { value: 'bassi maestro' } });
    await waitFor(() => expect(listTitles()).toEqual(['Capirai', 'Foto di gruppo']));
    fireEvent.click(within(panel()).getByRole('button', { name: /^▶ (Play|Suona)/ }));
    const [key, queue] = fns.playSong.mock.calls[0] as [string, AggregatedSong[]];
    expect(key).toBe('bassi maestro::capirai');
    expect(queue.map((s) => s.songKey)).toEqual(['bassi maestro::capirai', 'bassi maestro::foto di gruppo']);
  });

  it('an artist can be chosen even if all his songs are files', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(listTitles()).toHaveLength(5));
    const artists = within(panel()).getByText('Artist', { selector: 'legend' }).closest('fieldset') as HTMLElement;
    fireEvent.click(within(artists).getByRole('button', { name: /^Bassi Maestro/ }));
    await waitFor(() => expect(listTitles()).toEqual(['Capirai', 'Foto di gruppo']));
  });

  it('a choice that is still on keeps taking from everything after the panel is closed; with none, the list is the journal again', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(listTitles()).toHaveLength(5));
    fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Search songs' }), { target: { value: 'capirai' } });
    await waitFor(() => expect(listTitles()).toEqual(['Capirai']));
    fireEvent.click(within(panel()).getByRole('button', { name: /Close|Chiudi/ }));
    await waitFor(() => expect(screen.queryByTestId('choose-panel')).toBeNull());
    expect(listTitles()).toEqual(['Capirai']);
    // clear the search: nothing is chosen, nothing is open: the journal's list, as the page opens
    fireEvent.click(toggleButton());
    fireEvent.change(within(await screen.findByTestId('choose-panel')).getByRole('searchbox', { name: 'Search songs' }), { target: { value: '' } });
    fireEvent.click(within(panel()).getByRole('button', { name: /Close|Chiudi/ }));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Like a Prayer']));
  });

  it('the other shelves stay the journal\'s: with the panel open «to listen» is not flooded with files (they have no listening history)', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await waitFor(() => expect(listTitles()).toHaveLength(5));
    fireEvent.click(screen.getByRole('tab', { name: 'To listen' }));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Like a Prayer']));
    fireEvent.click(screen.getByRole('tab', { name: '⭐' }));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean']));
  });
});

describe('a playlist can hold songs that are only files', () => {
  const PLAYLISTS: PlaylistSummary[] = [{ id: 'p1', name: 'Mix', songCount: 2, createdAt: '', updatedAt: '' }];
  const DETAIL: PlaylistDetail = {
    id: 'p1', name: 'Mix', songCount: 2, createdAt: '', updatedAt: '', songKeys: ['bassi maestro::capirai', 'madonna::like a prayer'],
  };

  it('picked from the panel it lists the file-only song too, in ITS order', async () => {
    servePlaylistPages(() => PLAYLISTS);
    vi.mocked(api.fetchPlaylist).mockResolvedValue(DETAIL);
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    await openPanel();
    await choosePlaylist(panel(), 'Mix');
    await waitFor(() => expect(listTitles()).toEqual(['Capirai', 'Like a Prayer']));
  });
});

describe('thousands of songs: the first rows are drawn, «Show more» adds the rest', () => {
  const MANY = Array.from({ length: 350 }, (_, n) => posted(`Artist ${String(n).padStart(3, '0')}`, `Song ${String(n).padStart(3, '0')}`));

  it('draws 300 rows of 350 and says so; «Show 50 more» draws the rest', async () => {
    vi.mocked(api.fetchSongs).mockResolvedValue(MANY);
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(300));
    expect(screen.getByTestId('shown-songs')).toHaveTextContent('Showing 300 of 350');
    expect(document.querySelector('.player-car-count')).toHaveTextContent('350');
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(listTitles()).toHaveLength(350));
    expect(screen.queryByTestId('shown-songs')).toBeNull();
  });

  it('a short list shows no such line', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    expect(screen.queryByTestId('shown-songs')).toBeNull();
  });
});

describe('the saved queue may hold songs that are only files', () => {
  it('the page gives the player the journal AND a way to get everything, for a queue the journal does not know', async () => {
    renderPage();
    await waitFor(() => expect(fns.hydrateQueue).toHaveBeenCalledTimes(1));
    const [catalog, loadFull] = fns.hydrateQueue.mock.calls[0] as [AggregatedSong[], () => Promise<AggregatedSong[]>];
    expect(catalog).toEqual(JOURNAL);
    expect(askedEverything()).toBe(0); // nothing is fetched unless the player needs it
    expect(await loadFull()).toEqual(EVERY);
    expect(askedEverything()).toBe(1);
  });
});
