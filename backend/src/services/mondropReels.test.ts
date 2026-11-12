import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./userSongs', () => ({ getUserSongs: vi.fn() }));
vi.mock('./offlineManifest', () => ({ buildTracks: vi.fn() }));
vi.mock('../utils/logger', () => ({ logError: vi.fn() }));

import {
  REELS_DEFAULT_LIMIT,
  REELS_MAX_LIMIT,
  getReel,
  getReelImage,
  listReels,
  parseReelsQuery,
  realReelsDeps,
  type ReelsDeps,
} from './mondropReels';
import { logError } from '../utils/logger';
import { songKey } from './songMeta';
import type { ReelRow } from './reelBreakdown';
import type { OfflineTrack } from './offlineManifest';
import type { AggregatedSong } from '../types';

// The service behind the three routes of the reels (ADR-0033): the parameters of the list as a contract, a page of cards, the page of one reel with its music built by the
// library, and what a failure of a part costs (only that part).

const ID = '8167b826-f8e2-4298-b477-174c41bcc13b';
const ADDRESS = 'https://www.instagram.com/reel/TESTCODE123/';

const row = (results: unknown, id = ID): ReelRow => ({ id, createdAt: new Date('2026-11-12T08:01:00.000Z'), platform: 'instagram', thumbnailUrl: `/media/${id}/thumbnail.jpg`, results });

const aggregated = (artist: string, title: string): AggregatedSong => ({
  songKey: songKey(artist, title), title, artist, album: null, youtubeUrl: null, spotifyUrl: null, mentions: [], meta: null, inLibrary: false,
});
const trackOf = (song: AggregatedSong): OfflineTrack => ({
  songKey: song.songKey, title: song.title, artist: song.artist, mediaUrl: null, state: 'ready', downloadPath: `/api/mondrop/songs/${encodeURIComponent(song.songKey)}/file`,
} as unknown as OfflineTrack);

