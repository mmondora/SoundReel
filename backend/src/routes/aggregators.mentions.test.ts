import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() }, listEntries: vi.fn() }));
vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { aggregateSongs } from './songs';
import { aggregateFilms } from './films';
import { aggregateNotes } from './notes';
import { aggregateSoftware } from './software';
import type { Entry } from '../types';

/** 8 November: "Es 5 canzoni sono state estratte dallo stesso link": every card must say which post it came from. */
const song = (title: string) => ({ title, artist: 'Bishop Briggs', album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false });
const entry = (id: string, url: string, platform: string, results: Record<string, unknown>, createdAt = '2026-11-08T07:00:00Z'): Entry =>
  ({ id, sourceUrl: url, sourcePlatform: platform, createdAt, results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, ...results } }) as unknown as Entry;

const POST = 'https://www.instagram.com/reel/DWDZS4Qob0U';

describe('five songs from one post: five cards, the same link', () => {
  const entries = [entry('e1', POST, 'instagram', { songs: ['A', 'B', 'C', 'D', 'E'].map(song) })];
  const songs = [...aggregateSongs(entries, new Map()).values()];

  it('every song carries the post URL and platform', () => {
    expect(songs).toHaveLength(5);
    for (const s of songs) expect(s.mentions).toEqual([{ entryId: 'e1', createdAt: '2026-11-08T07:00:00Z', sourceUrl: POST, sourcePlatform: 'instagram' }]);
    expect(new Set(songs.map((s) => s.mentions[0].sourceUrl)).size).toBe(1);
  });
});

describe('the same thing from several posts: one card, one link per post', () => {
  it('songs: two posts, two mentions with their own URLs', () => {
    const entries = [
      entry('e2', 'https://www.tiktok.com/@a/video/1', 'tiktok', { songs: [song('Dream')] }, '2026-11-08T08:00:00Z'),
      entry('e1', POST, 'instagram', { songs: [song('Dream')] }),
    ];
    const [one] = [...aggregateSongs(entries, new Map()).values()];
    expect(one.mentions.map((m) => [m.entryId, m.sourcePlatform, m.sourceUrl])).toEqual([
      ['e2', 'tiktok', 'https://www.tiktok.com/@a/video/1'],
      ['e1', 'instagram', POST],
    ]);
  });

  it('an entry that names the same song twice counts once (the count is posts, not occurrences)', () => {
    const [one] = [...aggregateSongs([entry('e1', POST, 'instagram', { songs: [song('Dream'), { ...song('Dream'), source: 'audio_fingerprint' }] })], new Map()).values()];
    expect(one.mentions).toHaveLength(1);
  });

  it('films, notes and software carry the post too', () => {
    const entries = [
      entry('e1', POST, 'instagram', {
        films: [{ title: 'Dune', year: '2021', director: null }],
        notes: [{ text: 'Colosseo', category: 'place' }],
        software: [{ title: 'Claude Code', url: 'https://github.com/anthropics/claude-code', tag: 'repo' }],
      }),
    ];
    const film = [...aggregateFilms(entries, new Map()).values()][0];
    const note = [...aggregateNotes(entries, new Map()).values()][0];
    const sw = [...aggregateSoftware(entries, new Map()).values()].find((s) => s.title === 'Claude Code')!;
    for (const m of [film.mentions[0], note.mentions[0], sw.mentions[0]]) expect(m).toMatchObject({ entryId: 'e1', sourceUrl: POST, sourcePlatform: 'instagram' });
  });
});

describe('"Versione di": a version is its own card and points at the original (spec §7, D5)', () => {
  const by = (title: string, artist: string) => ({ ...song(title), artist });

  it('a version of a song the journal has is linked to it, the key of each card is unchanged', () => {
    const entries = [entry('e1', POST, 'instagram', { songs: [by('Circles', 'Post Malone'), by('Circles (Instrumental)', 'Post Malone'), by('Nightcall', 'Kavinsky')] })];
    const map = aggregateSongs(entries, new Map());
    expect([...map.keys()].sort()).toEqual(['kavinsky::nightcall', 'post malone::circles', 'post malone::circles (instrumental)']);
    expect(map.get('post malone::circles (instrumental)')?.versionOf).toEqual({
      title: 'Circles',
      artist: 'Post Malone',
      songKey: 'post malone::circles',
      labels: ['Instrumental'],
    });
    expect(map.get('post malone::circles')?.versionOf).toBeUndefined();
    expect(map.get('kavinsky::nightcall')?.versionOf).toBeUndefined();
  });

  it('with no original saved the card still says what it is a version of, without a link', () => {
    const map = aggregateSongs([entry('e1', POST, 'instagram', { songs: [by('Goth (Slowed + Reverb)', 'Sidewalks and Skeletons')] })], new Map());
    expect(map.get('sidewalks and skeletons::goth (slowed + reverb)')?.versionOf).toEqual({ title: 'Goth', artist: null, songKey: null, labels: ['Slowed + Reverb'] });
  });

  it('a version from another post is still linked to the original, and keeps its own mentions', () => {
    const entries = [
      entry('e2', 'https://www.tiktok.com/@a/video/1', 'tiktok', { songs: [by('Circles (Instrumental)', 'Post Malone')] }, '2026-11-08T08:00:00Z'),
      entry('e1', POST, 'instagram', { songs: [by('Circles', 'Post Malone')] }),
    ];
    const map = aggregateSongs(entries, new Map());
    const version = map.get('post malone::circles (instrumental)')!;
    expect(version.versionOf?.songKey).toBe('post malone::circles');
    expect(version.mentions.map((m) => m.entryId)).toEqual(['e2']);
  });
});
