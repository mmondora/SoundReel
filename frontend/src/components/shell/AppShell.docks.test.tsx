import '@testing-library/jest-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AppShell } from './AppShell';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { setStoredLanguage, translations } from '../../i18n/translations';
import * as api from '../../services/api';
import { applyPrefsPatch } from '../../utils/uiPrefs';
import type { PlayerDock, UiPrefs } from '../../types';

// Look and feel P4 (spec L3, Michele: «si, ma spostabile»): the shell puts the Player where the user chose: the bar at the bottom (the start),
// a floating pill, a panel on the right, or hidden (one line in the menu). The Player page is the player itself: no second one there.

const song = { songKey: 'a::b', title: 'Nightcall', artist: 'Kavinsky', meta: null };
const player = {
  queue: [song], index: 0, current: song, playing: false, currentTime: 0, duration: 0, queueLabel: null, loading: false, locationOverrides: {}, currentDownload: null,
  repeat: 'off', toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(), playSong: vi.fn(),
};
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
vi.mock('../player/SourceSwitch', () => ({ SourceSwitch: () => null }));
vi.mock('../player/PlayingFrom', () => ({ PlayingFrom: () => null }));
vi.mock('../manager/DownloadChip', () => ({ DownloadChip: () => null }));
vi.mock('../LocationBadge', () => ({ LocationBadge: () => null }));
vi.mock('../../services/api', () => ({
  fetchMe: vi.fn(), fetchJournalStats: vi.fn(), fetchUiPrefs: vi.fn(), saveUiPrefs: vi.fn(), resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.it;
const prefs = (dock: PlayerDock | string): UiPrefs => ({
  v: 1, views: { inbox: 'studio', links: 'studio' },
  home: { sections: ['resume', 'songs', 'playlists', 'collections', 'films'].map((id) => ({ id, visible: true })) as UiPrefs['home']['sections'] },
  player: { dock: dock as PlayerDock, float: { x: 1, y: 1 } },
});

function fakeServer(start: UiPrefs): void {
  let doc = start;
  vi.mocked(api.fetchUiPrefs).mockImplementation(async () => doc);
  vi.mocked(api.saveUiPrefs).mockImplementation(async (patch) => { doc = applyPrefsPatch(doc, patch); return doc; });
}

function phone(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes('760'), media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

function renderShell(path = '/songs') {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}>
        <UiPrefsProvider>
          <Routes>
            <Route element={<AppShell />}>
              <Route path="/songs" element={<p>pagina canzoni</p>} />
              <Route path="/player" element={<p>pagina player</p>} />
            </Route>
          </Routes>
        </UiPrefsProvider>
      </MemoryRouter>
    </LanguageProvider>,
  );
}

const shell = (c: HTMLElement) => c.querySelector('.shell') as HTMLElement;
const places = (c: HTMLElement) => ({
  bar: c.querySelector('.shell-bar') !== null,
  pill: c.querySelector('.shell-float') !== null,
  panel: c.querySelector('.shell-side') !== null,
  line: c.querySelector('.shell-rail-player') !== null,
});
const NONE = { bar: false, pill: false, panel: false, line: false };

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  setStoredLanguage('it');
  phone(false);
  vi.mocked(api.fetchMe).mockResolvedValue({ user: 'mike', displayName: 'Michele', isAdmin: false, authenticated: true, family: [] });
  vi.mocked(api.fetchJournalStats).mockResolvedValue({ totalEntries: 1, totalSongs: 1, totalFilms: 1, totalNotes: 1, totalSoftware: 1 });
});
afterEach(() => {
  // @ts-expect-error back to «no matchMedia», like the other tests
  delete window.matchMedia;
});

describe('where the Player is', () => {
  it.each([
    ['bottom', { ...NONE, bar: true }],
    ['float', { ...NONE, pill: true }],
    ['side', { ...NONE, panel: true }],
    ['hidden', { ...NONE, line: true }],
  ] as const)('%s: exactly that place, and none of the others', async (dock, expected) => {
    fakeServer(prefs(dock));
    const { container } = renderShell();
    await waitFor(() => expect(shell(container)).toHaveClass(`shell--dock-${dock}`));
    expect(places(container)).toEqual(expected);
    expect(screen.getByText('pagina canzoni')).toBeInTheDocument();
  });

  it('the bar is where the Player starts when there is no document (the server cannot be asked): never a Player that is nowhere', async () => {
    vi.mocked(api.fetchUiPrefs).mockRejectedValue(new Error('network down'));
    const { container } = renderShell();
    await waitFor(() => expect(places(container).bar).toBe(true));
    expect(shell(container)).toHaveClass('shell--dock-bottom');
  });

  it('a place the site does not know (a newer server) is the bar', async () => {
    fakeServer(prefs('orbit'));
    const { container } = renderShell();
    await waitFor(() => expect(places(container).bar).toBe(true));
    expect(places(container)).toEqual({ ...NONE, bar: true });
  });

  it.each(['bottom', 'float', 'side', 'hidden'] as const)('on the Player page there is no second player, whatever the place (%s)', async (dock) => {
    fakeServer(prefs(dock));
    const { container } = renderShell('/player');
    await screen.findByText('pagina player');
    await waitFor(() => expect(vi.mocked(api.fetchUiPrefs)).toHaveBeenCalled());
    expect(places(container)).toEqual(NONE);
  });

  it('opening the shell never starts the player, in any place', async () => {
    for (const dock of ['bottom', 'float', 'side', 'hidden'] as const) {
      fakeServer(prefs(dock));
      const { container, unmount } = renderShell();
      await waitFor(() => expect(shell(container)).toHaveClass(`shell--dock-${dock}`));
      unmount();
    }
    expect(player.toggle).not.toHaveBeenCalled();
  });
});

describe('on a phone', () => {
  it('a floating pill or a panel on the right have no room: the bar; hidden stays hidden (the choice is the user\'s, on every device)', async () => {
    phone(true);
    for (const [dock, expected] of [['float', { ...NONE, bar: true }], ['side', { ...NONE, bar: true }], ['hidden', { ...NONE, line: true }], ['bottom', { ...NONE, bar: true }]] as const) {
      fakeServer(prefs(dock));
      const { container, unmount } = renderShell();
      await waitFor(() => expect(vi.mocked(api.fetchUiPrefs)).toHaveBeenCalled());
      await waitFor(() => expect(places(container)).toEqual(expected));
      unmount();
    }
  });
});

describe('choosing the place in «Personalizza»', () => {
  it('moves the Player at once: the bar goes, the panel on the right comes, and the place is saved', async () => {
    fakeServer(prefs('bottom'));
    const { container } = renderShell();
    await waitFor(() => expect(places(container).bar).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Altro' }));
    await userEvent.click(screen.getByRole('menuitem', { name: t.personalizeOpen }));
    const dialog = await screen.findByRole('dialog', { name: t.personalizeTitle });
    await userEvent.click(within(dialog).getByRole('radio', { name: t.playerDockSide }));
    expect(places(container)).toEqual({ ...NONE, panel: true });
    expect(api.saveUiPrefs).toHaveBeenCalledWith({ player: { dock: 'side' } });
  });

  it('from hidden, the button of the line in the menu brings the bar back', async () => {
    fakeServer(prefs('hidden'));
    const { container } = renderShell();
    await waitFor(() => expect(places(container).line).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: t.dockShowBar }));
    await waitFor(() => expect(places(container)).toEqual({ ...NONE, bar: true }));
  });
});
