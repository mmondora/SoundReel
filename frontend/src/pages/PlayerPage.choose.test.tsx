import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { PlayerPage } from './PlayerPage';
import { PHONE_QUERY } from '../hooks/useMediaQuery';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryThumbnailCache } from '../hooks/useEntryThumbnail';
import * as api from '../services/api';
import { choosePlaylist, playlistButton, pickerDialog, servePlaylistPages } from '../testing/managerPicker';
import type { AggregatedSong, PlaylistDetail, PlaylistSummary } from '../types';

// "Scegli cosa suonare" in the web player (spec 2026-11-08-player-selection-and-filters-design.md X4): filters by type,
// years ("Anni 80"), album and author with counts, a search box and a playlist; the result becomes the queue.

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

interface Opts {
  album?: string;
  year?: number | null;
  genres?: string[];
  inLibrary?: boolean;
  mediaServer?: boolean;
  platforms?: string[];
  tags?: string[];
  noMeta?: boolean;
  favorite?: boolean;
}

function mk(artist: string, title: string, o: Opts = {}): AggregatedSong {
  const key = `${artist.toLowerCase()}::${title.toLowerCase()}`;
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt: '2026-05-01T00:00:00Z' }],
    meta: o.noMeta ? null : {
      songKey: key, deezerId: null, itunesId: null, genres: o.genres ?? [], album: o.album ?? null, releaseYear: o.year ?? null,
      coverUrl: null, previewUrl: null, deezerUrl: null, itunesUrl: null, enrichedAt: null, listened: false,
      favorite: o.favorite ?? false, downloaded: false, rating: null, score: null,
    },
    inLibrary: o.inLibrary ?? false,
    ...(o.mediaServer !== undefined ? { fs: o.inLibrary ?? false, mediaServer: o.mediaServer } : {}),
    ...(o.platforms ? { platforms: o.platforms } : {}),
    ...(o.tags ? { tags: o.tags } : {}),
  };
}

const SONGS: AggregatedSong[] = [
  mk('Michael Jackson', 'Billie Jean', { album: 'Thriller', genres: ['Pop'], year: 1982, platforms: ['instagram'] }),
  mk('Michael Jackson', 'Beat It', { album: 'Thriller', genres: ['Pop', 'Rock'], year: 1982, inLibrary: true, mediaServer: false }),
  mk('Madonna', 'Like a Prayer', { album: 'Like a Prayer', genres: ['Pop'], year: 1989, platforms: ['tiktok'] }),
  mk('Radiohead', 'Creep', { album: 'Pablo Honey', genres: ['Alternativa'], year: 1990, inLibrary: true, mediaServer: true }),
  mk('Foo Fighters', 'Everlong', { album: 'The Colour and the Shape', genres: ['Alternative'], year: 1997 }),
  mk('Daft Punk', 'One More Time', { album: 'Discovery', genres: ['Electronic'], year: 2001, inLibrary: true, mediaServer: true }),
  mk('Daft Punk', 'Around the World', { album: 'Homework', genres: ['Elettronica'], year: 1997 }),
  mk('Bassi Maestro', 'Il Mio Ragazzo', { album: 'Fastidio', genres: ['Rap/Hip Hop'], year: 2000 }),
  mk('Unknown Artist', 'Mystery', { noMeta: true }),
];
const keysOf = (...titles: string[]): string[] => SONGS.filter((s) => titles.includes(s.title)).map((s) => s.songKey);

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
const group = (legend: string) => within(panel()).getByText(legend, { selector: 'legend' }).closest('fieldset') as HTMLElement;
const chip = (legend: string, label: RegExp | string) => within(group(legend)).getByRole('button', { name: label });
const playButton = () => within(panel()).getByRole('button', { name: /^▶ (Play|Suona)/ });

async function open() {
  renderPage();
  await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
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
  vi.mocked(api.fetchSongs).mockResolvedValue(SONGS);
  vi.mocked(api.fetchPlaylists).mockResolvedValue([]);
  vi.mocked(api.getEntry).mockRejectedValue(new Error('not needed'));
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
});

