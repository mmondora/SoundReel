import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useSearchParams } from 'react-router-dom';
import type { JournalStats, MeResponse } from '../types';
import { useLanguage } from '../i18n';
import { fetchJournalStats, fetchMe } from '../services/api';

const APP_VERSION = __APP_VERSION__;
const GIT_REVISION = __GIT_REVISION__;

interface HeaderProps {
  /** Optional; when omitted the header loads /api/stats itself. */
  stats?: JournalStats | null;
}

function formatCount(n: number | undefined): string {
  if (n == null) return '—';
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}

export function Header({ stats: statsProp }: HeaderProps) {
  const { t } = useLanguage();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const [stats, setStats] = useState<JournalStats | null>(statsProp ?? null);
  const [me, setMe] = useState<MeResponse | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (statsProp) {
      setStats(statsProp);
      return;
    }
    let cancelled = false;
    fetchJournalStats()
      .then((s) => { if (!cancelled) setStats(s); })
      .catch(() => { /* keep null */ });
    return () => { cancelled = true; };
  }, [statsProp, location.pathname]);

  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((m) => { if (!cancelled) setMe(m); })
      .catch(() => { /* keep null */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    function onDoc(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (value) n.set('q', value);
        else n.delete('q');
        return n;
      },
      { replace: true },
    );
  };

  const handleClear = () => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete('q');
        return n;
      },
      { replace: true },
    );
  };

  const primary = [
    { to: '/', end: true, label: t.navInbox },
    { to: '/entries', end: false, label: t.navLinks, count: stats?.totalEntries },
    { to: '/songs', end: false, label: t.songs, count: stats?.totalSongs },
    { to: '/films', end: false, label: t.films, count: stats?.totalFilms },
    { to: '/notes', end: false, label: t.notes, count: stats?.totalNotes },
    { to: '/player', end: false, label: t.playerNav },
    { to: '/playlist-manager', end: false, label: t.playlistsTitle },
    { to: '/stats', end: false, label: t.statsNav },
  ];

  return (
    <header className="sr-header">
      <div className="sr-header-inner">
        <div className="sr-brand">
          <Link to="/" className="sr-logo">
            SoundReel
          </Link>
          <span className="sr-logo-sub">{t.navKbLabel}</span>
          <span className="sr-version" title={`build ${GIT_REVISION}`}>v{APP_VERSION}</span>
          {me && (
            <span
              className="sr-user-badge"
              title={me.authenticated ? `Authelia · ${me.user}` : 'Anonymous (no Remote-User)'}
            >
              {me.displayName}
              {me.isAdmin ? ' · admin' : ''}
            </span>
          )}
        </div>

        <nav className="sr-nav" aria-label="Primary">
          {primary.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) => `sr-nav-link${isActive ? ' active' : ''}`}
            >
              <span>{item.label}</span>
              {item.count != null && (
                <span className="sr-nav-count">{formatCount(item.count)}</span>
              )}
            </NavLink>
          ))}
        </nav>

        <div className="sr-search">
          <input
            className="sr-search-input"
            type="search"
            placeholder={t.navSearchPlaceholder}
            value={q}
            onChange={handleSearchChange}
            aria-label={t.navSearchPlaceholder}
          />
          {q && (
            <button type="button" className="sr-search-clear" onClick={handleClear} aria-label="Clear">
              ×
            </button>
          )}
        </div>

        <div className="sr-more" ref={menuRef}>
          <button
            type="button"
            className={`sr-more-btn${menuOpen ? ' open' : ''}`}
            aria-expanded={menuOpen}
            aria-haspopup="menu"
            onClick={() => setMenuOpen((v) => !v)}
          >
            ⋯
          </button>
          {menuOpen && (
            <div className="sr-more-menu" role="menu">
              <Link to="/software" role="menuitem" onClick={() => setMenuOpen(false)}>
                {t.software}
                {stats?.totalSoftware != null ? ` · ${formatCount(stats.totalSoftware)}` : ''}
              </Link>
              <Link to="/library" role="menuitem" onClick={() => setMenuOpen(false)}>
                {t.libraryNav}
              </Link>
              <hr />
              <Link to="/console" role="menuitem" onClick={() => setMenuOpen(false)}>
                {t.console}
              </Link>
              <Link to="/prompts" role="menuitem" onClick={() => setMenuOpen(false)}>
                {t.aiPrompts}
              </Link>
              <Link to="/admin" role="menuitem" onClick={() => setMenuOpen(false)}>
                Admin
              </Link>
              <Link to="/settings" role="menuitem" onClick={() => setMenuOpen(false)}>
                {t.settings}
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
