import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** A fake of the four statements the service uses, so the rules are tested without a database (the real one has its own test: uiPrefs.int.test.ts). */
const db = vi.hoisted(() => ({
  rows: new Map<string, unknown>(),
  log: [] as string[],
}));

vi.mock('../utils/db', () => {
  const run = async (text: string, params: unknown[] = []): Promise<{ rows: unknown[] }> => {
    const sql = text.replace(/\s+/g, ' ').trim();
    db.log.push(sql);
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return { rows: [] };
    if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
    if (sql.startsWith('SELECT prefs FROM user_prefs WHERE user_id = $1')) {
      const id = String(params[0]);
      return { rows: db.rows.has(id) ? [{ prefs: db.rows.get(id) }] : [] };
    }
    if (sql.startsWith('INSERT INTO user_prefs')) {
      db.rows.set(String(params[0]), JSON.parse(String(params[1])));
      return { rows: [] };
    }
    if (sql.startsWith('DELETE FROM user_prefs WHERE user_id = $1')) {
      db.rows.delete(String(params[0]));
      return { rows: [] };
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
  return {
    query: async (text: string, params?: unknown[]) => (await run(text, params)).rows,
    withClient: async (fn: (client: { query: typeof run }) => Promise<unknown>) => fn({ query: run }),
  };
});

import {
  DOCKS,
  SECTION_IDS,
  UI_PREFS_MAX_BYTES,
  defaultUiPrefs,
  getUiPrefs,
  mergeUiPrefs,
  mergeUiPrefsPatches,
  parseUiPrefsPatch,
  resetUiPrefs,
  sanitizeStoredUiPrefs,
  saveUiPrefs,
  type UiPrefsPatch,
} from './uiPrefs';

const ORDER = ['resume', 'songs', 'playlists', 'collections', 'films'] as const;
const sections = (order: readonly string[] = ORDER, hidden: string[] = []) => order.map((id) => ({ id, visible: !hidden.includes(id) }));

beforeEach(() => {
  db.rows.clear();
  db.log.length = 0;
});

describe('the defaults (Michele: «di default vista A»)', () => {
  it('every page opens in Studio, the Player is at the bottom, the five sections are visible in order', () => {
    expect(defaultUiPrefs()).toEqual({
      v: 1,
      views: { inbox: 'studio', links: 'studio' },
      home: { sections: sections() },
      player: { dock: 'bottom', float: { x: 1, y: 1 } },
    });
  });

  it('the lists the rules are made of are the ones of the plan', () => {
    expect([...SECTION_IDS]).toEqual([...ORDER]);
    expect([...DOCKS]).toEqual(['bottom', 'float', 'side', 'hidden']);
    expect(UI_PREFS_MAX_BYTES).toBe(4096);
  });

  it('every call hands out its own copy: changing one never changes the next', () => {
    const a = defaultUiPrefs();
    a.views.inbox = 'wall';
    a.home.sections[0].visible = false;
    a.player.float.x = 0;
    expect(defaultUiPrefs()).toEqual(defaultUiPrefs());
    expect(defaultUiPrefs().views.inbox).toBe('studio');
    expect(defaultUiPrefs().home.sections[0].visible).toBe(true);
    expect(defaultUiPrefs().player.float.x).toBe(1);
  });
});

describe('parseUiPrefsPatch: what is accepted', () => {
  it('nothing at all is a patch that changes nothing', () => {
    expect(parseUiPrefsPatch({})).toEqual({ ok: true, patch: {} });
    expect(parseUiPrefsPatch({ views: {}, home: {}, player: {} })).toEqual({ ok: true, patch: { views: {}, home: {}, player: {} } });
  });

  it('the complete document the server answers can be sent back as it is', () => {
    const whole = defaultUiPrefs();
    expect(parseUiPrefsPatch(whole)).toEqual({ ok: true, patch: whole });
  });

  it('a patch of each part', () => {
    expect(parseUiPrefsPatch({ views: { inbox: 'wall' } })).toEqual({ ok: true, patch: { views: { inbox: 'wall' } } });
    expect(parseUiPrefsPatch({ views: { inbox: 'home', links: 'wall' } })).toEqual({ ok: true, patch: { views: { inbox: 'home', links: 'wall' } } });
    expect(parseUiPrefsPatch({ player: { dock: 'side' } })).toEqual({ ok: true, patch: { player: { dock: 'side' } } });
    expect(parseUiPrefsPatch({ player: { float: { x: 0.25 } } })).toEqual({ ok: true, patch: { player: { float: { x: 0.25 } } } });
    const order = ['films', 'resume', 'songs', 'collections', 'playlists'];
    expect(parseUiPrefsPatch({ home: { sections: sections(order, ['songs']) } })).toEqual({ ok: true, patch: { home: { sections: sections(order, ['songs']) } } });
  });

  it('the limits of the floating Player are inside the range: 0 and 1', () => {
    expect(parseUiPrefsPatch({ player: { float: { x: 0, y: 1 } } })).toEqual({ ok: true, patch: { player: { float: { x: 0, y: 1 } } } });
  });

  it('every view allowed for a page, and no other', () => {
    for (const v of ['studio', 'wall', 'home']) expect(parseUiPrefsPatch({ views: { inbox: v } }).ok, `inbox ${v}`).toBe(true);
    for (const v of ['studio', 'wall']) expect(parseUiPrefsPatch({ views: { links: v } }).ok, `links ${v}`).toBe(true);
  });

  it('every dock', () => {
    for (const dock of ['bottom', 'float', 'side', 'hidden']) expect(parseUiPrefsPatch({ player: { dock } }).ok, dock).toBe(true);
  });

  it('answers a copy: what the caller sent is not changed and not kept', () => {
    const raw = { views: { inbox: 'wall' } };
    const out = parseUiPrefsPatch(raw);
    if (!out.ok) throw new Error('x');
    out.patch.views!.inbox = 'studio';
    expect(raw.views.inbox).toBe('wall');
  });
});

describe('parseUiPrefsPatch: what is refused, and the key that says why', () => {
  const BAD: Array<[string, unknown, string]> = [
    ['an unknown top-level key', { colour: 'red' }, 'invalid_prefs:colour'],
    ['a user in the body (the user is never read from there)', { user_id: 'sara' }, 'invalid_prefs:user_id'],
    ['a version that is not 1', { v: 2 }, 'invalid_prefs:v'],
    ['views that is not an object', { views: 'studio' }, 'invalid_prefs:views'],
    ['views that is a list', { views: ['studio'] }, 'invalid_prefs:views'],
    ['a page that has no views', { views: { songs: 'studio' } }, 'invalid_prefs:views.songs'],
    ['«home» as the view of the Link page', { views: { links: 'home' } }, 'invalid_prefs:views.links'],
    ['a view that does not exist', { views: { inbox: 'grid' } }, 'invalid_prefs:views.inbox'],
    ['a view that is not a string', { views: { inbox: 3 } }, 'invalid_prefs:views.inbox'],
    ['home that is not an object', { home: [] }, 'invalid_prefs:home'],
    ['an unknown key in home', { home: { shelves: [] } }, 'invalid_prefs:home.shelves'],
    ['sections that is not a list', { home: { sections: 'all' } }, 'invalid_prefs:home.sections'],
    ['a section list with one missing', { home: { sections: sections().slice(0, 4) } }, 'invalid_prefs:home.sections'],
    ['an empty section list', { home: { sections: [] } }, 'invalid_prefs:home.sections'],
    ['a section list with one too many', { home: { sections: [...sections(), { id: 'resume', visible: true }] } }, 'invalid_prefs:home.sections'],
    ['a section twice (so another one is missing)', { home: { sections: [...sections().slice(0, 4), { id: 'resume', visible: true }] } }, 'invalid_prefs:home.sections.4.id'],
    ['a section that does not exist', { home: { sections: [...sections().slice(0, 4), { id: 'radio', visible: true }] } }, 'invalid_prefs:home.sections.4.id'],
    ['a section whose visible is not a boolean', { home: { sections: sections().map((s, i) => (i === 2 ? { ...s, visible: 'yes' } : s)) } }, 'invalid_prefs:home.sections.2.visible'],
    ['a section with no visible', { home: { sections: sections().map((s, i) => (i === 0 ? { id: s.id } : s)) } }, 'invalid_prefs:home.sections.0.visible'],
    ['a section that is not an object', { home: { sections: [...sections().slice(0, 4), 'films'] } }, 'invalid_prefs:home.sections.4'],
    ['an unknown key inside a section', { home: { sections: sections().map((s, i) => (i === 1 ? { ...s, colour: 'red' } : s)) } }, 'invalid_prefs:home.sections.1.colour'],
    ['player that is not an object', { player: 'bottom' }, 'invalid_prefs:player'],
    ['an unknown key in player', { player: { size: 'big' } }, 'invalid_prefs:player.size'],
    ['a dock that does not exist', { player: { dock: 'top' } }, 'invalid_prefs:player.dock'],
    ['a dock that is not a string', { player: { dock: 1 } }, 'invalid_prefs:player.dock'],
    ['float that is not an object', { player: { float: 0.5 } }, 'invalid_prefs:player.float'],
    ['an unknown key in float', { player: { float: { z: 1 } } }, 'invalid_prefs:player.float.z'],
    ['a float x below 0', { player: { float: { x: -0.1 } } }, 'invalid_prefs:player.float.x'],
    ['a float y above 1', { player: { float: { y: 1.01 } } }, 'invalid_prefs:player.float.y'],
    ['a float that is a string', { player: { float: { x: '0.5' } } }, 'invalid_prefs:player.float.x'],
    ['a float that is not a number at all', { player: { float: { x: Number.NaN } } }, 'invalid_prefs:player.float.x'],
    ['a float that is infinite', { player: { float: { y: Number.POSITIVE_INFINITY } } }, 'invalid_prefs:player.float.y'],
  ];

  it.each(BAD)('%s', (_name, raw, error) => {
    expect(parseUiPrefsPatch(raw)).toEqual({ ok: false, error });
  });

  it.each([[null], [undefined], [[]], ['views'], [3], [true]])('a body that is not an object (%j)', (raw) => {
    expect(parseUiPrefsPatch(raw)).toEqual({ ok: false, error: 'invalid_prefs:body' });
  });

  it('a document of more than 4096 bytes, counted in bytes and not in characters, and the boundary is exact', () => {
    const doc = (n: number, ch = 'x') => ({ p: ch.repeat(n) }); // {"p":""} is 8 characters
    expect(JSON.stringify(doc(4088)).length).toBe(4096);
    expect(parseUiPrefsPatch(doc(4088))).toEqual({ ok: false, error: 'invalid_prefs:p' }); // 4096 bytes: not too big (it is the unknown key that is wrong)
    expect(parseUiPrefsPatch(doc(4089))).toEqual({ ok: false, error: 'invalid_prefs:size' }); // 4097
    expect(JSON.stringify(doc(2049, 'é')).length).toBeLessThan(4096); // fewer than 4096 characters …
    expect(parseUiPrefsPatch(doc(2049, 'é'))).toEqual({ ok: false, error: 'invalid_prefs:size' }); // … but more than 4096 bytes
  });

  it('the size is looked at before anything else: a huge body is "size", not an unknown key', () => {
    expect(parseUiPrefsPatch({ views: { inbox: 'grid' }, filler: 'x'.repeat(5000) })).toEqual({ ok: false, error: 'invalid_prefs:size' });
  });

  it('an unknown key is named before a bad value elsewhere (a fixed order, so the answer is the same every time)', () => {
    expect(parseUiPrefsPatch({ views: { inbox: 'grid' }, colour: 'red' })).toEqual({ ok: false, error: 'invalid_prefs:colour' });
  });

  it('a body that cannot even be written as JSON is a refused body, never a crash', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(parseUiPrefsPatch(loop)).toEqual({ ok: false, error: 'invalid_prefs:body' });
    expect(parseUiPrefsPatch({ views: { inbox: BigInt(10) } })).toEqual({ ok: false, error: 'invalid_prefs:body' });
  });
});

describe('mergeUiPrefs: a patch over a complete document', () => {
  it('the views merge page by page; the others stay', () => {
    const out = mergeUiPrefs(defaultUiPrefs(), { views: { links: 'wall' } });
    expect(out.views).toEqual({ inbox: 'studio', links: 'wall' });
  });

  it('the sections are replaced as a whole, with their order and their switches', () => {
    const order = ['films', 'resume', 'songs', 'collections', 'playlists'];
    const out = mergeUiPrefs(defaultUiPrefs(), { home: { sections: sections(order, ['songs']) } });
    expect(out.home.sections.map((s) => s.id)).toEqual(order);
    expect(out.home.sections.find((s) => s.id === 'songs')?.visible).toBe(false);
  });

  it('the dock is replaced, the position merges coordinate by coordinate', () => {
    const a = mergeUiPrefs(defaultUiPrefs(), { player: { dock: 'float', float: { x: 0.2 } } });
    expect(a.player).toEqual({ dock: 'float', float: { x: 0.2, y: 1 } });
    const b = mergeUiPrefs(a, { player: { float: { y: 0.4 } } });
    expect(b.player).toEqual({ dock: 'float', float: { x: 0.2, y: 0.4 } });
  });

  it('what is merged is the BASE it is given, not the defaults: a base that already has choices keeps the ones the patch does not name', () => {
    const chosen = { ...defaultUiPrefs(), views: { inbox: 'wall' as const, links: 'wall' as const }, player: { dock: 'side' as const, float: { x: 0.1, y: 0.2 } } };
    const out = mergeUiPrefs(chosen, { views: { inbox: 'home' } });
    expect(out.views).toEqual({ inbox: 'home', links: 'wall' });
    expect(out.player).toEqual({ dock: 'side', float: { x: 0.1, y: 0.2 } });
    const kept = mergeUiPrefs({ ...chosen, home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists']) } }, { views: { links: 'studio' } });
    expect(kept.home.sections.map((s) => s.id)).toEqual(['films', 'resume', 'songs', 'collections', 'playlists']);
  });

  it('what the patch does not name is not touched, and the base is not changed', () => {
    const base = defaultUiPrefs();
    const snapshot = JSON.stringify(base);
    const out = mergeUiPrefs(base, { views: { inbox: 'wall' } });
    expect(JSON.stringify(base)).toBe(snapshot);
    expect(out.player).toEqual(base.player);
    expect(out.home).toEqual(base.home);
    expect(out.v).toBe(1);
  });

  it('an empty patch gives back an equal document', () => {
    expect(mergeUiPrefs(defaultUiPrefs(), {})).toEqual(defaultUiPrefs());
  });
});

describe('mergeUiPrefsPatches: what the user chose, kept sparse', () => {
  it('two patches add up, the later one wins on the same key', () => {
    const a: UiPrefsPatch = { views: { inbox: 'wall' }, player: { dock: 'side' } };
    const b: UiPrefsPatch = { views: { links: 'wall' }, player: { float: { x: 0.5 } } };
    expect(mergeUiPrefsPatches(a, b)).toEqual({ views: { inbox: 'wall', links: 'wall' }, player: { dock: 'side', float: { x: 0.5 } } });
    expect(mergeUiPrefsPatches(a, { views: { inbox: 'home' } }).views).toEqual({ inbox: 'home' });
  });

  it('nothing is invented: a part nobody touched is not there', () => {
    expect(mergeUiPrefsPatches({}, { views: { inbox: 'wall' } })).toEqual({ views: { inbox: 'wall' } });
    expect(mergeUiPrefsPatches({}, {})).toEqual({});
  });

  it('the position of the floating Player merges axis by axis across two patches, and the dock of the earlier one stays', () => {
    const merged = mergeUiPrefsPatches({ player: { dock: 'float', float: { x: 0.1 } } }, { player: { float: { y: 0.2 } } });
    expect(merged).toEqual({ player: { dock: 'float', float: { x: 0.1, y: 0.2 } } });
    expect(mergeUiPrefsPatches({ player: { float: { x: 0.1, y: 0.1 } } }, { player: { float: { x: 0.9 } } }).player?.float).toEqual({ x: 0.9, y: 0.1 });
  });

  it('a later patch that does not mention the sections leaves the earlier ones alone', () => {
    const earlier: UiPrefsPatch = { home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists'], ['songs']) } };
    expect(mergeUiPrefsPatches(earlier, { views: { inbox: 'wall' } }).home).toEqual(earlier.home);
    expect(mergeUiPrefsPatches(earlier, { home: {} }).home).toEqual(earlier.home);
  });

  it('the sections replace as a whole here too', () => {
    const merged = mergeUiPrefsPatches({ home: { sections: sections() } }, { home: { sections: sections(['films', 'songs', 'resume', 'collections', 'playlists']) } });
    expect(merged.home?.sections.map((s) => s.id)).toEqual(['films', 'songs', 'resume', 'collections', 'playlists']);
  });
});

describe('sanitizeStoredUiPrefs: what the database holds may be old or damaged', () => {
  it('keeps what is valid, key by key, and drops the rest without a word', () => {
    const stored = {
      v: 1,
      views: { inbox: 'grid', links: 'wall', songs: 'studio' },
      home: { sections: [{ id: 'resume', visible: true }] },
      player: { dock: 'top', float: { x: 2, y: 0.5 } },
      colour: 'red',
    };
    expect(sanitizeStoredUiPrefs(stored)).toEqual({ views: { links: 'wall' }, player: { float: { y: 0.5 } } });
  });

  it('a stored section list that is no longer a permutation of the five is dropped whole', () => {
    expect(sanitizeStoredUiPrefs({ home: { sections: sections().slice(0, 4) } })).toEqual({});
    expect(sanitizeStoredUiPrefs({ home: { sections: [...sections().slice(0, 4), { id: 'radio', visible: true }] } })).toEqual({});
  });

  it('a good stored section list is kept', () => {
    expect(sanitizeStoredUiPrefs({ home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists'], ['films']) } })).toEqual({
      home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists'], ['films']) },
    });
  });

  it('anything that is not an object, and a null, is nothing', () => {
    for (const junk of [null, undefined, 3, 'x', [], true]) expect(sanitizeStoredUiPrefs(junk)).toEqual({});
    expect(sanitizeStoredUiPrefs({ views: 'studio', home: 3, player: [] })).toEqual({});
  });
});

describe('getUiPrefs', () => {
  it('a user who never chose anything gets the defaults', async () => {
    expect(await getUiPrefs('mike')).toEqual(defaultUiPrefs());
  });

  it('what the user chose is put over the defaults: the complete document comes back', async () => {
    db.rows.set('mike', { views: { inbox: 'wall' }, player: { dock: 'hidden' } });
    const prefs = await getUiPrefs('mike');
    expect(prefs.views).toEqual({ inbox: 'wall', links: 'studio' });
    expect(prefs.player).toEqual({ dock: 'hidden', float: { x: 1, y: 1 } });
    expect(prefs.home).toEqual(defaultUiPrefs().home);
    expect(prefs.v).toBe(1);
  });

  it('a stored value the code does not know falls back to the default of THAT key, and never throws', async () => {
    db.rows.set('mike', { views: { inbox: 'grid', links: 'wall' }, player: { dock: 'top' }, v: 7, extra: 1 });
    const prefs = await getUiPrefs('mike');
    expect(prefs.views).toEqual({ inbox: 'studio', links: 'wall' });
    expect(prefs.player.dock).toBe('bottom');
    expect(prefs).not.toHaveProperty('extra');
  });

  it('a stored document that is not even an object gives the defaults', async () => {
    db.rows.set('mike', 'broken');
    expect(await getUiPrefs('mike')).toEqual(defaultUiPrefs());
  });

  it('asks the database for THAT user only', async () => {
    await getUiPrefs('sara');
    expect(db.log).toEqual(['SELECT prefs FROM user_prefs WHERE user_id = $1']);
  });
});

describe('saveUiPrefs', () => {
  it('answers the COMPLETE document, with the patch in it', async () => {
    const prefs = await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(prefs).toEqual({ ...defaultUiPrefs(), views: { inbox: 'wall', links: 'studio' } });
  });

  it('keeps only what the user chose (so a default can change in one place), not the whole document', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(db.rows.get('mike')).toEqual({ views: { inbox: 'wall' } });
  });

  it('two saves add up: the second one does not erase the first', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    const prefs = await saveUiPrefs('mike', { player: { dock: 'side' } });
    expect(prefs.views.inbox).toBe('wall');
    expect(prefs.player.dock).toBe('side');
    expect(db.rows.get('mike')).toEqual({ views: { inbox: 'wall' }, player: { dock: 'side' } });
  });

  it('a later save that does not mention the sections keeps the order the user chose', async () => {
    const order = ['films', 'resume', 'songs', 'collections', 'playlists'];
    await saveUiPrefs('mike', { home: { sections: sections(order, ['songs']) } });
    const prefs = await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(prefs.home.sections).toEqual(sections(order, ['songs']));
    expect(db.rows.get('mike')).toEqual({ home: { sections: sections(order, ['songs']) }, views: { inbox: 'wall' } });
  });

  it('the same key chosen again is replaced', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect((await saveUiPrefs('mike', { views: { inbox: 'home' } })).views.inbox).toBe('home');
  });

  it('one user\'s save never changes another\'s', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' }, player: { dock: 'side' } });
    await saveUiPrefs('sara', { views: { links: 'wall' } });
    expect(await getUiPrefs('mike')).toMatchObject({ views: { inbox: 'wall', links: 'studio' }, player: { dock: 'side' } });
    expect(await getUiPrefs('sara')).toMatchObject({ views: { inbox: 'studio', links: 'wall' }, player: { dock: 'bottom' } });
    expect(await getUiPrefs('archi')).toEqual(defaultUiPrefs());
  });

  it('works inside a transaction that is closed, and the writes of one user are serialised (advisory lock)', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(db.log[0]).toBe('BEGIN');
    expect(db.log[1]).toContain('pg_advisory_xact_lock');
    expect(db.log[db.log.length - 1]).toBe('COMMIT');
    expect(db.log.some((s) => s.startsWith('SELECT prefs FROM user_prefs'))).toBe(true);
    expect(db.log.some((s) => s.startsWith('INSERT INTO user_prefs'))).toBe(true);
  });

  it('a stored value that is damaged is not carried into the new document', async () => {
    db.rows.set('mike', { views: { inbox: 'grid', links: 'wall' } });
    await saveUiPrefs('mike', { player: { dock: 'side' } });
    expect(db.rows.get('mike')).toEqual({ views: { links: 'wall' }, player: { dock: 'side' } });
  });
});

