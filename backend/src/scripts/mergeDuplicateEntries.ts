/**
 * Merges the entries that are the same post saved more than once (spec 2026-11-08-no-duplicates-and-post-links, D2;
 * ADR-0017). Measured on 8 November on the real journal: 9 pairs, all Instagram, the same reel stored under different URL
 * forms (`?utm_source=…`, `?igsh=…`, `?img_index=3`) before the normalizer and the shortcode lookup existed.
 *
 * For each group (same owner, same `postKey`) it keeps the OLDEST entry that holds data (its id is the one a Telegram
 * reply, a share or a bookmark may already point to), folds the others into it and deletes them:
 *  - songs, films, notes, software, links and tags are united (`mergeEntryResults`, additive); when the same song, film
 *    or piece of software is on both, the keeper's copy is completed with what only the other knew (a Spotify link, a
 *    poster, `addedToPlaylist: true`): nothing the keeper has is overwritten, nothing the other found is lost;
 *  - the keeper's summary, transcript and enrichments stay; the other's only fill what is blank;
 *  - the two action logs are joined in time order, plus one `merged_duplicate` line per entry that went;
 *  - shares, jobs, inbox items, share intents, the Spooty request and the console logs move to the keeper (the only tables
 *    that point at an entry: `job_queue` has no cascade, so it must be moved before the delete);
 *  - MP3 files, playlists and the library are NEVER touched (spec D6). The files of the duplicate (`/media/<id>/…`:
 *    thumbnail, slide images) are not copied either: that folder is removed by the orphan cleanup after 7 days, so a
 *    keeper that has no thumbnail or slide images of its own keeps none, and slides taken from the other lose their image
 *    link (their OCR text and summary stay). The plan prints a warning for every group where that happens.
 *
 * It is a DRY RUN unless `--apply` is given. With `--apply` it writes a backup of every row it is about to change or
 * delete (JSON lines, 0600) and then merges each group in its own transaction: the rows are locked and read again inside
 * it (the re-analysis batch may be writing entries), and a group with a job running is skipped, not forced.
 *
 * The backup goes to `/tmp` by default, NOT under `/data/media`: that folder is served over HTTP at `/media` and every
 * folder in it that is not an entry id is deleted after 7 days. Copy it out of the container when the run is over
 * (`docker cp soundreel:/tmp/<file> ~/.local/share/soundreel/backups/`).
 *
 * Usage (inside the container):
 *   node dist/scripts/mergeDuplicateEntries.js                      # the plan, nothing changes (also with --dry-run)
 *   node dist/scripts/mergeDuplicateEntries.js --apply              # backup, then merge
 *   node dist/scripts/mergeDuplicateEntries.js --apply --backup /tmp/merge.jsonl
 */
import type { Pool, PoolClient } from 'pg';
import type { ActionLogItem, EntryResults, EntrySlide, Film, Song, SoftwareItem } from '../types';
import { filmTitleKey, mergeEntryResults, songKey } from '../services/entryMerge';
import { softwareKey } from '../services/softwareMeta';
import { postKey } from '../services/urlNormalize';

export interface EntryRow {
  id: string;
  owner_user: string;
  source_url: string;
  source_platform: string;
  status: string;
  created_at: Date | string;
  caption: string | null;
  thumbnail_url: string | null;
  results: EntryResults | null;
  action_log: ActionLogItem[] | null;
}

const COLUMNS = 'id, owner_user, source_url, source_platform, status, created_at, caption, thumbnail_url, results, action_log';

const asList = <T>(value: T[] | null | undefined): T[] => (Array.isArray(value) ? value : []);
const blank = (value: string | null | undefined): boolean => value == null || value.trim() === '';
const time = (row: Pick<EntryRow, 'created_at'>): number => new Date(row.created_at).getTime();
const keyOf = (row: EntryRow): string => `${row.owner_user}|${postKey(row.source_url)}`;

/** The groups of entries that are the same post of the same owner (two or more). */
export function findDuplicateGroups(rows: EntryRow[]): EntryRow[][] {
  const groups = new Map<string, EntryRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(row);
  }
  return [...groups.values()].filter((g) => g.length > 1);
}

