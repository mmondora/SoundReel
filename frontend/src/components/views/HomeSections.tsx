import { useMemo, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { interpolate, useLanguage } from '../../i18n';
import { useUiPrefs } from '../../hooks/useUiPrefs';
import { useWebHome } from '../../hooks/useWebHome';
import { initial } from '../../utils/initial';
import { orderHomeSections } from '../../utils/homeSections';
import { HOME_SECTION_TITLE } from '../../utils/homeSectionTitles';
import type { HomeSectionId, WebHomeFilm, WebHomePlaylist, WebHomeSection, WebHomeSong } from '../../types';
import { CollectionCard } from '../CollectionCard';
import { Wall } from './Wall';
import { postFromSummary } from './postCard';

// The Home view (look and feel P3, board C of the mockups): the sections the server prepared, in the order and with the switches the user
// chose. The page computes nothing (rule P): the server decides what is in a section and in which order its items are; this draws them, links
// them to their pages, and skips what it does not know.

/** Where «see all» goes. */
const SEE_ALL: Record<HomeSectionId, string> = {
  resume: '/entries',
  songs: '/songs',
  playlists: '/playlist-manager',
  collections: '/collections',
  films: '/films',
};

function Art({ src, name, poster = false }: { src: string | null; name: string; poster?: boolean }) {
  const className = poster ? 'home-tile-art poster' : 'home-tile-art';
  return src ? (
    <img className={className} src={src} alt="" loading="lazy" />
  ) : (
    <span className={className} aria-hidden="true">{initial(name)}</span>
  );
}

function SongTile({ song }: { song: WebHomeSong }) {
  return (
    <Link to={`/songs?q=${encodeURIComponent(song.title)}`} className="home-tile" title={`${song.title} — ${song.artist}`}>
      <Art src={song.coverUrl} name={song.title} />
      <span className="home-tile-title">{song.title}</span>
      <span className="home-tile-sub">{song.artist}</span>
    </Link>
  );
}

function PlaylistTile({ playlist }: { playlist: WebHomePlaylist }) {
  const { t } = useLanguage();
  return (
    <Link to="/playlist-manager" className="home-tile" title={playlist.name}>
      <Art src={null} name={playlist.name} />
      <span className="home-tile-title">{playlist.name}</span>
      <span className="home-tile-sub">
        {interpolate(t.mgrItems, { n: playlist.songCount })}
        {playlist.origin === 'auto' && <span className="home-tile-badge">{t.playlistAutoBadge}</span>}
      </span>
      {playlist.kind === 'dynamic' && playlist.ruleSummary && <span className="home-tile-sub">{playlist.ruleSummary}</span>}
    </Link>
  );
}

function FilmTile({ film }: { film: WebHomeFilm }) {
  return (
    <Link to="/films" className="home-tile" title={film.year ? `${film.title} (${film.year})` : film.title}>
      <Art src={film.posterUrl} name={film.title} poster />
      <span className="home-tile-title">{film.title}</span>
      {film.year && <span className="home-tile-sub">{film.year}</span>}
    </Link>
  );
}

interface HomeSectionProps {
  section: WebHomeSection;
  selectedId: string | null;
  onOpenEntry: (id: string) => void;
}

function HomeSection({ section, selectedId, onOpenEntry }: HomeSectionProps) {
  const { t } = useLanguage();
  const title = t[HOME_SECTION_TITLE[section.id]];
  const headingId = `home-section-${section.id}`;
  let body: ReactNode;
  switch (section.id) {
    case 'resume':
      body = <Wall className="home-rail" label={title} posts={section.items.map(postFromSummary)} selectedId={selectedId} onSelect={onOpenEntry} />;
      break;
    case 'songs':
      body = <ul className="home-rail" aria-label={title}>{section.items.map((song) => <li key={song.songKey}><SongTile song={song} /></li>)}</ul>;
      break;
    case 'playlists':
      body = <ul className="home-rail" aria-label={title}>{section.items.map((pl) => <li key={pl.id}><PlaylistTile playlist={pl} /></li>)}</ul>;
      break;
    case 'collections':
      body = <ul className="home-rail" aria-label={title}>{section.items.map((collection) => <li key={collection.id}><CollectionCard collection={collection} /></li>)}</ul>;
      break;
    case 'films':
      body = <ul className="home-rail" aria-label={title}>{section.items.map((film) => <li key={film.filmKey}><FilmTile film={film} /></li>)}</ul>;
      break;
  }
  return (
    <section className="home-section" aria-labelledby={headingId}>
      <header className="home-section-head">
        <h2 id={headingId}>{title}</h2>
        <Link to={SEE_ALL[section.id]} className="home-see-all">{interpolate(t.homeSeeAll, { count: section.total })}</Link>
      </header>
      {body}
    </section>
  );
}

export interface HomeSectionsProps {
  /** The post that is open (the page shows it in a panel that closes). */
  selectedId: string | null;
  onOpenEntry: (id: string) => void;
}

export function HomeSections({ selectedId, onOpenEntry }: HomeSectionsProps) {
  const { t } = useLanguage();
  const { prefs } = useUiPrefs();
  const { sections, loading, error, reload } = useWebHome();
  const drawn = useMemo(() => orderHomeSections(prefs?.home.sections ?? null, sections), [prefs, sections]);

  if (loading) {
    return (
      <div className="journal-loading">
        <span className="spinner" />
        <p>{t.loading}</p>
      </div>
    );
  }
  if (error) {
    return (
      <div className="home-error" role="alert">
        <p>{t.homeLoadError}</p>
        <button type="button" onClick={reload}>{t.libRetry}</button>
      </div>
    );
  }
  if (drawn.length === 0) {
    return (
      <div className="journal-empty">
        <p>{t.homeEmpty}</p>
      </div>
    );
  }
  return (
    <div className="home-sections">
      {drawn.map((section) => (
        <HomeSection key={section.id} section={section} selectedId={selectedId} onOpenEntry={onOpenEntry} />
      ))}
    </div>
  );
}
