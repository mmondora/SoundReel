import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ query: vi.fn(), getUserSongs: vi.fn(), listReadySongKeys: vi.fn(), likedKeys: vi.fn(), libraryOnlySong: vi.fn() }));
vi.mock('../utils/db', () => ({ query: m.query }));
vi.mock('./userSongs', () => ({ getUserSongs: m.getUserSongs }));
vi.mock('./songFiles', () => ({ listReadySongKeys: m.listReadySongKeys }));
vi.mock('./songLikes', () => ({ likedKeys: m.likedKeys }));
vi.mock('./libraryOnlySongs', () => ({ libraryOnlySong: m.libraryOnlySong }));

import { parseRule, PRESETS, resolveDynamicSongKeys, ruleSummary, type DynamicRule } from './dynamicPlaylists';

const NOW = new Date('2026-11-08T08:00:00Z');
const rule = (over: Partial<DynamicRule> = {}): DynamicRule => ({ v: 1, scope: 'me', period: { days: 30 }, order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false, ...over });
const song = (key: string, over: Record<string, unknown> = {}) => ({
  songKey: key, title: key.split('::')[1], artist: key.split('::')[0], mentions: [{ entryId: `e-${key}`, createdAt: '2026-10-01T00:00:00Z' }],
  meta: { genres: ['Rock'], downloaded: false }, ...over,
}) as never;
const stat = (key: string, plays: number, last: string) => ({ song_key: key, plays, last_at: new Date(last) });

beforeEach(() => {
  vi.clearAllMocks();
  m.listReadySongKeys.mockResolvedValue(new Set());
  m.likedKeys.mockResolvedValue([]);
  m.libraryOnlySong.mockResolvedValue(undefined);
});

describe('parseRule', () => {
  it('fills the defaults of an empty rule', () => {
    expect(parseRule({})).toEqual({ ok: true, rule: { v: 1, scope: 'me', period: { days: 30 }, order: 'most_played', limit: 50, minPlays: 1, downloadedOnly: false } });
  });

  it('accepts the contract example and keeps it', () => {
    const r = parseRule({ v: 1, scope: 'me', period: { days: 30 }, window: { from: '07:00', to: '08:00', days: [5, 1, 3, 2, 4, 1] }, order: 'most_played', limit: 50, minPlays: 1, genres: ['Rock', 'Jazz'], downloadedOnly: false });
    expect(r).toMatchObject({ ok: true, rule: { window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5] }, genres: ['Jazz', 'Rock'] } });
  });

  it('canonicalizes genres so "Alternativa" and "Alternative" are one filter', () => {
    const r = parseRule({ genres: ['Alternativa', 'Alternative', 'Rap/Hip Hop'] });
    expect(r.ok && r.rule.genres).toEqual(['Alternative', 'Hip-Hop/Rap']);
  });

  it('a window that restricts nothing is dropped; days-only keeps the days', () => {
    expect(parseRule({ window: { from: '00:00', to: '00:00' } })).toMatchObject({ ok: true, rule: expect.not.objectContaining({ window: expect.anything() }) });
    expect(parseRule({ window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5, 6, 7] } })).toMatchObject({ ok: true, rule: { window: { from: '07:00', to: '08:00' } } });
    const weekend = parseRule({ window: { from: '00:00', to: '00:00', days: [7, 6] } });
    expect(weekend.ok && weekend.rule.window).toEqual({ from: '00:00', to: '00:00', days: [6, 7] });
    expect(parseRule({ window: null })).toMatchObject({ ok: true });
  });

  it('accepts a window that crosses midnight and "all" as period', () => {
    expect(parseRule({ window: { from: '22:00', to: '06:00' }, period: 'all' })).toMatchObject({ ok: true, rule: { window: { from: '22:00', to: '06:00' }, period: 'all' } });
  });

  it.each([
    [{ v: 2 }, 'v'], [{ scope: 'world' }, 'scope'], [{ period: { days: 0 } }, 'period'], [{ period: { days: 4000 } }, 'period'],
    [{ period: 'week' }, 'period'], [{ window: 'night' }, 'window'], [{ window: { from: '7:00', to: '08:00' } }, 'window.from'],
    [{ window: { from: '07:00', to: '24:00' } }, 'window.to'], [{ window: { from: '07:00', to: '08:00', days: [0] } }, 'window.days'],
    [{ window: { from: '07:00', to: '08:00', days: ['mon'] } }, 'window.days'], [{ order: 'loudest' }, 'order'],
    [{ limit: 0 }, 'limit'], [{ limit: 201 }, 'limit'], [{ limit: 1.5 }, 'limit'], [{ minPlays: 0 }, 'minPlays'],
    [{ genres: 'Rock' }, 'genres'], [{ genres: Array(21).fill('Rock') }, 'genres'], [{ genres: [7] }, 'genres'],
    [{ downloadedOnly: 'yes' }, 'downloadedOnly'],
  ])('rejects %j', (raw, field) => {
    expect(parseRule(raw)).toEqual({ ok: false, error: `invalid_rule:${field}` });
  });

  it('accepts the order "newest" (the songs added last, first: no listening in it) and keeps the genres', () => {
    const r = parseRule({ order: 'newest', genres: ['Soul', 'R&B'], period: 'all', limit: 200 });
    expect(r).toEqual({ ok: true, rule: { v: 1, scope: 'me', period: 'all', order: 'newest', limit: 200, minPlays: 1, genres: ['R&B/Soul'], downloadedOnly: false } });
  });

  it('accepts the order "liked" (the songs this person liked, the most recently liked first: no listening in it) and keeps the genres', () => {
    const r = parseRule({ order: 'liked', genres: ['Jazz'], period: 'all', limit: 200 });
    expect(r).toEqual({ ok: true, rule: { v: 1, scope: 'me', period: 'all', order: 'liked', limit: 200, minPlays: 1, genres: ['Jazz'], downloadedOnly: false } });
  });

  it('refuses garbage that is not a rule at all', () => {
    for (const junk of [null, undefined, 7, 'x', []]) expect(parseRule(junk)).toEqual({ ok: false, error: 'rule_required' });
  });
});

