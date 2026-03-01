import { Link } from 'react-router-dom';
import type { JournalStats } from '../types';
import { useLanguage } from '../i18n';

const APP_VERSION = __APP_VERSION__;

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const { t } = useLanguage();

  return (
    <header className="header">
      <div className="header-content">
        <div className="logo-wrapper">
          <Link to="/" className="logo">
            SoundReel
          </Link>
          <span className="version-badge">v{APP_VERSION}</span>
        </div>
        <div className="stats">
          <Link to="/entries" className="stat stat-link">{stats.totalEntries} {t.entries}</Link>
          <Link to="/songs" className="stat stat-link">{stats.totalSongs} {t.songs}</Link>
          <Link to="/films" className="stat stat-link">{stats.totalFilms} {t.films}</Link>
          <Link to="/notes" className="stat stat-link">{stats.totalNotes} {t.notes}</Link>
        </div>
        <nav className="nav">
          <Link to="/console" className="nav-link">{t.console}</Link>
          <Link to="/prompts" className="nav-link">{t.aiPrompts}</Link>
          <Link to="/settings" className="nav-link">{t.settings}</Link>
        </nav>
      </div>
    </header>
  );
}
