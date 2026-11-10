/**
 * Dynamic playlists: a RULE instead of a list of songs, evaluated against the listening events every time the
 * playlist is read (so every sync downloads what is "true right now"). Contract: docs/mondrop-stats.md §4, ADR-0008.
 *
 * "Most played at night" = counted plays whose LOCAL hour (the device's own clock when the song was heard) falls
 * in the window, in the period, for me or for the whole family, ranked.
 */
import { query } from '../utils/db';
import { canonicalGenres } from '../utils/genres';
import type { DynamicRule } from './dynamicRules';
import { libraryOnlySong } from './libraryOnlySongs';
import { listReadySongKeys } from './songFiles';
import { likedKeys } from './songLikes';
import { getUserSongs } from './userSongs';

export * from './dynamicRules';

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface ResolveContext {
  userId: string;
  isAdmin?: boolean;
}

interface Stat {
  plays: number;
  lastAt: number;
}

async function loadStats(rule: DynamicRule, userId: string, since: Date | null, useWindow: boolean): Promise<Map<string, Stat>> {
  const params: unknown[] = [rule.scope === 'family' ? null : [userId], since ? since.toISOString() : null];
  const conds = [
    'counted',
    '($1::text[] IS NULL OR user_id = ANY($1::text[]))',
    '($2::timestamptz IS NULL OR started_at >= $2::timestamptz)',
  ];
  const w = useWindow ? rule.window : undefined;
  if (w && w.from !== w.to) {
    params.push(w.from, w.to);
    const a = `$${params.length - 1}::time`;
    const b = `$${params.length}::time`;
    conds.push(
      w.from < w.to
        ? `(local_started_at::time >= ${a} AND local_started_at::time < ${b})`
        : `(local_started_at::time >= ${a} OR local_started_at::time < ${b})`,
    );
  }
  if (w?.days) {
    params.push(w.days);
    conds.push(`EXTRACT(ISODOW FROM local_started_at)::int = ANY($${params.length}::int[])`);
  }
  const rows = await query<{ song_key: string; plays: number; last_at: Date }>(
    `SELECT song_key, COUNT(*)::int AS plays, MAX(started_at) AS last_at
       FROM play_events WHERE ${conds.join(' AND ')} GROUP BY song_key`,
    params,
  );
  return new Map(rows.map((r) => [r.song_key, { plays: r.plays, lastAt: new Date(r.last_at).getTime() }]));
}

/** The songs a rule selects right now, in order, for this user. */
export async function resolveDynamicSongKeys(rule: DynamicRule, ctx: ResolveContext, now: Date = new Date()): Promise<string[]> {
  const songs = await getUserSongs(ctx.userId, ctx.isAdmin ?? false);
  const readyKeys = rule.downloadedOnly ? await listReadySongKeys().catch(() => new Set<string>()) : new Set<string>();
  const wanted = rule.genres ? new Set(rule.genres) : null;

  if (rule.order === 'liked') {
    // not about what was heard either: the songs THIS person liked (the rule's family scope changes nothing: a like is of one person), the most
    // recently liked first. A song is the journal's, or a file the library has; one that is nowhere any more is skipped (no source, no track),
    // and a library that cannot be read is a library with nothing in it, never a failure of the whole list of playlists. No listening events read.
    const out: string[] = [];
    for (const key of await likedKeys(ctx.userId)) {
      const song = songs.get(key) ?? (await libraryOnlySong(key).catch(() => undefined));
      if (!song) continue;
      if (wanted && !canonicalGenres(song.meta?.genres).some((g) => wanted.has(g))) continue;
      if (rule.downloadedOnly && !(song.meta?.downloaded || readyKeys.has(key))) continue;
      out.push(key);
      if (out.length >= rule.limit) break;
    }
    return out;
  }

  const candidates = [...songs.values()].filter((s) => {
    if (wanted && !canonicalGenres(s.meta?.genres).some((g) => wanted.has(g))) return false;
    if (rule.downloadedOnly && !(s.meta?.downloaded || readyKeys.has(s.songKey))) return false;
    return true;
  });
  if (candidates.length === 0) return [];

  const since = rule.period === 'all' ? null : new Date(now.getTime() - rule.period.days * 86_400_000);
  const byTitle = (a: string, b: string): number => a.localeCompare(b, 'it');

  if (rule.order === 'newest') {
    // not about what was heard: every song that matches (the tag decides, the plays do not), the last added first, no listening events read
    return candidates
      .sort((a, b) => (b.mentions[0]?.createdAt ?? '').localeCompare(a.mentions[0]?.createdAt ?? '') || byTitle(a.title, b.title))
      .slice(0, rule.limit)
      .map((s) => s.songKey);
  }

  if (rule.order === 'never_played') {
    const stats = await loadStats(rule, ctx.userId, since, false);
    return candidates
      .filter((s) => !stats.has(s.songKey))
      .sort((a, b) => (b.mentions[0]?.createdAt ?? '').localeCompare(a.mentions[0]?.createdAt ?? '') || byTitle(a.title, b.title))
      .slice(0, rule.limit)
      .map((s) => s.songKey);
  }

  const stats = await loadStats(rule, ctx.userId, since, true);
  const title = new Map(candidates.map((s) => [s.songKey, s.title]));

  if (rule.order === 'least_played') {
    return candidates
      .map((s) => ({ key: s.songKey, plays: stats.get(s.songKey)?.plays ?? 0, last: stats.get(s.songKey)?.lastAt ?? 0 }))
      .sort((a, b) => a.plays - b.plays || a.last - b.last || byTitle(title.get(a.key) ?? '', title.get(b.key) ?? ''))
      .slice(0, rule.limit)
      .map((x) => x.key);
  }

  const ranked = candidates
    .map((s) => ({ key: s.songKey, ...(stats.get(s.songKey) ?? { plays: 0, lastAt: 0 }) }))
    .filter((x) => x.plays >= rule.minPlays);
  ranked.sort(
    rule.order === 'recent'
      ? (a, b) => b.lastAt - a.lastAt || b.plays - a.plays || byTitle(title.get(a.key) ?? '', title.get(b.key) ?? '')
      : (a, b) => b.plays - a.plays || b.lastAt - a.lastAt || byTitle(title.get(a.key) ?? '', title.get(b.key) ?? ''),
  );
  return ranked.slice(0, rule.limit).map((x) => x.key);
}
