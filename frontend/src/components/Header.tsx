import { Link, useSearchParams } from 'react-router-dom';
import type { JournalStats } from '../types';
import { useLanguage } from '../i18n';

const APP_VERSION = __APP_VERSION__;
const GIT_REVISION = __GIT_REVISION__;

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        if (value) n.set('q', value);
        else n.delete('q');
        return n;
      },
      { replace: true }
    );
  };

  const handleClear = () => {
    setSearchParams(
      (prev) => {
        const n = new URLSearchParams(prev);
        n.delete('q');
        return n;
      },
      { replace: true }
    );
  };

  return (
    <header className="header">
      <div className="header-content">
        <div className="logo-wrapper">
          <Link to="/" className="logo">
            SoundReel
          </Link>
          <span className="version-badge" title={`build ${GIT_REVISION}`}>v{APP_VERSION}</span>
        </div>
        <div className="stats">
          <Link to="/entries" className="stat stat-link">{stats.totalEntries} {t.entries}</Link>
          <Link to="/songs" className="stat stat-link">{stats.totalSongs} {t.songs}</Link>
          <Link to="/films" className="stat stat-link">{stats.totalFilms} {t.films}</Link>
          <Link to="/notes" className="stat stat-link">{stats.totalNotes} {t.notes}</Link>
        </div>
        <div className="search-wrapper">
          <input
            className="search-input"
            type="search"
            placeholder="Cerca…"
            value={q}
            onChange={handleSearchChange}
            aria-label="Cerca tra i link salvati"
          />
          {q && (
            <button className="search-clear-btn" onClick={handleClear} aria-label="Cancella ricerca">
              ×
            </button>
          )}
        </div>
        <nav className="nav">
          <Link to="/console" className="nav-link">{t.console}</Link>
          <Link to="/prompts" className="nav-link">{t.aiPrompts}</Link>
          <Link to="/admin" className="nav-link">Admin</Link>
          <Link to="/settings" className="nav-link">{t.settings}</Link>
        </nav>
      </div>
    </header>
  );
}
