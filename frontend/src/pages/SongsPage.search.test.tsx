import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SongsPage } from './SongsPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import * as api from '../services/api';
import type { AggregatedSong, LibraryHit, LibrarySearchResponse } from '../types';

// The Songs page searches three places (spec 2026-11-07-library-search-music-folders-design.md): the library
// (the journal songs, filtered in the page as ever), the media server and the local files (asked of the server).

vi.mock('../player/PlayerContext', () => ({ usePlayer: () => ({ playSong: vi.fn() }) }));
vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  patchSongMeta: vi.fn(),
  searchLibrary: vi.fn(),
  fetchMe: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchPlaylists: vi.fn().mockResolvedValue([]),
  fetchPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
  fetchSongPreview: vi.fn(),
  fetchSongFileInfo: vi.fn(),
}));

const song = (key: string, created: string): AggregatedSong => {
  const [artist, title] = key.split('::');
  return { songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [{ entryId: `e-${key}`, createdAt: created }], meta: null };
};
const JOURNAL = [song('air::sexy boy', '2026-05-05T00:00:00Z'), song('daft punk::one more time', '2026-05-04T00:00:00Z')];

const MEDIA_URL = 'http://192.168.178.10:49152/Music/Bassi%20Maestro/Metropolis.mp3';
const LOCAL_PATH = '~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3';
const hits: LibraryHit[] = [
  { scope: 'media', artist: 'Bassi Maestro', title: 'Metropolis', album: 'Il Fuoriclasse', folder: 'Media server', location: MEDIA_URL, bytes: 5_000_000, songKey: 'bassi maestro::metropolis', inJournal: false },
  { scope: 'local', artist: 'Bassi Maestro', title: 'Foto di gruppo', album: null, folder: 'Libreria (Spooty)', location: LOCAL_PATH, bytes: 4_000_000, songKey: 'bassi maestro::foto di gruppo', inJournal: false },
];
const answer = (q: string, counts = { songs: 0, media: 2, local: 41 }, results = hits): LibrarySearchResponse => ({ q, scope: 'all', counts, results });

function renderPage() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <SongsPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

const box = () => screen.getByPlaceholderText(/🔍/);
const scopeSelect = () => screen.getByRole('combobox', { name: 'Search in' });
const type = (text: string) => fireEvent.change(box(), { target: { value: text } });
const cards = () => document.querySelectorAll('.list-item-row');

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('en');
  vi.mocked(api.fetchSongs).mockResolvedValue(JOURNAL);
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true, family: [] });
  vi.mocked(api.searchLibrary).mockImplementation(async (q) => answer(q));
});

async function ready() {
  renderPage();
  await screen.findByPlaceholderText(/🔍/);
}

describe('the scope selector next to the search box', () => {
  it('is "Search in", Library by default, with the three places and everything', async () => {
    await ready();
    expect(scopeSelect()).toHaveValue('songs');
    expect(within(scopeSelect()).getAllByRole('option').map((o) => o.textContent)).toEqual(['Library', 'Media server', 'Local files', 'Everything']);
  });

  it('in the Library scope the page filters the journal songs as it always did', async () => {
    await ready();
    expect(cards().length).toBe(2);
    type('sexy');
    await waitFor(() => expect(cards().length).toBe(1));
    expect(screen.getByText('sexy boy')).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Sort by' })).toBeInTheDocument();
  });
});

describe('asking the server', () => {
  it('does not ask under 2 characters', async () => {
    await ready();
    type('s');
    await new Promise((resolve) => { setTimeout(resolve, 450); });
    expect(api.searchLibrary).not.toHaveBeenCalled();
  });

  it('asks once after a pause of ~300 ms, for ALL scopes (the server only counts the scopes it searched), 100 at most each', async () => {
    await ready();
    type('bassi');
    type('bassi maestro');
    expect(api.searchLibrary).not.toHaveBeenCalled(); // still debouncing
    await waitFor(() => expect(api.searchLibrary).toHaveBeenCalledTimes(1));
    expect(vi.mocked(api.searchLibrary).mock.calls[0].slice(0, 3)).toEqual(['bassi maestro', 'all', 100]);
  });

  it('shows the count of each scope in the selector once the answer is in', async () => {
    await ready();
    type('bassi maestro');
    await waitFor(() => expect(within(scopeSelect()).getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Library (0)', 'Media server (2)', 'Local files (41)', 'Everything (43)',
    ]));
  });

  it('choosing another scope filters what is already there: no new request', async () => {
    await ready();
    type('bassi maestro');
    await waitFor(() => expect(within(scopeSelect()).getByRole('option', { name: 'Local files (41)' })).toBeInTheDocument());
    fireEvent.change(scopeSelect(), { target: { value: 'media' } });
    fireEvent.change(scopeSelect(), { target: { value: 'local' } });
    fireEvent.change(scopeSelect(), { target: { value: 'all' } });
    expect(api.searchLibrary).toHaveBeenCalledTimes(1);
  });
});

