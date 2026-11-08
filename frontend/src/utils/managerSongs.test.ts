import { describe, expect, it } from 'vitest';
import {
  EMPTY_FILTERS,
  activeFilterCount,
  countLabel,
  datasetFacets,
  enrichSongs,
  facetCounts,
  filterManagerSongs,
  isSongDownloaded,
  isSongPreparing,
  placeholderSong,
  platformLabel,
  sortLibrary,
} from './managerSongs';
import type { EntryFact, ManagerSong } from './managerSongs';
import type { AggregatedSong, SongMetaRecord } from '../types';

function meta(patch: Partial<SongMetaRecord> = {}): SongMetaRecord {
  return {
    songKey: 'k', deezerId: null, itunesId: null, genres: [], album: null, coverUrl: null,
    previewUrl: null, deezerUrl: null, itunesUrl: null, enrichedAt: null, listened: false,
    favorite: false, downloaded: false, rating: null, score: null, ...patch,
  };
}

function song(key: string, patch: Partial<AggregatedSong> = {}): AggregatedSong {
  const [artist, title] = key.split('::');
  return {
    songKey: key, title: title ?? key, artist: artist ?? '', album: null, youtubeUrl: null, spotifyUrl: null,
    mentions: [{ entryId: `e-${key}`, createdAt: '2026-01-01T00:00:00Z' }], meta: null, ...patch,
  };
}

const FACTS = new Map<string, EntryFact>([
  ['e-air::sexy boy', { platform: 'instagram', tags: ['#estate', '#chill'] }],
  ['e-bishop briggs::white flag', { platform: 'shazam', tags: [] }],
  ['e-daft punk::one more time', { platform: 'tiktok', tags: ['#estate'] }],
]);

function pool(): ManagerSong[] {
  return enrichSongs(
    [
      song('air::sexy boy', { album: 'Moon Safari', meta: meta({ genres: ['Electronic'], favorite: true }), inLibrary: true }),
      song('bishop briggs::white flag', { meta: meta({ genres: ['Alternative'] }), sources: ['shazam_link'] }),
      song('daft punk::one more time', { album: 'Discovery', meta: meta({ genres: ['Electronic', 'House'], listened: true }), sources: ['ai_analysis', 'audio_fingerprint'] }),
    ],
    FACTS,
  );
}

describe('enrichSongs', () => {
  it('derives platforms and tags from the entries a song is mentioned in', () => {
    const [air, bishop] = pool();
    expect(air.platforms).toEqual(['instagram']);
    expect(air.tags).toEqual(['#chill', '#estate']);
    expect(bishop.platforms).toEqual(['shazam']);
    expect(bishop.tags).toEqual([]);
  });

  it('lets backend-provided facets win over the join', () => {
    const [out] = enrichSongs(
      [song('air::sexy boy', { platforms: ['youtube'], tags: ['#x'], sources: ['music_list', 'music_list'] })],
      FACTS,
    );
    expect(out.platforms).toEqual(['youtube']);
    expect(out.tags).toEqual(['#x']);
    expect(out.sources).toEqual(['music_list']);
  });

  it('falls back to empty arrays without facts or backend data', () => {
    const [out] = enrichSongs([song('air::sexy boy')]);
    expect(out).toMatchObject({ sources: [], platforms: [], tags: [] });
  });

  it('keeps the very same song data (no mutation of the input)', () => {
    const input = [song('air::sexy boy')];
    enrichSongs(input, FACTS);
    expect(input[0]).not.toHaveProperty('platforms');
  });
});

describe('datasetFacets', () => {
  it('reports which facets have any data', () => {
    expect(datasetFacets(pool())).toEqual({ types: true, platforms: true, tags: true, genres: true });
    expect(datasetFacets(enrichSongs([song('a::b')]))).toEqual({ types: false, platforms: false, tags: false, genres: false });
  });
});

describe('placeholderSong', () => {
  it('derives artist and title from an artist::title key', () => {
    expect(placeholderSong('penny::say it ain\'t so')).toMatchObject({
      songKey: 'penny::say it ain\'t so', artist: 'penny', title: 'say it ain\'t so', placeholder: true,
    });
    expect(placeholderSong('just a title')).toMatchObject({ artist: '', title: 'just a title' });
  });
});

describe('platformLabel', () => {
  it('knows the usual platforms and capitalises the rest', () => {
    expect(platformLabel('tiktok')).toBe('TikTok');
    expect(platformLabel('twitter')).toBe('X');
    expect(platformLabel('mastodon')).toBe('Mastodon');
    expect(platformLabel('')).toBe('—');
  });
});

