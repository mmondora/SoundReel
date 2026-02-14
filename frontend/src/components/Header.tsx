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
          <span className="stat">{stats.totalEntries} {t.entries}</span>
          <span className="stat">{stats.totalSongs} {t.songs}</span>
          <span className="stat">{stats.totalFilms} {t.films}</span>
          <span className="stat">{stats.totalNotes} {t.notes}</span>
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
