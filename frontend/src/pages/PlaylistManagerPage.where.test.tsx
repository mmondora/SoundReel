import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlaylistManagerPage } from './PlaylistManagerPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import { resetEntryFactsCache } from '../hooks/usePlaylistManager';
import * as api from '../services/api';
import type { DownloadUiState } from '../player/songDownload';
import type { AggregatedSong, MeResponse, SongMetaRecord, SongStateResponse } from '../types';

// Playlist manager, rule W8: the location of EVERY song (path on disk, URL on the media server, YouTube link for the
// songs that are only streamed), a "Show paths" line per pane, the details dialog with copy buttons, and a green
// dot that means exactly fs || mediaServer (rule S8).

const { playerState } = vi.hoisted(() => ({ playerState: { downloadStates: {} as Record<string, DownloadUiState> } }));

vi.mock('../player/PlayerContext', () => ({
  usePlayer: () => ({ playSong: vi.fn(), downloadStates: playerState.downloadStates }),
}));

vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  fetchSongState: vi.fn(),
  fetchPlaylists: vi.fn(),
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

const NIGHTCALL_URL = 'http://192.168.178.10:49152/Music/Kavinsky/Nightcall/Nightcall.mp3';
const SEXY_PATH = '~/Music/SoundReel/Air - Sexy Boy.mp3';
const DAFT_PATH = '~/Music/Daft Punk - One More Time.mp3';
const DAFT_URL = 'http://192.168.178.10:49152/Music/Daft Punk/One More Time.mp3';

function song(key: string, createdAt: string, extra: Partial<AggregatedSong> = {}): AggregatedSong {
  const [artist, title] = key.split('::');
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt }], meta: null, ...extra,
  };
}

const SONGS: AggregatedSong[] = [
  song('kavinsky::nightcall', '2026-05-06T00:00:00Z', { fs: false, mediaServer: true, inLibrary: true, mediaUrl: NIGHTCALL_URL }),
  song('air::sexy boy', '2026-05-05T00:00:00Z', { fs: true, mediaServer: false, inLibrary: true, fsPath: SEXY_PATH }),
  song('daft punk::one more time', '2026-05-04T00:00:00Z', { fs: true, mediaServer: true, inLibrary: true, fsPath: DAFT_PATH, mediaUrl: DAFT_URL }),
  // the hand-set "downloaded" flag with the file nowhere: NOT green any more
  song('bishop briggs::white flag', '2026-05-03T00:00:00Z', { fs: false, mediaServer: false, inLibrary: false, meta: { downloaded: true } as SongMetaRecord }),
  song('police::roxanne', '2026-05-02T00:00:00Z', { youtubeUrl: 'https://www.youtube.com/watch?v=abc123' }),
];

const ME: MeResponse = {
  user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true,
  family: [{ id: 'mike', displayName: 'Michele' }],
};

const stateOf = (extra: Partial<SongStateResponse> = {}): SongStateResponse =>
  ({ state: 'ready', source: null, version: null, bytes: null, error: null, inLibrary: true, ...extra });

// A function, not a constant: a re-render with the very same element object would be skipped by React.
const makeTree = () => (
  <LanguageProvider>
    <MemoryRouter>
      <PlaylistManagerPage />
    </MemoryRouter>
  </LanguageProvider>
);

async function setup() {
  vi.mocked(api.fetchSongs).mockResolvedValue(SONGS);
  vi.mocked(api.fetchPlaylists).mockResolvedValue([]);
  vi.mocked(api.fetchMe).mockResolvedValue(ME);
  vi.mocked(api.fetchAllEntrySummaries).mockResolvedValue([]);
  vi.mocked(api.fetchSongState).mockRejectedValue(new Error('not asked'));
  const view = render(makeTree());
  const listA = await screen.findByRole('listbox', { name: /Pane A/ });
  const listB = screen.getByRole('listbox', { name: /Pane B/ });
  await waitFor(() => expect(within(listA).getAllByRole('option')).toHaveLength(SONGS.length));
  return { ...view, listA, listB };
}