describe('downloaded / preparing', () => {
  it('an old backend (no fs / mediaServer flags): inLibrary means FS, and a session-ready key counts', () => {
    expect(isSongDownloaded(song('a::b', { inLibrary: true }))).toBe(true);
    expect(isSongDownloaded(song('a::b'), { readyKeys: new Set(['a::b']) })).toBe(true);
    expect(isSongDownloaded(song('a::b'))).toBe(false);
  });

  it('the green dot is the backend’s inLibrary (= fs || mediaServer), nothing else (rule S8)', () => {
    expect(isSongDownloaded(song('a::b', { inLibrary: true, fs: true, mediaServer: false }))).toBe(true);
    expect(isSongDownloaded(song('a::b', { inLibrary: true, fs: false, mediaServer: true }))).toBe(true);
    expect(isSongDownloaded(song('a::b', { inLibrary: true, fs: true, mediaServer: true }))).toBe(true);
    expect(isSongDownloaded(song('a::b', { inLibrary: false, fs: false, mediaServer: false }))).toBe(false);
  });

  it('a song on the media server only (e.g. Nightcall on the Fritz) is green although nothing was downloaded', () => {
    expect(isSongDownloaded(song('kavinsky::nightcall', { fs: false, mediaServer: true, inLibrary: true }))).toBe(true);
  });

  it('the hand-set "downloaded" flag never turns the dot green', () => {
    expect(isSongDownloaded(song('a::b', { meta: meta({ downloaded: true }) }))).toBe(false);
    expect(isSongDownloaded(song('a::b', { meta: meta({ downloaded: true }), inLibrary: false, fs: false, mediaServer: false }))).toBe(false);
  });

  it('inLibrary is the word that counts when it is sent; the fs / mediaServer flags are only read when it is not', () => {
    expect(isSongDownloaded(song('a::b', { inLibrary: false, fs: true }))).toBe(false);
    expect(isSongDownloaded(song('a::b', { fs: true }))).toBe(true);
    expect(isSongDownloaded(song('a::b', { mediaServer: true }))).toBe(true);
    expect(isSongDownloaded(song('a::b', { fs: false, mediaServer: false }))).toBe(false);
  });

  it('a download finished in this session makes it green, without touching the others', () => {
    const ctx = { readyKeys: new Set(['a::b']) };
    expect(isSongDownloaded(song('a::b', { inLibrary: false }), ctx)).toBe(true);
    expect(isSongDownloaded(song('c::d', { inLibrary: false }), ctx)).toBe(false);
  });

  it('preparing = server says so or this session asked for it, and not downloaded yet', () => {
    expect(isSongPreparing(song('a::b', { fileState: 'preparing' }))).toBe(true);
    expect(isSongPreparing(song('a::b'), { preparingKeys: new Set(['a::b']) })).toBe(true);
    expect(isSongPreparing(song('a::b', { inLibrary: true, fileState: 'preparing' }))).toBe(false);
  });
});

describe('filterManagerSongs', () => {
  const keys = (list: ManagerSong[]) => list.map((s) => s.songKey);

  it('no filters returns everything', () => {
    expect(filterManagerSongs(pool(), EMPTY_FILTERS)).toHaveLength(3);
  });

  it('text searches title, artist and album', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, text: 'discovery' }))).toEqual(['daft punk::one more time']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, text: 'BRIGGS' }))).toEqual(['bishop briggs::white flag']);
  });

  it('autore and album are substring filters', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, artist: 'daft' }))).toEqual(['daft punk::one more time']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, album: 'safari' }))).toEqual(['air::sexy boy']);
  });

  it('tipo is OR across the picked kinds and matches any of the song’s sources', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, types: ['shazam_link'] }))).toEqual(['bishop briggs::white flag']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, types: ['audio_fingerprint', 'shazam_link'] }))).toEqual([
      'bishop briggs::white flag',
      'daft punk::one more time',
    ]);
  });

  it('fonte (platform) and tag filters', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, platforms: ['instagram', 'tiktok'] }))).toEqual([
      'air::sexy boy',
      'daft punk::one more time',
    ]);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, tags: ['#chill'] }))).toEqual(['air::sexy boy']);
  });

  it('genere, preferiti and ascoltate reuse the Songs page semantics', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, genres: ['House'] }))).toEqual(['daft punk::one more time']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, favorite: true }))).toEqual(['air::sexy boy']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, listened: 'listened' }))).toEqual(['daft punk::one more time']);
  });

  it('stato: downloaded / not downloaded / preparing (with the live context)', () => {
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, state: 'downloaded' }))).toEqual(['air::sexy boy']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, state: 'notDownloaded' }))).toEqual([
      'bishop briggs::white flag',
      'daft punk::one more time',
    ]);
    const ctx = { preparingKeys: new Set(['bishop briggs::white flag']), readyKeys: new Set(['daft punk::one more time']) };
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, state: 'preparing' }, ctx))).toEqual(['bishop briggs::white flag']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, state: 'downloaded' }, ctx))).toEqual([
      'air::sexy boy',
      'daft punk::one more time',
    ]);
  });

  it('membership is relative to the other pane and ignored when that pane is the library', () => {
    const other = new Set(['air::sexy boy']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, membership: 'in' }, { otherKeys: other }))).toEqual(['air::sexy boy']);
    expect(keys(filterManagerSongs(pool(), { ...EMPTY_FILTERS, membership: 'notIn' }, { otherKeys: other }))).toEqual([
      'bishop briggs::white flag',
      'daft punk::one more time',
    ]);
    expect(filterManagerSongs(pool(), { ...EMPTY_FILTERS, membership: 'notIn' }, { otherKeys: null })).toHaveLength(3);
  });

  it('combines facets with AND across categories', () => {
    const f = { ...EMPTY_FILTERS, platforms: ['instagram', 'tiktok'], genres: ['House'], text: 'daft' };
    expect(keys(filterManagerSongs(pool(), f))).toEqual(['daft punk::one more time']);
    expect(filterManagerSongs(pool(), { ...f, artist: 'air' })).toEqual([]);
  });
});

