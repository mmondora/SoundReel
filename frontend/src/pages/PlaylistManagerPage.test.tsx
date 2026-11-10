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
import { chooseLocation, locationButton, pickerDialog, servePlaylistPages } from '../testing/managerPicker';
import type { AggregatedSong, DynamicRule, EntrySummary, MeResponse, PlaylistDetail } from '../types';

const { playSong } = vi.hoisted(() => ({ playSong: vi.fn() }));

vi.mock('../player/PlayerContext', () => ({
  usePlayer: () => ({ playSong, downloadStates: {} }),
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
const BISHOP = 'bishop briggs::white flag';
const DAFT = 'daft punk::one more time';
const LIVE = 'police::roxanne (live)';
const STUDIO = 'police::roxanne';

function song(key: string, createdAt: string, extra: Partial<AggregatedSong> = {}): AggregatedSong {
  const [artist, title] = key.split('::');
  return {
    songKey: key, title, artist, album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt }], meta: null, ...extra,
  };
}

const SONGS: AggregatedSong[] = [
  song(AIR, '2026-05-05T00:00:00Z', { album: 'Moon Safari', inLibrary: true }),
  song(BISHOP, '2026-05-04T00:00:00Z'),
  song(DAFT, '2026-05-03T00:00:00Z'),
  song(LIVE, '2026-05-02T00:00:00Z'),
  song(STUDIO, '2026-05-01T00:00:00Z'),
];

const SUMMARIES: EntrySummary[] = [
  [AIR, 'instagram', ['#estate']],
  [BISHOP, 'shazam', []],
  [DAFT, 'tiktok', ['#estate']],
  [LIVE, 'youtube', []],
  [STUDIO, 'youtube', []],
].map(([key, platform, tags]) => ({
  id: `e-${key as string}`, sourceUrl: '', sourcePlatform: platform as string, caption: null, thumbnailUrl: null,
  status: 'completed', createdAt: '', summary: null, songCount: 1, filmCount: 0, noteCount: 0, tags: tags as string[],
}));

const ME: MeResponse = {
  user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true,
  family: [
    { id: 'mike', displayName: 'Michele' },
    { id: 'archi', displayName: 'Archimede' },
    { id: 'sara', displayName: 'Sara' },
    { id: 'anonymous', displayName: 'Anonymous' },
  ],
};

/** In-memory backend: ordered key lists per playlist, like the real service. */
interface FakeList {
  name: string;
  owner: string;
  keys: string[];
  kind?: 'static' | 'dynamic';
  rule?: DynamicRule;
  ruleSummary?: string;
}

function fakeBackend(initial: Record<string, FakeList>) {
  const lists = JSON.parse(JSON.stringify(initial)) as typeof initial;
  const detail = (id: string): PlaylistDetail => ({
    id, name: lists[id].name, ownerUser: lists[id].owner, songCount: lists[id].keys.length,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-02T00:00:00Z', songKeys: [...lists[id].keys],
    ...(lists[id].kind ? { kind: lists[id].kind } : {}),
    ...(lists[id].rule ? { rule: lists[id].rule } : {}),
    ...(lists[id].ruleSummary ? { ruleSummary: lists[id].ruleSummary } : {}),
  });
  vi.mocked(api.fetchPlaylists).mockImplementation(async () => Object.keys(lists).map((id) => {
    const { songKeys: _keys, ...summary } = detail(id);
    void _keys;
    return summary;
  }));
  servePlaylistPages(() => Object.keys(lists).map((id) => {
    const { songKeys: _keys, ...summary } = detail(id);
    void _keys;
    return summary;
  }));
  vi.mocked(api.fetchPlaylist).mockImplementation(async (id) => detail(id));
  vi.mocked(api.addSongToPlaylist).mockImplementation(async (id, key) => {
    if (!lists[id].keys.includes(key)) lists[id].keys.push(key);
    return detail(id);
  });
  vi.mocked(api.removeSongFromPlaylist).mockImplementation(async (id, key) => {
    lists[id].keys = lists[id].keys.filter((k) => k !== key);
    return detail(id);
  });
  vi.mocked(api.reorderPlaylist).mockImplementation(async (id, keys) => {
    lists[id].keys = [...keys];
    return detail(id);
  });
  vi.mocked(api.createPlaylist).mockImplementation(async (name) => {
    const id = `new-${Object.keys(lists).length}`;
    lists[id] = { name, owner: 'mike', keys: [] };
    return detail(id);
  });
  vi.mocked(api.createDynamicPlaylist).mockImplementation(async (name, rule) => {
    const id = `dyn-${Object.keys(lists).length}`;
    lists[id] = { name, owner: 'mike', keys: [DAFT, LIVE], kind: 'dynamic', rule, ruleSummary: 'Most played · test' };
    return detail(id);
  });
  vi.mocked(api.updatePlaylistRule).mockImplementation(async (id, rule) => {
    lists[id].rule = rule;
    lists[id].ruleSummary = 'Updated rule';
    lists[id].keys = [STUDIO];
    return detail(id);
  });
  return lists;
}

async function setup(lists: Record<string, FakeList>) {
  const backend = fakeBackend(lists);
  vi.mocked(api.fetchSongs).mockResolvedValue(SONGS);
  vi.mocked(api.fetchMe).mockResolvedValue(ME);
  vi.mocked(api.fetchAllEntrySummaries).mockResolvedValue(SUMMARIES);
  vi.mocked(api.fetchPlaylistShares).mockResolvedValue({ playlistId: 'p1', sharedWith: [], family: ['archi', 'sara'] });

  render(
    <LanguageProvider>
      <MemoryRouter>
        <PlaylistManagerPage />
      </MemoryRouter>
    </LanguageProvider>,
  );

  const listA = await screen.findByRole('listbox', { name: /Pane A/ });
  const listB = screen.getByRole('listbox', { name: /Pane B/ });
  // First visit: the right pane switches to the first playlist the user owns, then loads its songs.
  await waitFor(() => expect(locationButton('B')).toHaveTextContent('Mine'));
  await waitFor(() => expect(within(listB).queryByText('Loading...')).not.toBeInTheDocument());
  return { backend, listA, listB };
}

/** Focus inside act(): the pane list marks itself active on focus and the key handler must see it. */
const focus = (el: HTMLElement) => act(() => { el.focus(); });
const rowsOf = (list: HTMLElement) => within(list).queryAllByRole('option');
const textsOf = (list: HTMLElement) => rowsOf(list).map((r) => r.textContent ?? '');
const marked = (list: HTMLElement) => rowsOf(list).filter((r) => r.getAttribute('aria-selected') === 'true');
const key = (target: Element | Document, k: string, extra: KeyboardEventInit = {}) =>
  fireEvent.keyDown(target, { key: k, ...extra });
const status = () => screen.getAllByRole('status');
const statusText = () => status().map((s) => s.textContent).join(' | ');

const BASE = {
  p1: { name: 'Mine', owner: 'mike', keys: [BISHOP, STUDIO] },
  p2: { name: 'Sara mix', owner: 'sara', keys: [AIR, 'ghost::not mine'] },
  p3: { name: 'Empty', owner: 'mike', keys: [] },
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetEntryFactsCache();
  setStoredLanguage('en');
});

