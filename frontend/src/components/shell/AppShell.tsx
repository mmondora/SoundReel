import { Outlet, useLocation } from 'react-router-dom';
import { useJournalStats } from '../../hooks/useJournalStats';
import { PlayerBar } from './PlayerBar';
import { Rail } from './Rail';
import { TopBar } from './TopBar';
import '../../styles/shell.css';

/**
 * The layout every page lives in (the A direction of the look and feel, spec 2026-11-10-web-look-and-feel-rethink-design.md): the top bar, the
 * menu on the left, the page in the middle and the player at the bottom. A page no longer draws a header of its own. On the Player page the
 * bar is not drawn: that page IS the player.
 */
export function AppShell() {
  const stats = useJournalStats();
  const { pathname } = useLocation();
  const showBar = pathname !== '/player';

  return (
    <div className={`shell${showBar ? '' : ' shell--no-bar'}`}>
      <TopBar />
      <Rail stats={stats} />
      <main className="shell-main" id="main">
        <Outlet />
      </main>
      {showBar && <PlayerBar />}
    </div>
  );
}
