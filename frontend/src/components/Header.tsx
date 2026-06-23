import { useState, useRef, useEffect } from 'react';
import { Link } from 'react-router-dom';
import type { JournalStats } from '../types';
import { useLanguage } from '../i18n';
import { SearchOverlay } from './SearchOverlay';

const APP_VERSION = __APP_VERSION__;
const GIT_REVISION = __GIT_REVISION__;

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const { t } = useLanguage();
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const handleClose = () => {
    setSearchOpen(false);
    setSearchQuery('');
  };

  // Click-outside on the wrapper div (covers both input + overlay)
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setSearchOpen(false);
      }
    };
    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, []);

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setSearchOpen(e.target.value.trim().length >= 2);
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
        <div className="search-wrapper" ref={wrapperRef}>
          <input
            className="search-input"
            type="search"
            placeholder="Cerca…"
            value={searchQuery}
            onChange={handleSearchChange}
            onFocus={() => {
              if (searchQuery.trim().length >= 2) setSearchOpen(true);
            }}
            aria-label="Cerca tra i link salvati"
          />
          {searchOpen && (
            <SearchOverlay query={searchQuery} onClose={handleClose} />
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
