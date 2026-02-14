import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { JournalStats } from '../types';
import { deleteAllEntries } from '../services/api';
import { useLanguage, interpolate } from '../i18n';

const APP_VERSION = '1.4.0';

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useLanguage();

  const handleDeleteAll = async () => {
    if (!confirm(interpolate(t.confirmDeleteAll, { count: stats.totalEntries }))) {
      return;
    }

    setDeleting(true);
    try {
      const result = await deleteAllEntries();
      alert(interpolate(t.deleted, { count: result.deleted }));
    } catch (err) {
      console.error('Error deleting:', err);
      alert(t.errorDelete);
    } finally {
      setDeleting(false);
    }
  };

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
          {stats.totalEntries > 0 && (
            <button
              className="delete-all-btn"
              onClick={handleDeleteAll}
              disabled={deleting}
            >
              {deleting ? t.deleting : t.deleteAll}
            </button>
          )}
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
