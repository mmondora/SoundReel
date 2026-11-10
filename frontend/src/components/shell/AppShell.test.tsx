import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage } from '../../i18n/translations';
import * as api from '../../services/api';

// The layout every page lives in: top bar, left menu, the page, the player bar. A page no longer draws a header of its own.

const player = { current: null, locationOverrides: {}, currentDownload: null, playing: false, currentTime: 0, duration: 0, queueLabel: null, loading: false, toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn() };
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
// the pieces of the player bar that have their own tests
vi.mock('../player/SourceSwitch', () => ({ SourceSwitch: () => null }));
vi.mock('../player/PlayingFrom', () => ({ PlayingFrom: () => null }));
vi.mock('../manager/DownloadChip', () => ({ DownloadChip: () => null }));
vi.mock('../LocationBadge', () => ({ LocationBadge: () => null }));
vi.mock('../../services/api', () => ({ fetchMe: vi.fn(), fetchJournalStats: vi.fn() }));

function renderAt(path: string) {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<AppShell />}>
            <Route path="/" element={<Link to="/songs">vai alle canzoni</Link>} />
            <Route path="/songs" element={<p>pagina canzoni</p>} />
            <Route path="/player" element={<p>pagina player</p>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setStoredLanguage('it');
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true, family: [] });
  vi.mocked(api.fetchJournalStats).mockResolvedValue({ totalEntries: 1721, totalSongs: 943, totalFilms: 731, totalNotes: 6143, totalSoftware: 1370 });
});

describe('AppShell', () => {
  it('puts the page between the menu and the player bar, with ONE top bar and ONE menu', async () => {
    renderAt('/songs');
    expect(screen.getByText('pagina canzoni')).toBeInTheDocument();
    expect(screen.getAllByRole('banner')).toHaveLength(1);
    expect(screen.getAllByRole('navigation', { name: 'Sezioni' })).toHaveLength(1);
    expect(screen.getByRole('main')).toContainElement(screen.getByText('pagina canzoni'));
    expect(screen.getByRole('region', { name: 'Player' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /canzoni/i })).toHaveTextContent('943'));
  });

  it('marks the page that is open in the menu', () => {
    renderAt('/songs');
    expect(screen.getByRole('link', { name: /canzoni/i })).toHaveAttribute('aria-current', 'page');
  });

  it('on the Player page there is no second player: the bar is not drawn', () => {
    renderAt('/player');
    expect(screen.getByText('pagina player')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Player' })).not.toBeInTheDocument();
  });

  it('reads the numbers of the journal once for the page that opens, not once for every piece of the shell', async () => {
    renderAt('/');
    await waitFor(() => expect(api.fetchJournalStats).toHaveBeenCalled());
    expect(api.fetchJournalStats).toHaveBeenCalledTimes(1);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('reads the numbers again when the page changes (what was analysed meanwhile shows in the menu)', async () => {
    renderAt('/');
    await waitFor(() => expect(api.fetchJournalStats).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('link', { name: 'vai alle canzoni' }));
    await screen.findByText('pagina canzoni');
    await waitFor(() => expect(api.fetchJournalStats).toHaveBeenCalledTimes(2));
  });

  it('a failure of the numbers does not break the shell', async () => {
    vi.mocked(api.fetchJournalStats).mockRejectedValue(new Error('down'));
    renderAt('/songs');
    await waitFor(() => expect(api.fetchJournalStats).toHaveBeenCalled());
    expect(screen.getByText('pagina canzoni')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /canzoni/i })).not.toHaveTextContent(/\d/);
  });

  it('opening the shell never starts the player', () => {
    renderAt('/songs');
    expect(player.toggle).not.toHaveBeenCalled();
  });
});
