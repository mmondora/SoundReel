import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { SongsPage } from './SongsPage';
import { LanguageProvider } from '../i18n';
import { setStoredLanguage } from '../i18n/translations';
import * as api from '../services/api';
import type { AggregatedSong } from '../types';

// Michele, 10 November: «la pagina canzoni ora con l'elenco delle play list è illeggibile». With dozens of playlists (most of them
// automatic, ADR-0023) the panel was 30 rows in front of the songs; the Songs page now shows it as ONE folded line.

vi.mock('../player/PlayerContext', () => ({ usePlayer: () => ({ playSong: vi.fn() }) }));
vi.mock('../services/api', () => ({
  fetchSongs: vi.fn(),
  patchSongMeta: vi.fn(),
  searchLibrary: vi.fn(),
  fetchMe: vi.fn(),
  fetchJournalStats: vi.fn().mockResolvedValue({ totalEntries: 0, totalSongs: 0, totalFilms: 0, totalNotes: 0, totalSoftware: 0 }),
  fetchPlaylists: vi.fn().mockResolvedValue([]),
  fetchPlaylistsPage: vi.fn(),
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

const playlist = (id: string, name: string) => ({
  id, name, songCount: 3, createdAt: '2026-11-05T10:00:00.000Z', updatedAt: '2026-11-05T10:00:00.000Z', origin: 'auto' as const, autoKind: 'theme' as const,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('it');
  vi.mocked(api.fetchSongs).mockResolvedValue(JOURNAL);
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true, family: [] });
  vi.mocked(api.fetchPlaylistsPage).mockResolvedValue({
    playlists: [playlist('a', 'Jazz da ascoltare'), playlist('b', 'Soul da ascoltare')], total: 59, limit: 30, offset: 0,
  });
});

function renderPage() {
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <SongsPage />
      </MemoryRouter>
    </LanguageProvider>,
  );
}

describe('the list of playlists on the Songs page', () => {
  it('is one folded line with the count; the songs are in front, not 30 playlists', async () => {
    renderPage();
    await screen.findByText('sexy boy');
    const toggle = screen.getByRole('button', { name: /^Playlist/ });
    await waitFor(() => expect(toggle).toHaveTextContent('59'));
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Jazz da ascoltare')).toBeNull();
    expect(document.querySelectorAll('.playlist-row').length).toBe(0);
    expect(document.querySelectorAll('.list-item-row').length).toBe(2);
  });

  it('opens on a click and the playlists scroll in a box of their own', async () => {
    renderPage();
    await screen.findByText('sexy boy');
    const toggle = screen.getByRole('button', { name: /^Playlist/ });
    await waitFor(() => expect(toggle).toHaveTextContent('59'));
    fireEvent.click(toggle);
    await screen.findByText('Jazz da ascoltare');
    expect(document.querySelector('.playlist-list-scroll')?.querySelectorAll('.playlist-row').length).toBe(2);
    expect(screen.getByRole('button', { name: /Mostra altre/ })).toBeInTheDocument();
  });
});
