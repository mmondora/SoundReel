import { describe, expect, it } from 'vitest';
import { canonicalGenre, canonicalGenres } from './genres';

// Every distinct genre of the real song_meta table (2026-11-07), to prove the merge is faithful.
const REAL = [
  'Pop', 'Elettronica', 'Alternative', 'Rock', 'Dance', 'Alternativa', 'Electro', 'Colonne sonore', 'Hip-Hop/Rap',
  'Rap/Hip Hop', 'R&B/Soul', 'Film/Videogiochi', 'Jazz', 'Indie Rock', 'Classica', 'Indie Pop', 'Ambient',
  'Classica Crossover', 'R&B', 'Strumentale', 'Musica classica', 'Cantautori', 'Easy listening', 'Musica latina', 'New Age',
  'Blues', 'Indie pop', 'Lenti', 'Country', 'Folk', 'House', 'Latina', 'Bambini', 'Funk', 'Hard rock', 'Indie Pop/Folk',
  'Indie Rock/Pop rock', 'Jungle/Drum’n’Bass', 'K-Pop', 'Metal', 'Pop in lingua spagnola', 'Techno', 'Techno/House',
  'Telugu', 'Turca', 'Worldwide', 'Alternativa adulti', 'Anime', 'Bollywood', 'Breakbeat', 'Epoca contemporanea',
  'Hard Rock', 'Hip-hop', 'Iberia', 'Mandopop', 'Modern Dancehall', 'Musica Africana', 'Musica Brasiliana',
  'Musica per bambini', 'Musical', 'Natale: per bambini', 'New Wave', 'Pop francese', 'Pop internazionale', 'Punk', 'Rap',
  'Rap tradizionale', 'Reggae', 'Reggaeton', 'Singer & Songwriter', 'Soul', 'Soul & Funk', 'Tamil', 'Trance',
];

describe('canonicalGenre', () => {
  it.each([
    ['Alternativa', 'Alternative'], ['alternative', 'Alternative'], ['Alternativa adulti', 'Alternative'],
    ['Rap/Hip Hop', 'Hip-Hop/Rap'], ['Hip-hop', 'Hip-Hop/Rap'], ['Rap', 'Hip-Hop/Rap'],
    ['Electro', 'Elettronica'], ['Elettronica', 'Elettronica'],
    ['Film/Videogiochi', 'Colonne sonore'], ['Colonne sonore', 'Colonne sonore'],
    ['Musica classica', 'Classica'], ['Classica Crossover', 'Classica'],
    ['R&B', 'R&B/Soul'], ['Soul & Funk', 'R&B/Soul'],
    ['Musica latina', 'Latina'], ['Indie pop', 'Indie Pop'], ['Hard rock', 'Hard Rock'],
    ['Musica per bambini', 'Bambini'], ['Pop internazionale', 'Pop'], ['Singer & Songwriter', 'Cantautori'],
  ])('%s → %s', (raw, canonical) => expect(canonicalGenre(raw)).toBe(canonical));

  it('leaves genres it does not know alone (trimmed, spaces collapsed), and the ones that are already right', () => {
    expect(canonicalGenre('  Trap  ')).toBe('Trap');
    expect(canonicalGenre('Jazz')).toBe('Jazz');
    expect(canonicalGenre('Modern   Dancehall')).toBe('Modern Dancehall');
    expect(canonicalGenre('Rock')).toBe('Rock');
    expect(canonicalGenre('Dance')).toBe('Dance'); // deliberately NOT merged into Elettronica
  });

  it('never loses a real genre and shrinks the duplicate chips without inventing new ones', () => {
    const mapped = new Set(REAL.map(canonicalGenre));
    expect(REAL.length).toBeGreaterThan(70);
    expect(mapped.size).toBeLessThan(REAL.length); // duplicates merged
    expect(mapped.size).toBeGreaterThan(50); // …but not collapsed into a handful
    for (const g of REAL) expect(canonicalGenre(canonicalGenre(g))).toBe(canonicalGenre(g)); // idempotent
    for (const keep of ['Jazz', 'Rock', 'Pop', 'Metal', 'Blues', 'Punk', 'Reggae', 'Techno', 'Trance']) expect(mapped.has(keep)).toBe(true);
  });
});

describe('canonicalGenres', () => {
  it('dedupes after merging and sorts; tolerates null, empty strings and garbage', () => {
    expect(canonicalGenres(['Alternativa', 'Alternative', 'Rock', ' ', 'Electro', 'Elettronica'])).toEqual(['Alternative', 'Elettronica', 'Rock']);
    expect(canonicalGenres(null)).toEqual([]);
    expect(canonicalGenres(undefined)).toEqual([]);
    expect(canonicalGenres([7 as unknown as string, 'Jazz'])).toEqual(['Jazz']);
  });
});
