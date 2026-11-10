/**
 * Le playlist automatiche che ci sono GIA' e non rispettano le due regole di Michele del 10 novembre (ADR-0024, spec
 * 2026-11-10-auto-playlists-and-playlist-list-design.md §1.2, §3.A.11 e §3.A.12):
 *
 *   «le playlist non possono essere di una sola canzone - vanno smontate, si chiamano "play list"»
 *   «"Soul da ascoltare" mi aspetto che sia una dinamica deve avere il tag soul la canzone. oppure tutto il soul deve conferire in quella play list.»
 *
 * Per ogni playlist AUTOMATICA statica (le fatte a mano non si toccano mai):
 *  - il suo tema nomina un genere (Soul, Jazz, Rock…) e la libreria ha almeno due brani con quel tag -> diventa DINAMICA (la regola del genere, i piu'
 *    recenti per primi) e i brani scelti dai post si tolgono: decide il tag. Se la playlist dinamica di quel genere c'e' gia' (Rap / Hip hop,
 *    R&B / Soul) questa si smonta e le sue voci vanno a quella;
 *  - il suo tema nomina un genere ma la libreria ha meno di due brani col tag -> si smonta; le sue voci ASPETTANO (la playlist nasce quando i brani sono due);
 *  - non nomina un genere e ha meno di due brani -> si smonta; le sue voci aspettano il secondo brano del tema;
 *  - altrimenti resta com'e'.
 * Smontare toglie la playlist E il suo tema dal registro (un tema senza playlist vorrebbe dire «cancellata dall'utente», e non si rifarebbe piu').
 *
 * ANTEPRIMA PER DEFAULT: senza `--apply` non scrive niente. Con `--apply` scrive, una transazione per playlist.
 *
 * Usage (dentro il container):
 *   node dist/scripts/repairAutoPlaylists.js            # anteprima
 *   node dist/scripts/repairAutoPlaylists.js --apply    # scrive davvero
 */
import { genreRule, genreThemeKey, genresOfThemeTitle } from '../services/genreThemes';
import type { DynamicRule } from '../services/dynamicRules';
import { MIN_PLAYLIST_SONGS } from '../services/autoPlaylists';

export interface AutoPlaylistRow {
  id: string;
  owner: string;
  /** The name now (the user may have renamed it). */
  name: string;
  autoKind: 'theme' | 'one_off';
  themeKey: string | null;
  /** The title the theme was made with (the registry keeps it), whatever the playlist is called now. */
  themeTitle: string | null;
  kind: 'static' | 'dynamic';
  songCount: number;
}

export type RepairAction =
  | { type: 'keep'; playlist: AutoPlaylistRow }
  | { type: 'to_dynamic'; playlist: AutoPlaylistRow; themeKey: string; genres: string[]; matching: number }
  | { type: 'merge'; playlist: AutoPlaylistRow; into: AutoPlaylistRow; themeKey: string }
  | { type: 'dismantle'; playlist: AutoPlaylistRow; waitKey: string | null; why: 'too_small' | 'genre_has_too_few'; matching: number | null };

export interface Options {
  apply: boolean;
}

export function parseArgs(argv: string[]): Options {
  return { apply: argv.includes('--apply') };
}

/** What to do with each automatic playlist. Reads the library (to count the songs of a genre), writes nothing. */
export async function planRepair(rows: AutoPlaylistRow[], countGenreSongs: (owner: string, genres: string[]) => Promise<number>): Promise<RepairAction[]> {
  const dynamicOf = new Map<string, AutoPlaylistRow>();
  for (const p of rows) if (p.kind === 'dynamic' && p.themeKey?.startsWith('genre:')) dynamicOf.set(`${p.owner}|${p.themeKey}`, p);

  const actions: RepairAction[] = [];
  for (const p of rows) {
    if (p.kind === 'dynamic') {
      actions.push({ type: 'keep', playlist: p });
      continue;
    }
    const genres = p.autoKind === 'theme' ? genresOfThemeTitle(p.themeTitle ?? p.name) : null;
    if (genres) {
      const key = genreThemeKey(genres);
      const existing = dynamicOf.get(`${p.owner}|${key}`);
      if (existing && existing.id !== p.id) {
        actions.push({ type: 'merge', playlist: p, into: existing, themeKey: key });
        continue;
      }
      const matching = await countGenreSongs(p.owner, genres);
      if (matching >= MIN_PLAYLIST_SONGS) {
        dynamicOf.set(`${p.owner}|${key}`, p);
        actions.push({ type: 'to_dynamic', playlist: p, themeKey: key, genres, matching });
      } else {
        actions.push({ type: 'dismantle', playlist: p, waitKey: key, why: 'genre_has_too_few', matching });
      }
      continue;
    }
    if (p.songCount < MIN_PLAYLIST_SONGS) {
      actions.push({ type: 'dismantle', playlist: p, waitKey: p.autoKind === 'theme' ? p.themeKey : null, why: 'too_small', matching: null });
    } else {
      actions.push({ type: 'keep', playlist: p });
    }
  }
  return actions;
}