/** Songs, films, notes and software an entry holds. */
export function mediaCount(row: Pick<EntryRow, 'results'>): number {
  const r = row.results;
  return asList(r?.songs).length + asList(r?.films).length + asList(r?.notes).length + asList(r?.software).length;
}

/** An entry "has data" when the analysis found something to keep: media, a summary or a transcript. */
export function hasData(row: EntryRow): boolean {
  const r = row.results;
  return mediaCount(row) > 0 || !blank(r?.summary) || !blank(r?.transcript);
}

/**
 * The keeper: the oldest entry with data; if none has data, the oldest completed one; else the oldest. Nothing is lost
 * either way (the others are folded in), but the oldest id is the one most likely to be linked from somewhere.
 */
export function pickPrimary(group: EntryRow[]): { primary: EntryRow; surplus: EntryRow[] } {
  const rank = (row: EntryRow): number => (hasData(row) ? 2 : row.status === 'completed' ? 1 : 0);
  const ordered = [...group].sort((a, b) => rank(b) - rank(a) || time(a) - time(b) || a.id.localeCompare(b.id));
  return { primary: ordered[0], surplus: ordered.slice(1) };
}

export interface MergedEntry {
  results: EntryResults;
  actionLog: ActionLogItem[];
  caption: string | null;
}

// ---- completing the keeper's copy of the same thing --------------------------------------------------------------

const viaAudio = (s: Song['source']): boolean => s === 'audio_fingerprint' || s === 'both';
const viaAi = (s: Song['source']): boolean => s === 'ai_analysis' || s === 'both';

function foldSong(keep: Song, other: Song): Song {
  const bothWays = (viaAudio(keep.source) || viaAudio(other.source)) && (viaAi(keep.source) || viaAi(other.source));
  return {
    ...keep,
    album: blank(keep.album) ? other.album ?? null : keep.album,
    spotifyUri: blank(keep.spotifyUri) ? other.spotifyUri ?? null : keep.spotifyUri,
    spotifyUrl: blank(keep.spotifyUrl) ? other.spotifyUrl ?? null : keep.spotifyUrl,
    youtubeUrl: blank(keep.youtubeUrl) ? other.youtubeUrl ?? null : keep.youtubeUrl,
    soundcloudUrl: blank(keep.soundcloudUrl) ? other.soundcloudUrl ?? null : keep.soundcloudUrl,
    addedToPlaylist: keep.addedToPlaylist || other.addedToPlaylist,
    source: bothWays ? 'both' : keep.source,
  };
}

function foldFilm(keep: Film, other: Film): Film {
  return {
    ...keep,
    director: blank(keep.director) ? other.director ?? null : keep.director,
    year: blank(keep.year) ? other.year ?? null : keep.year,
    imdbUrl: blank(keep.imdbUrl) ? other.imdbUrl ?? null : keep.imdbUrl,
    posterUrl: blank(keep.posterUrl) ? other.posterUrl ?? null : keep.posterUrl,
    streamingUrls: keep.streamingUrls ?? other.streamingUrls ?? null,
  };
}

function foldSoftware(keep: SoftwareItem, other: SoftwareItem): SoftwareItem {
  return {
    ...keep,
    url: blank(keep.url) ? other.url ?? null : keep.url,
    description: blank(keep.description) ? other.description ?? null : keep.description,
  };
}

/** For each item of `incoming` whose key is already in `list`, completes the one in `list`; adds nothing, removes nothing. */
function foldInto<T>(list: T[], incoming: T[], key: (item: T) => string, fold: (keep: T, other: T) => T): T[] {
  const index = new Map(list.map((item, i) => [key(item), i] as const));
  const out = [...list];
  for (const other of incoming) {
    const i = index.get(key(other));
    if (i !== undefined && out[i] !== other) out[i] = fold(out[i], other);
  }
  return out;
}

const keepText = (keep: string | null | undefined, other: string | null | undefined): string | null =>
  blank(keep) && !blank(other) ? (other as string) : keep ?? null;

