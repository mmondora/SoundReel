import { describe, expect, it, vi } from 'vitest';
import type { Film, Song } from '../types';
import {
  REPOINT_STATEMENTS,
  applyGroup,
  describePlan,
  filesLostWarnings,
  findDuplicateGroups,
  mergeDuplicateEntries,
  mergeGroup,
  parseArgs,
  pickPrimary,
  planMerges,
  type Deps,
  type Dependants,
  type EntryRow,
  type GroupPlan,
} from './mergeDuplicateEntries';

const IG = (code: string, query = ''): string => `https://www.instagram.com/reel/${code}/${query}`;

const row = (id: string, over: Partial<EntryRow> = {}): EntryRow => ({
  id,
  owner_user: 'mike',
  source_url: IG('ABC123'),
  source_platform: 'instagram',
  status: 'completed',
  created_at: '2026-10-01T10:00:00.000Z',
  caption: null,
  thumbnail_url: `/media/${id}/thumbnail.jpg`,
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null },
  action_log: [],
  ...over,
});

const withResults = (results: Partial<NonNullable<EntryRow['results']>>): Pick<EntryRow, 'results'> => ({
  results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, ...results },
});

const song = (title: string, artist: string, over: Partial<Song> = {}): Song => ({
  title, artist, album: null, source: 'ai_analysis', spotifyUri: null, spotifyUrl: null, youtubeUrl: null, soundcloudUrl: null, addedToPlaylist: false, ...over,
});
const film = (title: string, over: Partial<Film> = {}): Film => ({ title, director: null, year: null, imdbUrl: null, posterUrl: null, streamingUrls: null, ...over });

