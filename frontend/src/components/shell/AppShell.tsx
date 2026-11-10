import { useRef } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { useJournalStats } from '../../hooks/useJournalStats';
import { useMediaQuery } from '../../hooks/useMediaQuery';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import type { PlayerDock } from '../../types';
import { FloatingPlayer } from './FloatingPlayer';
import { PlayerBar } from './PlayerBar';
import { Rail } from './Rail';
import { SidePlayer } from './SidePlayer';
import { TopBar } from './TopBar';
import '../../styles/shell.css';
import '../../styles/docks.css';

/** The width where the shell becomes the phone layout (the same breakpoint as `shell.css`): a floating pill and a side panel have no room there. */
const PHONE = '(max-width: 760px)';
const DOCKS: readonly PlayerDock[] = ['bottom', 'float', 'side', 'hidden'];

/**
 * The layout every page lives in (the A direction of the look and feel, spec 2026-11-10-web-look-and-feel-rethink-design.md): the top bar, the
 * menu on the left, the page in the middle and the player where the user put it (L3: «si, ma spostabile»): at the bottom (the start), a floating
 * pill, a panel on the right, or hidden (a line in the menu). A page no longer draws a header of its own. On the Player page there is no player
 * of the shell: that page IS the player. With no configuration (the server cannot be asked) or a place this build does not know, the Player is
 * at the bottom, where it always was; on a phone a pill and a panel have no room, so the bar is drawn instead.
 */
export function AppShell() {
  const stats = useJournalStats();
  const { pathname } = useLocation();
  const { prefs } = useUiPrefs();
  const phone = useMediaQuery(PHONE);
  const mainRef = useRef<HTMLElement>(null);
  const showPlayer = pathname !== '/player';

  const saved = prefs?.player.dock;
  const chosen: PlayerDock = saved && DOCKS.includes(saved) ? saved : 'bottom';
  const dock: PlayerDock = phone && (chosen === 'float' || chosen === 'side') ? 'bottom' : chosen;

  return (
    <div className={`shell shell--dock-${dock}${showPlayer ? '' : ' shell--no-bar'}`}>
      <TopBar />
      <Rail stats={stats} hiddenPlayer={showPlayer && dock === 'hidden'} />
      <main className="shell-main" id="main" ref={mainRef}>
        <Outlet />
      </main>
      {showPlayer && dock === 'bottom' && <PlayerBar />}
      {showPlayer && dock === 'float' && <FloatingPlayer areaRef={mainRef} />}
      {showPlayer && dock === 'side' && <SidePlayer />}
    </div>
  );
}