describe('ruleSummary', () => {
  it('says it the way a person would', () => {
    expect(ruleSummary(rule({ window: { from: '07:00', to: '08:00', days: [1, 2, 3, 4, 5] } }))).toBe('Più ascoltate · 07:00–08:00 (lun–ven) · ultimi 30 giorni · max 50');
    expect(ruleSummary(rule({ window: { from: '22:00', to: '06:00' }, period: { days: 90 } }))).toBe('Più ascoltate · 22:00–06:00 · ultimi 90 giorni · max 50');
    expect(ruleSummary(rule({ window: { from: '00:00', to: '00:00', days: [6, 7] }, period: 'all', scope: 'family', genres: ['Rock', 'Jazz'], downloadedOnly: true, limit: 20 })))
      .toBe('Più ascoltate · weekend · da sempre · tutta la famiglia · Rock, Jazz · solo scaricate · max 20');
    expect(ruleSummary(rule({ order: 'never_played', period: 'all', window: { from: '07:00', to: '08:00' } }))).toBe('Mai ascoltate · da sempre · max 50');
    expect(ruleSummary(rule({ order: 'recent', period: { days: 1 }, window: { from: '09:00', to: '10:00', days: [1, 3] } }))).toBe('Ascoltate di recente · 09:00–10:00 (lun, mer) · ultime 24 ore · max 50');
  });

  it('"newest" does not look at what was heard: no window, no period, no family in the words', () => {
    expect(ruleSummary(rule({ order: 'newest', period: 'all', genres: ['R&B/Soul'], limit: 200 }))).toBe('Aggiunte di recente · R&B/Soul · max 200');
    expect(ruleSummary(rule({ order: 'newest', period: { days: 7 }, scope: 'family', window: { from: '07:00', to: '08:00' }, downloadedOnly: true, limit: 20 })))
      .toBe('Aggiunte di recente · solo scaricate · max 20');
  });

  it('"liked" does not look at what was heard either: the words are «Piaciuti di recente», with no window, no period and no family', () => {
    expect(ruleSummary(rule({ order: 'liked', period: 'all', limit: 200 }))).toBe('Piaciuti di recente · max 200');
    expect(ruleSummary(rule({ order: 'liked', period: { days: 7 }, scope: 'family', window: { from: '07:00', to: '08:00' }, genres: ['Jazz'], downloadedOnly: true, limit: 20 })))
      .toBe('Piaciuti di recente · Jazz · solo scaricate · max 20');
  });

  it('every preset is a valid rule that survives parsing unchanged, with a summary', () => {
    expect(PRESETS.map((p) => p.id)).toEqual(expect.arrayContaining(['night', 'morning', 'weekend', 'never-played']));
    for (const p of PRESETS) {
      expect(parseRule(p.rule), p.id).toEqual({ ok: true, rule: p.rule });
      expect(ruleSummary(p.rule).length).toBeGreaterThan(10);
    }
    expect(new Set(PRESETS.map((p) => p.id)).size).toBe(PRESETS.length);
  });
});

