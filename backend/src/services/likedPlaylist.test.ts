import { describe, expect, it } from 'vitest';
import { MemoryAutoPlaylistStore } from './autoPlaylists';
import { parseRule, ruleSummary } from './dynamicRules';
import { LIKED_PLAYLIST_LIMIT, LIKED_PLAYLIST_NAME, LIKED_THEME_KEY, ensureLikedPlaylist, likedRule } from './likedPlaylist';

// The playlist «Mi piace» (Michele, 10 November: «1 si»; ADR-0028, spec 2026-11-10-mondrop-like-and-repeat-design.md L7): DYNAMIC (the rule «the songs I like», the
// most recently liked first), one per person, made at the FIRST like (never an empty one) and never made again when the person deletes it. The same
// place that makes the other automatic playlists (`createPlaylist` of the store, the theme registry) makes it, so the unique index decides under two likes at once.

const AT = new Date('2026-11-10T20:00:00.000Z');

describe('the rule of the playlist «Mi piace»', () => {
  it('is the songs the person liked, the most recently liked first, at most 200, and a rule the parser keeps exactly as it is', () => {
    expect(likedRule()).toEqual({ v: 1, scope: 'me', period: 'all', order: 'liked', limit: 200, minPlays: 1, downloadedOnly: false });
    expect(parseRule(likedRule())).toEqual({ ok: true, rule: likedRule() });
    expect(LIKED_PLAYLIST_LIMIT).toBe(200);
    expect(ruleSummary(likedRule())).toBe('Piaciuti di recente · max 200');
  });

  it('has the name and the theme the person and the registry know it by', () => {
    expect(LIKED_PLAYLIST_NAME).toBe('Mi piace');
    expect(LIKED_THEME_KEY).toBe('liked');
  });
});

describe('ensureLikedPlaylist', () => {
  it('makes it at the first like: dynamic, automatic, a theme with no post behind it, no songs of its own, registered', async () => {
    const store = new MemoryAutoPlaylistStore();
    const out = await ensureLikedPlaylist(store, { owner: 'mike', at: AT });
    expect(out.status).toBe('made');
    expect(store.playlists.size).toBe(1);
    const [p] = [...store.playlists.values()];
    expect(p).toMatchObject({ owner: 'mike', name: 'Mi piace', kind: 'theme', themeKey: 'liked', sourceEntryId: null, createdAt: AT, rule: likedRule(), songs: [] });
    expect(out).toEqual({ status: 'made', id: p.id });
    expect(await store.listThemes('mike')).toEqual([{ themeKey: 'liked', title: 'Mi piace', playlistId: p.id }]);
  });

  it('is one per person: the second like finds it and makes nothing', async () => {
    const store = new MemoryAutoPlaylistStore();
    const first = await ensureLikedPlaylist(store, { owner: 'mike', at: AT });
    const second = await ensureLikedPlaylist(store, { owner: 'mike', at: new Date('2026-11-11T08:00:00.000Z') });
    expect(second).toEqual({ status: 'there', id: (first as { id: string }).id });
    expect(store.playlists.size).toBe(1);
  });

  it('is the person\'s own: another person makes hers, and one never sees the other\'s', async () => {
    const store = new MemoryAutoPlaylistStore();
    await ensureLikedPlaylist(store, { owner: 'mike', at: AT });
    const sara = await ensureLikedPlaylist(store, { owner: 'sara', at: AT });
    expect(sara.status).toBe('made');
    expect([...store.playlists.values()].map((p) => p.owner).sort()).toEqual(['mike', 'sara']);
  });

  it('is never made again when the person deleted it: the registry remembers a theme with no playlist', async () => {
    const store = new MemoryAutoPlaylistStore();
    const made = await ensureLikedPlaylist(store, { owner: 'mike', at: AT });
    store.deletePlaylist((made as { id: string }).id);
    expect(await ensureLikedPlaylist(store, { owner: 'mike', at: new Date('2026-11-12T08:00:00.000Z') })).toEqual({ status: 'skipped', reason: 'deleted' });
    expect(store.playlists.size).toBe(0);
    // the other person is not affected by his deletion
    expect((await ensureLikedPlaylist(store, { owner: 'sara', at: AT })).status).toBe('made');
  });

  it('is made once when two likes arrive together (the unique index of the store decides, the loser gets the winner back)', async () => {
    const store = new MemoryAutoPlaylistStore();
    const [a, b] = await Promise.all([ensureLikedPlaylist(store, { owner: 'mike', at: AT }), ensureLikedPlaylist(store, { owner: 'mike', at: AT })]);
    expect(store.playlists.size).toBe(1);
    expect(new Set([(a as { id: string }).id, (b as { id: string }).id]).size).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['made', 'there']);
  });

  it('is never made for «anonymous» nor for nobody: a like of nobody has no playlist', async () => {
    const store = new MemoryAutoPlaylistStore();
    expect(await ensureLikedPlaylist(store, { owner: 'anonymous', at: AT })).toEqual({ status: 'skipped', reason: 'no_owner' });
    expect(await ensureLikedPlaylist(store, { owner: '', at: AT })).toEqual({ status: 'skipped', reason: 'no_owner' });
    expect(await ensureLikedPlaylist(store, { owner: '   ', at: AT })).toEqual({ status: 'skipped', reason: 'no_owner' });
    expect(store.playlists.size).toBe(0);
  });

  it('does not hide a failure of the store: the caller decides (a like never fails because of its playlist)', async () => {
    const store = {
      listThemes: async () => { throw new Error('db down'); },
      createPlaylist: async () => ({ id: 'x', created: true }),
    };
    await expect(ensureLikedPlaylist(store, { owner: 'mike', at: AT })).rejects.toThrow('db down');
  });

  it('asks the registry first: a person who has the theme with a playlist makes no insert at all', async () => {
    let inserts = 0;
    const store = {
      listThemes: async () => [{ themeKey: 'liked', title: 'Mi piace', playlistId: 'p-1' }],
      createPlaylist: async () => { inserts += 1; return { id: 'other', created: true }; },
    };
    expect(await ensureLikedPlaylist(store, { owner: 'mike', at: AT })).toEqual({ status: 'there', id: 'p-1' });
    expect(inserts).toBe(0);
  });
});
