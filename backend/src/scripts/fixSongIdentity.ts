/**
 * Corrects the identity of songs the analysis got wrong, entry by entry (asked for by the Mac-import agent on
 * 8 November: its CSV of songs that could not be matched to a file listed three that carried an Instagram handle as the
 * artist, "@massiveattackofficial" and "@cursesforever - Jennifer Cardini Remix", instead of the artist).
 *
 * A fix says "the song written like this is really that one":
 *   { "from": { "artist": "@massiveattackofficial", "title": "Mezzanine" },
 *     "to":   { "artist": "Massive Attack", "title": "Mezzanine", "album": "Mezzanine" } }
 * Every song of every entry whose song key (`songKey(artist, title)`) is the `from` key is rewritten: artist, title and,
 * when given, album; a SoundCloud or YouTube search link built from the wrong words is rebuilt from the right ones (a
 * link to a specific video is kept). Two songs of the same entry that become the same song are folded into one (the
 * first is completed with what the other knew, never overwritten). One `song_corrected` line goes in the action log.
 *
 * The song key is the key of playlists, `song_files`, `song_meta` and `play_events`: the run REPORTS how many rows hang
 * on each old key and refuses to apply a fix whose old key has playlist, file or play rows, because those would be
 * orphaned (move them first, deliberately). The empty enrichment rows (`song_meta`) of an old key are left alone: the new
 * key is enriched by the normal passes.
 *
 * DRY RUN unless `--apply` is given (`--dry-run` always wins). With `--apply` it writes a backup of every entry it will
 * change (JSON lines, 0600) and changes each entry in its own transaction, the row locked and read again inside it (the
 * software backfill writes `results.software` of the same rows).
 *
 * Usage:
 *   node dist/scripts/fixSongIdentity.js --file /tmp/fixes.json                 # what would change
 *   node dist/scripts/fixSongIdentity.js --file /tmp/fixes.json --apply [--backup /tmp/x.jsonl]
 */
import type { Pool, PoolClient } from 'pg';
import type { ActionLogItem, EntryResults, Song } from '../types';
import { generateSoundcloudSearchUrl, generateYoutubeSearchUrl } from '../services/spotify';
import { songKey } from '../services/songMeta';
import { foldSong } from './mergeDuplicateEntries';

export interface SongFix {
  from: { artist: string; title: string };
  to: { artist: string; title: string; album?: string | null };
}

export interface EntryRow {
  id: string;
  results: EntryResults | null;
  action_log: ActionLogItem[] | null;
}

const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;

/** Reads the JSON of the fixes and says what is wrong with it, by position. */
export function parseFixes(json: string): SongFix[] {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('fixes: not valid JSON');
  }
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('fixes: expected a non-empty array');
  return raw.map((entry, i) => {
    const f = entry as { from?: { artist?: unknown; title?: unknown }; to?: { artist?: unknown; title?: unknown; album?: unknown } };
    if (!f || typeof f !== 'object' || !f.from || !f.to) throw new Error(`fixes[${i}]: needs "from" and "to"`);
    if (typeof f.from.artist !== 'string' || !text(f.from.title)) throw new Error(`fixes[${i}].from: needs an artist (may be empty) and a title`);
    if (!text(f.to.artist) || !text(f.to.title)) throw new Error(`fixes[${i}].to: needs an artist and a title`);
    if (f.to.album !== undefined && f.to.album !== null && typeof f.to.album !== 'string') throw new Error(`fixes[${i}].to.album: must be a string or null`);
    if (songKey(f.from.artist, f.from.title) === songKey(f.to.artist, f.to.title) && f.to.album === undefined) {
      throw new Error(`fixes[${i}]: "from" and "to" are the same song`);
    }
    return {
      from: { artist: f.from.artist, title: f.from.title },
      to: { artist: f.to.artist.trim(), title: f.to.title.trim(), ...(f.to.album !== undefined ? { album: f.to.album as string | null } : {}) },
    };
  });
}

const SEARCH_LINK = /^https?:\/\/(?:www\.)?(?:soundcloud\.com\/search|youtube\.com\/results)/i;

function rewrite(song: Song, to: SongFix['to']): Song {
  const next: Song = { ...song, artist: to.artist, title: to.title };
  if (to.album !== undefined) next.album = to.album;
  // a search link was built from the old words; a link to a specific video or track is still that video or track
  if (typeof song.soundcloudUrl === 'string' && SEARCH_LINK.test(song.soundcloudUrl)) next.soundcloudUrl = generateSoundcloudSearchUrl(to.title, to.artist);
  if (typeof song.youtubeUrl === 'string' && SEARCH_LINK.test(song.youtubeUrl)) next.youtubeUrl = generateYoutubeSearchUrl(to.title, to.artist);
  return next;
}

export interface Change {
  from: string;
  to: string;
  /** How many songs of the entry were rewritten. */
  rewritten: number;
  /** Songs folded into another one because they became the same song. */
  folded: number;
}

export interface Corrected {
  results: EntryResults;
  actionLog: ActionLogItem[];
  changes: Change[];
}

