import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaylistPanel, PLAYLIST_PANEL_OPEN_KEY } from './PlaylistPanel';
import { LanguageProvider } from '../i18n';
import * as api from '../services/api';

// New playlists must start EMPTY: the user adds/removes songs himself.
// Regression: the player used to seed the create call with the whole queue
// (or the whole catalog), so "Crea" produced a playlist with every song in it.

vi.mock('../services/api', () => ({
  fetchPlaylists: vi.fn().mockResolvedValue([]),
  fetchPlaylistsPage: vi.fn().mockResolvedValue({ playlists: [], total: 0, limit: 30, offset: 0 }),
  fetchPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
  renamePlaylist: vi.fn(),
  deletePlaylist: vi.fn(),
  addSongToPlaylist: vi.fn(),
  removeSongFromPlaylist: vi.fn(),
}));

describe('PlaylistPanel create', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the playlist with the name only (no songs)', async () => {
    const created = { id: 'p1', name: 'Auto', songKeys: [] };
    vi.mocked(api.createPlaylist).mockResolvedValue(created as never);
    const onSelect = vi.fn();

    render(
      <LanguageProvider>
        <PlaylistPanel activeId={null} onSelect={onSelect} compact />
      </LanguageProvider>,
    );

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Auto' } });
    // Label is just "Crea"/"Create": no "(N)" song count any more.
    fireEvent.click(screen.getByRole('button', { name: /^(Crea|Create)$/ }));

    await waitFor(() => expect(api.createPlaylist).toHaveBeenCalledTimes(1));
    expect(api.createPlaylist).toHaveBeenCalledWith('Auto');
    await waitFor(() => expect(onSelect).toHaveBeenCalledWith(created));
  });
});

// The list of playlists: the date of creation beside the name, the automatic ones marked, search, sort and pages (ADR-0023).
describe('PlaylistPanel list', () => {
  const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, name, songCount: 3, createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', ...over,
  });
  const show = () =>
    render(
      <LanguageProvider>
        <PlaylistPanel activeId={null} onSelect={vi.fn()} />
      </LanguageProvider>,
    );

  // the tests read the Italian interface (the default of a test browser is English)
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.setItem('soundreel-language', 'it');
  });
  afterEach(() => {
    localStorage.removeItem('soundreel-language');
  });

  it('writes the creation date beside each name and marks the automatic playlists', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({
      playlists: [row('a', 'Jazz da ascoltare', { origin: 'auto', autoKind: 'theme' }), row('b', 'Road trip', { createdAt: '2025-12-24T10:00:00.000Z' })],
      total: 2, limit: 30, offset: 0,
    } as never);
    show();
    await screen.findByText('Jazz da ascoltare');
    expect(screen.getByText('automatica')).toBeTruthy();
    expect(screen.getByText('5 nov')).toBeTruthy();
    expect(screen.getByText('24 dic 2025')).toBeTruthy();
  });

  it('asks the server for the newest first, and for «show more» with the next page', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValueOnce({ playlists: [row('a', 'Prima')], total: 2, limit: 30, offset: 0 } as never);
    show();
    await screen.findByText('Prima');
    expect(api.fetchPlaylistsPage).toHaveBeenCalledWith(expect.objectContaining({ sort: 'created', order: 'desc', limit: 30, offset: 0 }));
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValueOnce({ playlists: [row('b', 'Seconda')], total: 2, limit: 30, offset: 1 } as never);
    fireEvent.click(screen.getByRole('button', { name: /Mostra altre/ }));
    await screen.findByText('Seconda');
    expect(api.fetchPlaylistsPage).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1 }));
    expect(screen.queryByRole('button', { name: /Mostra altre/ })).toBeNull();
  });

  it('a filter goes to the server; with nothing matching it says so (not «create one»)', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [row('a', 'Jazz da ascoltare')], total: 1, limit: 30, offset: 0 } as never);
    show();
    await screen.findByText('Jazz da ascoltare');
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [], total: 0, limit: 30, offset: 0 } as never);
    fireEvent.click(screen.getByRole('button', { name: 'Condivise' }));
    await waitFor(() => expect(api.fetchPlaylistsPage).toHaveBeenLastCalledWith(expect.objectContaining({ filter: 'shared', offset: 0 })));
    await screen.findByText('Nessuna playlist corrisponde');
    expect(screen.queryByText(/creane una/)).toBeNull();
  });

  it('with no playlist at all it says to create one', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [], total: 0, limit: 30, offset: 0 } as never);
    show();
    await screen.findByText(/creane una/);
  });

  it('the sort control offers the date of creation first and the arrow flips the direction', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [row('a', 'Uno')], total: 1, limit: 30, offset: 0 } as never);
    show();
    await screen.findByText('Uno');
    const select = screen.getByLabelText('Ordina le playlist per') as HTMLSelectElement;
    expect(select.value).toBe('created');
    fireEvent.click(screen.getByRole('button', { name: /invertire/ }));
    await waitFor(() => expect(api.fetchPlaylistsPage).toHaveBeenLastCalledWith(expect.objectContaining({ sort: 'created', order: 'asc' })));
  });
});

