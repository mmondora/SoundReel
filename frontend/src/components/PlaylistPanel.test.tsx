import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaylistPanel } from './PlaylistPanel';
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