describe('the panel', () => {
  it('is closed until asked for, and the button says so', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
    expect(toggleButton()).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('choose-panel')).toBeNull();
    fireEvent.click(toggleButton());
    expect(await screen.findByTestId('choose-panel')).toBeInTheDocument();
    expect(toggleButton()).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggleButton());
    expect(screen.queryByTestId('choose-panel')).toBeNull();
  });

  it('offers type, years, album and author with the number of songs behind each', async () => {
    await open();
    // type: the synonyms are one chip. "Electronic" and "Elettronica" are spelt once each: the canonical name wins
    // the tie; "Rap/Hip Hop" is the only spelling the data has, so that is how it is shown.
    expect(within(group('Type')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Pop 3', 'Alternative 2', 'Elettronica 2', 'Rap/Hip Hop 1', 'Rock 1',
    ]);
  });

  it('years: the decades in the order of time, "No year" last', async () => {
    await open();
    expect(within(group('Years')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '1980s 3', '1990s 3', '2000s 2', 'No year 1',
    ]);
  });

  it('says it in Italian: "Anni 80", "Senza anno", "Scegli cosa suonare"', async () => {
    setStoredLanguage('it');
    await open();
    expect(within(group('Anni')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      'Anni 80 3', 'Anni 90 3', 'Anni 2000 2', 'Senza anno 1',
    ]);
    expect(within(panel()).getByRole('heading', { name: 'Scegli cosa suonare' })).toBeInTheDocument();
  });

  it('keeps the first 6 albums as chips and the rest in a select', async () => {
    await open();
    expect(within(group('Album')).getAllByRole('button')).toHaveLength(6);
    const more = within(group('Album')).getByRole('combobox', { name: 'More values: Album' });
    expect(within(more).getAllByRole('option')).toHaveLength(1 + 1); // the placeholder and the one album left (7 in all)
    expect(within(more).getByRole('option', { name: 'More (1)…' })).toBeInTheDocument();
  });

  it('a heading nobody can fill is not drawn (no song has a year yet)', async () => {
    vi.mocked(api.fetchSongs).mockResolvedValue([mk('A', 'one', { genres: ['Pop'] }), mk('B', 'two', { noMeta: true })]);
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    fireEvent.click(toggleButton());
    await screen.findByTestId('choose-panel');
    expect(within(panel()).queryByText('Years', { selector: 'legend' })).toBeNull();
    expect(within(panel()).getByText('Type', { selector: 'legend' })).toBeInTheDocument();
  });
});

describe('a decade becomes the queue', () => {
  it('"1980s" narrows the list, and Play makes exactly those songs the queue (1989 is in, 1990 is out)', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']));
    expect(within(panel()).getByRole('status')).toHaveTextContent('3 songs of 9');
    fireEvent.click(playButton());
    expect(fns.playSong).toHaveBeenCalledTimes(1);
    const [startKey, queue, label, playlistId] = fns.playSong.mock.calls[0] as [string, AggregatedSong[], string, string | null];
    expect(startKey).toBe(keysOf('Billie Jean')[0]);
    expect(queue.map((s) => s.title)).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']);
    expect(label).toBe('1980s');
    expect(playlistId).toBeNull();
  });

  it('1990 is the nineties', async () => {
    await open();
    fireEvent.click(chip('Years', /^1990s/));
    await waitFor(() => expect(listTitles()).toEqual(['Creep', 'Everlong', 'Around the World']));
  });

  it('two decades are an OR; "No year" is the songs nobody dated', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    fireEvent.click(chip('Years', /^2000s/));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer', 'One More Time', 'Il Mio Ragazzo']));
    fireEvent.click(chip('Years', /^1980s/));
    fireEvent.click(chip('Years', /^2000s/));
    fireEvent.click(chip('Years', /^No year/));
    await waitFor(() => expect(listTitles()).toEqual(['Mystery']));
  });

  it('a chip is a pressed-state toggle', async () => {
    await open();
    expect(chip('Years', /^1980s/)).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(chip('Years', /^1980s/));
    expect(chip('Years', /^1980s/)).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(chip('Years', /^1980s/));
    expect(chip('Years', /^1980s/)).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
  });

  it('the toggle button counts the filters, and Reset clears them', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    fireEvent.click(chip('Type', /^Pop/));
    expect(toggleButton()).toHaveTextContent('Choose what to play · 2 active filters');
    fireEvent.click(within(panel()).getByRole('button', { name: 'Reset filters' }));
    await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
    expect(toggleButton()).not.toHaveTextContent('active');
    expect(within(panel()).getByRole('button', { name: 'Reset filters' })).toBeDisabled();
  });
});

