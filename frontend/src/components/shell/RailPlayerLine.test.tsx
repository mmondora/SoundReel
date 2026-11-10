import '@testing-library/jest-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { Rail } from './Rail';
import { UiPrefsProvider } from '../../hooks/useUiPrefs';
import { LanguageProvider } from '../../i18n';
import { translations } from '../../i18n/translations';
import * as api from '../../services/api';
import { applyPrefsPatch } from '../../utils/uiPrefs';
import type { UiPrefs } from '../../types';

// The Player when it is hidden (look and feel P4, L3: «nascosto (una riga nel menu a sinistra)»): the bar is gone, and in the menu there is one line
// with what plays, play or pause, next, and a way back to the bar. It starts nothing by itself.

const player = {
  current: null as null | { songKey: string; title: string; artist: string },
  playing: false, currentTime: 0, duration: 0, queueLabel: null, loading: false, locationOverrides: {}, currentDownload: null,
  toggle: vi.fn(), next: vi.fn(), previous: vi.fn(), seek: vi.fn(),
};
vi.mock('../../player/PlayerContext', () => ({ usePlayer: () => player }));
vi.mock('../../services/api', () => ({
  fetchUiPrefs: vi.fn(), saveUiPrefs: vi.fn(), resetUiPrefs: vi.fn(),
  UiPrefsAnonymousError: class UiPrefsAnonymousError extends Error {},
}));

const t = translations.en;
const START: UiPrefs = {
  v: 1, views: { inbox: 'studio', links: 'studio' },
  home: { sections: ['resume', 'songs', 'playlists', 'collections', 'films'].map((id) => ({ id, visible: true })) as UiPrefs['home']['sections'] },
  player: { dock: 'hidden', float: { x: 1, y: 1 } },
};

function renderRail(hiddenPlayer: boolean) {
  let doc = START;
  vi.mocked(api.fetchUiPrefs).mockImplementation(async () => doc);
  vi.mocked(api.saveUiPrefs).mockImplementation(async (patch) => { doc = applyPrefsPatch(doc, patch); return doc; });
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <UiPrefsProvider><Rail stats={null} hiddenPlayer={hiddenPlayer} /></UiPrefsProvider>
      </MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  player.current = { songKey: 'kavinsky::nightcall', title: 'Nightcall', artist: 'Kavinsky' };
  player.playing = false;
});

describe('the Player line in the menu', () => {
  it('is there only when the Player is hidden', () => {
    const open = renderRail(false);
    expect(screen.queryByRole('group', { name: t.shellPlayerLabel })).toBeNull();
    open.unmount();
    renderRail(true);
    expect(screen.getByRole('group', { name: t.shellPlayerLabel })).toBeInTheDocument();
  });

  it('shows what plays; with nothing loaded it says so', () => {
    const view = renderRail(true);
    const line = screen.getByRole('group', { name: t.shellPlayerLabel });
    expect(line).toHaveTextContent('Nightcall');
    expect(line).toHaveTextContent('Kavinsky');
    view.unmount();
    player.current = null;
    renderRail(true);
    expect(screen.getByRole('group', { name: t.shellPlayerLabel })).toHaveTextContent(t.shellNothingPlaying);
  });

  it('plays or pauses, goes to the next song, and starts nothing by itself', async () => {
    renderRail(true);
    expect(player.toggle).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: t.shellPlay }));
    expect(player.toggle).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole('button', { name: t.shellNext }));
    expect(player.next).toHaveBeenCalledTimes(1);
  });

  it('has no «previous» (the line is small): play or pause, next, the link and the way back', () => {
    renderRail(true);
    expect(screen.queryByRole('button', { name: t.shellPrevious })).toBeNull();
    const line = screen.getByRole('group', { name: t.shellPlayerLabel });
    expect(line.querySelectorAll('button')).toHaveLength(3);                // play, next, show the bar
  });

  it('shows «pause» while it plays', () => {
    player.playing = true;
    renderRail(true);
    expect(screen.getByRole('button', { name: t.shellPause })).toBeInTheDocument();
  });

  it('with nothing loaded the buttons wait', () => {
    player.current = null;
    renderRail(true);
    expect(screen.getByRole('button', { name: t.shellPlay })).toBeDisabled();
    expect(screen.getByRole('button', { name: t.shellNext })).toBeDisabled();
  });

  it('a button brings the bar back: it writes the bottom as the place of the Player', async () => {
    renderRail(true);
    await userEvent.click(screen.getByRole('button', { name: t.dockShowBar }));
    expect(api.saveUiPrefs).toHaveBeenCalledWith({ player: { dock: 'bottom' } });
  });

  it('the line has a link to the Player page too', () => {
    renderRail(true);
    expect(screen.getByRole('link', { name: t.shellOpenPlayer })).toHaveAttribute('href', '/player');
  });
});