describe('activeFilterCount', () => {
  it('counts non-default filters but not the text box', () => {
    expect(activeFilterCount(EMPTY_FILTERS)).toBe(0);
    expect(activeFilterCount({ ...EMPTY_FILTERS, text: 'x' })).toBe(0);
    expect(
      activeFilterCount({
        ...EMPTY_FILTERS, artist: 'a', types: ['both', 'music_list'], platforms: ['tiktok'], state: 'downloaded', favorite: true,
        membership: 'notIn',
      }),
    ).toBe(7);
  });
});

describe('facetCounts', () => {
  it('counts every value with the other filters applied (own facet excluded)', () => {
    const counts = facetCounts(pool(), { ...EMPTY_FILTERS, genres: ['Electronic'] });
    // genres ignore their own filter → all three songs contribute
    expect(counts.genres.get('Electronic')).toBe(2);
    expect(counts.genres.get('Alternative')).toBe(1);
    // platforms respect the genre filter → only the two Electronic songs
    expect(counts.platforms.get('instagram')).toBe(1);
    expect(counts.platforms.get('tiktok')).toBe(1);
    expect(counts.platforms.get('shazam')).toBeUndefined();
  });

  it('counts tipo, tag and state', () => {
    const counts = facetCounts(pool(), EMPTY_FILTERS);
    expect(counts.types.get('shazam_link')).toBe(1);
    expect(counts.types.get('ai_analysis')).toBe(1);
    expect(counts.tags.get('#estate')).toBe(2);
    expect(counts.state).toEqual({ downloaded: 1, notDownloaded: 2, preparing: 0 });
  });

  it('lists artists by frequency, then alphabetically', () => {
    const songs = enrichSongs([song('b::x'), song('a::y'), song('b::z')]);
    expect(facetCounts(songs, EMPTY_FILTERS).artists).toEqual([['b', 2], ['a', 1]]);
  });
});

describe('sortLibrary', () => {
  it('sorts by title, artist or most recent mention', () => {
    const list = enrichSongs([
      song('b::zeta', { mentions: [{ entryId: 'e1', createdAt: '2026-01-01T00:00:00Z' }] }),
      song('a::alpha', { mentions: [{ entryId: 'e2', createdAt: '2026-03-01T00:00:00Z' }] }),
      song('c::mid', { mentions: [{ entryId: 'e3', createdAt: '2026-02-01T00:00:00Z' }] }),
    ]);
    expect(sortLibrary(list, 'title').map((s) => s.title)).toEqual(['alpha', 'mid', 'zeta']);
    expect(sortLibrary(list, 'artist').map((s) => s.artist)).toEqual(['a', 'b', 'c']);
    expect(sortLibrary(list, 'date').map((s) => s.title)).toEqual(['alpha', 'mid', 'zeta']);
  });
});

describe('countLabel', () => {
  it('uses the singular for exactly one and the plural template otherwise', () => {
    expect(countLabel(1, '{n} brani', '1 brano')).toBe('1 brano');
    expect(countLabel(0, '{n} brani', '1 brano')).toBe('0 brani');
    expect(countLabel(12, '{n} brani', '1 brano')).toBe('12 brani');
  });
});
