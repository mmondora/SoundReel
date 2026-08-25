import { describe, it, expect } from 'vitest';
import { mergeEntryResults } from './entryMerge';
import type { EntryResults, Film, Song } from '../types';

const empty = (): EntryResults => ({
  songs: [], films: [], notes: [], links: [], tags: [], summary: null,
});

/**
 * A Song carries nine fields, all of them enrichment the first pass paid for.
 * The tests below name only title and artist because those are the key; the
 * factory fills the rest so the literals still typecheck as real songs.
 */
const song = (title: string, artist: string, extra: Partial<Song> = {}): Song => ({
  title,
  artist,
  album: null,
  source: 'ai_analysis',
  spotifyUri: null,
  spotifyUrl: null,
  youtubeUrl: null,
  soundcloudUrl: null,
  addedToPlaylist: false,
  ...extra,
});

const film = (title: string, extra: Partial<Film> = {}): Film => ({
  title,
  director: null,
  year: null,
  imdbUrl: null,
  posterUrl: null,
  streamingUrls: null,
  ...extra,
});

describe('mergeEntryResults', () => {
  it('keeps a song the second pass no longer finds', () => {
    const existing = { ...empty(), songs: [song('Roma', 'Baustelle')] };
    const incoming = { ...empty(), songs: [] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(1);
  });

  it('adds a song the second pass discovered', () => {
    const existing = { ...empty(), songs: [song('Roma', 'Baustelle')] };
    const incoming = { ...empty(), songs: [song('Charlie', 'Baustelle')] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(2);
  });

  it('does not duplicate the same song across casing and spacing', () => {
    const existing = { ...empty(), songs: [song('Roma', 'Baustelle')] };
    const incoming = { ...empty(), songs: [song('  roma ', 'BAUSTELLE')] };
    expect(mergeEntryResults(existing, incoming).songs).toHaveLength(1);
  });

  it('keeps the enriched copy of a song the second pass rediscovered bare', () => {
    // The whole reason the merge exists: the archived song carries a Spotify
    // link the second pass has no way to rebuild.
    const existing = {
      ...empty(),
      songs: [song('Roma', 'Baustelle', {
        spotifyUrl: 'https://open.spotify.com/track/abc',
        addedToPlaylist: true,
      })],
    };
    const incoming = { ...empty(), songs: [song('Roma', 'Baustelle')] };
    const out = mergeEntryResults(existing, incoming);
    expect(out.songs).toHaveLength(1);
    expect(out.songs[0].spotifyUrl).toBe('https://open.spotify.com/track/abc');
    expect(out.songs[0].addedToPlaylist).toBe(true);
  });

  it('keeps a film the second pass no longer finds and adds a new one', () => {
    const existing = { ...empty(), films: [film('Il Sorpasso', { imdbUrl: 'https://imdb.com/title/tt0056344' })] };
    const incoming = { ...empty(), films: [film('il sorpasso'), film('Amarcord')] };
    const out = mergeEntryResults(existing, incoming);
    expect(out.films.map((f) => f.title)).toEqual(['Il Sorpasso', 'Amarcord']);
    expect(out.films[0].imdbUrl).toBe('https://imdb.com/title/tt0056344');
  });

  it('keeps an existing summary untouched', () => {
    const existing = { ...empty(), summary: 'Riassunto scritto al primo giro' };
    const incoming = { ...empty(), summary: 'Riassunto nuovo con transcript' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto scritto al primo giro');
  });

  it('fills a summary that was missing', () => {
    const existing = { ...empty(), summary: null };
    const incoming = { ...empty(), summary: 'Riassunto nuovo con transcript' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto nuovo con transcript');
  });

  it('treats an empty-string summary as missing', () => {
    const existing = { ...empty(), summary: '   ' };
    const incoming = { ...empty(), summary: 'Riassunto nuovo' };
    expect(mergeEntryResults(existing, incoming).summary).toBe('Riassunto nuovo');
  });

  it('merges notes by key without losing existing ones', () => {
    const existing = { ...empty(), notes: [{ text: 'Trattoria da Elio', category: 'place' as const }] };
    const incoming = { ...empty(), notes: [{ text: 'Libro consigliato', category: 'book' as const }] };
    const out = mergeEntryResults(existing, incoming);
    expect(out.notes).toHaveLength(2);
  });

  it('does not duplicate a note the second pass restated', () => {
    const existing = { ...empty(), notes: [{ text: 'Trattoria da Elio', category: 'place' as const }] };
    const incoming = { ...empty(), notes: [{ text: '  trattoria   da elio ', category: 'place' as const }] };
    expect(mergeEntryResults(existing, incoming).notes).toHaveLength(1);
  });

  it('merges links by url without losing existing ones', () => {
    const existing = { ...empty(), links: [{ url: 'https://a.test', label: 'A' }] };
    const incoming = { ...empty(), links: [{ url: 'https://a.test', label: 'A bis' }, { url: 'https://b.test', label: 'B' }] };
    const out = mergeEntryResults(existing, incoming);
    expect(out.links.map((l) => l.label)).toEqual(['A', 'B']);
  });

  it('unions tags without duplicates', () => {
    const existing = { ...empty(), tags: ['#roma', '@baustelle'] };
    const incoming = { ...empty(), tags: ['#roma', '#musica'] };
    expect(mergeEntryResults(existing, incoming).tags.sort()).toEqual(['#musica', '#roma', '@baustelle']);
  });

  it('keeps the incoming transcript', () => {
    const existing = { ...empty(), transcript: null };
    const incoming = { ...empty(), transcript: 'testo trascritto' };
    expect(mergeEntryResults(existing, incoming).transcript).toBe('testo trascritto');
  });

  it('keeps the existing transcript when the second pass carries none', () => {
    const existing = { ...empty(), transcript: 'testo trascritto' };
    const incoming = { ...empty(), transcript: null };
    expect(mergeEntryResults(existing, incoming).transcript).toBe('testo trascritto');
  });

  it('fills vision, OCR and slide fields the existing entry never had', () => {
    // 815, 641 and 575 of 877 live rows lack visualContext, overlayText and
    // slides respectively. Spreading `...existing` alone meant a second pass
    // paid for OCR, vision and slide analysis and then persisted none of it.
    const incoming: EntryResults = {
      ...empty(),
      transcription: 'parlato',
      visualContext: 'una cucina',
      overlayText: 'RICETTA',
      slides: [{ index: 0, imageUrl: null, ocrText: 'testo', visualDescription: null, summary: null, links: [] }],
      transcriptLanguage: 'it',
    };
    const out = mergeEntryResults(empty(), incoming);
    expect(out.transcription).toBe('parlato');
    expect(out.visualContext).toBe('una cucina');
    expect(out.overlayText).toBe('RICETTA');
    expect(out.slides).toHaveLength(1);
    expect(out.transcriptLanguage).toBe('it');
  });

  it('does not let the second pass overwrite vision, OCR or slides it already had', () => {
    const existing: EntryResults = {
      ...empty(),
      visualContext: 'descrizione originale',
      overlayText: 'ORIGINALE',
      slides: [{ index: 0, imageUrl: null, ocrText: 'originale', visualDescription: null, summary: null, links: [] }],
    };
    const incoming: EntryResults = {
      ...empty(),
      visualContext: 'nuova',
      overlayText: 'NUOVO',
      slides: [
        { index: 0, imageUrl: null, ocrText: 'a', visualDescription: null, summary: null, links: [] },
        { index: 1, imageUrl: null, ocrText: 'b', visualDescription: null, summary: null, links: [] },
      ],
    };
    const out = mergeEntryResults(existing, incoming);
    expect(out.visualContext).toBe('descrizione originale');
    expect(out.overlayText).toBe('ORIGINALE');
    expect(out.slides).toHaveLength(1);
  });

  it('treats an empty slide array as absent so a later pass can fill it', () => {
    const existing: EntryResults = { ...empty(), slides: [] };
    const incoming: EntryResults = {
      ...empty(),
      slides: [{ index: 0, imageUrl: null, ocrText: 'testo', visualDescription: null, summary: null, links: [] }],
    };
    expect(mergeEntryResults(existing, incoming).slides).toHaveLength(1);
  });

  it('is a no-op on an entry with no results yet', () => {
    // The route merges unconditionally, so a first pass runs through here too:
    // everything the pass found must come out unchanged.
    const incoming: EntryResults = {
      ...empty(),
      songs: [song('Roma', 'Baustelle')],
      films: [film('Amarcord')],
      notes: [{ text: 'Trattoria da Elio', category: 'place' }],
      links: [{ url: 'https://a.test', label: 'A' }],
      tags: ['#roma'],
      summary: 'riassunto',
      visualContext: 'una cucina',
    };
    const out = mergeEntryResults(empty(), incoming);
    expect(out.songs).toEqual(incoming.songs);
    expect(out.films).toEqual(incoming.films);
    expect(out.notes).toEqual(incoming.notes);
    expect(out.links).toEqual(incoming.links);
    expect(out.tags).toEqual(incoming.tags);
    expect(out.summary).toBe('riassunto');
    expect(out.visualContext).toBe('una cucina');
  });

  it('preserves fields the second pass never produces', () => {
    // enrichments, slides and transcriptLanguage are written by other steps;
    // a second pass that dropped them would lose OpenAI enrichment outright.
    const existing: EntryResults = {
      ...empty(),
      transcriptLanguage: 'it',
      enrichments: { category: 'tech', items: [{ label: 'x', explanation: 'y', links: [] }] },
      slides: [{ index: 0, imageUrl: null, ocrText: 'testo', visualDescription: null, summary: null, links: [] }],
    };
    const out = mergeEntryResults(existing, empty());
    expect(out.transcriptLanguage).toBe('it');
    expect(out.enrichments?.items).toHaveLength(1);
    expect(out.slides).toHaveLength(1);
  });

  it('survives a results object missing its collections', () => {
    // results is JSONB and the route now merges on every analysis, so one
    // malformed row must cost a merge, not the whole pipeline.
    const broken = { summary: null } as unknown as EntryResults;
    const incoming: EntryResults = { ...empty(), songs: [song('Roma', 'Baustelle')], tags: ['#roma'] };
    const out = mergeEntryResults(broken, incoming);
    expect(out.songs).toHaveLength(1);
    expect(out.films).toEqual([]);
    expect(out.notes).toEqual([]);
    expect(out.links).toEqual([]);
    expect(out.tags).toEqual(['#roma']);
  });

  it('never mutates the entry it was given', () => {
    const existing = { ...empty(), songs: [song('Roma', 'Baustelle')], tags: ['#roma'] };
    const incoming = { ...empty(), songs: [song('Charlie', 'Baustelle')], tags: ['#musica'] };
    mergeEntryResults(existing, incoming);
    expect(existing.songs).toHaveLength(1);
    expect(existing.tags).toEqual(['#roma']);
  });
});
