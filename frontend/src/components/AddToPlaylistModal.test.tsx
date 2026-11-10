import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AddToPlaylistModal } from './AddToPlaylistModal';
import { LanguageProvider } from '../i18n';
import * as api from '../services/api';

vi.mock('../services/api', () => ({
  fetchPlaylistsPage: vi.fn(),
  addSongToPlaylist: vi.fn(),
  createPlaylist: vi.fn(),
}));

const row = (id: string, name: string, createdAt = '2026-11-05T10:00:00.000Z') => ({ id, name, songCount: 3, createdAt, updatedAt: createdAt });
const show = (onDone = vi.fn(), onClose = vi.fn()) =>
  render(
    <LanguageProvider>
      <AddToPlaylistModal songKey="a::b" songLabel="A – B" onClose={onClose} onDone={onDone} />
    </LanguageProvider>,
  );

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.setItem('soundreel-language', 'it');
  vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [row('a', 'Jazz da ascoltare'), row('b', 'Road trip', '2025-12-24T10:00:00.000Z')], total: 2, limit: 30, offset: 0 } as never);
});
afterEach(() => {
  localStorage.removeItem('soundreel-language');
});

describe('the sheet «add to a playlist»', () => {
  it('lists the playlists, the newest first, with the date of creation beside the name', async () => {
    show();
    await screen.findByText('Jazz da ascoltare');
    expect(api.fetchPlaylistsPage).toHaveBeenCalledWith(expect.objectContaining({ sort: 'created', order: 'desc', limit: 30 }));
    expect(screen.getByText('5 nov')).toBeTruthy();
    expect(screen.getByText('24 dic 2025')).toBeTruthy();
  });

  it('has only the search (the sheet is small), and the search goes to the server', async () => {
    show();
    await screen.findByText('Jazz da ascoltare');
    expect(screen.queryByLabelText('Ordina le playlist per')).toBeNull();
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'road' } });
    await waitFor(() => expect(api.fetchPlaylistsPage).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'road', offset: 0 })), { timeout: 2000 });
  });

  it('picking a playlist adds the song to it', async () => {
    const onDone = vi.fn();
    const onClose = vi.fn();
    vi.mocked(api.addSongToPlaylist).mockResolvedValue({ id: 'a' } as never);
    show(onDone, onClose);
    fireEvent.click(await screen.findByText('Jazz da ascoltare'));
    await waitFor(() => expect(api.addSongToPlaylist).toHaveBeenCalledWith('a', 'a::b'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('says «nessuna playlist corrisponde» when a search finds nothing', async () => {
    show();
    await screen.findByText('Jazz da ascoltare');
    vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({ playlists: [], total: 0, limit: 30, offset: 0 } as never);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'zzz' } });
    await screen.findByText('Nessuna playlist corrisponde', undefined, { timeout: 2000 });
  });
});