function deps(over: Partial<ReelsDeps> = {}): ReelsDeps {
  return {
    rows: async () => ({ rows: [], total: 0 }),
    kindCounts: async () => [],
    row: async () => null,
    journal: async () => new Map(),
    tracks: async (songs) => songs.map(trackOf),
    image: async () => null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('parseReelsQuery: the parameters of the list', () => {
  it('has a default for each: 20 a page, from the start, every category, no facets', () => {
    expect(parseReelsQuery({})).toEqual({ ok: true, query: { limit: REELS_DEFAULT_LIMIT, offset: 0, kind: undefined, facets: false } });
    expect(REELS_DEFAULT_LIMIT).toBe(20);
    expect(REELS_MAX_LIMIT).toBe(50);
  });

  it('reads the four of them', () => {
    expect(parseReelsQuery({ limit: '50', offset: '40', kind: 'film', facets: '1' })).toEqual({ ok: true, query: { limit: 50, offset: 40, kind: 'film', facets: true } });
    expect(parseReelsQuery({ limit: '1', offset: '0', kind: 'music', facets: 'true' })).toEqual({ ok: true, query: { limit: 1, offset: 0, kind: 'music', facets: true } });
    expect(parseReelsQuery({ facets: '0' })).toMatchObject({ ok: true, query: { facets: false } });
    expect(parseReelsQuery({ facets: 'FALSE' })).toMatchObject({ ok: true, query: { facets: false } });
    expect(parseReelsQuery({ facets: 'True' })).toMatchObject({ ok: true, query: { facets: true } });
  });

  it('takes every one of the ten categories', () => {
    for (const kind of ['music', 'film', 'software', 'place', 'book', 'product', 'brand', 'person', 'event', 'quote']) {
      expect(parseReelsQuery({ kind })).toMatchObject({ ok: true, query: { kind } });
    }
  });

  it('reads a blank one as not given (an app that builds the address from optional parts)', () => {
    expect(parseReelsQuery({ limit: '', offset: ' ', kind: '', facets: '' })).toEqual({ ok: true, query: { limit: 20, offset: 0, kind: undefined, facets: false } });
  });

  it('refuses a limit that is not a whole number from 1 to 50', () => {
    for (const limit of ['0', '51', '1000', 'abc', '-1', '1.5', '1e1', '+5', '0x10', '٣', ['10', '20'], { a: 1 }, 5]) {
      expect(parseReelsQuery({ limit })).toEqual({ ok: false, field: 'limit' });
    }
  });

  it('refuses an offset that is not a whole number from 0 up', () => {
    for (const offset of ['-1', 'x', '1.5', '1e3', '1000001', ['0', '1'], 3]) {
      expect(parseReelsQuery({ offset })).toEqual({ ok: false, field: 'offset' });
    }
    expect(parseReelsQuery({ offset: '1000000' })).toMatchObject({ ok: true });
  });

  it('refuses a category that is not one of the ten, however it is written, and the same name twice', () => {
    for (const kind of ['other', 'tag', 'Film', 'FILM', 'films', 'musica', 'persone', ' film ', "film' OR 1=1 --", ['film', 'book'], 7]) {
      expect(parseReelsQuery({ kind })).toEqual({ ok: false, field: 'kind' });
    }
  });

  it('refuses a facets that is not 1, 0, true or false', () => {
    for (const facets of ['yes', '2', 'on', ['1', '1'], true, 1]) {
      expect(parseReelsQuery({ facets })).toEqual({ ok: false, field: 'facets' });
    }
  });

  it('names the first wrong one, in the order limit, offset, kind, facets', () => {
    expect(parseReelsQuery({ facets: 'x', kind: 'x', offset: 'x', limit: 'x' })).toEqual({ ok: false, field: 'limit' });
    expect(parseReelsQuery({ facets: 'x', kind: 'x', offset: 'x' })).toEqual({ ok: false, field: 'offset' });
    expect(parseReelsQuery({ facets: 'x', kind: 'x' })).toEqual({ ok: false, field: 'kind' });
    expect(parseReelsQuery({ facets: 'x' })).toEqual({ ok: false, field: 'facets' });
  });

  it('does not know a user: whatever else is in the query is none of its business', () => {
    expect(parseReelsQuery({ user: 'sara', owner: 'archi', limit: '5' })).toEqual({ ok: true, query: { limit: 5, offset: 0, kind: undefined, facets: false } });
  });
});

describe('listReels: a page of cards', () => {
  it('reads the page of the user it is told, with the page it is asked for, and makes a card of each post', async () => {
    const rows = vi.fn(async () => ({ rows: [row({ summary: 'Di cosa parla.', software: [{ title: 'Notion', tag: 'product' }] })], total: 41 }));
    const page = await listReels('sara', { limit: 20, offset: 20, kind: 'software', facets: false }, deps({ rows }));
    expect(rows).toHaveBeenCalledWith('sara', { kind: 'software', limit: 20, offset: 20 });
    expect(page).toEqual({
      total: 41, limit: 20, offset: 20,
      reels: [{
        id: ID, createdAt: '2026-11-12T08:01:00.000Z', platform: 'instagram', summary: 'Di cosa parla.', imagePath: `/api/mondrop/reels/${ID}/image`,
        counts: [{ kind: 'software', label: 'Software', count: 1, names: ['Notion'] }],
      }],
    });
  });

  it('has no «kinds» unless the facets are asked for, and does not even read them', async () => {
    const kindCounts = vi.fn(async () => [{ kind: 'music' as const, count: 3 }]);
    const page = await listReels('mike', { limit: 20, offset: 0, facets: false }, deps({ kindCounts }));
    expect('kinds' in page).toBe(false);
    expect(kindCounts).not.toHaveBeenCalled();
  });

  it('has «kinds» with the words of each category when the facets are asked for, for the same user', async () => {
    const kindCounts = vi.fn(async () => [{ kind: 'music' as const, count: 733 }, { kind: 'place' as const, count: 5 }]);
    const page = await listReels('mike', { limit: 20, offset: 0, facets: true }, deps({ kindCounts }));
    expect(kindCounts).toHaveBeenCalledWith('mike');
    expect(page.kinds).toEqual([{ kind: 'music', label: 'Musica', count: 733 }, { kind: 'place', label: 'Luoghi', count: 5 }]);
  });

  it('keeps the list when the facets fail: it costs the facets, and says so in the log', async () => {
    const page = await listReels('mike', { limit: 20, offset: 0, facets: true }, deps({
      rows: async () => ({ rows: [row({ summary: 'x' })], total: 1 }),
      kindCounts: async () => { throw new Error('db hiccup'); },
    }));
    expect(page.reels).toHaveLength(1);
    expect('kinds' in page).toBe(false);
    expect(logError).toHaveBeenCalledWith('mondrop reels: the categories could not be counted', expect.objectContaining({ err: expect.stringContaining('db hiccup') }));
  });

  it('fails when the posts cannot be read at all (nothing to show is not the same as nothing)', async () => {
    await expect(listReels('mike', { limit: 20, offset: 0, facets: false }, deps({ rows: async () => { throw new Error('db down'); } }))).rejects.toThrow('db down');
  });

  it('does not carry the address of the post, nor any address, in a page, whatever the post carried', async () => {
    const results = {
      summary: `Vedi ${ADDRESS}`, links: [{ url: ADDRESS }], software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }],
      films: [{ title: 'Dune', imdbUrl: 'https://imdb.com/x', posterUrl: 'https://img.test/p.jpg' }],
    };
    const page = await listReels('mike', { limit: 20, offset: 0, facets: true }, deps({ rows: async () => ({ rows: [row(results)], total: 1 }), kindCounts: async () => [] }));
    const text = JSON.stringify(page);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/"(?:sourceUrl|mediaUrl|imdbUrl|url|posterUrl)"/);
  });
});

