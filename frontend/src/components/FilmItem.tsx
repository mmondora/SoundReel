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
      </div>
    </div>
  );
}