describe('findDuplicateGroups', () => {
  it('groups the same Instagram post written with different URL forms, per owner', () => {
    const rows = [
      row('a', { source_url: IG('ABC123', '?utm_source=ig_web_copy_link') }),
      row('b', { source_url: 'https://www.instagram.com/p/ABC123/?img_index=3' }),
      row('c', { source_url: IG('ABC123', '?igsh=xyz') }),
      row('d', { source_url: IG('OTHER99') }),
      row('e', { source_url: IG('ABC123'), owner_user: 'sara' }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].map((r) => r.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('groups YouTube forms of the same video and leaves distinct posts alone', () => {
    const rows = [
      row('y1', { source_url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', source_platform: 'youtube' }),
      row('y2', { source_url: 'https://youtu.be/dQw4w9WgXcQ?si=abc', source_platform: 'youtube' }),
      row('y3', { source_url: 'https://www.youtube.com/watch?v=another1234', source_platform: 'youtube' }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups.map((g) => g.map((r) => r.id).sort())).toEqual([['y1', 'y2']]);
  });

  it('finds nothing when there is nothing to merge', () => {
    expect(findDuplicateGroups([row('a'), row('b', { source_url: IG('ZZZ') })])).toEqual([]);
    expect(findDuplicateGroups([])).toEqual([]);
  });
});

describe('pickPrimary', () => {
  const data = withResults({ songs: [song('A', 'B')] });
  it('keeps the oldest entry that has data, even if a newer one holds more', () => {
    const older = row('old', { created_at: '2026-10-01T10:00:00Z', ...withResults({ notes: [{ text: 'n', category: 'place' }] }) });
    const newer = row('new', { created_at: '2026-10-02T10:00:00Z', ...withResults({ songs: [song('A', 'B'), song('C', 'D')], summary: 'x' }) });
    const { primary, surplus } = pickPrimary([newer, older]);
    expect(primary.id).toBe('old');
    expect(surplus.map((s) => s.id)).toEqual(['new']);
  });

  it('an older entry with nothing in it does not beat a newer one with data', () => {
    const empty = row('empty', { created_at: '2026-10-01T10:00:00Z', status: 'completed' });
    const full = row('full', { created_at: '2026-10-05T10:00:00Z', ...data });
    expect(pickPrimary([empty, full]).primary.id).toBe('full');
  });

  it('with no data anywhere the oldest completed one wins over an older error', () => {
    const err = row('err', { created_at: '2026-09-01T10:00:00Z', status: 'error' });
    const ok = row('ok', { created_at: '2026-10-01T10:00:00Z', status: 'completed' });
    expect(pickPrimary([err, ok]).primary.id).toBe('ok');
  });

  it('with all in error the oldest wins, and ties are broken by id', () => {
    const a = row('a1', { created_at: '2026-09-01T10:00:00Z', status: 'error' });
    const b = row('b1', { created_at: '2026-09-02T10:00:00Z', status: 'error' });
    expect(pickPrimary([b, a]).primary.id).toBe('a1');
    const t1 = row('t1', { created_at: '2026-09-01T10:00:00Z' });
    const t2 = row('t2', { created_at: '2026-09-01T10:00:00Z' });
    expect(pickPrimary([t2, t1]).primary.id).toBe('t1');
  });
});

describe('mergeGroup', () => {
  const NOW = new Date('2026-11-09T09:00:00.000Z');

  it('unites songs, films, notes, software, links and tags without losing any', () => {
    const keep = row('keep', withResults({
      songs: [song('Nightcall', 'Kavinsky')],
      films: [film('Drive')],
      notes: [{ text: 'Bar Basso', category: 'place' }],
      software: [{ title: 'Claude Code', url: 'https://github.com/anthropics/claude-code', tag: 'repo' }],
      links: [{ url: 'https://a.example/x', label: 'x' }],
      tags: ['musica'],
      summary: 'Riassunto del keeper',
    }));
    const other = row('other', withResults({
      songs: [song('Nightcall', 'Kavinsky'), song('A Real Hero', 'College')],
      films: [film('Drive'), film('Heat')],
      notes: [{ text: 'Bar Basso', category: 'place' }, { text: 'Navigli', category: 'place' }],
      software: [{ title: 'Ollama', url: 'https://ollama.com', tag: 'product' }],
      links: [{ url: 'https://a.example/x', label: 'x' }, { url: 'https://b.example/y', label: 'y' }],
      tags: ['#musica', 'film'],
      summary: 'Riassunto dell altro',
    }));
    const { results } = mergeGroup(keep, [other], NOW);
    expect(results.songs.map((s) => s.title)).toEqual(['Nightcall', 'A Real Hero']);
    expect(results.films.map((f) => f.title)).toEqual(['Drive', 'Heat']);
    expect(results.notes.map((n) => n.text)).toEqual(['Bar Basso', 'Navigli']);
    expect(results.software?.map((s) => s.title)).toEqual(['Claude Code', 'Ollama']);
    expect(results.links.map((l) => l.url)).toEqual(['https://a.example/x', 'https://b.example/y']);
    expect(results.tags).toEqual(['#musica', 'film']);
    expect(results.summary).toBe('Riassunto del keeper');
  });

  it("completes the keeper's copy of the same song with what only the other knew", () => {
    const keep = row('keep', withResults({ songs: [song('Nightcall', 'Kavinsky', { source: 'audio_fingerprint' })] }));
    const other = row('other', withResults({
      songs: [song('nightcall', 'KAVINSKY', {
        source: 'ai_analysis', album: 'OutRun', spotifyUri: 'spotify:track:1', spotifyUrl: 'https://open.spotify.com/track/1',
        youtubeUrl: 'https://youtube.com/results?x', soundcloudUrl: 'https://sc.example/n', addedToPlaylist: true,
      })],
    }));
    const [merged] = mergeGroup(keep, [other], NOW).results.songs;
    expect(merged.title).toBe('Nightcall'); // the keeper's spelling stays
    expect(merged).toMatchObject({
      album: 'OutRun', spotifyUri: 'spotify:track:1', spotifyUrl: 'https://open.spotify.com/track/1',
      youtubeUrl: 'https://youtube.com/results?x', soundcloudUrl: 'https://sc.example/n', addedToPlaylist: true, source: 'both',
    });
  });

  it('never overwrites what the keeper already has on a song or a film', () => {
    const keep = row('keep', withResults({
      songs: [song('A', 'B', { spotifyUrl: 'https://open.spotify.com/track/KEEP', album: 'Mine', addedToPlaylist: true })],
      films: [film('Drive', { posterUrl: '/p/keep.jpg', year: '2011' })],
    }));
    const other = row('other', withResults({
      songs: [song('A', 'B', { spotifyUrl: 'https://open.spotify.com/track/OTHER', album: 'Theirs', addedToPlaylist: false })],
      films: [film('Drive', { posterUrl: '/p/other.jpg', year: '2012', director: 'Refn', imdbUrl: 'https://imdb.example/t1' })],
    }));
    const { songs, films } = mergeGroup(keep, [other], NOW).results;
    expect(songs[0]).toMatchObject({ spotifyUrl: 'https://open.spotify.com/track/KEEP', album: 'Mine', addedToPlaylist: true });
    expect(films[0]).toMatchObject({ posterUrl: '/p/keep.jpg', year: '2011', director: 'Refn', imdbUrl: 'https://imdb.example/t1' });
  });

  it('fills the url and description of the same software', () => {
    const keep = row('keep', withResults({ software: [{ title: 'Tool', url: 'https://tool.example', tag: 'product', description: null }] }));
    const other = row('other', withResults({ software: [{ title: 'Tool', url: 'https://tool.example', tag: 'product', description: 'A tool' }] }));
    expect(mergeGroup(keep, [other], NOW).results.software?.[0].description).toBe('A tool');
  });

  it("keeps the keeper's transcript and only fills a blank one", () => {
    const keep = row('keep', { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, transcript: 'mio', transcriptLanguage: 'it' } });
    const other = row('other', { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, transcript: 'suo', transcriptLanguage: 'en' } });
    const kept = mergeGroup(keep, [other], NOW).results;
    expect(kept.transcript).toBe('mio');
    expect(kept.transcriptLanguage).toBe('it');

    const blank = row('blank', { results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, transcript: '  ', transcriptLanguage: null } });
    const filled = mergeGroup(blank, [other], NOW).results;
    expect(filled.transcript).toBe('suo');
    expect(filled.transcriptLanguage).toBe('en');
  });

  it("takes the other's summary only when the keeper has none, and keeps the keeper's enrichments", () => {
    const keep = row('keep', withResults({ summary: '   ', enrichments: { items: [] } as never }));
    const other = row('other', withResults({ summary: 'Dell altro', enrichments: { items: ['x'] } as never }));
    const { results } = mergeGroup(keep, [other], NOW);
    expect(results.summary).toBe('Dell altro');
    expect(results.enrichments).toEqual({ items: [] });
  });

  it("never takes the other's slide images, whose folder is about to be cleaned up", () => {
    const slide = (i: number, imageUrl: string | null) => ({ index: i, imageUrl, ocrText: `ocr ${i}`, visualDescription: null, summary: `s${i}`, links: [] });
    const own = row('keep', withResults({ slides: [slide(0, '/media/keep/slide-0.jpg')] }));
    const theirs = row('other', withResults({ slides: [slide(0, '/media/other/slide-0.jpg'), slide(1, '/media/other/slide-1.jpg')] }));
    expect(mergeGroup(own, [theirs], NOW).results.slides).toEqual([slide(0, '/media/keep/slide-0.jpg')]);

    const none = row('none', withResults({ slides: [] }));
    const taken = mergeGroup(none, [theirs], NOW).results.slides!;
    expect(taken.map((s) => s.imageUrl)).toEqual([null, null]);
    expect(taken.map((s) => s.ocrText)).toEqual(['ocr 0', 'ocr 1']);

    const neither = mergeGroup(row('n1', withResults({})), [row('n2', withResults({}))], NOW).results;
    expect(neither.slides ?? []).toEqual([]);
  });

  it('joins the action logs in time order with one merged_duplicate line per entry that goes', () => {
    const at = (t: string, action: string) => ({ action, details: {}, timestamp: t });
    const keep = row('keep', { action_log: [at('2026-10-01T10:00:00Z', 'start'), at('2026-10-01T10:05:00Z', 'done')], ...withResults({ songs: [song('A', 'B')] }) });
    const other = row('other', {
      source_url: IG('ABC123', '?igsh=1'),
      status: 'error',
      action_log: [at('2026-10-01T10:02:00Z', 'retry'), { action: 'undated', details: {}, timestamp: '' }],
    });
    const { actionLog } = mergeGroup(keep, [other], NOW);
    expect(actionLog.map((l) => l.action)).toEqual(['start', 'retry', 'done', 'merged_duplicate', 'undated']);
    const merged = actionLog.find((l) => l.action === 'merged_duplicate')!;
    expect(merged.timestamp).toBe('2026-11-09T09:00:00.000Z');
    expect(merged.details).toMatchObject({ mergedFrom: 'other', sourceUrl: IG('ABC123', '?igsh=1'), status: 'error', songs: 0 });
  });

  it('folds three entries into one and fills the caption', () => {
    const keep = row('k', { ...withResults({ songs: [song('A', 'B')] }), caption: null });
    const o1 = row('o1', { ...withResults({ songs: [song('C', 'D')] }), caption: 'didascalia' });
    const o2 = row('o2', withResults({ songs: [song('E', 'F')], notes: [{ text: 'n', category: 'event' }] }));
    const merged = mergeGroup(keep, [o1, o2], NOW);
    expect(merged.results.songs.map((s) => s.title)).toEqual(['A', 'C', 'E']);
    expect(merged.results.notes).toHaveLength(1);
    expect(merged.caption).toBe('didascalia');
    expect(merged.actionLog.filter((l) => l.action === 'merged_duplicate')).toHaveLength(2);
  });

  it('does not touch its inputs and gives the same answer twice', () => {
    const keep = row('keep', withResults({ songs: [song('A', 'B')], tags: ['x'] }));
    const other = row('other', withResults({ songs: [song('A', 'B', { spotifyUrl: 'https://s' }), song('C', 'D')], tags: ['#x', 'y'] }));
    const before = structuredClone([keep, other]);
    const first = mergeGroup(keep, [other], NOW);
    expect([keep, other]).toEqual(before);
    expect(mergeGroup(keep, [other], NOW)).toEqual(first);
  });

  it('copes with rows whose results or log are missing', () => {
    const keep = row('keep', { results: null, action_log: null });
    const other = row('other', { results: null, action_log: null });
    const { results, actionLog } = mergeGroup(keep, [other], NOW);
    expect(results.songs).toEqual([]);
    expect(actionLog.map((l) => l.action)).toEqual(['merged_duplicate']);
  });
});

describe('planning and describing', () => {
  it('plans the groups oldest first and describes them', () => {
    const rows = [
      row('b2', { source_url: IG('BBB', '?igsh=1'), created_at: '2026-10-05T10:00:00Z', ...withResults({ songs: [song('A', 'B')] }) }),
      row('b1', { source_url: IG('BBB'), created_at: '2026-10-04T10:00:00Z', ...withResults({ songs: [song('A', 'B')] }) }),
      row('a2', { source_url: IG('AAA', '?igsh=1'), created_at: '2026-10-02T10:00:00Z', ...withResults({ notes: [{ text: 'n', category: 'place' }] }) }),
      row('a1', { source_url: IG('AAA'), created_at: '2026-10-01T10:00:00Z', ...withResults({ notes: [{ text: 'n', category: 'place' }] }) }),
      row('solo', { source_url: IG('SOLO') }),
    ];
    const plans = planMerges(rows);
    expect(plans.map((p) => [p.primary.id, p.surplus.map((s) => s.id)])).toEqual([['a1', ['a2']], ['b1', ['b2']]]);

    const dependants = new Map<string, Dependants>([['a2', { shares: 1, jobs: 3, inbox: 0, intents: 0, spooty: 0, logs: 7 }]]);
    const text = describePlan(plans, dependants).join('\n');
    expect(text).toContain('2 gruppi, 2 entry in piu');
    expect(text).toContain('instagram:AAA');
    expect(text).toMatch(/TIENE\s+a1/);
    expect(text).toMatch(/unisce\s+a2/);
    expect(text).toContain('sposta: 1 condivisioni, 3 job, 7 righe di log');
    expect(text).not.toContain('solo');
  });

  it('warns when the other holds a thumbnail or slide images the keeper cannot take', () => {
    const slide = { index: 0, imageUrl: '/media/o/s0.jpg', ocrText: null, visualDescription: null, summary: null, links: [] };
    const plan: GroupPlan = {
      key: 'mike|instagram:AAA',
      primary: row('keep', { thumbnail_url: null }),
      surplus: [row('other', { thumbnail_url: '/media/other/thumbnail.jpg', ...withResults({ slides: [slide] }) })],
    };
    const warnings = filesLostWarnings(plan);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/miniatura/);
    expect(warnings[1]).toMatch(/1 slide/);
    expect(filesLostWarnings({ ...plan, primary: row('keep') })).toHaveLength(1); // the keeper has a thumbnail but no slides
    // both have a thumbnail and nobody has slide images: nothing to warn about
    expect(filesLostWarnings({ ...plan, primary: row('keep'), surplus: [row('other')] })).toEqual([]);
  });
});

type Call = { sql: string; params: unknown[] };

function fakeClient(opts: { rows?: EntryRow[]; processing?: number; failOn?: RegExp } = {}) {
  const calls: Call[] = [];
  const client = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (opts.failOn?.test(sql)) throw new Error('boom');
      if (/FOR UPDATE/.test(sql)) return { rows: opts.rows ?? [] };
      if (/count\(\*\)/.test(sql)) return { rows: [{ n: String(opts.processing ?? 0) }] };
      return { rows: [] };
    }),
  };
  return { client: client as never, calls };
}