describe('PlaylistManagerPage layout', () => {
  it('shows the library on the left and the first playlist you own on the right', async () => {
    const { listA, listB } = await setup(BASE);
    expect(textsOf(listA)).toHaveLength(5);
    expect(textsOf(listA)[0]).toContain('sexy boy');
    expect(textsOf(listB).map((t) => t.replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining('white flag'),
      expect.stringContaining('roxanne'),
    ]);
    expect(locationButton('B')).toHaveTextContent('Mine');
    expect(screen.getByRole('toolbar', { name: 'Commands' })).toBeInTheDocument();
  });

  it('marks the active pane and Tab on a list moves to the other pane (Shift+Tab stays native)', async () => {
    const { listA, listB } = await setup(BASE);
    focus(listA);
    expect(screen.getByRole('region', { name: /Pane A/ })).toHaveAttribute('aria-current', 'true');
    key(listA, 'Tab');
    expect(screen.getByRole('region', { name: /Pane B/ })).toHaveAttribute('aria-current', 'true');
    expect(listB).toHaveFocus();
    const notPrevented = fireEvent.keyDown(listB, { key: 'Tab', shiftKey: true });
    expect(notPrevented).toBe(true); // not preventDefault()ed: native focus movement leaves the list
  });

  it('remembers the pane locations between visits', async () => {
    await setup(BASE);
    await chooseLocation('A', 'Empty');
    await waitFor(() => expect(JSON.parse(localStorage.getItem('soundreel.manager.v1') ?? '{}')).toMatchObject({ a: { kind: 'playlist', id: 'p3' } }));
  });
});

