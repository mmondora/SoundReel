import type { Film } from '../types';
import { useLanguage } from '../i18n';

interface FilmItemProps {
  film: Film;
}

export function FilmItem({ film }: FilmItemProps) {
  const { t } = useLanguage();

  return (
    <div className="film-item">
      <div className="film-info">
        <span className="film-title">{film.title}</span>
        {film.year && <span className="film-year">({film.year})</span>}
        {film.director && <span className="film-director">{film.director}</span>}
      </div>
      <div className="film-actions">
        {film.imdbUrl && (
          <a
            href={film.imdbUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="action-link imdb"
            title={t.openOnIMDb}
          >
            IMDb
          </a>
        )}
        {film.streamingUrls && (
          <>
            <a href={film.streamingUrls.netflix} target="_blank" rel="noopener noreferrer" className="action-link netflix" title={t.searchOnNetflix}>N</a>
            <a href={film.streamingUrls.primeVideo} target="_blank" rel="noopener noreferrer" className="action-link prime" title={t.searchOnPrimeVideo}>P</a>
            <a href={film.streamingUrls.raiPlay} target="_blank" rel="noopener noreferrer" className="action-link raiplay" title={t.searchOnRaiPlay}>Rai</a>
            <a href={film.streamingUrls.now} target="_blank" rel="noopener noreferrer" className="action-link now" title={t.searchOnNow}>NOW</a>
            <a href={film.streamingUrls.disneyPlus} target="_blank" rel="noopener noreferrer" className="action-link disney" title={t.searchOnDisneyPlus}>D+</a>
            <a href={film.streamingUrls.appleTv} target="_blank" rel="noopener noreferrer" className="action-link appletv" title={t.searchOnAppleTv}>TV</a>
          </>
        )}
      </div>
    </div>
  );
}