describe('applyGroup', () => {
  const NOW = new Date('2026-11-09T09:00:00.000Z');
  const keep = row('keep', { created_at: '2026-10-01T10:00:00Z', ...withResults({ songs: [song('A', 'B')] }) });
  const dup = row('dup', { created_at: '2026-10-02T10:00:00Z', source_url: IG('ABC123', '?igsh=1'), ...withResults({ songs: [song('C', 'D')] }) });
  const plan: GroupPlan = { key: 'mike|instagram:ABC123', primary: keep, surplus: [dup] };

  it('locks and reads the rows again, updates the keeper, moves every reference, then deletes the duplicate, in one transaction', async () => {
    const { client, calls } = fakeClient({ rows: [dup, keep] });
    expect(await applyGroup(client, plan, NOW)).toBe(true);

    const kinds = calls.map((c) => c.sql.replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' '));
    expect(kinds[0]).toBe('BEGIN');
    expect(kinds.at(-1)).toBe('COMMIT');
    expect(calls[1].sql).toMatch(/FOR UPDATE/);
    expect(calls[1].params).toEqual([['keep', 'dup']]);
    expect(calls[2].sql).toMatch(/status = 'processing'/);

    const sqls = calls.map((c) => c.sql);
    const order = [
      sqls.findIndex((s) => s.startsWith('UPDATE entries')),
      sqls.indexOf(REPOINT_STATEMENTS.shares),
      sqls.indexOf(REPOINT_STATEMENTS.inboxDuplicates),
      sqls.indexOf(REPOINT_STATEMENTS.jobs),
      sqls.indexOf(REPOINT_STATEMENTS.inbox),
      sqls.indexOf(REPOINT_STATEMENTS.pendingIntents),
      sqls.indexOf(REPOINT_STATEMENTS.intents),
      sqls.indexOf(REPOINT_STATEMENTS.spooty),
      sqls.indexOf(REPOINT_STATEMENTS.logs),
      sqls.indexOf(REPOINT_STATEMENTS.remove),
    ];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order); // the delete is last, job_queue is moved before it

    // every move goes from the duplicate ($1) to the keeper ($2)
    for (const statement of [REPOINT_STATEMENTS.shares, REPOINT_STATEMENTS.jobs, REPOINT_STATEMENTS.inbox, REPOINT_STATEMENTS.intents, REPOINT_STATEMENTS.spooty, REPOINT_STATEMENTS.logs]) {
      expect(calls.find((c) => c.sql === statement)!.params).toEqual(['dup', 'keep']);
    }
    expect(calls.find((c) => c.sql === REPOINT_STATEMENTS.remove)!.params).toEqual(['dup']);

    const update = calls.find((c) => c.sql.startsWith('UPDATE entries'))!;
    expect(update.params[0]).toBe('keep');
    expect(JSON.parse(update.params[1] as string).songs.map((s: Song) => s.title)).toEqual(['A', 'C']);
    expect(JSON.parse(update.params[2] as string).map((l: { action: string }) => l.action)).toContain('merged_duplicate');
  });

  it('makes the plan again from the rows it just locked: the keeper follows the fresh data', async () => {
    // meanwhile `dup` got analysed and `keep` was emptied: the oldest entry with data is now `dup`
    const freshKeep = row('keep', { created_at: '2026-10-01T10:00:00Z', status: 'error', results: null });
    const { client, calls } = fakeClient({ rows: [freshKeep, dup] });
    expect(await applyGroup(client, plan, NOW)).toBe(true);
    expect(calls.find((c) => c.sql.startsWith('UPDATE entries'))!.params[0]).toBe('dup');
    expect(calls.find((c) => c.sql === REPOINT_STATEMENTS.remove)!.params).toEqual(['keep']);
  });

  it('skips the group, changing nothing, when a job is running', async () => {
    const { client, calls } = fakeClient({ rows: [keep, dup], processing: 1 });
    expect(await applyGroup(client, plan, NOW)).toBe(false);
    expect(calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql.startsWith('UPDATE entries') || c.sql === REPOINT_STATEMENTS.remove)).toBe(false);
  });

  it('skips the group when one of the rows is already gone', async () => {
    const { client, calls } = fakeClient({ rows: [keep] });
    expect(await applyGroup(client, plan, NOW)).toBe(false);
    expect(calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql === REPOINT_STATEMENTS.remove)).toBe(false);
  });

  it('rolls back and rethrows when a statement fails', async () => {
    const { client, calls } = fakeClient({ rows: [keep, dup], failOn: /DELETE FROM entries/ });
    await expect(applyGroup(client, plan, NOW)).rejects.toThrow('boom');
    expect(calls.map((c) => c.sql).at(-1)).toBe('ROLLBACK');
    expect(calls.some((c) => c.sql === 'COMMIT')).toBe(false);
  });

  it('moves the references of every duplicate of a group of three', async () => {
    const dup2 = row('dup2', { created_at: '2026-10-03T10:00:00Z', source_url: IG('ABC123', '?utm_source=x') });
    const { client, calls } = fakeClient({ rows: [keep, dup, dup2] });
    await applyGroup(client, { ...plan, surplus: [dup, dup2] }, NOW);
    expect(calls.filter((c) => c.sql === REPOINT_STATEMENTS.remove).map((c) => c.params[0])).toEqual(['dup', 'dup2']);
    expect(calls.filter((c) => c.sql === REPOINT_STATEMENTS.jobs).map((c) => c.params)).toEqual([['dup', 'keep'], ['dup2', 'keep']]);
  });
});

