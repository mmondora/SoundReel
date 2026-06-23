import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearch } from '../hooks/useSearch';
import type { SearchResult } from '../types';

const PLATFORM_LABELS: Record<string, string> = {
  instagram: 'IG', tiktok: 'TT', youtube: 'YT', facebook: 'FB',
  twitter: 'X', threads: 'TH', snapchat: 'SC', pinterest: 'PIN',
  linkedin: 'LI', reddit: 'RD', vimeo: 'VM', twitch: 'TW',
  spotify: 'SP', soundcloud: 'SND',
};

function truncate(s: string | null, max: number): string {
  if (!s) return '';
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

function ResultRow({ result, onClose }: { result: SearchResult; onClose: () => void }) {
  const navigate = useNavigate();

  const handleClick = () => {
    onClose();
    navigate(`/?entry=${result.id}`);
  };

  const label = PLATFORM_LABELS[result.sourcePlatform] ?? 'WEB';
  const summary = result.results.summary ?? result.caption;
  const songCount = result.results.songs.length;
  const filmCount = result.results.films.length;
  const noteCount = result.results.notes.length;

  return (
    <button className="search-result-row" onClick={handleClick}>
      {result.thumbnailUrl ? (
        <img src={result.thumbnailUrl} alt="" className="search-result-thumb" loading="lazy" />
      ) : (
        <div className="search-result-thumb-placeholder">{label}</div>
      )}
      <div className="search-result-body">
        <div className="search-result-url">{truncate(result.sourceUrl, 60)}</div>
        {summary && (
          <div className="search-result-summary">{truncate(summary, 120)}</div>
        )}
        <div className="search-result-badges">
          {songCount > 0 && <span>♪ {songCount}</span>}
          {filmCount > 0 && <span>🎬 {filmCount}</span>}
          {noteCount > 0 && <span>📝 {noteCount}</span>}
          {result.results.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="search-result-tag">{tag}</span>
          ))}
        </div>
      </div>
    </button>
  );
}

interface SearchOverlayProps {
  query: string;
  onClose: () => void;
}

export function SearchOverlay({ query, onClose }: SearchOverlayProps) {
  const { results, expandedTerms, loading, error } = useSearch(query);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  if (query.trim().length < 2) return null;

  return (
    <div className="search-overlay">
      {loading && <div className="search-overlay-status">Ricerca in corso…</div>}
      {error && <div className="search-overlay-status search-overlay-error">Errore: {error}</div>}
      {!loading && !error && results.length === 0 && (
        <div className="search-overlay-status">Nessun risultato per "{query}"</div>
      )}
      {expandedTerms.length > 0 && (
        <div className="search-expanded-terms">
          Cercato anche: {expandedTerms.join(', ')}
        </div>
      )}
      <div className="search-results-list">
        {results.map((r) => (
          <ResultRow key={r.id} result={r} onClose={onClose} />
        ))}
      </div>
    </div>
  );
}
