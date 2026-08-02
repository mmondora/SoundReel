import type { AggregatedFilm, StreamingUrls } from '../types';
import { safeUrl } from './songEnrichment';

/** Same service list and order as the FilmCard badges, so the exported page
 * and the app agree on what "where can I watch this" means. */
// keep in sync with FilmCard.tsx SERVICES
const SERVICES: Array<{ key: keyof StreamingUrls; label: string }> = [
  { key: 'netflix', label: 'Netflix' },
  { key: 'primeVideo', label: 'Prime' },
  { key: 'raiPlay', label: 'Rai' },
  { key: 'now', label: 'NOW' },
  { key: 'disneyPlus', label: 'D+' },
  { key: 'appleTv', label: 'TV' },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderCard(film: AggregatedFilm): string {
  const subtitle = [film.director, film.year].filter(Boolean).map(String).map(escapeHtml).join(' · ');
  // safeUrl restricts to http(s) before anything reaches an href/src: entry
  // JSONB is not schema-validated on write (see films.ts), so a value here
  // cannot be trusted to be a safe scheme just because it "should" be a URL.
  const posterUrl = safeUrl(film.posterUrl);
  const poster = posterUrl
    ? `<img src="${escapeHtml(posterUrl)}" alt="" loading="lazy">`
    : '<div class="noposter">🎬</div>';

  const links: string[] = [];
  // The API-reported deep links (meta.streamingOptions) take precedence, same
  // as FilmCard.tsx: they point straight at the title on that platform rather
  // than a generic search page. Only fall back to the generic search links
  // when the API has nothing for this film.
  const streamingOptions = film.meta?.streamingOptions ?? [];
  if (streamingOptions.length > 0) {
    for (const option of streamingOptions) {
      const href = safeUrl(option.url);
      if (href) links.push(`<a href="${escapeHtml(href)}">${escapeHtml(option.platform)}</a>`);
    }
  } else if (film.streamingUrls) {
    for (const svc of SERVICES) {
      const href = safeUrl(film.streamingUrls[svc.key]);
      if (href) links.push(`<a href="${escapeHtml(href)}">${svc.label}</a>`);
    }
  }
  const imdbUrl = safeUrl(film.imdbUrl);
  if (imdbUrl) links.push(`<a href="${escapeHtml(imdbUrl)}">IMDb</a>`);
  const iaPageUrl = safeUrl(film.meta?.iaPageUrl);
  if (iaPageUrl) links.push(`<a href="${escapeHtml(iaPageUrl)}">Archive</a>`);

  const downloaded = film.meta?.iaDownloadedPath ? '<span class="dl">✓ in archivio</span>' : '';

  return `<article>
  ${poster}
  <div class="body">
    <h2>${escapeHtml(film.title)}${downloaded}</h2>
    <p class="sub">${subtitle}</p>
    <p class="links">${links.join(' ')}</p>
  </div>
</article>`;
}

/**
 * Renders the whole film list as one self-contained HTML page. It lives on
 * the Fritz storage next to the media, so it must work with no network beyond
 * the links themselves and no local assets: styles are inlined and there is
 * no JavaScript. Posters are remote URLs and simply do not render offline.
 */
export function renderWatchlistHtml(films: AggregatedFilm[]): string {
  const sorted = [...films].sort((a, b) => a.title.localeCompare(b.title));
  const cards = sorted.map(renderCard).join('\n');

  return `<!doctype html>
<html lang="it">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SoundReel — Film</title>
<style>
:root { color-scheme: dark; }
body { margin: 0; padding: 1rem; background: #0a0a0a; color: #f5f5f7;
       font-family: system-ui, -apple-system, sans-serif; }
h1 { font-size: 1.2rem; margin: 0 0 1rem; }
article { display: flex; gap: .75rem; padding: .6rem 0; border-bottom: 1px solid #262626; }
article img, .noposter { width: 60px; height: 90px; object-fit: cover; border-radius: 4px;
       background: #1a1a1a; display: flex; align-items: center; justify-content: center; flex: none; }
.body { min-width: 0; }
h2 { font-size: .95rem; margin: 0 0 .2rem; font-weight: 600; }
.sub { font-size: .75rem; color: #a1a1aa; margin: 0 0 .35rem; }
.links a { display: inline-block; font-size: .65rem; font-weight: 600; padding: .1rem .4rem;
       margin: 0 .2rem .2rem 0; border-radius: 4px; background: #27272a; color: #f5f5f7;
       text-decoration: none; }
.dl { font-size: .65rem; color: #22c55e; margin-left: .4rem; }
.links { margin: 0; }
</style>
</head>
<body>
<h1>SoundReel — Film (${sorted.length})</h1>
${cards}
</body>
</html>
`;
}