/** A slide taken from another entry: its image lives in a folder that is about to be cleaned up. */
const detach = (slide: EntrySlide): EntrySlide => ({ ...slide, imageUrl: null });

const EMPTY: EntryResults = { songs: [], films: [], notes: [], links: [], tags: [], summary: null };

/** The keeper with everything of the duplicates folded in. Pure: the same inputs always give the same entry. */
export function mergeGroup(primary: EntryRow, surplus: EntryRow[], now: Date): MergedEntry {
  let results: EntryResults = { ...EMPTY, ...(primary.results ?? {}) };
  for (const other of surplus) {
    const theirs: EntryResults = { ...EMPTY, ...(other.results ?? {}) };
    const mine = results;
    const merged = mergeEntryResults(mine, theirs);
    const slides = mine.slides?.length ? mine.slides : asList(theirs.slides).map(detach);
    results = {
      ...merged,
      songs: foldInto(merged.songs, asList(theirs.songs), (s) => songKey(s.title, s.artist), foldSong),
      films: foldInto(merged.films, asList(theirs.films), (f) => filmTitleKey(f.title), foldFilm),
      software: foldInto(asList(merged.software), asList(theirs.software), (s) => softwareKey(s.tag, s.title, s.url), foldSoftware),
      // `mergeEntryResults` lets the incoming transcript win: here the keeper's stays and the other's only fills a blank
      transcript: keepText(mine.transcript, theirs.transcript),
      transcriptLanguage: keepText(mine.transcriptLanguage, theirs.transcriptLanguage),
      enrichments: mine.enrichments ?? theirs.enrichments,
      slides: slides.length ? slides : mine.slides,
    };
  }

  const log: ActionLogItem[] = [...asList(primary.action_log)];
  for (const other of surplus) {
    log.push(...asList(other.action_log));
    log.push({
      action: 'merged_duplicate',
      details: {
        mergedFrom: other.id,
        sourceUrl: other.source_url,
        status: other.status,
        songs: asList(other.results?.songs).length,
        films: asList(other.results?.films).length,
        notes: asList(other.results?.notes).length,
        software: asList(other.results?.software).length,
      },
      timestamp: now.toISOString(),
    });
  }
  // time order; a line with no usable timestamp goes after the dated ones, in the order it came
  const stamp = (item: ActionLogItem): number => {
    const t = item.timestamp ? new Date(item.timestamp).getTime() : Number.NaN;
    return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
  };
  const actionLog = log
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (stamp(a.item) === stamp(b.item) ? a.index - b.index : stamp(a.item) < stamp(b.item) ? -1 : 1))
    .map((x) => x.item);

  return { results, actionLog, caption: primary.caption ?? surplus.find((s) => !blank(s.caption))?.caption ?? null };
}

// ---- the plan ----------------------------------------------------------------------------------------------------

export interface GroupPlan {
  key: string;
  primary: EntryRow;
  surplus: EntryRow[];
}

export function planMerges(rows: EntryRow[]): GroupPlan[] {
  return findDuplicateGroups(rows)
    .map((group) => {
      const { primary, surplus } = pickPrimary(group);
      return { key: keyOf(primary), primary, surplus };
    })
    .sort((a, b) => time(a.primary) - time(b.primary) || a.key.localeCompare(b.key));
}

export interface Dependants {
  shares: number;
  jobs: number;
  inbox: number;
  intents: number;
  spooty: number;
  logs: number;
}

const countsOf = (row: EntryRow): string => {
  const r = row.results;
  const parts = [
    `${asList(r?.songs).length} canzoni`,
    `${asList(r?.films).length} film`,
    `${asList(r?.notes).length} note`,
    `${asList(r?.software).length} software`,
  ];
  if (asList(r?.slides).length) parts.push(`${asList(r?.slides).length} slide`);
  if (!blank(r?.summary)) parts.push('riassunto');
  if (row.thumbnail_url) parts.push('miniatura');
  return parts.join(', ');
};