const rows = (list: HTMLElement) => within(list).getAllByRole('option');
const rowOf = (list: HTMLElement, title: string) => {
  const row = rows(list).find((r) => within(r).queryByText(title) !== null);
  if (!row) throw new Error(`no row for ${title}`);
  return row;
};
const dotOf = (row: HTMLElement) => within(row).getByRole('img', { name: /^(downloaded|not downloaded|preparing)$/ }).getAttribute('aria-label');
const toggleA = () => screen.getByRole('button', { name: 'Show paths (Pane A)' });

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  playerState.downloadStates = {};
  resetEntryFactsCache();
  setStoredLanguage('en');
});

describe('the green dot is fs || mediaServer, nothing else (rule S8)', () => {
  it('green for FS only, MS only and both; not green for streaming-only songs, whatever the old flag says', async () => {
    const { listA } = await setup();
    expect(dotOf(rowOf(listA, 'nightcall'))).toBe('downloaded');
    expect(dotOf(rowOf(listA, 'sexy boy'))).toBe('downloaded');
    expect(dotOf(rowOf(listA, 'one more time'))).toBe('downloaded');
    expect(dotOf(rowOf(listA, 'white flag'))).toBe('not downloaded'); // meta.downloaded = true, but nowhere
    expect(dotOf(rowOf(listA, 'roxanne'))).toBe('not downloaded');
  });

  it('every green dot has its badge next to it: the dot always leads to a place', async () => {
    const { listA } = await setup();
    for (const title of ['nightcall', 'sexy boy', 'one more time']) {
      const row = rowOf(listA, title);
      expect(dotOf(row)).toBe('downloaded');
      expect(row.querySelector('.loc-badge')).not.toBeNull();
    }
    expect(rowOf(listA, 'white flag').querySelector('.loc-badge')).toBeNull();
  });

  it('the "Downloaded" filter and its count follow the same rule: three songs are at home, not four', async () => {
    const { listA } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: /^Filters/ })[0]);
    fireEvent.click(await screen.findByRole('radio', { name: 'Downloaded (3)' }));
    await waitFor(() => expect(rows(listA)).toHaveLength(3));
    expect(rows(listA).map((r) => r.textContent).join(' ')).toMatch(/nightcall.*sexy boy.*one more time/is);
    expect(screen.getByRole('radio', { name: 'Not downloaded (2)' })).toBeInTheDocument();
  });
});