describe('counts follow the other filters', () => {
  it('picking a type narrows the years but keeps the other types to switch to', async () => {
    await open();
    fireEvent.click(chip('Type', /^Rock/));
    // only "Beat It" (1982) is a Rock song: the other decades drop out
    expect(within(group('Years')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['1980s 1']);
    expect(chip('Type', /^Pop/)).toHaveTextContent('3'); // its own heading ignores its own filter: still all three Pop songs
    await waitFor(() => expect(listTitles()).toEqual(['Beat It']));
  });

  it('picking a decade narrows the types but keeps the other decades', async () => {
    await open();
    fireEvent.click(chip('Years', /^2000s/));
    expect(within(group('Type')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim()).sort()).toEqual([
      'Electronic 1', 'Rap/Hip Hop 1',
    ]);
    expect(within(group('Years')).getAllByRole('button')).toHaveLength(4);
  });

  it('a picked value stays on screen even when the others leave it with nothing, so it can be undone', async () => {
    await open();
    fireEvent.click(chip('Type', /^Rock/));
    fireEvent.click(chip('Type', /^Alternative/)); // Rock OR Alternative
    fireEvent.click(chip('Years', /^1990s/)); // …in the nineties: Rock has nothing there (its only song is from 1982)
    const rock = chip('Type', /^Rock/);
    expect(rock).toHaveAttribute('aria-pressed', 'true');
    expect(rock).toHaveTextContent('0');
    fireEvent.click(rock); // and it can be undone
    expect(within(group('Type')).queryByRole('button', { name: /^Rock/ })).toBeNull();
  });
});

describe('album, author and one song', () => {
  it('picking an album shows only its songs and Play starts them', async () => {
    await open();
    fireEvent.click(chip('Album', /^Thriller/));
    await waitFor(() => expect(listTitles()).toEqual(['Billie Jean', 'Beat It']));
    fireEvent.click(playButton());
    const [, queue, label] = fns.playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(queue.map((s) => s.title)).toEqual(['Billie Jean', 'Beat It']);
    expect(label).toBe('Thriller');
  });

  it('picking an author from the select (an album or author beyond the chips)', async () => {
    await open();
    const more = within(group('Artist')).getByRole('combobox', { name: 'More values: Artist' });
    fireEvent.change(more, { target: { value: 'Unknown Artist' } });
    await waitFor(() => expect(listTitles()).toEqual(['Mystery']));
    expect(chip('Artist', /^Unknown Artist/)).toHaveAttribute('aria-pressed', 'true');
    // the picked value is a chip now, so the select has nothing left to offer and goes away
    expect(within(group('Artist')).queryByRole('combobox', { name: 'More values: Artist' })).toBeNull();
  });

  it('a song picked in the list starts inside the filtered result', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    await waitFor(() => expect(listTitles()).toHaveLength(3));
    fireEvent.click(screen.getByText('Beat It').closest('button') as HTMLElement);
    const [key, queue, label] = fns.playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(key).toBe(keysOf('Beat It')[0]);
    expect(queue.map((s) => s.title)).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']);
    expect(label).toBe('1980s');
  });
});

describe('search', () => {
  it('the order of the words does not matter ("Maestro Bassi" finds "Bassi Maestro")', async () => {
    await open();
    fireEvent.change(within(panel()).getByRole('searchbox', { name: 'Search songs' }), { target: { value: 'Maestro Bassi' } });
    await waitFor(() => expect(listTitles()).toEqual(['Il Mio Ragazzo']));
    fireEvent.click(playButton());
    expect((fns.playSong.mock.calls[0] as unknown[])[2]).toBe('Search: Maestro Bassi');
  });

  it('works together with the chips (AND)', async () => {
    await open();
    fireEvent.change(within(panel()).getByRole('searchbox'), { target: { value: 'michael' } });
    fireEvent.click(chip('Type', /^Rock/));
    await waitFor(() => expect(listTitles()).toEqual(['Beat It']));
  });

  it('nothing matches: says so and Play is off', async () => {
    await open();
    fireEvent.change(within(panel()).getByRole('searchbox'), { target: { value: 'zzzzzz' } });
    await waitFor(() => expect(listTitles()).toEqual([]));
    expect(within(panel()).getByText('No song matches these filters.')).toBeInTheDocument();
    expect(playButton()).toBeDisabled();
    expect(within(panel()).getByRole('button', { name: /Shuffle and play/ })).toBeDisabled();
  });
});

