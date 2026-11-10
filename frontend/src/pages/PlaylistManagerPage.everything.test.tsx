import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PlaylistManagerPage } from './PlaylistManagerPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryFactsCache } from '../hooks/usePlaylistManager';
import * as api from '../services/api';
import { locationButton, pickerDialog, servePlaylistPages } from '../testing/managerPicker';
import type { AggregatedSong, MeResponse, PlaylistDetail } from '../types';

// Michele, 8 November: «anche la creazione delle playlist, la ricerca deve prendere da tutto e non solo dalla libreria»
// (spec 2026-11-08-playlist-search-everything-design.md). The manager's list is EVERYTHING SoundReel knows: the journal's songs and
// the songs that exist only as files (geekom's library, the NAS), so searching for a song to put in a playlist finds them all.

vi.mock('../player/PlayerContext', () => ({
  usePlayer: () => ({ playSong: vi.fn(), downloadStates: {} }),
}));

vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  fetchPlaylists: vi.fn(),
  fetchPlaylistsPage: vi.fn(),
  fetchPlaylist: vi.fn(),
  fetchMe: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchAllEntrySummaries: vi.fn(),
  addSongToPlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
  reorderPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  fetchPlaylistShares: vi.fn(),
  sharePlaylistWith: vi.fn(),
  unsharePlaylistWith: vi.fn(),
  createDynamicPlaylist: vi.fn(),
  updatePlaylistRule: vi.fn(),
  fetchDynamicPresets: vi.fn().mockResolvedValue([]),
}));

const AIR = 'air::sexy boy';
const DAFT = 'daft punk::one more time';
const CAPIRAI = 'bassi maestro::capirai';
const FOTO = 'bassi maestro::foto di gruppo';
const NOCHE = 'el raton::una noche';
const GHOST = 'ghost::not mine';

const post = (key: string, createdAt: string): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [{ entryId: `e-${key}`, createdAt }], meta: null };
};

/** A song that exists only as a file: no post, no mentions, no metadata (what `GET /api/songs?scope=everything` adds). */
const file = (key: string, album: string | null = null): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, inLibrary: true, fs: false, mediaServer: true, libraryOnly: true };
};

const SONGS: AggregatedSong[] = [
  post(AIR, '2026-05-05T00:00:00Z'),
  post(DAFT, '2026-05-03T00:00:00Z'),
  file(CAPIRAI, "L'ultimo testimone"),
  file(FOTO, 'Bassi Maestro'),
  file(NOCHE),
];

const ME: MeResponse = {
  user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true,
  family: [{ id: 'mike', displayName: 'Michele' }],
};

/** In-memory backend with one playlist of mine, like the real service (keys in order). */
function fakeBackend(keys: string[]) {
  const list = { name: 'Mine', keys: [...keys] };
  const detail = (): PlaylistDetail => ({
    id: 'p1', name: list.name, ownerUser: 'mike', songCount: list.keys.length,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', songKeys: [...list.keys],
  });
  vi.mocked(api.fetchPlaylists).mockImplementation(async () => {
    const { songKeys: _keys, ...summary } = detail();
    void _keys;
    return [summary];
  });
  servePlaylistPages(() => {
    const { songKeys: _keys, ...summary } = detail();
    void _keys;
    return [summary];
  });
  vi.mocked(api.fetchPlaylist).mockImplementation(async () => detail());
  vi.mocked(api.addSongToPlaylist).mockImplementation(async (_id, key) => {
    if (!list.keys.includes(key)) list.keys.push(key);
    return detail();
  });
  return list;
}

async function setup(songs: AggregatedSong[] = SONGS, playlistKeys: string[] = [AIR]) {
  const backend = fakeBackend(playlistKeys);
  vi.mocked(api.fetchSongs).mockResolvedValue(songs);
  vi.mocked(api.fetchMe).mockResolvedValue(ME);
  vi.mocked(api.fetchAllEntrySummaries).mockResolvedValue([]);
  vi.mocked(api.fetchPlaylistShares).mockResolvedValue({ playlistId: 'p1', sharedWith: [], family: [] });
  render(
    <LanguageProvider>
      <MemoryRouter>
        <PlaylistManagerPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
  const listA = await screen.findByRole('listbox', { name: /Pane A/ });
  const listB = screen.getByRole('listbox', { name: /Pane B/ });
  await waitFor(() => expect(locationButton('B')).toHaveTextContent('Mine'));
  await waitFor(() => expect(within(listB).queryByText('Loading...')).not.toBeInTheDocument());
  return { backend, listA, listB };
}

const focus = (el: HTMLElement) => act(() => { el.focus(); });
const rowsOf = (list: HTMLElement) => within(list).queryAllByRole('option');
const row = (list: HTMLElement, title: string) => {
  const found = rowsOf(list).find((r) => within(r).queryByText(title) !== null);
  if (!found) throw new Error(`no row for ${title}`);
  return found;
};
const key = (target: Element | Document, k: string) => fireEvent.keyDown(target, { key: k });
const searchA = () => screen.getByRole('searchbox', { name: /\(Pane A\)/ });
const type = (el: HTMLElement, text: string) => fireEvent.change(el, { target: { value: text } });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetEntryFactsCache();
  setStoredLanguage('en');
});