/** The entry with the fixes applied, or null when none of its songs matches. Pure. */
export function correctEntry(row: EntryRow, fixes: SongFix[], now: Date): Corrected | null {
  const songs = Array.isArray(row.results?.songs) ? row.results!.songs : [];
  const byFrom = new Map(fixes.map((f) => [songKey(f.from.artist, f.from.title), f]));
  const counts = new Map<string, number>();
  const rewritten: Song[] = songs.map((s) => {
    const fix = byFrom.get(songKey(typeof s.artist === 'string' ? s.artist : '', typeof s.title === 'string' ? s.title : ''));
    if (!fix) return s;
    counts.set(songKey(fix.from.artist, fix.from.title), (counts.get(songKey(fix.from.artist, fix.from.title)) ?? 0) + 1);
    return rewrite(s, fix.to);
  });
  if (counts.size === 0) return null;

  // two songs that became the same song are one: the first is completed with what the other knew
  const out: Song[] = [];
  const index = new Map<string, number>();
  const folded = new Map<string, number>();
  for (const s of rewritten) {
    const k = songKey(s.artist ?? '', s.title);
    const at = index.get(k);
    if (at === undefined) {
      index.set(k, out.length);
      out.push(s);
    } else {
      out[at] = foldSong(out[at], s);
      folded.set(k, (folded.get(k) ?? 0) + 1);
    }
  }

  // two fixes can lead to the same song: the folding is told once, on the first of them
  const told = new Set<string>();
  const changes: Change[] = [...counts.entries()].map(([fromKey, n]) => {
    const fix = byFrom.get(fromKey)!;
    const toKey = songKey(fix.to.artist, fix.to.title);
    const foldedHere = told.has(toKey) ? 0 : folded.get(toKey) ?? 0;
    told.add(toKey);
    return { from: fromKey, to: toKey, rewritten: n, folded: foldedHere };
  });
  const results: EntryResults = { ...(row.results as EntryResults), songs: out };
  const log: ActionLogItem = {
    action: 'song_corrected',
    details: { changes, source: 'fixSongIdentity' },
    timestamp: now.toISOString(),
  };
  return { results, actionLog: [...(Array.isArray(row.action_log) ? row.action_log : []), log], changes };
}

/** What hangs on a song key outside the entries: playlists, files and plays make an old key unsafe to abandon. */
export interface KeyUsage {
  playlists: number;
  files: number;
  plays: number;
  meta: number;
}

export function refuses(usage: KeyUsage): boolean {
  return usage.playlists > 0 || usage.files > 0 || usage.plays > 0;
}

export interface Options {
  file: string | null;
  apply: boolean;
  backup: string | null;
}

export function parseArgs(argv: string[]): Options {
  const value = (flag: string): string | null => {
    const i = argv.indexOf(flag);
    const next = i >= 0 ? argv[i + 1] : undefined;
    return next && !next.startsWith('--') ? next : null;
  };
  return { file: value('--file'), apply: argv.includes('--apply') && !argv.includes('--dry-run'), backup: value('--backup') };
}

export interface Deps {
  readFile: (path: string) => Promise<string>;
  /** The entries that have a song with one of these (lowercase, trimmed) titles. */
  entries: (titles: string[]) => Promise<EntryRow[]>;
  usage: (keys: string[]) => Promise<Map<string, KeyUsage>>;
  backup: (path: string, ids: string[]) => Promise<void>;
  /** One entry: lock, read again, correct, write. Returns the changes made, or null when nothing matched any more. */
  apply: (entryId: string, fixes: SongFix[]) => Promise<Change[] | null>;
  say: (line: string) => void;
  now: () => Date;
}

export interface Outcome {
  entries: number;
  corrected: number;
  refused: number;
  failed: number;
}