describe('shuffle', () => {
  it('"Shuffle and play" queues the same songs in another order, starting anywhere', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    await waitFor(() => expect(listTitles()).toHaveLength(3));
    const picks = [0.9, 0.1];
    let i = 0;
    vi.spyOn(Math, 'random').mockImplementation(() => picks[i++ % picks.length]);
    fireEvent.click(within(panel()).getByRole('button', { name: /Shuffle and play/ }));
    const [startKey, queue, label] = fns.playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(queue.map((s) => s.title).sort()).toEqual(['Beat It', 'Billie Jean', 'Like a Prayer']);
    expect(queue.map((s) => s.title)).not.toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']);
    expect(startKey).toBe(queue[0].songKey);
    expect(label).toBe('1980s');
  });
});

describe('a playlist', () => {
  const PLAYLISTS: PlaylistSummary[] = [
    { id: 'p1', name: 'Road trip', songCount: 3, createdAt: '', updatedAt: '' },
    { id: 'p2', name: 'Empty', songCount: 0, createdAt: '', updatedAt: '' },
  ];
  const DETAIL: PlaylistDetail = {
    id: 'p1', name: 'Road trip', songCount: 3, createdAt: '', updatedAt: '',
    songKeys: keysOf('Like a Prayer', 'One More Time', 'Billie Jean').reverse(),
  };

  beforeEach(() => {
    servePlaylistPages(() => PLAYLISTS);
    vi.mocked(api.fetchPlaylist).mockResolvedValue(DETAIL);
  });

  it('is picked in a dialog (asked a page at a time); the list shows its songs in ITS order, and the facets count inside it', async () => {
    await open();
    expect(playlistButton(panel())).toHaveTextContent('All songs');
    await userEvent.click(playlistButton(panel()));
    const rows = within(pickerDialog()).getAllByRole('button').filter((b) => b.hasAttribute('data-pl-option'));
    await waitFor(() => expect(within(pickerDialog()).getAllByRole('button').filter((b) => b.hasAttribute('data-pl-option'))).toHaveLength(2));
    void rows;
    expect(within(pickerDialog()).getByRole('button', { name: /^All songs/ })).toBeInTheDocument();
    await userEvent.click(within(pickerDialog()).getByRole('button', { name: /^Road trip 3 songs/ }));
    expect(playlistButton(panel())).toHaveTextContent('Road trip (3)');
    await waitFor(() => expect(listTitles()).toEqual(['One More Time', 'Like a Prayer', 'Billie Jean']));
    // opened again, the dialog marks the playlist the list comes from
    await userEvent.click(playlistButton(panel()));
    await waitFor(() => expect(within(pickerDialog()).getByRole('button', { name: /^Road trip 3 songs/ })).toHaveAttribute('aria-current', 'true'));
    expect(within(pickerDialog()).getByRole('button', { name: /^All songs/ })).not.toHaveAttribute('aria-current');
    await userEvent.keyboard('{Escape}');
    expect(api.fetchPlaylist).toHaveBeenCalledWith('p1');
    // the years offered are the ones inside the playlist
    expect(within(group('Years')).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['1980s 2', '2000s 1']);
  });

  it('plays it with its name, and a filter inside it narrows it ("Road trip · 1980s")', async () => {
    await open();
    await choosePlaylist(panel(), 'Road trip');
    await waitFor(() => expect(listTitles()).toHaveLength(3));
    fireEvent.click(playButton());
    expect((fns.playSong.mock.calls[0] as unknown[])[2]).toBe('Road trip');
    expect((fns.playSong.mock.calls[0] as unknown[])[3]).toBe('p1');
    fns.playSong.mockClear();
    fireEvent.click(chip('Years', /^1980s/));
    await waitFor(() => expect(listTitles()).toEqual(['Like a Prayer', 'Billie Jean'])); // still in the playlist's order
    fireEvent.click(playButton());
    expect((fns.playSong.mock.calls[0] as unknown[])[2]).toBe('Road trip · 1980s');
    expect(((fns.playSong.mock.calls[0] as unknown[])[1] as AggregatedSong[]).map((s) => s.title)).toEqual(['Like a Prayer', 'Billie Jean']);
  });

  it('"All songs" goes back to the whole library', async () => {
    await open();
    await choosePlaylist(panel(), 'Road trip');
    await waitFor(() => expect(listTitles()).toHaveLength(3));
    await choosePlaylist(panel(), 'library');
    await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
    expect(playlistButton(panel())).toHaveTextContent('All songs');
  });

  it('a playlist that cannot be read leaves the list as it was', async () => {
    vi.mocked(api.fetchPlaylist).mockRejectedValue(new Error('HTTP 500'));
    await open();
    await choosePlaylist(panel(), 'Road trip');
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect(listTitles()).toHaveLength(SONGS.length);
  });

  it('the whole list of playlists is never asked for: the dialog asks a page of them, and only when it is opened', async () => {
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(SONGS.length));
    fireEvent.click(toggleButton());
    await screen.findByTestId('choose-panel');
    expect(api.fetchPlaylists).not.toHaveBeenCalled();
    expect(api.fetchPlaylistsPage).not.toHaveBeenCalled();
    await userEvent.click(playlistButton(panel()));
    await waitFor(() => expect(api.fetchPlaylistsPage).toHaveBeenCalledTimes(1));
    expect(api.fetchPlaylistsPage).toHaveBeenCalledWith(expect.objectContaining({ limit: 30, offset: 0 }));
    expect(api.fetchPlaylists).not.toHaveBeenCalled();
  });
});