const dependantsText = (d: Dependants | undefined): string => {
  if (!d) return '';
  const parts = [
    d.shares && `${d.shares} condivisioni`,
    d.jobs && `${d.jobs} job`,
    d.inbox && `${d.inbox} avvisi`,
    d.intents && `${d.intents} intenzioni di condivisione`,
    d.spooty && `${d.spooty} richiesta Spooty`,
    d.logs && `${d.logs} righe di log`,
  ].filter(Boolean);
  return parts.length ? `  [sposta: ${parts.join(', ')}]` : '';
};

/** What the other entry has that the keeper cannot take over (files of a folder that is about to be cleaned up). */
export function filesLostWarnings(plan: GroupPlan): string[] {
  const out: string[] = [];
  for (const s of plan.surplus) {
    if (s.thumbnail_url && !plan.primary.thumbnail_url) out.push(`${s.id.slice(0, 8)} ha una miniatura e la tenuta no: resta senza`);
    const keeperSlides = asList(plan.primary.results?.slides).length;
    const slides = asList(s.results?.slides).filter((x) => x.imageUrl).length;
    if (slides > 0 && keeperSlides === 0) out.push(`${s.id.slice(0, 8)} ha ${slides} slide con immagine e la tenuta nessuna: il testo passa, le immagini no`);
  }
  return out;
}

export function describePlan(plans: GroupPlan[], dependants: Map<string, Dependants> = new Map()): string[] {
  const lines = [`[merge] entry doppie: ${plans.length} gruppi, ${plans.reduce((n, p) => n + p.surplus.length, 0)} entry in piu'`];
  for (const p of plans) {
    lines.push(`  ${p.key.split('|').slice(1).join('|')}  (utente ${p.primary.owner_user})`);
    lines.push(`    TIENE   ${p.primary.id.slice(0, 8)} ${p.primary.status.padEnd(10)} ${new Date(p.primary.created_at).toISOString().slice(0, 10)}  ${countsOf(p.primary)}`);
    for (const s of p.surplus) {
      lines.push(
        `    unisce  ${s.id.slice(0, 8)} ${s.status.padEnd(10)} ${new Date(s.created_at).toISOString().slice(0, 10)}  ${countsOf(s)}${dependantsText(dependants.get(s.id))}`,
      );
    }
    for (const w of filesLostWarnings(p)) lines.push(`    ATTENZIONE ${w}`);
  }
  return lines;
}

// ---- applying ----------------------------------------------------------------------------------------------------

/**
 * What moves from a duplicate (`$1`) to the keeper (`$2`), in this order, before the duplicate is deleted. Every table
 * that points at an entry is here: `entry_shares`, `job_queue`, `inbox_items`, `share_intents`, `spooty_requests` and the
 * `logs` (the last one has no foreign key).
 */
export const REPOINT_STATEMENTS = {
  shares: `INSERT INTO entry_shares (entry_id, shared_with, shared_by, created_at, seen_at)
             SELECT $2, s.shared_with, s.shared_by, s.created_at, s.seen_at FROM entry_shares s
              WHERE s.entry_id = $1 AND s.shared_with <> (SELECT owner_user FROM entries WHERE id = $2)
             ON CONFLICT (entry_id, shared_with) DO NOTHING`,
  // "somebody shared this with you" is one notice per user and entry, also after the merge
  inboxDuplicates: `DELETE FROM inbox_items i WHERE i.entry_id = $1 AND i.kind = 'share_received'
                      AND EXISTS (SELECT 1 FROM inbox_items k WHERE k.entry_id = $2 AND k.user_id = i.user_id
                                   AND k.kind = 'share_received' AND k.removed_at IS NULL)`,
  // all of them, also a queued one: it is work on the same post, and the analysis is additive (a second run is harmless,
  // a dropped retry is not)
  jobs: `UPDATE job_queue SET entry_id = $2 WHERE entry_id = $1`,
  inbox: `UPDATE inbox_items SET entry_id = $2 WHERE entry_id = $1`,
  // one open intent per entry and sender (unique index): the keeper's wins
  pendingIntents: `DELETE FROM share_intents si WHERE si.entry_id = $1 AND si.status = 'pending'
                     AND EXISTS (SELECT 1 FROM share_intents p WHERE p.entry_id = $2 AND p.user_id = si.user_id AND p.status = 'pending')`,
  intents: `UPDATE share_intents SET entry_id = $2 WHERE entry_id = $1`,
  // one request per entry (unique): if the keeper has one already, the duplicate's goes with the entry
  spooty: `UPDATE spooty_requests SET entry_id = $2 WHERE entry_id = $1 AND NOT EXISTS (SELECT 1 FROM spooty_requests WHERE entry_id = $2)`,
  logs: `UPDATE logs SET entry_id = $2 WHERE entry_id = $1`,
  remove: `DELETE FROM entries WHERE id = $1`,
} as const;

