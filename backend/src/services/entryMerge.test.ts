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

  it('never mutates the entry it was given', () => {
    const existing = { ...empty(), songs: [song('Roma', 'Baustelle')], tags: ['#roma'] };
    const incoming = { ...empty(), songs: [song('Charlie', 'Baustelle')], tags: ['#musica'] };
    mergeEntryResults(existing, incoming);
    expect(existing.songs).toHaveLength(1);
    expect(existing.tags).toEqual(['#roma']);
  });
});