describe('more filters: source, scaricata, FS / MS', () => {
  const more = () => within(panel()).getByText('More filters').closest('details') as HTMLElement;
  const openMore = () => fireEvent.click(within(panel()).getByText('More filters'));

  it('source chips come from where the songs were found', async () => {
    await open();
    openMore();
    expect(within(more()).getAllByRole('button', { name: /^(Instagram|TikTok)/ }).map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['Instagram 1', 'TikTok 1']);
    fireEvent.click(within(more()).getByRole('button', { name: /^TikTok/ }));
    await waitFor(() => expect(listTitles()).toEqual(['Like a Prayer']));
  });

  it('FS / MS: where the file is', async () => {
    await open();
    openMore();
    const where = within(more()).getByText('Where it is', { selector: 'legend' }).closest('fieldset') as HTMLElement;
    expect(within(where).getAllByRole('button').map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual(['FS 3', 'MS 2']);
    fireEvent.click(within(where).getByRole('button', { name: /^MS/ }));
    await waitFor(() => expect(listTitles()).toEqual(['Creep', 'One More Time']));
  });

  it('downloaded / not downloaded, with counts', async () => {
    await open();
    openMore();
    // inLibrary is the backend’s word for "on FS or on the media server"
    fireEvent.click(within(more()).getByRole('radio', { name: 'Downloaded (3)' }));
    await waitFor(() => expect(listTitles()).toEqual(['Beat It', 'Creep', 'One More Time']));
  });

  it('favorites only', async () => {
    vi.mocked(api.fetchSongs).mockResolvedValue([mk('A', 'liked', { favorite: true, year: 1985 }), mk('B', 'plain', { year: 1985 })]);
    renderPage();
    await waitFor(() => expect(listTitles()).toHaveLength(2));
    fireEvent.click(toggleButton());
    await screen.findByTestId('choose-panel');
    openMore();
    fireEvent.click(within(more()).getByRole('checkbox', { name: /Favorites only/ }));
    await waitFor(() => expect(listTitles()).toEqual(['liked']));
  });
});

describe('with a queue already playing', () => {
  it('changing a filter shows what the filters leave, not the queue; the queue stays one tab away', async () => {
    playerMock.current = makePlayer({ queue: SONGS, index: 0, current: SONGS[0], queueLabel: 'Road trip', playing: true });
    renderPage();
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Road trip' })).toBeInTheDocument());
    fireEvent.click(toggleButton());
    await screen.findByTestId('choose-panel');
    fireEvent.click(chip('Years', /^1980s/));
    await waitFor(() => expect(screen.getByRole('heading', { name: '1980s' })).toBeInTheDocument());
    expect(listTitles()).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']);
    expect(screen.getByRole('tab', { name: /Road trip/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------------------------------------
// On a phone (spec 2026-11-08-web-mobile-ux-design.md M2/M5): a full-height sheet, a dialog for keyboard and screen reader
// ---------------------------------------------------------------------------------------------------------------

function stubPhone(phone: boolean) {
  window.matchMedia = vi.fn((media: string) => ({
    matches: phone && media === PHONE_QUERY,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
}

describe('on a phone: a full-height sheet', () => {
  beforeEach(() => stubPhone(true));
  afterEach(() => { delete (window as unknown as { matchMedia?: unknown }).matchMedia; });

  it('is a modal dialog named after its title, and takes the focus', async () => {
    await open();
    const sheet = screen.getByRole('dialog', { name: 'Choose what to play' });
    expect(sheet).toHaveAttribute('aria-modal', 'true');
    expect(sheet).toHaveAttribute('data-sheet', 'true');
    expect(sheet).toHaveFocus();
  });

  it('keeps title and count on top, the filters in the middle and the actions at the bottom', async () => {
    await open();
    const sheet = screen.getByRole('dialog');
    expect(sheet.firstElementChild?.tagName).toBe('HEADER');
    expect(sheet.lastElementChild?.tagName).toBe('FOOTER');
    expect(within(sheet.firstElementChild as HTMLElement).getByRole('heading', { name: 'Choose what to play' })).toBeInTheDocument();
    expect(within(sheet.firstElementChild as HTMLElement).getByRole('status')).toHaveTextContent('9 songs');
    expect(within(sheet.lastElementChild as HTMLElement).getAllByRole('button').map((b) => b.textContent)).toEqual([
      '▶ Play · 9', '🔀 Shuffle and play', 'Reset filters',
    ]);
    expect(sheet.querySelector('.ch-body')).toContainElement(group('Years'));
  });

  it('the close button, and Escape, close it and give the focus back to the button that opened it', async () => {
    await open();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    expect(screen.queryByTestId('choose-panel')).toBeNull();
    await waitFor(() => expect(toggleButton()).toHaveFocus());

    fireEvent.click(toggleButton());
    const sheet = await screen.findByRole('dialog');
    fireEvent.keyDown(sheet, { key: 'Escape' });
    expect(screen.queryByTestId('choose-panel')).toBeNull();
  });

  it('Play starts the queue and gets the sheet out of the way (it covers the player)', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    fireEvent.click(playButton());
    expect(fns.playSong).toHaveBeenCalledTimes(1);
    expect((fns.playSong.mock.calls[0] as [string, AggregatedSong[]])[1].map((s) => s.title)).toEqual(['Billie Jean', 'Beat It', 'Like a Prayer']);
    expect(screen.queryByTestId('choose-panel')).toBeNull();
    expect(toggleButton()).toHaveAttribute('aria-expanded', 'false');
  });

  it('so does Shuffle and play', async () => {
    await open();
    fireEvent.click(within(panel()).getByRole('button', { name: /Shuffle and play/ }));
    expect(fns.playSong).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId('choose-panel')).toBeNull();
  });

  it('picking filters and resetting them keeps the sheet open', async () => {
    await open();
    fireEvent.click(chip('Years', /^1980s/));
    fireEvent.click(within(panel()).getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByTestId('choose-panel')).toBeInTheDocument();
  });

  it('Tab stays inside the sheet: from the last control it goes to the first', async () => {
    await open();
    const sheet = screen.getByRole('dialog');
    const focusable = Array.from(sheet.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), summary'));
    const last = focusable[focusable.length - 1];
    last.focus();
    fireEvent.keyDown(last, { key: 'Tab' });
    expect(focusable[0]).toHaveFocus();
  });

  it('a song count of zero keeps Play and Shuffle off and says why, inside the footer', async () => {
    await open();
    fireEvent.change(within(panel()).getByRole('searchbox'), { target: { value: 'zzzzzz' } });
    await waitFor(() => expect(listTitles()).toEqual([]));
    const footer = screen.getByRole('dialog').lastElementChild as HTMLElement;
    expect(within(footer).getByText('No song matches these filters.')).toBeInTheDocument();
    expect(within(footer).getByRole('button', { name: /^▶ Play/ })).toBeDisabled();
  });
});

describe('on a big screen: the card it always was', () => {
  it('is a region, takes no focus, and stays open when a song starts', async () => {
    await open();
    expect(screen.queryByRole('dialog')).toBeNull();
    const card = panel();
    expect(card).toHaveAttribute('data-sheet', 'false');
    expect(card).toHaveAttribute('role', 'region');
    expect(card).not.toHaveFocus();
    fireEvent.click(playButton());
    expect(fns.playSong).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('choose-panel')).toBeInTheDocument();
  });

  it('Escape does not close it (nothing is trapped)', async () => {
    await open();
    fireEvent.keyDown(panel(), { key: 'Escape' });
    expect(screen.getByTestId('choose-panel')).toBeInTheDocument();
  });
});