describe('getReel: the page of one reel', () => {
  const RESULTS = { summary: 'Una guida.', songs: [{ title: 'Garden of Eden', artist: 'Yom' }, { title: 'Houdini', artist: 'Dua Lipa' }, { title: 'Sconosciuta', artist: 'Nessuno' }], software: [{ title: 'Notion', tag: 'product' }] };

  it('is nothing for a reel that does not exist or that the user cannot read, and then reads nothing else', async () => {
    const journal = vi.fn(async () => new Map<string, AggregatedSong>());
    const tracks = vi.fn(async () => []);
    await expect(getReel('mike', ID, deps({ row: async () => null, journal, tracks }))).resolves.toBeNull();
    expect(journal).not.toHaveBeenCalled();
    expect(tracks).not.toHaveBeenCalled();
  });

  it('asks for the reel of the user it is told', async () => {
    const one = vi.fn(async () => null);
    await getReel('archi', ID, deps({ row: one }));
    expect(one).toHaveBeenCalledWith('archi', ID);
  });

  it('builds the music from the journal of the user: the songs the post names, in its order, those the journal knows, once each', async () => {
    const yom = aggregated('Yom', 'Garden of Eden');
    const dua = aggregated('Dua Lipa', 'Houdini');
    const journal = vi.fn(async () => new Map([[yom.songKey, yom], [dua.songKey, dua]]));
    const tracks = vi.fn(async (songs: AggregatedSong[]) => songs.map(trackOf));
    const detail = await getReel('mike', ID, deps({ row: async () => row(RESULTS), journal, tracks }));
    expect(journal).toHaveBeenCalledWith('mike');
    expect(tracks).toHaveBeenCalledTimes(1);
    expect(tracks).toHaveBeenCalledWith([yom, dua], 'mike');           // «Sconosciuta» is not in the journal: left out, not a hole
    const music = detail?.sections[0];
    expect(music?.kind).toBe('music');
    expect(music && 'tracks' in music && music.tracks.map((t) => t.songKey)).toEqual([yom.songKey, dua.songKey]);
    expect(detail?.sections.map((s) => s.kind)).toEqual(['music', 'software']);
    expect(detail?.summary).toBe('Una guida.');
  });

  it('does not touch the journal or the library for a reel without songs', async () => {
    const journal = vi.fn(async () => new Map<string, AggregatedSong>());
    const tracks = vi.fn(async () => []);
    const detail = await getReel('mike', ID, deps({ row: async () => row({ summary: 'x' }), journal, tracks }));
    expect(detail).not.toBeNull();
    expect(journal).not.toHaveBeenCalled();
    expect(tracks).not.toHaveBeenCalled();
  });

  it('keeps the page when the journal cannot be read: it costs the music, and says so in the log', async () => {
    const detail = await getReel('mike', ID, deps({ row: async () => row(RESULTS), journal: async () => { throw new Error('journal down'); } }));
    expect(detail?.sections.map((s) => s.kind)).toEqual(['software']);
    expect(detail?.summary).toBe('Una guida.');
    expect(logError).toHaveBeenCalledWith('mondrop reels: the music of a reel could not be built', expect.objectContaining({ id: ID, err: expect.stringContaining('journal down') }));
  });

  it('keeps the page when the library cannot build the tracks', async () => {
    const yom = aggregated('Yom', 'Garden of Eden');
    const detail = await getReel('mike', ID, deps({
      row: async () => row(RESULTS), journal: async () => new Map([[yom.songKey, yom]]), tracks: async () => { throw new Error('files unreachable'); },
    }));
    expect(detail?.sections.map((s) => s.kind)).toEqual(['software']);
    expect(logError).toHaveBeenCalledTimes(1);
  });

  it('has no music section when the journal knows none of the songs', async () => {
    const detail = await getReel('mike', ID, deps({ row: async () => row(RESULTS), journal: async () => new Map() }));
    expect(detail?.sections.map((s) => s.kind)).toEqual(['software']);
  });

  it('does not carry the address of the post, nor any address, in a page, whatever the post carried', async () => {
    const yom = aggregated('Yom', 'Garden of Eden');
    const results = {
      summary: `Vedi ${ADDRESS}`, songs: [{ title: 'Garden of Eden', artist: 'Yom', spotifyUrl: 'https://open.spotify.com/track/1' }], links: [{ url: ADDRESS }],
      software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }], films: [{ title: 'Dune', imdbUrl: 'https://imdb.com/x' }],
      slides: [{ index: 0, imageUrl: '/media/x/0.jpg', summary: `Slide ${ADDRESS}` }],
      enrichments: { items: [{ label: 'Software: Notion', explanation: `App. ${ADDRESS}`, links: [{ url: ADDRESS }] }] },
    };
    const detail = await getReel('mike', ID, deps({ row: async () => row(results), journal: async () => new Map([[yom.songKey, yom]]) }));
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/https?:\/\//i);
    expect(text).not.toMatch(/"(?:sourceUrl|mediaUrl|imdbUrl|url|posterUrl)"/);
  });

  it('carries the sheet of a film on IMDb, built from its id, and the post and the software none (ADR-0033, «Q3 si apri sulla scheda»)', async () => {
    const results = {
      summary: `Vedi ${ADDRESS}`, links: [{ url: ADDRESS }], software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }],
      films: [{ title: 'Dune', imdbUrl: 'http://m.imdb.com/title/tt1160419/' }],
    };
    const detail = await getReel('mike', ID, deps({ row: async () => row(results), journal: async () => new Map() }));
    const film = detail?.sections.find((s) => s.kind === 'film');
    expect(film && 'items' in film && film.items).toEqual([{ title: 'Dune', detail: null, openUrl: 'https://www.imdb.com/title/tt1160419/' }]);
    expect(JSON.stringify(detail).match(/https?:\/\/[^"\s]*/gi)).toEqual(['https://www.imdb.com/title/tt1160419/']);
  });
});