describe('finding songs the library does not know (the case that started it)', () => {
  it('no library match but matches elsewhere: says so and offers them; a click shows them', async () => {
    await ready();
    type('bassi maestro');
    const hint = await screen.findByTestId('elsewhere-hint');
    expect(hint).toHaveTextContent('No library song matches.');
    expect(within(hint).getByRole('button', { name: 'Media server (2)' })).toBeInTheDocument();
    fireEvent.click(within(hint).getByRole('button', { name: 'Local files (41)' }));
    expect(scopeSelect()).toHaveValue('local');
    const results = await screen.findByRole('region', { name: 'Search results' });
    expect(within(results).getByText('Foto di gruppo')).toBeInTheDocument();
    expect(within(results).getByText(LOCAL_PATH)).toBeInTheDocument();
  });

  it('the hint is gone when the library has a match', async () => {
    await ready();
    type('sexy');
    await waitFor(() => expect(api.searchLibrary).toHaveBeenCalled());
    await waitFor(() => expect(within(scopeSelect()).getByRole('option', { name: /^Local files \(/ })).toBeInTheDocument());
    expect(screen.queryByTestId('elsewhere-hint')).toBeNull();
  });

  it('"Local files" replaces the song cards with where the files are, copyable, and shows how many there are', async () => {
    await ready();
    type('bassi maestro');
    await waitFor(() => expect(within(scopeSelect()).getByRole('option', { name: 'Local files (41)' })).toBeInTheDocument());
    fireEvent.change(scopeSelect(), { target: { value: 'local' } });
    const results = await screen.findByRole('region', { name: 'Search results' });
    expect(cards().length).toBe(0);
    expect(within(results).getByText('Foto di gruppo')).toBeInTheDocument();
    expect(within(results).queryByText('Metropolis')).toBeNull(); // that is the media server's
    expect(within(results).getByRole('button', { name: 'Copy Bassi Maestro – Foto di gruppo: path' })).toBeInTheDocument();
    expect(document.querySelector('.filter-result-count')).toHaveTextContent('41');
  });

  it('"Everything" shows every place, grouped', async () => {
    await ready();
    type('bassi maestro');
    await waitFor(() => expect(within(scopeSelect()).getByRole('option', { name: 'Everything (43)' })).toBeInTheDocument());
    fireEvent.change(scopeSelect(), { target: { value: 'all' } });
    const results = await screen.findByRole('region', { name: 'Search results' });
    expect(within(results).getByRole('heading', { name: 'Media server 2' })).toBeInTheDocument();
    expect(within(results).getByRole('heading', { name: 'Local files 41' })).toBeInTheDocument();
    expect(within(results).getByText(MEDIA_URL)).toBeInTheDocument();
    expect(document.querySelector('.filter-result-count')).toHaveTextContent('43');
  });

  it('the journal controls (sort, filters, playlists) go away with the cards and come back with the Library', async () => {
    await ready();
    expect(screen.getByRole('button', { name: /Filters/ })).toBeInTheDocument();
    fireEvent.change(scopeSelect(), { target: { value: 'media' } });
    expect(screen.queryByRole('button', { name: /^Filters/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Sort by' })).toBeNull();
    fireEvent.change(scopeSelect(), { target: { value: 'songs' } });
    expect(screen.getByRole('button', { name: /Filters/ })).toBeInTheDocument();
    expect(cards().length).toBe(2);
  });
});

describe('what the files view says when there is nothing to show yet', () => {
  it('asks for 2 characters instead of an empty page', async () => {
    await ready();
    fireEvent.change(scopeSelect(), { target: { value: 'local' } });
    expect(screen.getByText('Type at least 2 characters to search the files.')).toBeInTheDocument();
    type('b');
    expect(screen.getByText('Type at least 2 characters to search the files.')).toBeInTheDocument();
  });

  it('no match anywhere: says so, with no pointers', async () => {
    vi.mocked(api.searchLibrary).mockImplementation(async (q) => answer(q, { songs: 0, media: 0, local: 0 }, []));
    await ready();
    fireEvent.change(scopeSelect(), { target: { value: 'local' } });
    type('zzzzz');
    expect(await screen.findByTestId('lib-summary')).toHaveTextContent('No results for “zzzzz” in Local files.');
    expect(screen.queryByText('Found elsewhere:')).toBeNull();
  });

  it('a failing search is an alert with a retry that asks again', async () => {
    vi.mocked(api.searchLibrary).mockRejectedValueOnce(new Error('{"error":"library search failed"}'));
    await ready();
    fireEvent.change(scopeSelect(), { target: { value: 'local' } });
    type('bassi');
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Search is not available right now.');
    fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('region', { name: 'Search results' })).toBeInTheDocument();
    expect(api.searchLibrary).toHaveBeenCalledTimes(2);
  });

  it('is in Italian: "Cerca in", "File locali"', async () => {
    setStoredLanguage('it');
    await ready();
    expect(screen.getByRole('combobox', { name: 'Cerca in' })).toBeInTheDocument();
    expect(within(screen.getByRole('combobox', { name: 'Cerca in' })).getByRole('option', { name: 'File locali' })).toBeInTheDocument();
  });
});

describe('the link of "Versione di" (/songs?q=…)', () => {
  it('opens the page already searching for that title', async () => {
    render(
      <LanguageProvider>
        <MemoryRouter initialEntries={['/songs?q=sexy%20boy']}>
          <SongsPage />
        </MemoryRouter>
      </LanguageProvider>,
    );
    await waitFor(() => expect(document.querySelectorAll('.list-item-row').length).toBe(1));
    expect((box() as HTMLInputElement).value).toBe('sexy boy');
    expect(document.body.textContent).toContain('sexy boy');
    expect(document.body.textContent).not.toContain('one more time');
  });

  it('without a q the page lists everything, as ever', async () => {
    renderPage();
    await waitFor(() => expect(document.querySelectorAll('.list-item-row').length).toBe(2));
    expect((box() as HTMLInputElement).value).toBe('');
  });
});