describe('REPOINT_STATEMENTS', () => {
  it('covers every table that points at an entry, and no table of the files, playlists or library', () => {
    const all = Object.values(REPOINT_STATEMENTS).join('\n');
    for (const table of ['entry_shares', 'job_queue', 'inbox_items', 'share_intents', 'spooty_requests', 'logs']) expect(all).toContain(table);
    for (const table of ['song_files', 'playlists', 'playlist_songs', 'media_index', 'song_meta', 'play_events']) expect(all).not.toContain(table);
  });

  it('never deletes a job, and only deletes entry-bound rows of the duplicate', () => {
    expect(REPOINT_STATEMENTS.jobs).toMatch(/^UPDATE job_queue/);
    for (const s of Object.values(REPOINT_STATEMENTS)) {
      if (/^DELETE/.test(s.trim())) expect(s).toMatch(/entry_id = \$1|id = \$1/);
    }
  });
});

describe('parseArgs', () => {
  it('is a dry run unless --apply is given, and --dry-run always wins', () => {
    expect(parseArgs([])).toEqual({ apply: false, backup: null });
    expect(parseArgs(['--dry-run'])).toEqual({ apply: false, backup: null });
    expect(parseArgs(['--apply'])).toEqual({ apply: true, backup: null });
    expect(parseArgs(['--apply', '--dry-run'])).toEqual({ apply: false, backup: null });
  });
  it('reads the backup path and ignores a flag mistaken for it', () => {
    expect(parseArgs(['--apply', '--backup', '/tmp/m.jsonl'])).toEqual({ apply: true, backup: '/tmp/m.jsonl' });
    expect(parseArgs(['--backup', '--apply'])).toEqual({ apply: true, backup: null });
  });
});