describe('the choice of a playlist, over the manager', () => {
  it('while the dialog is open the keys of the page are not for the page: F5 does not copy behind it, and works again when it is closed', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    await userEvent.click(locationButton('B'));
    key(pickerDialog(), 'F5');
    expect(api.addSongToPlaylist).not.toHaveBeenCalled();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    focus(listA);
    key(listA, 'F5');
    await waitFor(() => expect(api.addSongToPlaylist).toHaveBeenCalled());
  });

  it('the pane says the playlist it holds, with its number of songs and whose it is when it is not mine', async () => {
    await setup(BASE);
    expect(locationButton('B')).toHaveTextContent(/^Mine \(2\)/);
    await chooseLocation('A', 'Sara mix');
    await waitFor(() => expect(locationButton('A')).toHaveTextContent(/^Sara mix \(2\)/));
    expect(locationButton('A')).toHaveTextContent('Sara');
  });

  it('the dialog marks what the pane holds, and says whose a shared playlist is (and nothing for mine)', async () => {
    await setup(BASE);
    await userEvent.click(locationButton('B'));
    const dialog = pickerDialog();
    const mine = await within(dialog).findByRole('button', { name: /^Mine \d+ songs/ });
    expect(mine).toHaveAttribute('aria-current', 'true');
    expect(within(dialog).getByRole('button', { name: /^All songs/ })).not.toHaveAttribute('aria-current');
    expect(within(dialog).getByRole('button', { name: /^Sara mix \d+ songs/ })).toHaveTextContent('by Sara');
    expect(mine).not.toHaveTextContent('by ');
  });

  it('a person with a hundred playlists does not scroll them: the dialog shows a page of them and asks the server for the rest', async () => {
    const many = Object.fromEntries(Array.from({ length: 100 }, (_, i) => [`m${i}`, { name: `Mix ${String(i + 1).padStart(3, '0')}`, owner: 'mike', keys: [] as string[] }]));
    await setup({ ...BASE, ...many });
    await userEvent.click(locationButton('A'));
    const dialog = pickerDialog();
    await waitFor(() => expect(within(dialog).getAllByRole('button').filter((b) => b.hasAttribute('data-pl-option'))).toHaveLength(30));
    expect(within(dialog).getByText('Page 1 of 4')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByRole('searchbox', { name: 'Search playlists' }), 'Mix 077');
    await waitFor(() => expect(within(dialog).getAllByRole('button').filter((b) => b.hasAttribute('data-pl-option'))).toHaveLength(1));
    await userEvent.click(within(dialog).getByRole('button', { name: /Mix 077/ }));
    await waitFor(() => expect(locationButton('A')).toHaveTextContent('Mix 077'));
  });
});

describe('marks and cursor', () => {
  it('Space marks and moves down; + marks by wildcard text; * inverts; Esc clears', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, ' ');
    expect(marked(listA)).toHaveLength(1);
    expect(marked(listA)[0].textContent).toContain('sexy boy');
    expect(listA.getAttribute('aria-activedescendant')).toBe('mgr-a-row-1');

    key(listA, '+');
    const dialog = await screen.findByRole('dialog', { name: 'Mark by text' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: '*(live)*' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(marked(listA)).toHaveLength(2);
    expect(listA).toHaveFocus(); // focus returns to the list after the dialog

    key(listA, '*');
    expect(marked(listA)).toHaveLength(3);
    key(listA, 'Escape');
    expect(marked(listA)).toHaveLength(0);
  });

  it('Ctrl+A marks every visible row', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'a', { ctrlKey: true });
    expect(marked(listA)).toHaveLength(5);
  });

  it('clicking the mark glyph marks without moving the cursor; double click plays', async () => {
    const { listA } = await setup(BASE);
    const row = rowsOf(listA)[2];
    fireEvent.click(row.querySelector('[data-mark]') as HTMLElement);
    expect(marked(listA)).toHaveLength(1);
    fireEvent.doubleClick(row);
    expect(playSong).toHaveBeenCalledWith(DAFT, expect.any(Array), 'All songs');
  });

  it('Enter plays the cursor song with the pane as the queue', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'ArrowDown');
    key(listA, 'Enter');
    expect(playSong).toHaveBeenCalledTimes(1);
    const [songKey, queue, label] = playSong.mock.calls[0] as [string, AggregatedSong[], string];
    expect(songKey).toBe(BISHOP);
    expect(queue.map((s) => s.songKey)).toEqual([AIR, BISHOP, DAFT, LIVE, STUDIO]);
    expect(label).toBe('All songs');
  });
});

