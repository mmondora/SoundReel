import { describe, expect, it } from 'vitest';
import { collapseFilms } from './filmCollapse';
import type { AggregatedFilm } from '../types';

const m = (entryId: string, createdAt = '2026-11-08T07:00:00Z') => ({ entryId, createdAt, sourceUrl: `https://www.instagram.com/reel/${entryId}`, sourcePlatform: 'instagram' });
const film = (title: string, year: string | null, mentions = [m('e1')], over: Partial<AggregatedFilm> = {}): AggregatedFilm => ({
  filmKey: `${title.toLowerCase()}::${year ?? ''}`, title, director: null, year, imdbUrl: null, posterUrl: null, streamingUrls: null, mentions, meta: null, ...over,
});

describe('collapseFilms: one card per film', () => {
  it('"Dune" and "Dune (2021)" are one card with every post', () => {
    const [one, ...rest] = collapseFilms([film('Dune', null, [m('e1', '2026-11-01T00:00:00Z')]), film('Dune', '2021', [m('e2', '2026-11-05T00:00:00Z')])]);
    expect(rest).toHaveLength(0);
    expect(one.year).toBe('2021');
    expect(one.mentions.map((x) => x.entryId)).toEqual(['e2', 'e1']);
  });

  it('different years stay different films (Dune 1984, Dune 2021)', () => {
    const out = collapseFilms([film('Dune', '1984'), film('Dune', '2021', [m('e2')])]);
    expect(out.map((f) => f.year).sort()).toEqual(['1984', '2021']);
  });

  it('a film with no year joins the year the title is best known by', () => {
    const out = collapseFilms([film('Dune', '1984', [m('a')]), film('Dune', '2021', [m('b'), m('c')]), film('Dune', null, [m('d')])]);
    expect(out).toHaveLength(2);
    const modern = out.find((f) => f.year === '2021')!;
    expect(modern.mentions.map((x) => x.entryId).sort()).toEqual(['b', 'c', 'd']);
    expect(out.find((f) => f.year === '1984')!.mentions).toHaveLength(1);
  });

  it('case, accents and punctuation do not make a new film', () => {
    const [one, ...rest] = collapseFilms([film('Amélie', '2001'), film('amelie', '2001', [m('e2')]), film('AMÉLIE!', null, [m('e3')])]);
    expect(rest).toHaveLength(0);
    expect(one.mentions).toHaveLength(3);
  });

  it('the card that knows the most leads, and fills the gaps from the others', () => {
    const [one] = collapseFilms([
      film('Dune', '2021', [m('e1')], { director: 'Denis Villeneuve', meta: { filmKey: 'dune::2021' } as never }),
      film('Dune', null, [m('e2'), m('e3')], { imdbUrl: 'https://www.imdb.com/title/tt1160419/', posterUrl: 'https://img/p.jpg' }),
    ]);
    expect(one.filmKey).toBe('dune::2021');
    expect(one.director).toBe('Denis Villeneuve');
    expect(one.imdbUrl).toBe('https://www.imdb.com/title/tt1160419/');
    expect(one.posterUrl).toBe('https://img/p.jpg');
    expect(one.meta).toEqual({ filmKey: 'dune::2021' });
  });

  it('a post that names the film twice counts once', () => {
    const [one] = collapseFilms([film('Heat', '1995', [m('e1')]), film('Heat', null, [m('e1')])]);
    expect(one.mentions).toHaveLength(1);
  });

  it('different films, and an empty list, are left alone', () => {
    expect(collapseFilms([film('Heat', '1995'), film('Ronin', '1998')]).map((f) => f.title)).toEqual(['Heat', 'Ronin']);
    expect(collapseFilms([])).toEqual([]);
  });
});
