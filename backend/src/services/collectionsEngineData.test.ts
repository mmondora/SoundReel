import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../utils/db', () => ({ query: vi.fn(), withClient: vi.fn(), pool: {} }));
vi.mock('../utils/logger', () => ({ logWarning: vi.fn(), logError: vi.fn(), logInfo: vi.fn() }));

import { query } from '../utils/db';
import { CONTENT_SONG_SOURCES } from './autoPlaylists';
import { PgCollectionsStore } from './collectionsStore';
import { addAutoMembers, entryFeatures, hasCollections, listOwners, realAssignOneDeps, realEngineDeps } from './collectionsEngineData';

// Raccolte, task 7: the real (Postgres) sources of the engine that the store does not give: the owners that have vectors, what each entry says and whether
// it has songs from the content or films, and the insert of the fast lane. The SQL is tested for its shape here (the query is mocked) and run on a real
// database in collectionsEngineData.int.test.ts (COLLECTIONS_INT=1, scratch database).

const queryMock = vi.mocked(query);
beforeEach(() => vi.clearAllMocks());

describe('listOwners: the users the nightly pass is for', () => {
  it('are the owners of entries that have a vector and the users such entries are shared with: distinct, never «anonymous», never an empty name', async () => {
    queryMock.mockResolvedValue([{ user_id: 'mike' }, { user_id: 'sara' }] as never);
    expect(await listOwners()).toEqual(['mike', 'sara']);
    const sql = String(queryMock.mock.calls[0][0]);
    expect(sql).toMatch(/entry_vectors/);
    expect(sql).toMatch(/entry_shares/);
    expect(sql).toMatch(/shared_with/);
    expect(sql).toMatch(/<> 'anonymous'/);
    expect(sql).toMatch(/<> ''/);
    expect(sql).toMatch(/IS NOT NULL/);
    expect(sql).toMatch(/UNION/);
    expect(sql).toMatch(/ORDER BY/);
  });

  it('nobody has a vector: nobody', async () => {
    queryMock.mockResolvedValue([] as never);
    expect(await listOwners()).toEqual([]);
  });
});

describe('hasCollections: has this owner a first publication yet', () => {
  it('is true when the owner has any row in the table of the collections, in any state (a hidden or a merged one is a publication too)', async () => {
    queryMock.mockResolvedValue([{ one: 1 }] as never);
    expect(await hasCollections('luisa')).toBe(true);
    const [sql, params] = queryMock.mock.calls[0];
    expect(String(sql)).toMatch(/FROM collections/);
    expect(String(sql)).toMatch(/owner_user = \$1/);
    expect(String(sql)).toMatch(/LIMIT 1/);
    expect(String(sql)).not.toMatch(/state/);
    expect(params).toEqual(['luisa']);
  });

  it('is false when the owner has none', async () => {
    queryMock.mockResolvedValue([] as never);
    expect(await hasCollections('sara')).toBe(false);
  });
});

describe('entryFeatures: what the engine asks to know about each entry', () => {
  const row = (over: Record<string, unknown> = {}) => ({ id: 'e1', text: 'Un post sul vino', tags: ['#vino', '#cantina'], has_content_songs: false, has_films: false, ...over });

  it('is the text, the tags and the two flags of each entry, by id', async () => {
    queryMock.mockResolvedValue([row(), row({ id: 'e2', text: '', tags: [], has_content_songs: true, has_films: true })] as never);
    const out = await entryFeatures('mike', ['e1', 'e2']);
    expect(out.get('e1')).toEqual({ text: 'Un post sul vino', tags: ['#vino', '#cantina'], hasContentSongs: false, hasFilms: false });
    expect(out.get('e2')).toEqual({ text: '', tags: [], hasContentSongs: true, hasFilms: true });
    expect(out.size).toBe(2);
  });

  it('a text that is null is an empty text, and a flag that is null is false (a row with nothing in it says nothing)', async () => {
    queryMock.mockResolvedValue([row({ text: null, has_content_songs: null, has_films: null })] as never);
    expect((await entryFeatures('mike', ['e1'])).get('e1')).toEqual({ text: '', tags: ['#vino', '#cantina'], hasContentSongs: false, hasFilms: false });
  });

  it('a tag that is not text, or tags that are not a list, are read as nothing', async () => {
    queryMock.mockResolvedValue([row({ tags: ['#a', 7, null, '#b'] }), row({ id: 'e2', tags: null })] as never);
    const out = await entryFeatures('mike', ['e1', 'e2']);
    expect(out.get('e1')?.tags).toEqual(['#a', '#b']);
    expect(out.get('e2')?.tags).toEqual([]);
  });

  it('«songs from the content» are the ones of the auto-playlists (never the audio fingerprint), and they go in as a parameter of the query', async () => {
    queryMock.mockResolvedValue([] as never);
    await entryFeatures('mike', ['e1']);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(params[1]).toEqual([...CONTENT_SONG_SOURCES]);
    expect([...CONTENT_SONG_SOURCES]).not.toContain('audio_fingerprint');
    expect(sql).toMatch(/jsonb_typeof\(e\.results->'songs'\) = 'array'/);
    expect(sql).toMatch(/jsonb_typeof\(e\.results->'films'\) = 'array'/);
    expect(sql).toMatch(/summary/);
    expect(sql).toMatch(/caption/);
  });

  it('is asked in batches (a library is thousands of ids) and nothing is asked for no ids', async () => {
    queryMock.mockResolvedValue([] as never);
    expect((await entryFeatures('mike', [])).size).toBe(0);
    expect(queryMock).not.toHaveBeenCalled();
    const ids = Array.from({ length: 2500 }, (_, i) => `e${i}`);
    await entryFeatures('mike', ids);
    expect(queryMock).toHaveBeenCalledTimes(3);
    expect((queryMock.mock.calls[0][1] as unknown[][])[0]).toHaveLength(1000);
    expect((queryMock.mock.calls[2][1] as unknown[][])[0]).toHaveLength(500);
  });
});

describe('addAutoMembers: the insert of the fast lane', () => {
  it('adds automatic members to the ACTIVE collections of the user, and leaves alone what is already there (a member, or an entry taken out by hand)', async () => {
    queryMock.mockResolvedValue([] as never);
    await addAutoMembers('mike', [{ collectionId: 'c1', entryId: 'e1', score: 0.7 }, { collectionId: 'c2', entryId: 'e1', score: 0.5 }]);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toMatch(/INSERT INTO collection_entries/);
    expect(sql).toMatch(/'auto'/);
    expect(sql).toMatch(/ON CONFLICT \(collection_id, entry_id\) DO NOTHING/);
    expect(sql).toMatch(/c\.owner_user = \$4/);
    expect(sql).toMatch(/c\.state = 'active'/);
    expect(params).toEqual([['c1', 'c2'], ['e1', 'e1'], [0.7, 0.5], 'mike']);
  });

  it('nothing to add: no query', async () => {
    await addAutoMembers('mike', []);
    expect(queryMock).not.toHaveBeenCalled();
  });
});

describe('the real dependencies', () => {
  it('use the database store, the real features and a fresh id for every collection that is born', () => {
    const deps = realEngineDeps();
    expect(deps.store).toBeInstanceOf(PgCollectionsStore);
    expect(deps.features).toBe(entryFeatures);
    const a = deps.newId();
    const b = deps.newId();
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
    expect(typeof deps.nameGroup).toBe('function');
  });

  it('the fast lane writes with the insert above', () => {
    const deps = realAssignOneDeps();
    expect(deps.store).toBeInstanceOf(PgCollectionsStore);
    expect(deps.addMembers).toBe(addAutoMembers);
  });
});