describe('filters', () => {
  it('fonte / tag facets come from the journal summaries and filter the pane', async () => {
    const { listA } = await setup(BASE);
    fireEvent.click(screen.getAllByRole('button', { name: /^Filters/ })[0]);
    const shazam = await screen.findByRole('button', { name: /^Shazam\s*1$/ });
    fireEvent.click(shazam);
    expect(textsOf(listA)).toHaveLength(1);
    expect(textsOf(listA)[0]).toContain('white flag');
    // Counts of the other facets follow the picked filter: only the tags of the remaining song.
    expect(screen.queryByRole('button', { name: /#estate/ })).not.toBeInTheDocument();
    fireEvent.click(shazam);
    expect(textsOf(listA)).toHaveLength(5);
  });

  it('"not yet in the other playlist" hides what the other pane already holds', async () => {
    const { listA } = await setup(BASE);
    fireEvent.click(screen.getAllByRole('button', { name: /^Filters/ })[0]);
    fireEvent.click(await screen.findByRole('radio', { name: 'Not yet in the other playlist' }));
    // Mine already has BISHOP and STUDIO.
    expect(textsOf(listA).map((t) => t.replace(/\s+/g, ' '))).toEqual([
      expect.stringContaining('sexy boy'),
      expect.stringContaining('one more time'),
      expect.stringContaining('roxanne (live)'),
    ]);
  });

  it('the text box filters and "n / total" is shown in the pane footer', async () => {
    const { listA } = await setup(BASE);
    fireEvent.change(screen.getByRole('searchbox', { name: /Pane A/ }), { target: { value: 'roxanne' } });
    expect(textsOf(listA)).toHaveLength(2);
    expect(within(screen.getByRole('region', { name: /Pane A/ })).getByText(/2 songs \/ 5/)).toBeInTheDocument();
  });
});

describe('F5 copy / F6 move', () => {
  it('F5 adds the marked songs to the playlist of the OTHER pane, skipping the ones already there', async () => {
    const { listA, listB, backend } = await setup(BASE);
    focus(listA);
    key(listA, ' '); // AIR (Space marks and moves down)
    key(listA, ' '); // BISHOP (already in Mine)
    key(listA, ' '); // DAFT
    key(listA, 'F5');

    await waitFor(() => expect(statusText()).toMatch(/Copy: 2 added · 1 already there/));
    expect(vi.mocked(api.addSongToPlaylist).mock.calls).toEqual([['p1', AIR], ['p1', DAFT]]);
    expect(backend.p1.keys).toEqual([BISHOP, STUDIO, AIR, DAFT]);
    // The right pane shows the result without another fetch, and everything that was handled loses its mark.
    await waitFor(() => expect(textsOf(listB)).toHaveLength(4));
    expect(marked(listA)).toHaveLength(0);
  });

  it('copies the cursor song when nothing is marked', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'ArrowDown');
    key(listA, 'ArrowDown');
    fireEvent.keyDown(document.body, { key: 'F5' });
    await waitFor(() => expect(api.addSongToPlaylist).toHaveBeenCalledWith('p1', DAFT));
  });

  it('a partial failure is never silent: the failed song and its reason are listed, and retry runs only that one', async () => {
    const { listA } = await setup(BASE);
    vi.mocked(api.addSongToPlaylist).mockImplementationOnce(async (id, k) => {
      throw new Error(JSON.stringify({ error: `no way for ${id}/${k}` }));
    });
    focus(listA);
    key(listA, ' '); // AIR → fails
    key(listA, ' '); // BISHOP → already there
    key(listA, ' '); // DAFT → ok
    key(listA, 'F5');

    await waitFor(() => expect(statusText()).toMatch(/1 added/));
    expect(statusText()).toMatch(/1 failed/);
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/air — sexy boy/)).toBeInTheDocument();
    expect(screen.getByText(/no way for p1\/air::sexy boy/)).toBeInTheDocument();

    // Retry: only the failed song is sent again (and this time it works).
    fireEvent.click(screen.getByRole('button', { name: 'Retry the failures' }));
    await waitFor(() => expect(vi.mocked(api.addSongToPlaylist).mock.calls.filter(([, k]) => k === AIR)).toHaveLength(2));
    expect(vi.mocked(api.addSongToPlaylist).mock.calls.filter(([, k]) => k === DAFT)).toHaveLength(1);
  });

  it('F6 moves between my playlists: add to the target first, then remove from the source', async () => {
    const { backend } = await setup({ ...BASE, p3: { name: 'Empty', owner: 'mike', keys: [] } });
    // Left pane = Mine (p1), right pane = Empty (p3)
    await chooseLocation('A', 'Mine');
    await chooseLocation('B', 'Empty');
    const listA = screen.getByRole('listbox', { name: /Pane A/ });
    await waitFor(() => expect(rowsOf(listA)).toHaveLength(2));
    await screen.findByText(/Empty playlist/); // the target playlist has loaded
    focus(listA);
    key(listA, 'F6');
    await waitFor(() => expect(statusText()).toMatch(/Move: 1 added · 1 removed/));
    expect(backend.p3.keys).toEqual([BISHOP]);
    expect(backend.p1.keys).toEqual([STUDIO]);
    const order = [...vi.mocked(api.addSongToPlaylist).mock.invocationCallOrder, ...vi.mocked(api.removeSongFromPlaylist).mock.invocationCallOrder];
    expect(order).toEqual([...order].sort((a, b) => a - b)); // all adds happened before the removes
  });

  it('undo puts back exactly what the copy added', async () => {
    const { listA, backend } = await setup(BASE);
    focus(listA);
    key(listA, ' ');
    key(listA, 'F5');
    await waitFor(() => expect(backend.p1.keys).toContain(AIR));
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(backend.p1.keys).toEqual([BISHOP, STUDIO]));
    expect(statusText()).toMatch(/Operation undone/);
  });

  it('Ctrl+Z undoes the last operation from the keyboard', async () => {
    const { listA, backend } = await setup(BASE);
    focus(listA);
    key(listA, ' ');
    key(listA, 'F5');
    await waitFor(() => expect(backend.p1.keys).toContain(AIR));
    key(listA, 'z', { ctrlKey: true });
    await waitFor(() => expect(backend.p1.keys).toEqual([BISHOP, STUDIO]));
    expect(statusText()).toMatch(/Operation undone/);
  });

  it('is refused with a reason when the other pane is the library, and nothing is called', async () => {
    const { listA } = await setup(BASE);
    await chooseLocation('B', 'library');
    focus(listA);
    key(listA, 'F5');
    await waitFor(() => expect(statusText()).toMatch(/Needs an editable playlist in the other pane/));
    expect(api.addSongToPlaylist).not.toHaveBeenCalled();
  });

  it('cannot copy into a playlist shared with me (read-only)', async () => {
    const { listA } = await setup(BASE);
    await chooseLocation('B', 'Sara mix');
    await waitFor(() => expect(rowsOf(screen.getByRole('listbox', { name: /Pane B/ })).length).toBeGreaterThan(0));
    focus(listA);
    key(listA, 'F5');
    await waitFor(() => expect(statusText()).toMatch(/Shared with you: read-only/));
    expect(api.addSongToPlaylist).not.toHaveBeenCalled();
  });
});