describe('"Show paths": a detail line under each song (rule W8)', () => {
  it('is off at first; the toggle is a labelled pressed-state button per pane', async () => {
    const { listA } = await setup();
    expect(screen.queryAllByTestId('song-where')).toHaveLength(0);
    expect(toggleA()).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Show paths (Pane B)' })).toHaveAttribute('aria-pressed', 'false');
    expect(rows(listA)).toHaveLength(SONGS.length);
  });

  it('turns the lines on for that pane only', async () => {
    const { listA, listB } = await setup();
    fireEvent.click(toggleA());
    expect(toggleA()).toHaveAttribute('aria-pressed', 'true');
    expect(within(listA).getAllByTestId('song-where')).toHaveLength(SONGS.length);
    expect(within(listB).queryAllByTestId('song-where')).toHaveLength(0);
    fireEvent.click(toggleA());
    expect(within(listA).queryAllByTestId('song-where')).toHaveLength(0);
  });

  it('says where every song is: MS URL, FS path, both, or the YouTube link for streaming-only songs', async () => {
    const { listA } = await setup();
    fireEvent.click(toggleA());

    const ms = within(rowOf(listA, 'nightcall')).getByTestId('song-where');
    expect(within(ms).getByText('MS')).toBeInTheDocument();
    expect(ms).toHaveTextContent(NIGHTCALL_URL);
    expect(within(ms).queryByText('FS')).toBeNull();

    const fs = within(rowOf(listA, 'sexy boy')).getByTestId('song-where');
    expect(within(fs).getByText('FS')).toBeInTheDocument();
    expect(fs).toHaveTextContent(SEXY_PATH);

    const both = within(rowOf(listA, 'one more time')).getByTestId('song-where');
    expect(both).toHaveTextContent(DAFT_PATH);
    expect(both).toHaveTextContent(DAFT_URL);
    expect(within(both).getAllByRole('img').map((i) => i.textContent)).toEqual(['FS', 'MS']);

    // streaming only: the YouTube link (the known video, or a search when none is known)
    const known = within(rowOf(listA, 'roxanne')).getByTestId('song-where');
    expect(within(known).getByRole('link')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=abc123');
    expect(within(known).getByRole('link')).toHaveAttribute('target', '_blank');
    expect(within(known).getByRole('link')).toHaveAttribute('rel', expect.stringContaining('noopener'));
    expect(within(known).queryByText('FS')).toBeNull();
    const search = within(rowOf(listA, 'white flag')).getByTestId('song-where');
    expect(within(search).getByRole('link')).toHaveAttribute('href', 'https://youtube.com/results?search_query=bishop%20briggs%20white%20flag');
    expect(search).toHaveTextContent('search: the video is not known yet');
  });

  it('a file whose path the server did not tell is said so (never an empty line)', async () => {
    vi.mocked(api.fetchSongs).mockResolvedValue([song('air::sexy boy', '2026-05-05T00:00:00Z', { fs: true, inLibrary: true })]);
    vi.mocked(api.fetchPlaylists).mockResolvedValue([]);
    vi.mocked(api.fetchMe).mockResolvedValue(ME);
    vi.mocked(api.fetchAllEntrySummaries).mockResolvedValue([]);
    render(makeTree());
    const listA = await screen.findByRole('listbox', { name: /Pane A/ });
    await waitFor(() => expect(within(listA).getAllByRole('option')).toHaveLength(1));
    fireEvent.click(toggleA());
    expect(within(listA).getByTestId('song-where')).toHaveTextContent('path not reported by the server');
  });

  it('is remembered by this browser, per pane', async () => {
    const first = await setup();
    fireEvent.click(toggleA());
    expect(JSON.parse(localStorage.getItem('soundreel.manager.paths.v1') ?? '{}')).toEqual({ a: true, b: false });
    first.unmount();

    const { listA, listB } = await setup();
    expect(toggleA()).toHaveAttribute('aria-pressed', 'true');
    expect(within(listA).getAllByTestId('song-where')).toHaveLength(SONGS.length);
    expect(within(listB).queryAllByTestId('song-where')).toHaveLength(0);
  });

  it('works when localStorage is unusable', async () => {
    localStorage.setItem('soundreel.manager.paths.v1', '{not json');
    const { listA } = await setup();
    expect(toggleA()).toHaveAttribute('aria-pressed', 'false');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    fireEvent.click(toggleA());
    expect(within(listA).getAllByTestId('song-where')).toHaveLength(SONGS.length);
    setItem.mockRestore();
  });
});

describe('a download that finishes in this session (live)', () => {
  it('turns the dot green and shows the new path without a reload', async () => {
    const { listA, rerender } = await setup();
    fireEvent.click(toggleA());
    const before = rowOf(listA, 'white flag');
    expect(dotOf(before)).toBe('not downloaded');

    playerState.downloadStates = {
      'bishop briggs::white flag': {
        songKey: 'bishop briggs::white flag',
        phase: 'ready',
        location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/Bishop Briggs - White Flag.mp3', mediaUrl: null, streamUrl: null },
      },
    };
    await act(async () => { rerender(makeTree()); });
    const after = rowOf(listA, 'white flag');
    expect(dotOf(after)).toBe('downloaded');
    expect(within(after).getByTestId('song-where')).toHaveTextContent('~/Music/SoundReel/Bishop Briggs - White Flag.mp3');
    // the badge beside the dot and the tag of the detail line
    expect(within(after).getAllByRole('img', { name: 'File on geekom’s disk (server)' })).toHaveLength(2);
  });
});

describe('the song details dialog (F3)', () => {
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    clipboard.writeText.mockClear();
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
  });

  async function openDetails(title: string, listA: HTMLElement) {
    fireEvent.click(rowOf(listA, title));
    act(() => { listA.focus(); });
    fireEvent.keyDown(listA, { key: 'F3' });
    return screen.findByRole('dialog', { name: 'Song details' });
  }

  it('shows the media server URL and each address has a Copy button that really copies', async () => {
    const { listA } = await setup();
    const dialog = await openDetails('nightcall', listA);
    const where = within(within(dialog).getByTestId('where-list'));
    expect(where.getAllByRole('listitem')).toHaveLength(3);

    const ms = within(dialog).getByText(NIGHTCALL_URL).closest('li') as HTMLElement;
    expect(ms).toHaveAttribute('data-where', 'ms');
    fireEvent.click(within(ms).getByRole('button', { name: 'Copy Media server (MS)' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(NIGHTCALL_URL));
    expect(await within(ms).findByText('Copied', { selector: 'button' })).toBeInTheDocument();

    const fs = dialog.querySelector('[data-where="fs"]') as HTMLElement;
    expect(fs).toHaveTextContent('not there');
    expect(within(fs).queryByRole('button')).toBeNull(); // nothing to copy
  });

  it('shows the disk path of a song on FS, and both addresses of a song on both', async () => {
    const { listA } = await setup();
    const dialog = await openDetails('one more time', listA);
    const fs = dialog.querySelector('[data-where="fs"]') as HTMLElement;
    const ms = dialog.querySelector('[data-where="ms"]') as HTMLElement;
    expect(fs).toHaveTextContent(DAFT_PATH);
    expect(ms).toHaveTextContent(DAFT_URL);
    fireEvent.click(within(fs).getByRole('button', { name: 'Copy geekom disk (FS)' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith(DAFT_PATH));
  });

  it('always has a YouTube address, copyable: the known video, or a search link saying so', async () => {
    const { listA } = await setup();
    const dialog = await openDetails('white flag', listA);
    const yt = dialog.querySelector('[data-where="youtube"]') as HTMLElement;
    expect(within(yt).getByRole('link')).toHaveAttribute('href', 'https://youtube.com/results?search_query=bishop%20briggs%20white%20flag');
    expect(yt).toHaveTextContent('search: the video is not known yet');
    fireEvent.click(within(yt).getByRole('button', { name: 'Copy YouTube' }));
    await waitFor(() => expect(clipboard.writeText).toHaveBeenCalledWith('https://youtube.com/results?search_query=bishop%20briggs%20white%20flag'));
  });

  it('asks the song state and shows the stream URL it knows (and its fresher paths)', async () => {
    vi.mocked(api.fetchSongState).mockResolvedValue(stateOf({
      location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/Fresh.mp3', mediaUrl: null, streamUrl: 'https://www.youtube.com/watch?v=fresh' },
    }));
    const { listA } = await setup();
    vi.mocked(api.fetchSongState).mockResolvedValue(stateOf({
      location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/Fresh.mp3', mediaUrl: null, streamUrl: 'https://www.youtube.com/watch?v=fresh' },
    }));
    const dialog = await openDetails('white flag', listA);
    const yt = dialog.querySelector('[data-where="youtube"]') as HTMLElement;
    await waitFor(() => expect(within(yt).getByRole('link')).toHaveAttribute('href', 'https://www.youtube.com/watch?v=fresh'));
    expect(yt).not.toHaveTextContent('search');
    expect(dialog.querySelector('[data-where="fs"]')).toHaveTextContent('~/Music/SoundReel/Fresh.mp3');
    expect(api.fetchSongState).toHaveBeenCalledWith('bishop briggs::white flag');
  });

  it('a failing state call changes nothing: what the list knew stays on screen', async () => {
    const { listA } = await setup();
    const dialog = await openDetails('nightcall', listA);
    await waitFor(() => expect(api.fetchSongState).toHaveBeenCalled());
    expect(within(dialog).getByText(NIGHTCALL_URL)).toBeInTheDocument();
  });

  it('a song of a finished download of this session shows its paths too', async () => {
    playerState.downloadStates = {
      'police::roxanne': {
        songKey: 'police::roxanne',
        phase: 'ready',
        location: { fs: true, mediaServer: false, fsPath: '~/Music/SoundReel/Police - Roxanne.mp3', mediaUrl: null, streamUrl: null },
      },
    };
    const { listA } = await setup();
    const dialog = await openDetails('roxanne', listA);
    expect(dialog.querySelector('[data-where="fs"]')).toHaveTextContent('~/Music/SoundReel/Police - Roxanne.mp3');
  });
});
