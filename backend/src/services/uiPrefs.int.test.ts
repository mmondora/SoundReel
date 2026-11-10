/**
 * The configuration of the site against a REAL Postgres (ADR-0026). Skipped unless `PREFS_INT=1`: it needs a throw-away database that already
 * has `init.sql` and the migrations applied, and the usual `DB_*` variables pointing at it (never production):
 *
 *   PREFS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=prefs_check DB_USER=postgres DB_PASSWORD=… npx vitest run --no-file-parallelism src/services/uiPrefs.int.test.ts
 *
 * What the unit tests cannot see: the migration applied twice, the upsert, the sparse document that really sits in the jsonb column, the
 * advisory lock that keeps two devices from erasing each other, the rollback of a failed save, and a damaged row that is read back.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { pool } from '../utils/db';
import { defaultUiPrefs, getUiPrefs, resetUiPrefs, saveUiPrefs } from './uiPrefs';

const on = process.env.PREFS_INT === '1';
const d = on ? describe : describe.skip;

const sections = (order: string[]) => order.map((id) => ({ id: id as 'resume', visible: true }));

d('the configuration of the site on a real database', () => {
  beforeEach(async () => {
    await pool.query('DELETE FROM user_prefs');
  });

  afterAll(async () => {
    await pool.end();
  });

  const raw = async (user: string) => (await pool.query('SELECT prefs, updated_at FROM user_prefs WHERE user_id = $1', [user])).rows[0] as { prefs: unknown; updated_at: Date } | undefined;

  it('the migration, on its own in an empty schema, can be applied again and again and makes the table the code expects', async () => {
    const sql = fs.readFileSync(path.resolve(__dirname, '../db/migrations/023_user_prefs.sql'), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('DROP SCHEMA IF EXISTS mig_check CASCADE');
      await client.query('CREATE SCHEMA mig_check');
      await client.query('SET search_path TO mig_check');
      await client.query(sql);
      await client.query(sql);
      const cols = (
        await client.query(
          `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema = 'mig_check' AND table_name = 'user_prefs' ORDER BY column_name`,
        )
      ).rows;
      expect(cols.map((c) => [c.column_name, c.data_type, c.is_nullable])).toEqual([
        ['prefs', 'jsonb', 'NO'],
        ['updated_at', 'timestamp with time zone', 'NO'],
        ['user_id', 'text', 'NO'],
      ]);
      expect(cols.find((c) => c.column_name === 'prefs')?.column_default).toContain("'{}'::jsonb");
      expect(cols.find((c) => c.column_name === 'updated_at')?.column_default).toContain('now()');
      const pk = (await client.query(`SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) WHERE i.indrelid = 'mig_check.user_prefs'::regclass AND i.indisprimary`)).rows;
      expect(pk.map((r) => r.attname)).toEqual(['user_id']);
      await client.query(`INSERT INTO user_prefs (user_id) VALUES ('x')`);
      expect((await client.query(`SELECT prefs FROM user_prefs WHERE user_id = 'x'`)).rows[0].prefs).toEqual({});
      await expect(client.query(`INSERT INTO user_prefs (user_id) VALUES ('x')`)).rejects.toThrow(); // the user is the key: one row each
    } finally {
      await client.query('RESET search_path').catch(() => undefined);
      await client.query('DROP SCHEMA IF EXISTS mig_check CASCADE').catch(() => undefined);
      client.release();
    }
  });

  it('a row with nothing chosen reads as the defaults (the column default is an empty object)', async () => {
    await pool.query(`INSERT INTO user_prefs (user_id) VALUES ('mike')`);
    expect((await raw('mike'))?.prefs).toEqual({});
    expect(await getUiPrefs('mike')).toEqual(defaultUiPrefs());
  });

  it('upsert: the first save makes the row, the second changes it, and what sits in the column is only what was chosen', async () => {
    expect(await raw('mike')).toBeUndefined();
    const first = await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(first.views).toEqual({ inbox: 'wall', links: 'studio' });
    expect((await raw('mike'))?.prefs).toEqual({ views: { inbox: 'wall' } });
    const second = await saveUiPrefs('mike', { views: { inbox: 'home' } });
    expect(second.views.inbox).toBe('home');
    expect((await pool.query('SELECT count(*)::int AS n FROM user_prefs')).rows[0].n).toBe(1);
    expect((await raw('mike'))?.prefs).toEqual({ views: { inbox: 'home' } });
  });

  it('merge: two saves add up in the database, and the complete document comes back from the read', async () => {
    await saveUiPrefs('mike', { views: { links: 'wall' } });
    await saveUiPrefs('mike', { player: { dock: 'float', float: { x: 0.25 } } });
    await saveUiPrefs('mike', { player: { float: { y: 0.75 } }, home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists']) } });
    expect((await raw('mike'))?.prefs).toEqual({
      views: { links: 'wall' },
      home: { sections: sections(['films', 'resume', 'songs', 'collections', 'playlists']) },
      player: { dock: 'float', float: { x: 0.25, y: 0.75 } },
    });
    const prefs = await getUiPrefs('mike');
    expect(prefs.views).toEqual({ inbox: 'studio', links: 'wall' });
    expect(prefs.player).toEqual({ dock: 'float', float: { x: 0.25, y: 0.75 } });
    expect(prefs.home.sections.map((s) => s.id)).toEqual(['films', 'resume', 'songs', 'collections', 'playlists']);
  });

  it('reset: the row is gone and the user reads the defaults again', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect(await resetUiPrefs('mike')).toEqual(defaultUiPrefs());
    expect(await raw('mike')).toBeUndefined();
    expect(await getUiPrefs('mike')).toEqual(defaultUiPrefs());
  });

  it('two users: each reads and writes his own row, and a reset touches only its owner', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' }, player: { dock: 'side' } });
    await saveUiPrefs('sara', { views: { links: 'wall' } });
    expect((await getUiPrefs('mike')).views).toEqual({ inbox: 'wall', links: 'studio' });
    expect((await getUiPrefs('sara')).views).toEqual({ inbox: 'studio', links: 'wall' });
    expect((await getUiPrefs('sara')).player.dock).toBe('bottom');
    expect(await getUiPrefs('archi')).toEqual(defaultUiPrefs());
    await resetUiPrefs('sara');
    expect((await getUiPrefs('mike')).player.dock).toBe('side');
    expect((await pool.query('SELECT count(*)::int AS n FROM user_prefs')).rows[0].n).toBe(1);
  });

  it('two devices saving at the same moment do not erase each other (the advisory lock): six saves at once, ten times over', async () => {
    for (let round = 0; round < 10; round++) {
      await resetUiPrefs('mike');
      const order = ['collections', 'films', 'resume', 'playlists', 'songs'];
      await Promise.all([
        saveUiPrefs('mike', { views: { inbox: 'wall' } }),
        saveUiPrefs('mike', { views: { links: 'wall' } }),
        saveUiPrefs('mike', { player: { dock: 'float' } }),
        saveUiPrefs('mike', { player: { float: { x: 0.25 } } }),
        saveUiPrefs('mike', { player: { float: { y: 0.75 } } }),
        saveUiPrefs('mike', { home: { sections: sections(order) } }),
      ]);
      const prefs = await getUiPrefs('mike');
      expect(prefs.views, `round ${round}`).toEqual({ inbox: 'wall', links: 'wall' });
      expect(prefs.player, `round ${round}`).toEqual({ dock: 'float', float: { x: 0.25, y: 0.75 } });
      expect(prefs.home.sections.map((s) => s.id), `round ${round}`).toEqual(order);
    }
  });

  it('the date of the last change moves on every save', async () => {
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    const before = (await raw('mike'))!.updated_at.getTime();
    await new Promise((r) => setTimeout(r, 15));
    await saveUiPrefs('mike', { views: { inbox: 'home' } });
    expect((await raw('mike'))!.updated_at.getTime()).toBeGreaterThan(before);
  });

  it('a damaged row (old or hand-made) is read back with the defaults for what is wrong, and a save does not carry the damage on', async () => {
    await pool.query(`INSERT INTO user_prefs (user_id, prefs) VALUES ('mike', $1::jsonb)`, [
      JSON.stringify({ views: { inbox: 'grid', links: 'wall' }, player: { dock: 'top', float: { x: 3, y: 0.5 } }, home: { sections: [{ id: 'radio', visible: true }] }, colour: 'red' }),
    ]);
    const read = await getUiPrefs('mike');
    expect(read.views).toEqual({ inbox: 'studio', links: 'wall' });
    expect(read.player).toEqual({ dock: 'bottom', float: { x: 1, y: 0.5 } });
    expect(read.home).toEqual(defaultUiPrefs().home);
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect((await raw('mike'))?.prefs).toEqual({ views: { inbox: 'wall', links: 'wall' }, player: { float: { y: 0.5 } } });
  });

  it('a save that fails is rolled back and leaves nothing locked: the next save works', async () => {
    await expect(saveUiPrefs(null as unknown as string, { views: { inbox: 'wall' } })).rejects.toThrow();
    expect((await pool.query('SELECT count(*)::int AS n FROM user_prefs')).rows[0].n).toBe(0);
    await saveUiPrefs('mike', { views: { inbox: 'wall' } });
    expect((await getUiPrefs('mike')).views.inbox).toBe('wall');
    // no connection is left in a transaction
    const open = (await pool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND state LIKE 'idle in transaction%'`)).rows[0].n;
    expect(open).toBe(0);
  });
});