describe('the manager lists EVERYTHING, not only the journal', () => {
  it('asks the server for everything, and the pane is called «All songs» with the whole count', async () => {
    const { listA } = await setup();
    expect(api.fetchSongs).toHaveBeenCalledWith('everything');
    expect(rowsOf(listA)).toHaveLength(5);
    // the left pane is on it, and the right pane offers it first in its choice of a place
    expect(locationButton('A')).toHaveTextContent('All songs (5)');
    await userEvent.click(locationButton('B'));
    expect(within(pickerDialog()).getByRole('button', { name: 'All songs (5)' })).toBeInTheDocument();
  });

  it('a song that exists only as a file is a row like the others, and says so with a badge', async () => {
    const { listA } = await setup();
    const capirai = row(listA, 'capirai');
    expect(within(capirai).getByText('File only')).toHaveAttribute('title', expect.stringMatching(/only as a file/));
    expect(within(row(listA, 'sexy boy')).queryByText('File only')).not.toBeInTheDocument();
    // it is at home: the green dot and the place badge, because the server knows where the file is
    expect(within(capirai).getByRole('img', { name: 'downloaded' })).toBeInTheDocument();
    expect(capirai.querySelector('.loc-badge')).not.toBeNull();
    expect(capirai.classList.contains('is-missing')).toBe(false);
  });
});

describe('the journal summaries are not fetched for songs that have no post', () => {
  it('journal songs that carry platforms and tags + songs that are only files: the heavy summaries are never asked for', async () => {
    const withFacets = (x: AggregatedSong): AggregatedSong => ({ ...x, platforms: ['instagram'], tags: [] });
    await setup([withFacets(post(AIR, '2026-05-05T00:00:00Z')), file(CAPIRAI), file(FOTO)]);
    expect(api.fetchAllEntrySummaries).not.toHaveBeenCalled();
  });

  it('but a journal song without them still makes the page derive them (an old backend)', async () => {
    await setup([post(AIR, '2026-05-05T00:00:00Z'), file(CAPIRAI)]);
    await waitFor(() => expect(api.fetchAllEntrySummaries).toHaveBeenCalledTimes(1));
  });
});

describe('the search takes from everything', () => {
  it('«bassi maestro» finds the files nobody ever posted', async () => {
    const { listA } = await setup();
    type(searchA(), 'bassi maestro');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(2));
    expect(rowsOf(listA).map((r) => r.textContent).join(' ')).toMatch(/capirai.*foto di gruppo/is);
  });

  it('the order of the words does not matter, and the album counts', async () => {
    const { listA } = await setup();
    type(searchA(), 'maestro bassi');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(2));
    type(searchA(), 'testimone');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(1));
    expect(within(rowsOf(listA)[0]).getByText('capirai')).toBeInTheDocument();
  });
});

describe('creating a playlist with songs that are only files', () => {
  it('F5 adds a file-only song to the playlist of the other pane: it is a real song, not a placeholder that is skipped', async () => {
    const { listA, backend } = await setup();
    type(searchA(), 'capirai');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(1));
    focus(listA);
    key(listA, ' ');
    key(listA, 'F5');
    await waitFor(() => expect(api.addSongToPlaylist).toHaveBeenCalledWith('p1', CAPIRAI));
    expect(backend.keys).toEqual([AIR, CAPIRAI]);
    await waitFor(() => expect(screen.getAllByRole('status').map((s) => s.textContent).join(' ')).toMatch(/Copy: 1 added/));
  });

  it('a playlist that already holds a file-only song (put there from «Cerca» in Mondrop) shows it as a real row, not as «not in your journal»', async () => {
    const { listB } = await setup(SONGS, [CAPIRAI, GHOST]);
    await waitFor(() => expect(rowsOf(listB)).toHaveLength(2));
    const capirai = row(listB, 'capirai');
    expect(capirai.classList.contains('is-missing')).toBe(false);
    expect(within(capirai).getByText('File only')).toBeInTheDocument();
    // only the key nobody knows (not in the journal, not a file) stays a placeholder
    expect(row(listB, 'not mine').classList.contains('is-missing')).toBe(true);
    expect(within(screen.getByRole('region', { name: /Pane B/ })).getByText(/1 song.*not in your journal/i)).toBeInTheDocument();
  });
});

describe('thousands of songs: the first rows are drawn, «Show more» adds the rest', () => {
  const MANY: AggregatedSong[] = [
    post(AIR, '2026-05-05T00:00:00Z'),
    ...Array.from({ length: 349 }, (_, n) => file(`artist ${String(n).padStart(3, '0')}::song ${String(n).padStart(3, '0')}`)),
  ];

  it('draws 300 rows of 350 and says so; «Show 50 more» draws the rest', async () => {
    const { listA } = await setup(MANY, []);
    expect(rowsOf(listA)).toHaveLength(300);
    expect(screen.getByTestId('shown-a')).toHaveTextContent('Showing 300 of 350');
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(350));
    expect(screen.queryByTestId('shown-a')).not.toBeInTheDocument();
  });

  it('a search covers ALL the songs, not only the drawn ones, and starts again from the first rows', async () => {
    const { listA } = await setup(MANY, []);
    fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(350));
    type(searchA(), 'song 340'); // a song that was NOT among the first 300
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(1));
    expect(within(rowsOf(listA)[0]).getByText('song 340')).toBeInTheDocument();
    type(searchA(), '');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(300)); // the full list again, from the first rows
  });

  it('the cursor is always drawn: End goes to the last song even if it was not among the first rows', async () => {
    const { listA } = await setup(MANY, []);
    focus(listA);
    key(listA, 'End');
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(350));
    const last = rowsOf(listA)[349];
    expect(last).toHaveClass('is-cursor');
    expect(listA.getAttribute('aria-activedescendant')).toBe(last.id);
  });
});