// The Songs page folds the panel into ONE line, and its list scrolls in a box of its own. Michele, 10 November:
// «la pagina canzoni ora con l'elenco delle play list è illeggibile» (59 playlists were 30 rows in front of the songs, and on a
// phone each name was squeezed to three letters by the badge, the date and the buttons).
describe('PlaylistPanel folded (the Songs page)', () => {
  const row = (id: string, name: string, over: Record<string, unknown> = {}) => ({
    id, name, songCount: 3, createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', ...over,
  });
  const page = (names: string[], total = names.length) => ({
    playlists: names.map((n, i) => row(`p${i}`, n)), total, limit: 30, offset: 0,
  });
  const show = (props: Partial<React.ComponentProps<typeof PlaylistPanel>> = {}) =>
    render(
      <LanguageProvider>
        <PlaylistPanel collapsible activeId={null} onSelect={vi.fn()} {...props} />
      </LanguageProvider>,
    );
  const toggle = () => screen.getByRole('button', { name: /^Playlist/ });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    localStorage.setItem('soundreel-language', 'it');
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue(page(['Jazz da ascoltare', 'Road trip'], 59) as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('is folded by default: one line with the count of ALL the playlists, no rows, no create box', async () => {
    show();
    await waitFor(() => expect(toggle().textContent).toContain('59'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Jazz da ascoltare')).toBeNull();
    expect(screen.queryByPlaceholderText('Nome playlist…')).toBeNull();
    expect(document.querySelector('.playlist-panel')?.classList.contains('collapsed')).toBe(true);
  });

  it('opens on a click, folds on the next, and remembers the choice', async () => {
    show();
    await waitFor(() => expect(toggle().textContent).toContain('59'));
    fireEvent.click(toggle());
    await screen.findByText('Jazz da ascoltare');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByPlaceholderText('Nome playlist…')).toBeTruthy();
    expect(localStorage.getItem(PLAYLIST_PANEL_OPEN_KEY)).toBe('1');
    fireEvent.click(toggle());
    expect(screen.queryByText('Jazz da ascoltare')).toBeNull();
    expect(localStorage.getItem(PLAYLIST_PANEL_OPEN_KEY)).toBe('0');
  });

  it('comes back open when it was left open', async () => {
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    show();
    await screen.findByText('Jazz da ascoltare');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });

  it('the list scrolls in a box of its own (the Player, which is not folded, has none)', async () => {
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    const { unmount } = show();
    await screen.findByText('Jazz da ascoltare');
    const box = document.querySelector('.playlist-list-scroll');
    expect(box).not.toBeNull();
    expect(box?.querySelectorAll('.playlist-row').length).toBe(2);
    unmount();

    render(
      <LanguageProvider>
        <PlaylistPanel compact activeId={null} onSelect={vi.fn()} />
      </LanguageProvider>,
    );
    await screen.findByText('Jazz da ascoltare');
    expect(document.querySelector('.playlist-list-scroll')).toBeNull();
    // always open, no toggle: the Player shows the panel when its own button asks for it
    expect(screen.queryByRole('button', { name: /^Playlist/ })).toBeNull();
  });

  it('keeps counting ALL the playlists while a search narrows the list', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockImplementation((async (query?: { q?: string }) =>
      (query?.q ? page(['Jazz da ascoltare'], 1) : page(['Jazz da ascoltare', 'Road trip'], 59))) as never);
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    show();
    await screen.findByText('Road trip');
    await waitFor(() => expect(toggle().textContent).toContain('59'));
    fireEvent.change(screen.getByPlaceholderText('Cerca nelle playlist'), { target: { value: 'jazz' } });
    await waitFor(() => expect(screen.queryByText('Road trip')).toBeNull());
    expect(api.fetchPlaylistsPage).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'jazz' }));
    expect(toggle().textContent).toContain('59');
    expect(toggle().textContent).not.toContain('1 ');
  });

  it('stays open while a song is being added, whatever was saved, and does not overwrite the saved choice', async () => {
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '0');
    show({ songToAdd: 'air::sexy boy' });
    await screen.findByText('Jazz da ascoltare');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
    expect((toggle() as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByTitle('Aggiungi a playlist').length).toBe(2);
    expect(localStorage.getItem(PLAYLIST_PANEL_OPEN_KEY)).toBe('0');
  });

  it('choosing a playlist hands it to the page and folds the list so its songs are in front', async () => {
    vi.mocked(api.fetchPlaylist).mockResolvedValue({ ...row('p0', 'Jazz da ascoltare'), songKeys: [] } as never);
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    const onSelect = vi.fn();
    show({ onSelect });
    fireEvent.click(await screen.findByText('Jazz da ascoltare'));
    await waitFor(() => expect(onSelect).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(toggle().getAttribute('aria-expanded')).toBe('false'));
    expect(screen.queryByText('Road trip')).toBeNull();
  });

  it('with a playlist chosen, «Mostra tutte» stays on the folded line', async () => {
    const onSelect = vi.fn();
    show({ activeId: 'p0', onSelect });
    fireEvent.click(await screen.findByRole('button', { name: 'Mostra tutte' }));
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('marks a dynamic playlist and says what its rule is; a static one has neither', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({
      playlists: [
        row('d', 'Soul da ascoltare', { kind: 'dynamic', origin: 'auto', autoKind: 'theme', ruleSummary: 'Più recenti · R&B/Soul · max 200' }),
        row('s', 'Road trip', { kind: 'static' }),
      ],
      total: 2, limit: 30, offset: 0,
    } as never);
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    show();
    await screen.findByText('Soul da ascoltare');
    expect(screen.getAllByText('dinamica').length).toBe(1);
    expect(screen.getByText('Più recenti · R&B/Soul · max 200')).toBeTruthy();
    expect(screen.getAllByText('automatica').length).toBe(1);
    const staticRow = screen.getByText('Road trip').closest('.playlist-row');
    expect(staticRow?.querySelector('.playlist-dynamic')).toBeNull();
    expect(staticRow?.querySelector('.playlist-rule')).toBeNull();
  });

  it('keeps the badges and the date out of the line of the name (a phone squeezed the name to three letters)', async () => {
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({
      playlists: [row('a', 'Album poco chiacchierati da recuperare', { origin: 'auto', autoKind: 'one_off' })],
      total: 1, limit: 30, offset: 0,
    } as never);
    localStorage.setItem(PLAYLIST_PANEL_OPEN_KEY, '1');
    show();
    const name = await screen.findByText('Album poco chiacchierati da recuperare');
    expect(name.parentElement?.classList.contains('playlist-main')).toBe(true);
    const meta = name.parentElement?.querySelector('.playlist-meta');
    expect(meta?.querySelector('.playlist-auto')).not.toBeNull();
    expect(meta?.querySelector('.playlist-date')).not.toBeNull();
    // the name is not inside the line of the meta
    expect(meta?.contains(name)).toBe(false);
  });

  it('a blocked localStorage does not break it: folded, and it still opens', async () => {
    const realGet = Storage.prototype.getItem;
    const realSet = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
      if (key === PLAYLIST_PANEL_OPEN_KEY) throw new Error('blocked');
      return realGet.call(this, key);
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (key === PLAYLIST_PANEL_OPEN_KEY) throw new Error('blocked');
      realSet.call(this, key, value);
    });
    show();
    await waitFor(() => expect(toggle().textContent).toContain('59'));
    expect(toggle().getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle());
    await screen.findByText('Jazz da ascoltare');
    expect(toggle().getAttribute('aria-expanded')).toBe('true');
  });
});