describe('resolveDynamicSongKeys: ranking', () => {
  const songs = new Map([
    ['a::alpha', song('a::alpha')], ['b::bravo', song('b::bravo')], ['c::charlie', song('c::charlie')], ['d::delta', song('d::delta')],
  ]);
  beforeEach(() => {
    m.getUserSongs.mockResolvedValue(songs);
    m.query.mockResolvedValue([
      stat('a::alpha', 3, '2026-11-01T07:10:00Z'), stat('b::bravo', 9, '2026-11-02T07:10:00Z'),
      stat('c::charlie', 3, '2026-11-05T07:10:00Z'), stat('ghost::not-visible', 50, '2026-11-05T07:10:00Z'),
    ]);
  });

  it('most played: by count, ties by most recent, only songs the user can see', async () => {
    expect(await resolveDynamicSongKeys(rule(), { userId: 'mike' }, NOW)).toEqual(['b::bravo', 'c::charlie', 'a::alpha']);
  });

  it('respects the limit and minPlays', async () => {
    expect(await resolveDynamicSongKeys(rule({ limit: 2 }), { userId: 'mike' }, NOW)).toEqual(['b::bravo', 'c::charlie']);
    expect(await resolveDynamicSongKeys(rule({ minPlays: 4 }), { userId: 'mike' }, NOW)).toEqual(['b::bravo']);
  });

  it('recent: by last listening, newest first', async () => {
    expect(await resolveDynamicSongKeys(rule({ order: 'recent' }), { userId: 'mike' }, NOW)).toEqual(['c::charlie', 'b::bravo', 'a::alpha']);
  });

  it('least played: zeros first (songs never heard), then by count, ties by oldest last listening', async () => {
    expect(await resolveDynamicSongKeys(rule({ order: 'least_played' }), { userId: 'mike' }, NOW)).toEqual(['d::delta', 'a::alpha', 'c::charlie', 'b::bravo']);
  });

  it('never played: songs with no counted play in the period, newest mention first, ignoring the time window', async () => {
    const withMentions = new Map([
      ['a::alpha', song('a::alpha')],
      ['d::delta', song('d::delta', { mentions: [{ entryId: 'e1', createdAt: '2026-11-07T00:00:00Z' }] })],
      ['e::echo', song('e::echo', { mentions: [{ entryId: 'e2', createdAt: '2026-09-01T00:00:00Z' }] })],
    ]);
    m.getUserSongs.mockResolvedValue(withMentions);
    const out = await resolveDynamicSongKeys(rule({ order: 'never_played', window: { from: '07:00', to: '08:00' } }), { userId: 'mike' }, NOW);
    expect(out).toEqual(['d::delta', 'e::echo']); // alpha has plays
    const params = (m.query.mock.calls[0] as [string, unknown[]])[1];
    expect(params).toHaveLength(2); // user + since only: the window is not applied
  });

  it('no candidates, no query', async () => {
    m.getUserSongs.mockResolvedValue(new Map());
    expect(await resolveDynamicSongKeys(rule(), { userId: 'mike' }, NOW)).toEqual([]);
    expect(m.query).not.toHaveBeenCalled();
  });
});