describe('getReelImage', () => {
  it('asks for the picture of the user it is told, and gives what the read gives', async () => {
    const image = vi.fn(async () => ({ absPath: '/data/media/x/thumbnail.jpg', size: 10 }));
    await expect(getReelImage('sara', ID, deps({ image }))).resolves.toEqual({ absPath: '/data/media/x/thumbnail.jpg', size: 10 });
    expect(image).toHaveBeenCalledWith('sara', ID);
    await expect(getReelImage('sara', ID, deps())).resolves.toBeNull();
  });
});

describe('the real reads', () => {
  it('are the ones of the data module and of the library (the journal of the user is the one of a person, not of the administrator)', async () => {
    const { getUserSongs } = await import('./userSongs');
    const { buildTracks } = await import('./offlineManifest');
    vi.mocked(getUserSongs).mockResolvedValue(new Map());
    vi.mocked(buildTracks).mockResolvedValue([]);
    await realReelsDeps.journal('sara');
    expect(getUserSongs).toHaveBeenCalledWith('sara', false);
    const song = aggregated('a', 'b');
    await realReelsDeps.tracks([song], 'sara');
    expect(buildTracks).toHaveBeenCalledWith([song], 'sara');
    expect(typeof realReelsDeps.rows).toBe('function');
    expect(typeof realReelsDeps.kindCounts).toBe('function');
    expect(typeof realReelsDeps.row).toBe('function');
    expect(typeof realReelsDeps.image).toBe('function');
  });
});