export interface RepairDeps {
  /** Every automatic playlist (origin `auto`), oldest first. */
  listAuto(): Promise<AutoPlaylistRow[]>;
  countGenreSongs(owner: string, genres: string[]): Promise<number>;
  /** Static -> dynamic, in ONE transaction: the rule, the key of the genre, the songs of the posts out, the theme registry follows. */
  makeDynamic(playlist: AutoPlaylistRow, themeKey: string, rule: DynamicRule): Promise<void>;
  /**
   * Takes the playlist apart, in ONE transaction: its runs wait for the theme again (`waitKey`) or follow the playlist they merge into (`mergeInto`),
   * its theme leaves the registry (a theme without a playlist would mean «deleted by the user»), then the playlist goes.
   */
  dismantle(playlist: AutoPlaylistRow, how: { waitKey: string | null; mergeInto: string | null }): Promise<void>;
  say(line: string): void;
}

export interface RepairSummary {
  total: number;
  kept: number;
  toDynamic: number;
  merged: number;
  dismantled: number;
}

const brani = (n: number): string => `${n} ${n === 1 ? 'brano' : 'brani'}`;

export async function repairAutoPlaylists(deps: RepairDeps, opts: Options): Promise<RepairSummary> {
  const rows = await deps.listAuto();
  const actions = await planRepair(rows, deps.countGenreSongs);
  const summary: RepairSummary = { total: rows.length, kept: 0, toDynamic: 0, merged: 0, dismantled: 0 };
  deps.say(`[auto-playlists] RIPARA: ${rows.length} playlist automatiche | ${opts.apply ? 'SCRIVE (--apply)' : 'ANTEPRIMA (niente scritto)'}`);

  for (const a of actions) {
    const p = a.playlist;
    if (a.type === 'keep') {
      summary.kept++;
      continue;
    }
    if (a.type === 'to_dynamic') {
      summary.toDynamic++;
      deps.say(`  dinamica   «${p.name}»  ${brani(p.songCount)} dei post -> ${brani(a.matching)} col tag ${a.genres.join(' / ')}`);
      if (opts.apply) await deps.makeDynamic(p, a.themeKey, genreRule(a.genres));
    } else if (a.type === 'merge') {
      summary.merged++;
      deps.say(`  unita      «${p.name}»  (${brani(p.songCount)}) e' lo stesso genere di «${a.into.name}»: si smonta, le sue voci vanno a quella`);
      if (opts.apply) await deps.dismantle(p, { waitKey: null, mergeInto: a.into.id });
    } else {
      summary.dismantled++;
      const why = a.why === 'genre_has_too_few' ? `la libreria ha ${a.matching} ${a.matching === 1 ? 'brano' : 'brani'} col tag: ne servono ${MIN_PLAYLIST_SONGS}` : `ha ${brani(p.songCount)}: ne servono ${MIN_PLAYLIST_SONGS}`;
      deps.say(`  smontata   «${p.name}»  ${why}; le sue voci aspettano il secondo brano del tema`);
      if (opts.apply) await deps.dismantle(p, { waitKey: a.waitKey, mergeInto: null });
    }
  }
  deps.say(
    `[auto-playlists] ${opts.apply ? 'fatto' : 'da fare'}: ${summary.toDynamic} diventano dinamiche, ${summary.merged} unite, ${summary.dismantled} smontate, ${summary.kept} restano`,
  );
  return summary;
}