describe('resolveDynamicSongKeys: newest (the playlist of a genre: every song with the tag, the last added first)', () => {
  const at = (day: string) => [{ entryId: `e-${day}`, createdAt: `${day}T00:00:00Z` }];
  beforeEach(() => {
    m.getUserSongs.mockResolvedValue(new Map([
      ['a::old-soul', song('a::old-soul', { mentions: at('2026-08-01'), meta: { genres: ['R&B/Soul'], downloaded: false } })],
      ['b::new-soul', song('b::new-soul', { mentions: at('2026-11-05'), meta: { genres: ['Soul'], downloaded: false } })], // raw "Soul" = canonical R&B/Soul
      ['c::mid-soul', song('c::mid-soul', { mentions: at('2026-10-01'), meta: { genres: ['R&B'], downloaded: false } })],
      ['d::rocker', song('d::rocker', { mentions: at('2026-11-09') })],
      ['e::untagged', song('e::untagged', { mentions: at('2026-11-09'), meta: null })],
    ]));
  });

  it('every song that has the genre, the newest mention first, and nothing asked of the listening events', async () => {
    const out = await resolveDynamicSongKeys(rule({ order: 'newest', genres: ['R&B/Soul'], period: 'all' }), { userId: 'mike' }, NOW);
    expect(out).toEqual(['b::new-soul', 'c::mid-soul', 'a::old-soul']);
    expect(m.query).not.toHaveBeenCalled(); // songs never played are in too: the tag decides, not the plays
  });

  it('a song without metadata has no tag: it is not in a playlist of a genre', async () => {
    const out = await resolveDynamicSongKeys(rule({ order: 'newest', genres: ['Rock'], period: 'all' }), { userId: 'mike' }, NOW);
    expect(out).toEqual(['d::rocker']);
  });

  it('respects the limit (the newest are kept) and the ties go by title', async () => {
    expect(await resolveDynamicSongKeys(rule({ order: 'newest', genres: ['R&B/Soul'], limit: 2 }), { userId: 'mike' }, NOW)).toEqual(['b::new-soul', 'c::mid-soul']);
    m.getUserSongs.mockResolvedValue(new Map([
      ['z::zulu', song('z::zulu', { mentions: at('2026-11-05') })],
      ['a::alpha', song('a::alpha', { mentions: at('2026-11-05') })],
    ]));
    expect(await resolveDynamicSongKeys(rule({ order: 'newest' }), { userId: 'mike' }, NOW)).toEqual(['a::alpha', 'z::zulu']);
  });

  it('with no genre it is the newest of the whole library', async () => {
    const out = await resolveDynamicSongKeys(rule({ order: 'newest', limit: 3 }), { userId: 'mike' }, NOW);
    expect(out).toHaveLength(3);
    expect(out.slice(0, 2).sort()).toEqual(['d::rocker', 'e::untagged']);
    expect(out[2]).toBe('b::new-soul');
  });
});