describe('F8 remove / permissions', () => {
  it('F8 asks for confirmation, then removes the cursor song from the playlist', async () => {
    const { listA, listB, backend } = await setup(BASE);
    focus(listA);
    key(listA, 'Tab');
    expect(listB).toHaveFocus();
    key(listB, 'F8');
    const dialog = await screen.findByRole('dialog', { name: 'Remove from playlist' });
    expect(dialog).toHaveTextContent('Remove 1 songs from “Mine”');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Remove' }));
    await waitFor(() => expect(api.removeSongFromPlaylist).toHaveBeenCalledWith('p1', BISHOP));
    await waitFor(() => expect(backend.p1.keys).toEqual([STUDIO]));
    await waitFor(() => expect(statusText()).toMatch(/Remove: 1 removed/));
    expect(textsOf(listB)).toHaveLength(1);
  });

  it('cancelling the confirmation removes nothing', async () => {
    const { listB } = await setup(BASE);
    focus(listB);
    key(listB, 'F8');
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(api.removeSongFromPlaylist).not.toHaveBeenCalled();
  });

  it('in the library pane F8 explains instead of removing', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'F8');
    await waitFor(() => expect(statusText()).toMatch(/Not available in “All songs”/));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.removeSongFromPlaylist).not.toHaveBeenCalled();
  });

  it('a playlist shared with me is read-only: owner and lock are shown, edits are refused with the reason', async () => {
    const { listA } = await setup(BASE);
    await chooseLocation('A', 'Sara mix');
    await waitFor(() => expect(rowsOf(screen.getByRole('listbox', { name: /Pane A/ })).length).toBe(2));
    expect(screen.getByTestId('owner-a')).toHaveTextContent('by Sara');
    expect(screen.getByTestId('owner-a')).toHaveTextContent('read-only');

    focus(listA);
    key(listA, 'F8');
    await waitFor(() => expect(statusText()).toMatch(/Shared with you: read-only/));
    key(listA, 'F4');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    key(listA, 'F9');
    await waitFor(() => expect(statusText()).toMatch(/Only the owner can share it/));
    key(listA, 'ArrowDown', { ctrlKey: true });
    expect(api.reorderPlaylist).not.toHaveBeenCalled();
    expect(api.removeSongFromPlaylist).not.toHaveBeenCalled();
  });

  it('songs of a shared playlist that are not in my journal are shown as such and cannot be played', async () => {
    const { listA } = await setup(BASE);
    await chooseLocation('A', 'Sara mix');
    const list = screen.getByRole('listbox', { name: /Pane A/ });
    await waitFor(() => expect(rowsOf(list).length).toBe(2));
    expect(within(rowsOf(list)[1]).getByRole('img', { name: 'not in your journal' })).toBeInTheDocument();
    focus(listA);
    key(listA, 'ArrowDown');
    key(listA, 'Enter');
    await waitFor(() => expect(statusText()).toMatch(/Cannot be played from here/));
    expect(playSong).not.toHaveBeenCalled();
  });
});