export async function fixSongIdentity(deps: Deps, opts: Options): Promise<Outcome> {
  if (!opts.file) throw new Error('usage: fixSongIdentity --file <fixes.json> [--apply] [--backup <path>]');
  const fixes = parseFixes(await deps.readFile(opts.file));
  const keys = fixes.map((f) => songKey(f.from.artist, f.from.title));
  const usage = await deps.usage(keys);
  const blocked = new Set<string>();
  for (const key of keys) {
    const u = usage.get(key) ?? { playlists: 0, files: 0, plays: 0, meta: 0 };
    const unsafe = refuses(u);
    if (unsafe) blocked.add(key);
    deps.say(`  ${key}  [playlist ${u.playlists}, file ${u.files}, ascolti ${u.plays}, enrichment ${u.meta}]${unsafe ? '  RIFIUTATA: ha playlist, file o ascolti da spostare prima' : ''}`);
  }
  const usable = fixes.filter((f) => !blocked.has(songKey(f.from.artist, f.from.title)));

  const rows = usable.length ? await deps.entries([...new Set(usable.map((f) => f.from.title.trim().toLowerCase()))]) : [];
  const plans = rows
    .map((row) => ({ row, result: correctEntry(row, usable, deps.now()) }))
    .filter((p): p is { row: EntryRow; result: Corrected } => p.result !== null);
  deps.say(`[fix] ${fixes.length} correzioni, ${plans.length} entry da toccare, ${blocked.size} rifiutate`);
  for (const { row, result } of plans) {
    for (const c of result.changes) deps.say(`  ${row.id.slice(0, 8)}  ${c.from}  ->  ${c.to}  (${c.rewritten} canzone/i${c.folded ? `, ${c.folded} unita a un'altra uguale` : ''})`);
  }
  const base: Outcome = { entries: plans.length, corrected: 0, refused: blocked.size, failed: 0 };
  if (!opts.apply) {
    deps.say("[fix] DRY RUN: non e' cambiato niente (con --apply: copia di sicurezza, poi le correzioni)");
    return base;
  }
  if (plans.length === 0) return base;

  const backupPath = opts.backup ?? `/tmp/soundreel-fix-song-identity-${deps.now().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await deps.backup(backupPath, plans.map((p) => p.row.id));
  deps.say(`[fix] copia di sicurezza: ${backupPath}  (copiala fuori dal container)`);
  const out = { ...base };
  for (const { row } of plans) {
    try {
      const changes = await deps.apply(row.id, usable);
      if (changes) {
        out.corrected += 1;
        deps.say(`  corretta: ${row.id.slice(0, 8)}`);
      } else {
        deps.say(`  invariata (nel frattempo non c'era piu' niente da correggere): ${row.id.slice(0, 8)}`);
      }
    } catch (err) {
      out.failed += 1;
      deps.say(`  ERRORE ${row.id.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.say(`[fix] fatto: ${out.corrected} entry corrette, ${out.refused} rifiutate, ${out.failed} in errore`);
  return out;
}

type Queryable = Pick<PoolClient, 'query'>;

/** One entry in one transaction: the row is locked and read again, so a concurrent write to it is never lost. */
export async function applyEntry(client: Queryable, entryId: string, fixes: SongFix[], now: Date): Promise<Change[] | null> {
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<EntryRow>('SELECT id, results, action_log FROM entries WHERE id = $1 FOR UPDATE', [entryId]);
    const corrected = rows[0] ? correctEntry(rows[0], fixes, now) : null;
    if (!corrected) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE entries SET results = $2::jsonb, action_log = $3::jsonb WHERE id = $1', [
      entryId,
      JSON.stringify(corrected.results),
      JSON.stringify(corrected.actionLog),
    ]);
    await client.query('COMMIT');
    return corrected.changes;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main(): Promise<void> {
  const [{ pool }, fs, path] = await Promise.all([import('../utils/db'), import('node:fs/promises'), import('node:path')]);
  const db: Pick<Pool, 'query'> = pool;
  try {
    const outcome = await fixSongIdentity(
      {
        readFile: (file) => fs.readFile(file, 'utf8'),
        entries: async (titles) =>
          (
            await db.query<EntryRow>(
              `SELECT id, results, action_log FROM entries
                WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(results->'songs', '[]'::jsonb)) s
                               WHERE lower(trim(s->>'title')) = ANY($1::text[]))
                ORDER BY created_at`,
              [titles],
            )
          ).rows,
        usage: async (keys) => {
          const out = new Map<string, KeyUsage>(keys.map((k) => [k, { playlists: 0, files: 0, plays: 0, meta: 0 }]));
          const count = async (sql: string, field: keyof KeyUsage): Promise<void> => {
            const { rows } = await db.query<{ song_key: string; n: string }>(sql, [keys]);
            for (const r of rows) {
              const u = out.get(r.song_key);
              if (u) u[field] = Number(r.n);
            }
          };
          await count('SELECT song_key, count(*) AS n FROM playlist_songs WHERE song_key = ANY($1::text[]) GROUP BY song_key', 'playlists');
          await count('SELECT song_key, count(*) AS n FROM song_files WHERE song_key = ANY($1::text[]) GROUP BY song_key', 'files');
          await count('SELECT song_key, count(*) AS n FROM play_events WHERE song_key = ANY($1::text[]) GROUP BY song_key', 'plays');
          await count('SELECT song_key, count(*) AS n FROM song_meta WHERE song_key = ANY($1::text[]) GROUP BY song_key', 'meta');
          return out;
        },
        backup: async (file, ids) => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          const { rows } = await db.query('SELECT * FROM entries WHERE id = ANY($1::text[])', [ids]);
          await fs.writeFile(file, `${rows.map((row) => JSON.stringify({ table: 'entries', row })).join('\n')}\n`, { mode: 0o600 });
        },
        apply: async (entryId, fixes) => {
          const client = await pool.connect();
          try {
            return await applyEntry(client, entryId, fixes, new Date());
          } finally {
            client.release();
          }
        },
        say: (line) => console.log(line),
        now: () => new Date(),
      },
      parseArgs(process.argv.slice(2)),
    );
    if (outcome.failed > 0) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[fix] errore fatale', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
