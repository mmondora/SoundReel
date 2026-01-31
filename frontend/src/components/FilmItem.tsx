import type { Film } from '../types';

interface FilmItemProps {
  film: Film;
}

export function FilmItem({ film }: FilmItemProps) {
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
            title="Apri su IMDb"
          >
            IMDb
          </a>
        )}
      </div>
    </div>
  );
}