describe('resolveDynamicSongKeys: liked (the playlist «Mi piace»: the songs this person liked, the most recently liked first)', () => {
  const LIKED = rule({ order: 'liked', period: 'all', limit: 200 });
  const journal = new Map([
    ['a::alpha', song('a::alpha')],
    ['b::bravo', song('b::bravo', { meta: { genres: ['Jazz'], downloaded: true } })],
    ['c::charlie', song('c::charlie')],
  ]);
  const fileOnly = (key: string, over: Record<string, unknown> = {}) => song(key, { libraryOnly: true, meta: undefined, mentions: [], ...over });
  beforeEach(() => {
    m.getUserSongs.mockResolvedValue(journal);
    m.likedKeys.mockResolvedValue(['c::charlie', 'a::alpha', 'b::bravo']);
  });

  it('are the liked keys in the order of the likes, the most recently liked first', async () => {
    expect(await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW)).toEqual(['c::charlie', 'a::alpha', 'b::bravo']);
  });

  it('are the likes of THIS person: the user of the viewer, only that one, and the family scope of the rule changes nothing', async () => {
    await resolveDynamicSongKeys(rule({ order: 'liked', scope: 'family', period: 'all' }), { userId: 'sara' }, NOW);
    expect(m.likedKeys).toHaveBeenCalledTimes(1);
    expect(m.likedKeys).toHaveBeenCalledWith('sara');
  });

  it('do not read the listening events at all (no query: what was heard does not count)', async () => {
    await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW);
    expect(m.query).not.toHaveBeenCalled();
  });

  it('respect the limit of the rule: the first ones, that is the most recently liked', async () => {
    expect(await resolveDynamicSongKeys(rule({ order: 'liked', period: 'all', limit: 2 }), { userId: 'mike' }, NOW)).toEqual(['c::charlie', 'a::alpha']);
  });

  it('include a song that exists only as a file (a like given in «Cerca» on a song of the library), even with no journal at all', async () => {
    m.getUserSongs.mockResolvedValue(new Map());
    m.likedKeys.mockResolvedValue(['x::only-file', 'a::alpha']);
    m.libraryOnlySong.mockImplementation(async (key: string) => (key === 'x::only-file' ? fileOnly(key) : undefined));
    expect(await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW)).toEqual(['x::only-file']);
  });

  it('skip a liked song that exists nowhere any more (no source, no track: it would only inflate the count)', async () => {
    m.likedKeys.mockResolvedValue(['gone::song', 'a::alpha']);
    expect(await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW)).toEqual(['a::alpha']);
    expect(m.libraryOnlySong).toHaveBeenCalledWith('gone::song');
  });

  it('look for a file only when the journal does not have the song', async () => {
    await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW);
    expect(m.libraryOnlySong).not.toHaveBeenCalled();
  });

  it('a library that cannot be read is a library with nothing in it, never a failure of the list of playlists', async () => {
    m.likedKeys.mockResolvedValue(['x::only-file', 'a::alpha']);
    m.libraryOnlySong.mockRejectedValue(new Error('index down'));
    expect(await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW)).toEqual(['a::alpha']);
  });

  it('are narrowed by the genre of the rule, like every rule (a song that has none of them is out, a file-only one too)', async () => {
    m.likedKeys.mockResolvedValue(['x::only-file', 'c::charlie', 'b::bravo']);
    m.libraryOnlySong.mockImplementation(async (key: string) => (key === 'x::only-file' ? fileOnly(key) : undefined));
    expect(await resolveDynamicSongKeys(rule({ order: 'liked', period: 'all', genres: ['Jazz'] }), { userId: 'mike' }, NOW)).toEqual(['b::bravo']);
  });

  it('are narrowed by «solo scaricate», by the flag of the song or by a file the server has ready', async () => {
    m.likedKeys.mockResolvedValue(['a::alpha', 'b::bravo', 'c::charlie']);
    m.listReadySongKeys.mockResolvedValue(new Set(['c::charlie']));
    expect(await resolveDynamicSongKeys(rule({ order: 'liked', period: 'all', downloadedOnly: true }), { userId: 'mike' }, NOW)).toEqual(['b::bravo', 'c::charlie']);
  });

  it('a person who liked nothing has an empty playlist', async () => {
    m.likedKeys.mockResolvedValue([]);
    expect(await resolveDynamicSongKeys(LIKED, { userId: 'mike' }, NOW)).toEqual([]);
  });
});

