/**
 * One card per film (spec 2026-11-08-no-duplicates-and-post-links, D1; ADR-0017).
 *
 * `filmKey` is title + year, so "Dune" and "Dune (2021)" were two cards; measured on 8 November: 14 titles under more
 * than one spelling or year. At READ time the cards collapse by normalized title when the years agree or one of them has
 * none; two different years stay two films (Dune 1984, Dune 2021). A card with no year joins the year the title is best
 * known by (the most mentions). Nothing stored is rewritten.
 */
import type { AggregatedFilm } from '../types';
import { addMention } from '../utils/mentions';

const titleKey = (title: string): string =>
  title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const yearOf = (film: Pick<AggregatedFilm, 'year'>): string => (film.year ?? '').toString().trim();

export function collapseFilms(films: AggregatedFilm[]): AggregatedFilm[] {
  // 1. bucket by title, then by year
  const byTitle = new Map<string, Map<string, AggregatedFilm[]>>();
  const order: string[] = [];
  for (const film of films) {
    const t = titleKey(film.title) || `\u0000${film.filmKey}`;
    if (!byTitle.has(t)) {
      byTitle.set(t, new Map());
      order.push(t);
    }
    const years = byTitle.get(t)!;
    const y = yearOf(film);
    if (!years.has(y)) years.set(y, []);
    years.get(y)!.push(film);
  }

  const out: AggregatedFilm[] = [];
  for (const t of order) {
    const years = byTitle.get(t)!;
    const dated = [...years.entries()].filter(([y]) => y !== '');
    const undated = years.get('') ?? [];

    // 2. the films that have no year join the dated one with the most mentions (if the title has any dated film)
    const groups = new Map<string, AggregatedFilm[]>(dated.map(([y, list]) => [y, [...list]]));
    if (undated.length > 0) {
      if (groups.size === 0) groups.set('', [...undated]);
      else {
        const best = [...groups.entries()].sort(
          (a, b) => b[1].reduce((n, f) => n + f.mentions.length, 0) - a[1].reduce((n, f) => n + f.mentions.length, 0),
        )[0][0];
        groups.get(best)!.push(...undated);
      }
    }

    for (const members of groups.values()) out.push(members.length === 1 ? members[0] : merge(members));
  }
  return out;
}

function merge(members: AggregatedFilm[]): AggregatedFilm {
  // the card that knows the most leads: persisted metadata first, then the most mentions
  const lead = [...members].sort(
    (a, b) => Number(!!b.meta) - Number(!!a.meta) || b.mentions.length - a.mentions.length,
  )[0];
  const mentions: AggregatedFilm['mentions'] = [];
  for (const m of members) for (const mention of m.mentions) addMention(mentions, mention);
  mentions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const first = <K extends keyof AggregatedFilm>(key: K): AggregatedFilm[K] =>
    (lead[key] ?? members.find((m) => m[key] != null)?.[key] ?? null) as AggregatedFilm[K];
  return {
    filmKey: lead.filmKey,
    title: lead.title,
    director: first('director'),
    year: first('year'),
    imdbUrl: first('imdbUrl'),
    posterUrl: first('posterUrl'),
    streamingUrls: first('streamingUrls'),
    mentions,
    meta: lead.meta,
  };
}
