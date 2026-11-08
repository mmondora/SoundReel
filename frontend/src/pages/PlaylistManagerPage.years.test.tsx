import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlaylistManagerPage } from './PlaylistManagerPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryFactsCache } from '../hooks/usePlaylistManager';
import * as api from '../services/api';
import type { AggregatedSong, MeResponse, SongMetaRecord } from '../types';

// The Playlist manager filters by "Anni" (decades) with the same engine as the player (utils/managerSongs).

vi.mock('../player/PlayerContext', () => ({ usePlayer: () => ({ playSong: vi.fn(), downloadStates: {} }) }));
vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  fetchPlaylists: vi.fn(),
  fetchPlaylist: vi.fn(),
  fetchMe: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchAllEntrySummaries: vi.fn(),
  fetchSongState: vi.fn(),
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

const meta = (key: string, year: number | null, genres: string[] = []): SongMetaRecord => ({
  songKey: key, deezerId: null, itunesId: null, genres, album: null, releaseYear: year, coverUrl: null, previewUrl: null,
  deezerUrl: null, itunesUrl: null, enrichedAt: null, listened: false, favorite: false, downloaded: false, rating: null, score: null,
});

function song(key: string, year: number | null | undefined, genres: string[] = []): AggregatedSong {
  const [artist, title] = key.split('::');
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt: '2026-05-01T00:00:00Z' }],
    meta: year === undefined ? null : meta(key, year, genres),
  };
}

const ME: MeResponse = { user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true, family: [{ id: 'mike', displayName: 'Michele' }] };

async function setup(songs: AggregatedSong[]) {
  vi.mocked(api.fetchSongs).mockResolvedValue(songs);
  vi.mocked(api.fetchPlaylists).mockResolvedValue([]);
  vi.mocked(api.fetchMe).mockResolvedValue(ME);
  vi.mocked(api.fetchAllEntrySummaries).mockResolvedValue([]);
  render(
    <LanguageProvider>
      <MemoryRouter>
        <PlaylistManagerPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
  const listA = await screen.findByRole('listbox', { name: /(Pane|Pannello) A/ });
  await waitFor(() => expect(within(listA).getAllByRole('option').length).toBe(songs.length));
  return listA;
}

const openFilters = () => fireEvent.click(screen.getAllByRole('button', { name: /^(Filters|Filtri)/ })[0]);
const titles = (list: HTMLElement) => within(list).getAllByRole('option').map((r) => r.querySelector('.mgr-title')?.textContent);
const yearsGroup = () => screen.getAllByText('Years').map((l) => l.closest('fieldset') as HTMLElement)[0];

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetEntryFactsCache();
  setStoredLanguage('en');
});

const SONGS = [
  song('a::eighties one', 1982, ['Pop']),
  song('b::eighties two', 1989, ['Rock']),
  song('c::nineties', 1990, ['Pop']),
  song('d::two thousands', 2001, ['Pop']),
  song('e::mystery', null),
  song('f::no data', undefined),
];

describe('"Years" in the Playlist manager filters', () => {
  it('lists the decades in the order of time with a count each, and "No year" last', async () => {
    await setup(SONGS);
    openFilters();
    const group = yearsGroup();
    expect(group).toBeInTheDocument();
    const chips = within(group).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    expect(chips).toEqual(['1980s 2', '1990s 1', '2000s 1', 'No year 2']);
  });

  it('1989 is in the eighties and 1990 is not', async () => {
    const listA = await setup(SONGS);
    openFilters();
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1980s/ }));
    await waitFor(() => expect(titles(listA)).toEqual(['eighties one', 'eighties two']));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1980s/ }));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1990s/ }));
    await waitFor(() => expect(titles(listA)).toEqual(['nineties']));
  });

  it('several decades are an OR; "No year" finds the songs nobody dated (with or without meta)', async () => {
    const listA = await setup(SONGS);
    openFilters();
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1980s/ }));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^2000s/ }));
    await waitFor(() => expect(titles(listA)).toEqual(['eighties one', 'eighties two', 'two thousands']));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1980s/ }));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^2000s/ }));
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^No year/ }));
    await waitFor(() => expect(titles(listA)).toEqual(['mystery', 'no data']));
  });

  it('is a pressed-state toggle, shows in the filter count, and "Reset filters" clears it', async () => {
    const listA = await setup(SONGS);
    openFilters();
    const chip = within(yearsGroup()).getByRole('button', { name: /^1990s/ });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip);
    expect(within(yearsGroup()).getByRole('button', { name: /^1990s/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByRole('button', { name: /^Filters \(1\)/ }).length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByRole('button', { name: 'Reset filters' })[0]);
    await waitFor(() => expect(titles(listA)).toHaveLength(SONGS.length));
    expect(within(yearsGroup()).getByRole('button', { name: /^1990s/ })).toHaveAttribute('aria-pressed', 'false');
  });

  it('counts follow the other filters (a genre narrows the decades, never its own heading)', async () => {
    await setup(SONGS);
    openFilters();
    const typeGroup = screen.getAllByText('Type (genre)').map((l) => l.closest('fieldset') as HTMLElement)[0];
    fireEvent.click(within(typeGroup).getByRole('button', { name: /^Rock/ }));
    const chips = within(yearsGroup()).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim());
    // only the 1989 Rock song is left: the other decades have nothing to offer under that genre, so they drop out
    expect(chips).toEqual(['1980s 1']);
  });

  it('a picked value that has nothing left under the other filters stays, with a 0, so it can be undone', async () => {
    const listA = await setup(SONGS);
    openFilters();
    const typeGroup = () => screen.getAllByText('Type (genre)').map((l) => l.closest('fieldset') as HTMLElement)[0];
    fireEvent.click(within(typeGroup()).getByRole('button', { name: /^Rock/ }));
    fireEvent.click(within(typeGroup()).getByRole('button', { name: /^Pop/ })); // Rock OR Pop
    fireEvent.click(within(yearsGroup()).getByRole('button', { name: /^1990s/ })); // …in the nineties Rock has nothing
    await waitFor(() => expect(titles(listA)).toEqual(['nineties']));
    const rock = within(typeGroup()).getByRole('button', { name: /^Rock/ });
    expect(rock).toHaveAttribute('aria-pressed', 'true');
    expect(rock).toHaveTextContent('0');
    fireEvent.click(rock);
    expect(within(typeGroup()).queryByRole('button', { name: /^Rock/ })).toBeNull();
  });

  it('says it in Italian: "Anni 80", "Anni 2000", "Senza anno"', async () => {
    setStoredLanguage('it');
    await setup(SONGS);
    openFilters();
    const group = screen.getAllByText('Anni').map((l) => l.closest('fieldset') as HTMLElement)[0];
    expect(within(group).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Anni 80 2', 'Anni 90 1', 'Anni 2000 1', 'Senza anno 2',
    ]);
  });

  it('is not offered at all while no song has a year yet (the background fill has not run)', async () => {
    await setup([song('a::one', null, ['Pop']), song('b::two', undefined)]);
    openFilters();
    expect(screen.queryByText('Years')).toBeNull();
  });
});