describe('F7 new / F4 rename / reorder', () => {
  it('F7 creates an EMPTY playlist (name only) and puts it in the pane that is not the library', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'F7');
    const dialog = await screen.findByRole('dialog', { name: 'New playlist' });
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Road trip' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(api.createPlaylist).toHaveBeenCalledTimes(1));
    expect(api.createPlaylist).toHaveBeenCalledWith('Road trip');
    await waitFor(() => expect(locationButton('B')).toHaveTextContent('Road trip'));
    expect(locationButton('A')).toHaveTextContent('All songs');
    expect(statusText()).toMatch(/“Road trip” created \(empty\)/);
  });

  it('F4 renames the playlist of the active pane', async () => {
    const { listB } = await setup(BASE);
    vi.mocked(api.renamePlaylist).mockResolvedValue({ id: 'p1', name: 'Renamed', songCount: 2, createdAt: '', updatedAt: 'x', songKeys: [BISHOP, STUDIO], ownerUser: 'mike' });
    focus(listB);
    key(listB, 'F4');
    const dialog = await screen.findByRole('dialog', { name: 'Rename playlist' });
    expect(within(dialog).getByRole('textbox')).toHaveValue('Mine');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.renamePlaylist).toHaveBeenCalledWith('p1', 'Renamed'));
    await waitFor(() => expect(locationButton('B')).toHaveTextContent('Renamed'));
  });

  it('Ctrl+↓ moves the cursor song down inside the playlist', async () => {
    const { listB } = await setup(BASE);
    focus(listB);
    key(listB, 'ArrowDown', { ctrlKey: true });
    await waitFor(() => expect(api.reorderPlaylist).toHaveBeenCalledWith('p1', [STUDIO, BISHOP]));
    await waitFor(() => expect(textsOf(listB)[0]).toContain('roxanne'));
  });

  it('reordering is refused while a filter is active', async () => {
    const { listB } = await setup(BASE);
    fireEvent.change(screen.getByRole('searchbox', { name: /Pane B/ }), { target: { value: 'white' } });
    focus(listB);
    key(listB, 'ArrowDown', { ctrlKey: true });
    await waitFor(() => expect(statusText()).toMatch(/Clear the filters to reorder/));
    expect(api.reorderPlaylist).not.toHaveBeenCalled();
  });
});

describe('F9 share', () => {
  it('the owner shares and unshares with family members; the pane header follows', async () => {
    const { listB } = await setup(BASE);
    vi.mocked(api.sharePlaylistWith).mockResolvedValue({ playlistId: 'p1', sharedWith: ['archi'] });
    vi.mocked(api.unsharePlaylistWith).mockResolvedValue({ playlistId: 'p1', sharedWith: [] });
    expect(screen.getByTestId('owner-b')).toHaveTextContent('yours');
    await waitFor(() => expect(screen.getByTestId('owner-b')).toHaveTextContent('Not shared'));

    focus(listB);
    key(listB, 'F9');
    const dialog = await screen.findByRole('dialog', { name: 'Share “Mine”' });
    expect(dialog).toHaveTextContent('Owner: Michele');
    const archi = await within(dialog).findByRole('checkbox', { name: /Archimede/ });
    expect(archi).not.toBeChecked();
    await waitFor(() => expect(archi).toHaveFocus()); // focus lands on the first choice once the list has loaded
    fireEvent.click(archi);
    await waitFor(() => expect(api.sharePlaylistWith).toHaveBeenCalledWith('p1', ['archi']));
    await waitFor(() => expect(archi).toBeChecked());
    fireEvent.click(archi);
    await waitFor(() => expect(api.unsharePlaylistWith).toHaveBeenCalledWith('p1', 'archi'));
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close' })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByTestId('owner-b')).toHaveTextContent('Not shared');
  });

  it('a failed share call is shown and the checkbox goes back', async () => {
    const { listB } = await setup(BASE);
    vi.mocked(api.sharePlaylistWith).mockRejectedValue(new Error('{"error":"authentication required"}'));
    focus(listB);
    key(listB, 'F9');
    const dialog = await screen.findByRole('dialog');
    const sara = await within(dialog).findByRole('checkbox', { name: /Sara/ });
    fireEvent.click(sara);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('authentication required');
    expect(sara).not.toBeChecked();
  });
});

describe('help, details and the function bar', () => {
  it('F1 lists the shortcuts and Escape closes the dialog', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'F1');
    const dialog = await screen.findByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(dialog).toHaveTextContent('Shift+Tab leaves the list');
    fireEvent.keyDown(dialog, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('F3 shows the details of the cursor song', async () => {
    const { listA } = await setup(BASE);
    focus(listA);
    key(listA, 'F3');
    const dialog = await screen.findByRole('dialog', { name: 'Song details' });
    expect(dialog).toHaveTextContent('sexy boy');
    expect(dialog).toHaveTextContent('Moon Safari');
    expect(dialog).toHaveTextContent('downloaded');
    await waitFor(() => expect(dialog).toHaveTextContent('Instagram')); // platform comes from the journal summaries
  });

  it('a not-allowed button stays clickable and says why', async () => {
    await setup(BASE);
    const remove = screen.getByRole('button', { name: /F8\s*Remove/ });
    expect(remove).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(remove);
    await waitFor(() => expect(statusText()).toMatch(/Not available in “All songs”/));
  });

  it('every function key has a button', async () => {
    await setup(BASE);
    for (const label of ['F1', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('the pane switcher (narrow screens) changes the active pane', async () => {
    await setup(BASE);
    fireEvent.click(screen.getByRole('tab', { name: /Pane B/ }));
    expect(screen.getByRole('region', { name: /Pane B/ })).toHaveAttribute('aria-current', 'true');
  });
});

describe('counts', () => {
  it('says "1 song" for one and "n songs" otherwise', async () => {
    const { listA } = await setup(BASE);
    fireEvent.change(screen.getByRole('searchbox', { name: /Pane A/ }), { target: { value: 'white flag' } });
    expect(textsOf(listA)).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: /Pane A/ })).getByText('1 song / 5')).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: /Pane B/ })).getByText('2 songs')).toBeInTheDocument();
  });
});

