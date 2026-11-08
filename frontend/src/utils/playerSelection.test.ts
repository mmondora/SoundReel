import { describe, expect, it } from 'vitest';
import { selectionLabel, shuffled } from './playerSelection';
import { EMPTY_FILTERS } from './managerSongs';
import { NO_YEAR } from './songFacets';

const IT = { language: 'it' as const, noYear: 'Senza anno', search: (q: string) => `Ricerca: ${q}` };
const EN = { language: 'en' as const, noYear: 'No year', search: (q: string) => `Search: ${q}` };

describe('selectionLabel: what the queue is called', () => {
  it('nothing picked: no name of its own (the shelf or the playlist names it)', () => {
    expect(selectionLabel(EMPTY_FILTERS, IT)).toBeNull();
    expect(selectionLabel({ ...EMPTY_FILTERS, text: '   ' }, IT)).toBeNull();
  });

  it('names the picks, decades the way people say them', () => {
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [1980], genres: ['Elettronica'] }, IT)).toBe('Anni 80 · Elettronica');
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [1980, 2000] }, IT)).toBe('Anni 80 + Anni 2000');
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [1980] }, EN)).toBe('1980s');
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [NO_YEAR] }, IT)).toBe('Senza anno');
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [NO_YEAR] }, EN)).toBe('No year');
  });

  it('album, author and search text; the playlist comes first', () => {
    expect(selectionLabel({ ...EMPTY_FILTERS, albums: ['Discovery'], artists: ['Daft Punk'] }, IT)).toBe('Discovery · Daft Punk');
    expect(selectionLabel({ ...EMPTY_FILTERS, text: '  maestro   bassi ' }, IT)).toBe('Ricerca: maestro bassi');
    expect(selectionLabel({ ...EMPTY_FILTERS, decades: [1990] }, IT, 'Road trip')).toBe('Road trip · Anni 90');
    expect(selectionLabel(EMPTY_FILTERS, IT, 'Road trip')).toBe('Road trip');
  });

  it('stays short: at most four parts, then an ellipsis', () => {
    const label = selectionLabel({ ...EMPTY_FILTERS, decades: [1980], genres: ['Pop'], albums: ['A'], artists: ['B'], text: 'c' }, IT, 'P');
    expect(label).toBe('P · Anni 80 · Pop · A …');
  });
});

describe('shuffled', () => {
  const list = [1, 2, 3, 4, 5, 6];

  it('is a permutation of the same songs, and leaves the input alone', () => {
    const out = shuffled(list, () => 0.3);
    expect([...out].sort()).toEqual(list);
    expect(list).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('can start anywhere (the first song is shuffled too) and is deterministic for a given random source', () => {
    const picks = [0.99, 0.5, 0.1, 0.8, 0.2];
    const run = () => { let i = 0; return shuffled(list, () => picks[i++ % picks.length]); };
    expect(run()).toEqual(run());
    expect(run()[0]).not.toBe(list[0]);
  });

  it('copes with 0 and 1 songs', () => {
    expect(shuffled([])).toEqual([]);
    expect(shuffled([7])).toEqual([7]);
  });
});