describe('resetUiPrefs', () => {
  it('takes the choices away and says the defaults', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(await resetUiPrefs('mike')).toEqual(defaultUiPrefs());
    expect(db.rows.has('mike')).toBe(false);
    expect(await getUiPrefs('mike')).toEqual(defaultUiPrefs());
  });

  it('touches only that user', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    await saveUiPrefs('sara', { views: { inbox: 'home' } });
    await resetUiPrefs('mike');
    expect((await getUiPrefs('sara')).views.inbox).toBe('home');
  });

  it('a user with nothing to reset is no problem', async () => {
    expect(await resetUiPrefs('archi')).toEqual(defaultUiPrefs());
  });
});

describe('the table: init.sql and the migration say the same thing', () => {
  const block = (sql: string): string => {
    const m = /CREATE TABLE IF NOT EXISTS user_prefs \(([\s\S]*?)\n\);/.exec(sql);
    if (!m) throw new Error('no CREATE TABLE IF NOT EXISTS user_prefs in the file');
    return m[1].replace(/\s+/g, ' ').trim();
  };
  const dir = path.resolve(__dirname, '../db');

  it('the migration is idempotent and makes the table the code reads', () => {
    const migration = fs.readFileSync(path.join(dir, 'migrations/023_user_prefs.sql'), 'utf8');
    expect(block(migration)).toBe("user_id TEXT PRIMARY KEY, prefs JSONB NOT NULL DEFAULT '{}'::jsonb, updated_at TIMESTAMPTZ NOT NULL DEFAULT now()");
  });

  it('a fresh database (init.sql) gets the same table as a migrated one', () => {
    const init = fs.readFileSync(path.join(dir, 'init.sql'), 'utf8');
    const migration = fs.readFileSync(path.join(dir, 'migrations/023_user_prefs.sql'), 'utf8');
    expect(block(init)).toBe(block(migration));
  });
});
