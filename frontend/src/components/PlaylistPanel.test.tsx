import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PlaylistPanel } from './PlaylistPanel';
import { LanguageProvider } from '../i18n';
import * as api from '../services/api';

// New playlists must start EMPTY: the user adds/removes songs himself.
// Regression: the player used to seed the create call with the whole queue
// (or the whole catalog), so "Crea" produced a playlist with every song in it.

vi.mock('../services/api', () => ({
  fetchPlaylists: vi.fn().mockResolvedValue([]),
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
