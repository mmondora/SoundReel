import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { useLanguage } from '../../i18n';
import type { JournalStats } from '../../types';

/** 943 → «943», 1721 → «1,7k», 6143 → «6,1k»: the way the old header wrote the counts. */
export function formatCount(n: number | undefined | null): string {
  if (n == null) return '';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1).replace('.', ',')}k`;
  return String(n);
}

/** The icon of each section: plain strokes, like the symbols of the app. */
const ICONS: Record<string, ReactNode> = {
  '/': (<><path d="M22 12h-6l-2 3h-4l-2-3H2" /><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" /></>),
  '/entries': (<><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" /></>),
  '/songs': (<><path d="M9 18V5l12-2v13" /><circle cx="6" cy="18" r="3" /><circle cx="18" cy="16" r="3" /></>),
  '/films': (<><rect x="2" y="2" width="20" height="20" rx="2.2" /><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5" /></>),
  '/software': (<><path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" /></>),
  '/notes': (<><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7z" /><path d="M14 2v4a2 2 0 0 0 2 2h4M8 13h8M8 17h8M8 9h2" /></>),
  '/player': (<polygon points="7 3 20 12 7 21 7 3" />),
  '/playlist-manager': (<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />),
  '/stats': (<><path d="M3 3v18h18" /><path d="M18 17V9M13 17V5M8 17v-3" /></>),
};

interface RailProps {
  stats: JournalStats | null;
}

/** The left menu of the shell: the sections of the site, in two groups, the current one marked. */
export function Rail({ stats }: RailProps) {
  const { t } = useLanguage();

  const archive = [
    { to: '/', end: true, label: t.navInbox, count: undefined as number | undefined },
    { to: '/entries', end: false, label: t.navLinks, count: stats?.totalEntries },
    { to: '/songs', end: false, label: t.songs, count: stats?.totalSongs },
    { to: '/films', end: false, label: t.films, count: stats?.totalFilms },
    { to: '/software', end: false, label: t.software, count: stats?.totalSoftware },
    { to: '/notes', end: false, label: t.notes, count: stats?.totalNotes },
  ];
  const listen = [
    { to: '/player', end: false, label: t.playerNav, count: undefined as number | undefined },
    { to: '/playlist-manager', end: false, label: t.playlistsTitle, count: undefined as number | undefined },
    { to: '/stats', end: false, label: t.statsNav, count: undefined as number | undefined },
  ];

  const group = (title: string, items: typeof archive) => (
    <>
      <div className="shell-group">{title}</div>
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          className={({ isActive }) => `shell-nav${isActive ? ' active' : ''}`}
        >
          <svg className="shell-ic" viewBox="0 0 24 24" aria-hidden="true">{ICONS[item.to]}</svg>
          <span className="shell-nav-label">{item.label}</span>
          {item.count != null && <span className="shell-nav-count">{formatCount(item.count)}</span>}
        </NavLink>
      ))}
    </>
  );

  return (
    <nav className="shell-rail" aria-label={t.shellNavLabel}>
      {group(t.shellGroupArchive, archive)}
      {group(t.shellGroupListen, listen)}
    </nav>
  );
}