type Queryable = Pick<PoolClient, 'query'>;

export async function activeJobs(client: Queryable, ids: string[]): Promise<number> {
  const { rows } = await client.query<{ n: string }>(
    `SELECT count(*) AS n FROM job_queue WHERE entry_id = ANY($1::text[]) AND status = 'processing'`,
    [ids],
  );
  return Number(rows[0]?.n ?? 0);
}

/**
 * One group, one transaction: lock the rows and read them again, skip if a job is running, update the keeper, move the
 * references, delete the duplicates. Returns false when the group was skipped (nothing changed).
 */
export async function applyGroup(client: Queryable, plan: GroupPlan, now: Date): Promise<boolean> {
  const ids = [plan.primary.id, ...plan.surplus.map((s) => s.id)];
  await client.query('BEGIN');
  try {
    const { rows } = await client.query<EntryRow>(`SELECT ${COLUMNS} FROM entries WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [ids]);
    if (rows.length !== ids.length || (await activeJobs(client, ids)) > 0) {
      await client.query('ROLLBACK');
      return false;
    }
    // the plan is made again from the rows as they are now: the keeper can change if an analysis finished meanwhile
    const { primary, surplus } = pickPrimary(rows);
    const merged = mergeGroup(primary, surplus, now);
    await client.query(`UPDATE entries SET results = $2::jsonb, action_log = $3::jsonb, caption = $4 WHERE id = $1`, [
      primary.id,
      JSON.stringify(merged.results),
      JSON.stringify(merged.actionLog),
      merged.caption,
    ]);
    for (const dup of surplus) {
      const pair = [dup.id, primary.id];
      await client.query(REPOINT_STATEMENTS.shares, pair);
      await client.query(REPOINT_STATEMENTS.inboxDuplicates, pair);
      await client.query(REPOINT_STATEMENTS.jobs, pair);
      await client.query(REPOINT_STATEMENTS.inbox, pair);
      await client.query(REPOINT_STATEMENTS.pendingIntents, pair);
      await client.query(REPOINT_STATEMENTS.intents, pair);
      await client.query(REPOINT_STATEMENTS.spooty, pair);
      await client.query(REPOINT_STATEMENTS.logs, pair);
      await client.query(REPOINT_STATEMENTS.remove, [dup.id]);
    }
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

export interface Options {
  apply: boolean;
  backup: string | null;
}

/** A dry run is the default. `--dry-run` is accepted too (the other scripts use it) and wins over `--apply`. */
export function parseArgs(argv: string[]): Options {
  const i = argv.indexOf('--backup');
  const next = i >= 0 ? argv[i + 1] : undefined;
  return { apply: argv.includes('--apply') && !argv.includes('--dry-run'), backup: next && !next.startsWith('--') ? next : null };
}

export interface Deps {
  rows: () => Promise<EntryRow[]>;
  /** What hangs from each of these entries (shown in the plan). */
  dependants: (ids: string[]) => Promise<Map<string, Dependants>>;
  /** Writes the JSON lines of everything about to change or go (the entries and what points at them). */
  backup: (path: string, ids: string[]) => Promise<void>;
  apply: (plan: GroupPlan) => Promise<boolean>;
  say: (line: string) => void;
  now: () => Date;
}

export interface Outcome {
  groups: number;
  merged: number;
  skipped: number;
  failed: number;
}

export async function mergeDuplicateEntries(deps: Deps, opts: Options): Promise<Outcome> {
  const plans = planMerges(await deps.rows());
  const surplusIds = plans.flatMap((p) => p.surplus.map((s) => s.id));
  for (const line of describePlan(plans, surplusIds.length ? await deps.dependants(surplusIds) : new Map())) deps.say(line);
  const none: Outcome = { groups: plans.length, merged: 0, skipped: 0, failed: 0 };
  if (!opts.apply) {
    deps.say("[merge] DRY RUN: non e' cambiato niente (con --apply: copia di sicurezza, poi la fusione)");
    return none;
  }
  if (plans.length === 0) return none;

  const backupPath = opts.backup ?? `/tmp/soundreel-merge-duplicates-${deps.now().toISOString().replace(/[:.]/g, '-')}.jsonl`;
  await deps.backup(backupPath, plans.flatMap((p) => [p.primary.id, ...p.surplus.map((s) => s.id)]));
  deps.say(`[merge] copia di sicurezza: ${backupPath}  (copiala fuori dal container)`);

  const out = { ...none };
  for (const plan of plans) {
    const label = `${plan.primary.id.slice(0, 8)} <- ${plan.surplus.map((s) => s.id.slice(0, 8)).join(', ')}`;
    try {
      if (await deps.apply(plan)) {
        out.merged += plan.surplus.length;
        deps.say(`  unite: ${label}`);
      } else {
        out.skipped += 1;
        deps.say(`  SALTATA (un job in corso, o una riga e' cambiata): ${label}`);
      }
    } catch (err) {
      out.failed += 1;
      deps.say(`  ERRORE ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  deps.say(`[merge] fatto: ${out.merged} entry unite, ${out.skipped} gruppi saltati, ${out.failed} in errore`);
  return out;
}

const BACKUP_TABLES = [
  ['entry_shares', 'entry_id'],
  ['job_queue', 'entry_id'],
  ['inbox_items', 'entry_id'],
  ['share_intents', 'entry_id'],
  ['spooty_requests', 'entry_id'],
  ['logs', 'entry_id'],
] as const;

async function main(): Promise<void> {
  const [{ pool }, fs, path] = await Promise.all([import('../utils/db'), import('node:fs/promises'), import('node:path')]);
  const db: Pick<Pool, 'query'> = pool;
  try {
    const outcome = await mergeDuplicateEntries(
      {
        rows: async () => (await db.query<EntryRow>(`SELECT ${COLUMNS} FROM entries`)).rows,
        dependants: async (ids) => {
          const out = new Map<string, Dependants>(ids.map((id) => [id, { shares: 0, jobs: 0, inbox: 0, intents: 0, spooty: 0, logs: 0 }]));
          const count = async (table: string, key: keyof Dependants): Promise<void> => {
            const { rows } = await db.query<{ entry_id: string; n: string }>(
              `SELECT entry_id, count(*) AS n FROM ${table} WHERE entry_id = ANY($1::text[]) GROUP BY entry_id`,
              [ids],
            );
            for (const r of rows) out.get(r.entry_id)![key] = Number(r.n);
          };
          await count('entry_shares', 'shares');
          await count('job_queue', 'jobs');
          await count('inbox_items', 'inbox');
          await count('share_intents', 'intents');
          await count('spooty_requests', 'spooty');
          await count('logs', 'logs');
          return out;
        },
        backup: async (file, ids) => {
          await fs.mkdir(path.dirname(file), { recursive: true });
          const lines: string[] = [];
          const dump = async (table: string, column: string): Promise<void> => {
            const { rows } = await db.query(`SELECT * FROM ${table} WHERE ${column} = ANY($1::text[])`, [ids]);
            for (const row of rows) lines.push(JSON.stringify({ table, row }));
          };
          await dump('entries', 'id');
          for (const [table, column] of BACKUP_TABLES) await dump(table, column);
          await fs.writeFile(file, `${lines.join('\n')}\n`, { mode: 0o600 });
        },
        apply: async (plan) => {
          const client = await pool.connect();
          try {
            return await applyGroup(client, plan, new Date());
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
    console.error('[merge] errore fatale', err);
    process.exit(1);
  });
}
