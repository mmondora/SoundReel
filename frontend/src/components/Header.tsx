import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { JournalStats } from '../types';
import { deleteAllEntries } from '../services/api';

const APP_VERSION = '1.2.0';

interface HeaderProps {
  stats: JournalStats;
}

export function Header({ stats }: HeaderProps) {
  const [deleting, setDeleting] = useState(false);

  const handleDeleteAll = async () => {
    if (!confirm(`Sei sicuro di voler eliminare tutte le ${stats.totalEntries} entry? Questa azione non può essere annullata.`)) {
      return;
    }

    setDeleting(true);
    try {
      const result = await deleteAllEntries();
      alert(`Eliminate ${result.deleted} entry`);
    } catch (err) {
      console.error('Errore eliminazione:', err);
      alert('Errore durante l\'eliminazione');
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
          <span className="stat">{stats.totalEntries} entries</span>
          <span className="stat">{stats.totalSongs} canzoni</span>
          <span className="stat">{stats.totalFilms} film</span>
          {stats.totalEntries > 0 && (
            <button
              className="delete-all-btn"
              onClick={handleDeleteAll}
              disabled={deleting}
            >
              {deleting ? 'Eliminazione...' : 'Cancella tutto'}
            </button>
          )}
        </div>
        <nav className="nav">
          <Link to="/console" className="nav-link">Console</Link>
          <Link to="/prompts" className="nav-link">Prompt AI</Link>
          <Link to="/settings" className="nav-link">Impostazioni</Link>
        </nav>
      </div>
    </header>
  );
}
