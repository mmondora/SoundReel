import { describe, expect, it } from 'vitest';
import { canonicalGenres } from '../utils/genres';
import { THEME_GENRES } from './autoPlaylistTitle';
import { parseRule } from './dynamicRules';
import { GENRE_OF_THEME, GENRE_PLAYLIST_LIMIT, THEME_SUFFIX, genreRule, genreThemeKey, genresOfThemeTitle } from './genreThemes';

describe('which themes name a genre the metadata knows', () => {
  it('«Soul da ascoltare» is the genre R&B/Soul (the canonical name the chips and the rules use)', () => {
    expect(genresOfThemeTitle('Soul da ascoltare')).toEqual(['R&B/Soul']);
    expect(genresOfThemeTitle('Jazz da ascoltare')).toEqual(['Jazz']);
    expect(genresOfThemeTitle('Rock da ascoltare')).toEqual(['Rock', 'Hard Rock']);
  });

  it('a theme the metadata has no tag for is NOT a theme of a genre: it stays a list of the songs of the posts', () => {
    for (const word of ['Synthwave', 'Darkwave', 'Italo disco', 'Disco', 'Lo-fi', 'Musica italiana', 'Anni 80', 'Anni 90']) {
      expect(genresOfThemeTitle(`${word} da ascoltare`), word).toBeNull();
    }
  });

  it('the occasions and the free titles are not a genre', () => {
    for (const title of ['Musica per la notte', 'Musica per allenarsi', 'Band rock da ascoltare', 'Album da ascoltare per gli audiofili', 'Le 5 musiche di Natale', '']) {
      expect(genresOfThemeTitle(title), title).toBeNull();
    }
  });

  it('is exact on the title: a genre word inside a longer title, or another suffix, is no match', () => {
    expect(genresOfThemeTitle('Soul italiano da ascoltare')).toBeNull();
    expect(genresOfThemeTitle('Soul da riascoltare')).toBeNull();
    expect(genresOfThemeTitle('Soul')).toBeNull();
    expect(genresOfThemeTitle('Soul 0123456789abc')).toBeNull(); // as long as the suffix, but not the suffix
    expect(genresOfThemeTitle('  Soul da ascoltare  ')).toEqual(['R&B/Soul']);
    expect(genresOfThemeTitle('toString da ascoltare')).toBeNull(); // not an inherited property of the table
    expect(genresOfThemeTitle('constructor da ascoltare')).toBeNull();
  });

  it('hands out a copy: changing the answer does not change the table', () => {
    const got = genresOfThemeTitle('Jazz da ascoltare');
    got?.push('Hacked');
    expect(genresOfThemeTitle('Jazz da ascoltare')).toEqual(['Jazz']);
  });
});

describe('the table is consistent with the closed list and with the genres of the metadata', () => {
  it('every word is a theme of the closed list (a typo would make a playlist nobody can reach)', () => {
    for (const word of Object.keys(GENRE_OF_THEME)) expect(THEME_GENRES as readonly string[], word).toContain(word);
  });

  it('every genre is canonical: it is the label the songs carry once canonicalised, so the rule matches them', () => {
    for (const [word, genres] of Object.entries(GENRE_OF_THEME)) {
      expect(genres.length, word).toBeGreaterThan(0);
      expect(canonicalGenres([...genres]).sort(), word).toEqual([...genres].sort());
    }
  });

  it('the suffix is what the closed list ends with', () => {
    expect(THEME_SUFFIX).toBe(' da ascoltare');
  });
});

describe('one theme per set of genres', () => {
  it('«Rap» and «Hip hop», «R&B» and «Soul» are the same playlist', () => {
    const key = (title: string) => genreThemeKey(genresOfThemeTitle(title) ?? []);
    expect(key('Rap da ascoltare')).toBe(key('Hip hop da ascoltare'));
    expect(key('R&B da ascoltare')).toBe(key('Soul da ascoltare'));
    expect(key('Soul da ascoltare')).toBe('genre:R&B/Soul');
  });

  it('different genres are different themes, and the order of the genres does not matter', () => {
    expect(genreThemeKey(['Jazz'])).not.toBe(genreThemeKey(['Blues']));
    expect(genreThemeKey(['Rock', 'Hard Rock'])).toBe(genreThemeKey(['Hard Rock', 'Rock']));
    expect(genreThemeKey(['Rock', 'Hard Rock'])).not.toBe(genreThemeKey(['Rock']));
  });

  it('the key never looks like the key of a theme made of words (the unique index keeps the two apart)', () => {
    expect(genreThemeKey(['Jazz']).startsWith('genre:')).toBe(true);
  });
});

describe('the rule of the playlist of a genre', () => {
  it('every genre theme gives a rule that parseRule keeps as it is (what the database stores is what is evaluated)', () => {
    for (const [word, genres] of Object.entries(GENRE_OF_THEME)) {
      const rule = genreRule(genres);
      expect(parseRule(rule), word).toEqual({ ok: true, rule });
    }
  });

  it('is «every song with the tag, the last added first»: order newest, the whole library, no listening in it', () => {
    expect(genreRule(['R&B/Soul'])).toEqual({
      v: 1, scope: 'me', period: 'all', order: 'newest', limit: GENRE_PLAYLIST_LIMIT, minPlays: 1, genres: ['R&B/Soul'], downloadedOnly: false,
    });
    expect(GENRE_PLAYLIST_LIMIT).toBe(200);
  });
});