describe('typing in a filter box is not hijacked', () => {
  it('Space and + inside the search box do not mark or open dialogs, but F-keys still work', async () => {
    const { listA } = await setup(BASE);
    const box = screen.getByRole('searchbox', { name: /Pane A/ });
    focus(box);
    key(box, ' ');
    key(box, '+');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(marked(listA)).toHaveLength(0);
    key(box, 'F1');
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toBeInTheDocument();
  });
});

const NIGHT_RULE: DynamicRule = {
  v: 1, scope: 'me', period: { days: 30 }, window: { from: '22:00', to: '06:00' }, order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false,
};
const DYN = {
  ...BASE,
  night: { name: 'Night owls', owner: 'mike', keys: [DAFT, LIVE], kind: 'dynamic' as const, rule: NIGHT_RULE, ruleSummary: 'Most played · 22:00–06:00 · last 30 days' },
};

/** Left = the dynamic playlist, right = Mine (p1): the usual setup for the next tests. */
async function setupDynamic() {
  const ctx = await setup(DYN);
  await chooseLocation('A', 'Night owls');
  await waitFor(() => expect(rowsOf(screen.getByRole('listbox', { name: /Pane A/ }))).toHaveLength(2));
  return ctx;
}

describe('dynamic playlists', () => {
  it('shows as a read-only pane with an icon, the rule summary, the computed count and when it was evaluated', async () => {
    await setupDynamic();
    expect(locationButton('A')).toHaveTextContent('◷ Night owls');
    const pane = screen.getByTestId('dynamic-a');
    expect(pane).toHaveTextContent('Most played · 22:00–06:00 · last 30 days');
    expect(pane).toHaveTextContent('2 songs');
    expect(pane).toHaveTextContent(/evaluated at \d{2}:\d{2}/);
    expect(screen.getByTestId('owner-a')).toHaveTextContent('dynamic');
    expect(screen.getByTestId('owner-a')).toHaveTextContent('read-only');
  });

  it('add / remove / move / reorder / rename-by-name are refused with the reason, and nothing is called', async () => {
    const { listA } = await setupDynamic();
    focus(listA);
    key(listA, 'F8');
    await waitFor(() => expect(statusText()).toMatch(/Dynamic playlist: the rule picks the songs/));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    key(listA, 'F6');
    await waitFor(() => expect(statusText()).toMatch(/Dynamic playlist/));
    key(listA, 'ArrowDown', { ctrlKey: true });
    expect(api.removeSongFromPlaylist).not.toHaveBeenCalled();
    expect(api.addSongToPlaylist).not.toHaveBeenCalled();
    expect(api.reorderPlaylist).not.toHaveBeenCalled();
    expect(api.renamePlaylist).not.toHaveBeenCalled();
  });

  it('nothing can be copied INTO a dynamic playlist', async () => {
    await setupDynamic();
    const listB = screen.getByRole('listbox', { name: /Pane B/ });
    await chooseLocation('B', 'Night owls');
    await chooseLocation('A', 'library');
    focus(screen.getByRole('listbox', { name: /Pane A/ }));
    key(screen.getByRole('listbox', { name: /Pane A/ }), 'F5');
    await waitFor(() => expect(statusText()).toMatch(/Dynamic playlist/));
    expect(api.addSongToPlaylist).not.toHaveBeenCalled();
    void listB;
  });

  it('copying FROM a dynamic playlist into a static one adds the songs it has right now', async () => {
    const { backend } = await setupDynamic();
    const listA = screen.getByRole('listbox', { name: /Pane A/ });
    focus(listA);
    key(listA, 'a', { ctrlKey: true });
    key(listA, 'F5');
    await waitFor(() => expect(statusText()).toMatch(/Copy: 2 added/));
    expect(backend.p1.keys).toEqual([BISHOP, STUDIO, DAFT, LIVE]);
    expect(api.removeSongFromPlaylist).not.toHaveBeenCalled();
    // …and the dynamic playlist itself did not change
    expect(backend.night.keys).toEqual([DAFT, LIVE]);
  });

  it('F4 on a dynamic playlist edits its RULE (PATCH {rule}); the name is not editable', async () => {
    const { backend } = await setupDynamic();
    const listA = screen.getByRole('listbox', { name: /Pane A/ });
    focus(listA);
    expect(screen.getByRole('button', { name: /F4\s*Rule/ })).not.toHaveAttribute('aria-disabled', 'true');
    key(listA, 'F4');
    const dialog = await screen.findByRole('dialog', { name: 'Rule of “Night owls”' });
    expect(within(dialog).queryByRole('textbox', { name: 'Name' })).not.toBeInTheDocument();
    expect(within(dialog).getByLabelText('From')).toHaveValue('22:00');
    expect(within(dialog).getByRole('note')).toHaveTextContent('Crosses midnight');
    fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Maximum songs (1–200)' }), { target: { value: '10' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save the rule' }));

    await waitFor(() => expect(api.updatePlaylistRule).toHaveBeenCalledTimes(1));
    expect(api.updatePlaylistRule).toHaveBeenCalledWith('night', { ...NIGHT_RULE, limit: 10 });
    expect(api.renamePlaylist).not.toHaveBeenCalled();
    // the pane shows the re-evaluated playlist
    await waitFor(() => expect(screen.getByTestId('dynamic-a')).toHaveTextContent('Updated rule'));
    expect(rowsOf(listA)).toHaveLength(1);
    expect(backend.night.rule).toEqual({ ...NIGHT_RULE, limit: 10 });
    expect(statusText()).toMatch(/Rule updated: 1 song/);
  });

  it('F2 creates a dynamic playlist from a preset: POST {name, kind:"dynamic", rule}, shown in the pane that is not the library', async () => {
    vi.mocked(api.fetchDynamicPresets).mockResolvedValue([{ id: 'morning', label: 'Morning 7–8', rule: { ...NIGHT_RULE, window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5] } } }]);
    const { listA } = await setup(DYN);
    focus(listA);
    key(listA, 'F2');
    const dialog = await screen.findByRole('dialog', { name: 'New dynamic playlist' });
    fireEvent.change(await within(dialog).findByRole('combobox', { name: 'Preset' }), { target: { value: 'morning' } });
    expect(within(dialog).getByRole('textbox', { name: 'Name' })).toHaveValue('Morning 7–8');
    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Name' }), { target: { value: 'Mornings' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create the playlist' }));

    await waitFor(() => expect(api.createDynamicPlaylist).toHaveBeenCalledTimes(1));
    expect(api.createDynamicPlaylist).toHaveBeenCalledWith('Mornings', {
      v: 1, scope: 'me', period: { days: 30 }, window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5] },
      order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false,
    });
    expect(api.createPlaylist).not.toHaveBeenCalled(); // not the static creation path
    await waitFor(() => expect(locationButton('B')).toHaveTextContent('◷ Mornings'));
    expect(locationButton('A')).toHaveTextContent('All songs');
    expect(statusText()).toMatch(/Dynamic playlist “Mornings” created: 2 songs/);
    expect(screen.getByTestId('dynamic-b')).toBeInTheDocument();
  });

  it('F2 has its own Fn-bar button and is in the help dialog', async () => {
    await setup(DYN);
    expect(screen.getByRole('button', { name: /F2\s*Dynamic/ })).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: 'F1' });
    expect(await screen.findByRole('dialog', { name: 'Keyboard shortcuts' })).toHaveTextContent('F2 new dynamic playlist');
  });

  it('"Recalculate" and re-selecting the playlist evaluate it again', async () => {
    await setupDynamic();
    const before = vi.mocked(api.fetchPlaylist).mock.calls.filter(([id]) => id === 'night').length;
    fireEvent.click(within(screen.getByTestId('dynamic-a')).getByRole('button', { name: /Recalculate/ }));
    await waitFor(() => expect(vi.mocked(api.fetchPlaylist).mock.calls.filter(([id]) => id === 'night').length).toBe(before + 1));

    // switching away and back re-evaluates: "true right now"
    await chooseLocation('A', 'library');
    await chooseLocation('A', 'Night owls');
    await waitFor(() => expect(vi.mocked(api.fetchPlaylist).mock.calls.filter(([id]) => id === 'night').length).toBe(before + 2));
  });

  it('a 409 playlist_is_dynamic from the backend is shown as a reason, not as a code', async () => {
    const { listA } = await setup(BASE);
    vi.mocked(api.addSongToPlaylist).mockRejectedValue(new Error('{"error":"playlist_is_dynamic"}'));
    focus(listA);
    key(listA, ' ');
    key(listA, 'F5');
    await waitFor(() => expect(statusText()).toMatch(/1 failed/));
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText(/Dynamic playlist: the rule picks the songs/)).toBeInTheDocument();
    expect(screen.queryByText(/playlist_is_dynamic/)).not.toBeInTheDocument();
  });

  it('a dynamic playlist of somebody else: read-only, rule not editable, but it can be copied from', async () => {
    const { listA } = await setup({ ...DYN, saradyn: { name: 'Sara night', owner: 'sara', keys: [AIR], kind: 'dynamic', rule: NIGHT_RULE, ruleSummary: 'Most played' } });
    await chooseLocation('A', 'Sara night');
    await waitFor(() => expect(rowsOf(screen.getByRole('listbox', { name: /Pane A/ }))).toHaveLength(1));
    focus(listA);
    key(listA, 'F4');
    await waitFor(() => expect(statusText()).toMatch(/Only the owner can share it or change its rule/));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    key(listA, 'F5');
    await waitFor(() => expect(api.addSongToPlaylist).toHaveBeenCalledWith('p1', AIR));
  });
});