describe('resolveDynamicSongKeys: filters', () => {
  beforeEach(() => {
    m.getUserSongs.mockResolvedValue(new Map([
      ['a::rocker', song('a::rocker', { meta: { genres: ['Rock'], downloaded: true } })],
      ['b::jazzer', song('b::jazzer', { meta: { genres: ['Jazz'], downloaded: false } })],
      ['c::alt', song('c::alt', { meta: { genres: ['Alternativa'], downloaded: false } })],
      ['d::nometa', song('d::nometa', { meta: null })],
    ]));
    m.query.mockResolvedValue([stat('a::rocker', 5, '2026-11-01T00:00:00Z'), stat('b::jazzer', 4, '2026-11-01T00:00:00Z'), stat('c::alt', 3, '2026-11-01T00:00:00Z'), stat('d::nometa', 2, '2026-11-01T00:00:00Z')]);
  });

  it('"tipo" = genre, merged through the canonical names (Alternativa is Alternative)', async () => {
    expect(await resolveDynamicSongKeys(rule({ genres: ['Rock', 'Jazz'] }), { userId: 'mike' }, NOW)).toEqual(['a::rocker', 'b::jazzer']);
    expect(await resolveDynamicSongKeys(rule({ genres: ['Alternative'] }), { userId: 'mike' }, NOW)).toEqual(['c::alt']);
  });

  it('downloadedOnly keeps what is on disk, by flag or by a recorded file', async () => {
    m.listReadySongKeys.mockResolvedValue(new Set(['b::jazzer']));
    expect(await resolveDynamicSongKeys(rule({ downloadedOnly: true }), { userId: 'mike' }, NOW)).toEqual(['a::rocker', 'b::jazzer']);
  });
});

describe('resolveDynamicSongKeys: the query (semantics are proven on a real Postgres separately)', () => {
  beforeEach(() => {
    m.getUserSongs.mockResolvedValue(new Map([['a::alpha', song('a::alpha')]]));
    m.query.mockResolvedValue([]);
  });
  const run = async (r: DynamicRule) => {
    await resolveDynamicSongKeys(r, { userId: 'mike' }, NOW);
    return m.query.mock.calls[m.query.mock.calls.length - 1] as [string, unknown[]];
  };

  it('"me" is the requester, "family" is everybody; the period is a cut-off, "all" has none', async () => {
    expect((await run(rule()))[1].slice(0, 2)).toEqual([['mike'], '2026-10-09T08:00:00.000Z']);
    expect((await run(rule({ scope: 'family', period: 'all' })))[1].slice(0, 2)).toEqual([null, null]);
  });

  it('a window inside the day: from <= local time < to', async () => {
    const [sql, params] = await run(rule({ window: { from: '07:00', to: '08:00' } }));
    expect(sql).toMatch(/local_started_at::time >= \$3::time AND local_started_at::time < \$4::time/);
    expect(params.slice(2)).toEqual(['07:00', '08:00']);
  });

  it('a window across midnight: from <= time OR time < to (night 22:00–06:00)', async () => {
    const [sql, params] = await run(rule({ window: { from: '22:00', to: '06:00' } }));
    expect(sql).toMatch(/local_started_at::time >= \$3::time OR local_started_at::time < \$4::time/);
    expect(params.slice(2)).toEqual(['22:00', '06:00']);
  });

  it('weekdays use the local weekday of the listening; days-only windows add no time condition', async () => {
    const [sql, params] = await run(rule({ window: { from: '00:00', to: '00:00', days: [6, 7] } }));
    expect(sql).toMatch(/EXTRACT\(ISODOW FROM local_started_at\)::int = ANY\(\$3::int\[\]\)/);
    expect(sql).not.toMatch(/::time\b/); // (::timestamptz is the period cut-off, not a time-of-day condition)
    expect(params[2]).toEqual([6, 7]);
  });

  it('only counted plays are ever considered', async () => {
    expect((await run(rule()))[0]).toMatch(/WHERE counted AND/);
  });
});