describe('mergeDuplicateEntries', () => {
  const rows = [
    row('a1', { source_url: IG('AAA'), created_at: '2026-10-01T10:00:00Z', ...withResults({ songs: [song('A', 'B')] }) }),
    row('a2', { source_url: IG('AAA', '?igsh=1'), created_at: '2026-10-02T10:00:00Z' }),
    row('b1', { source_url: IG('BBB'), created_at: '2026-10-03T10:00:00Z', ...withResults({ songs: [song('C', 'D')] }) }),
    row('b2', { source_url: IG('BBB', '?igsh=1'), created_at: '2026-10-04T10:00:00Z' }),
    row('solo', { source_url: IG('SOLO') }),
  ];

  function deps(over: Partial<Deps> = {}) {
    const said: string[] = [];
    const order: string[] = [];
    const d: Deps = {
      rows: vi.fn(async () => rows),
      dependants: vi.fn(async () => new Map()),
      backup: vi.fn(async () => { order.push('backup'); }),
      apply: vi.fn(async (plan: GroupPlan) => { order.push(`apply:${plan.primary.id}`); return true; }),
      say: (line) => said.push(line),
      now: () => new Date('2026-11-09T09:00:00.000Z'),
      ...over,
    };
    return { d, said, order };
  }

  it('is a dry run by default: it shows the plan and changes nothing', async () => {
    const { d, said } = deps();
    const out = await mergeDuplicateEntries(d, { apply: false, backup: null });
    expect(out).toEqual({ groups: 2, merged: 0, skipped: 0, failed: 0 });
    expect(d.backup).not.toHaveBeenCalled();
    expect(d.apply).not.toHaveBeenCalled();
    expect(d.dependants).toHaveBeenCalledWith(['a2', 'b2']);
    expect(said.join('\n')).toContain('DRY RUN');
    expect(said.join('\n')).toContain('2 gruppi, 2 entry in piu');
  });

  it('writes the backup of every entry involved before the first merge', async () => {
    const { d, said, order } = deps();
    const out = await mergeDuplicateEntries(d, { apply: true, backup: null });
    expect(out).toEqual({ groups: 2, merged: 2, skipped: 0, failed: 0 });
    expect(order).toEqual(['backup', 'apply:a1', 'apply:b1']);
    const [path, ids] = vi.mocked(d.backup).mock.calls[0];
    expect(path).toMatch(/^\/tmp\/soundreel-merge-duplicates-2026-11-09T09-00-00-000Z\.jsonl$/); // never under /data/media
    expect(ids).toEqual(['a1', 'a2', 'b1', 'b2']);
    expect(said.join('\n')).toContain('copiala fuori dal container');
  });

  it('uses the backup path it is given', async () => {
    const { d } = deps();
    await mergeDuplicateEntries(d, { apply: true, backup: '/tmp/mio.jsonl' });
    expect(vi.mocked(d.backup).mock.calls[0][0]).toBe('/tmp/mio.jsonl');
  });

  it('counts a skipped group and goes on with the next; one that throws does not stop the others', async () => {
    const { d, said } = deps({
      apply: vi.fn(async (plan: GroupPlan) => {
        if (plan.primary.id === 'a1') return false;
        throw new Error('deadlock');
      }),
    });
    const out = await mergeDuplicateEntries(d, { apply: true, backup: null });
    expect(out).toEqual({ groups: 2, merged: 0, skipped: 1, failed: 1 });
    expect(said.join('\n')).toContain('SALTATA');
    expect(said.join('\n')).toContain('ERRORE b1');
    expect(said.join('\n')).toContain('deadlock');
  });

  it('does nothing, not even a backup, when there are no duplicates', async () => {
    const { d } = deps({ rows: vi.fn(async () => [rows[4]]) });
    const out = await mergeDuplicateEntries(d, { apply: true, backup: null });
    expect(out).toEqual({ groups: 0, merged: 0, skipped: 0, failed: 0 });
    expect(d.backup).not.toHaveBeenCalled();
    expect(d.dependants).not.toHaveBeenCalled();
  });
});