// ---------------------------------------------------------------------------
// The database
// ---------------------------------------------------------------------------

/** The bits of `pg` the Postgres deps need (so a test can hand it a real pool, and nothing else imports the database). */
export interface PgLike {
  query<T = unknown>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  connect(): Promise<{ query(sql: string, params?: unknown[]): Promise<unknown>; release(): void }>;
}

export function pgRepairDeps(db: PgLike, extra: Pick<RepairDeps, 'countGenreSongs' | 'say'>): RepairDeps {
  async function inTransaction(work: (q: (sql: string, params?: unknown[]) => Promise<unknown>) => Promise<void>): Promise<void> {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await work((sql, params) => client.query(sql, params));
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  return {
    ...extra,
    async listAuto() {
      const { rows } = await db.query<{
        id: string; owner_user: string; name: string; auto_kind: string | null; theme_key: string | null; kind: string; song_count: number; theme_title: string | null;
      }>(
        `SELECT p.id, p.owner_user, p.name, p.auto_kind, p.theme_key, p.kind,
                (SELECT count(*)::int FROM playlist_songs ps WHERE ps.playlist_id = p.id) AS song_count,
                t.title AS theme_title
           FROM playlists p
           LEFT JOIN auto_playlist_themes t ON t.owner_user = p.owner_user AND t.playlist_id = p.id
          WHERE p.origin = 'auto'
          ORDER BY p.created_at ASC, p.id ASC`,
      );
      return rows.map((r) => ({
        id: r.id,
        owner: r.owner_user,
        name: r.name,
        autoKind: r.auto_kind === 'theme' ? ('theme' as const) : ('one_off' as const),
        themeKey: r.theme_key,
        themeTitle: r.theme_title,
        kind: r.kind === 'dynamic' ? ('dynamic' as const) : ('static' as const),
        songCount: Number(r.song_count),
      }));
    },

    async makeDynamic(p, themeKey, rule) {
      await inTransaction(async (q) => {
        await q(`UPDATE playlists SET kind = 'dynamic', rule = $2::jsonb, theme_key = $3, updated_at = now() WHERE id = $1 AND origin = 'auto'`, [p.id, JSON.stringify(rule), themeKey]);
        await q(`DELETE FROM playlist_songs WHERE playlist_id = $1`, [p.id]);
        await q(`UPDATE auto_playlist_themes SET theme_key = $3 WHERE owner_user = $1 AND playlist_id = $2`, [p.owner, p.id, themeKey]);
      });
    },

    async dismantle(p, how) {
      await inTransaction(async (q) => {
        if (how.mergeInto) {
          await q(`UPDATE auto_playlist_runs SET playlist_id = $2 WHERE playlist_id = $1`, [p.id, how.mergeInto]);
        } else if (how.waitKey) {
          await q(
            `UPDATE auto_playlist_runs SET status = 'waiting', playlist_id = NULL, reason = 'needs_two_songs', theme_key = $2 WHERE playlist_id = $1 AND status = 'done'`,
            [p.id, how.waitKey],
          );
        } else {
          await q(`UPDATE auto_playlist_runs SET status = 'skipped', playlist_id = NULL, reason = 'dismantled_too_small' WHERE playlist_id = $1 AND status = 'done'`, [p.id]);
        }
        // the theme leaves the registry BEFORE the playlist goes: a theme left without a playlist would read as «deleted by the user»
        await q(`DELETE FROM auto_playlist_themes WHERE owner_user = $1 AND playlist_id = $2`, [p.owner, p.id]);
        await q(`DELETE FROM playlists WHERE id = $1 AND origin = 'auto'`, [p.id]);
      });
    },
  };
}

async function main(): Promise<void> {
  const [{ pool }, { countGenreSongs }] = await Promise.all([import('../utils/db'), import('../services/autoPlaylistWiring')]);
  const options = parseArgs(process.argv.slice(2));
  try {
    await repairAutoPlaylists(pgRepairDeps(pool as unknown as PgLike, { countGenreSongs, say: (line) => console.log(line) }), options);
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[auto-playlists] errore fatale', err);
    process.exit(1);
  });
}
