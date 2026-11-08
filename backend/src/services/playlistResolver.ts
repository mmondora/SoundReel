/**
 * What a playlist contains RIGHT NOW for a viewer: its stored songs if it is static, the songs its rule selects
 * if it is dynamic (ADR-0008). Kept apart from the playlist service so that one never needs the evaluator
 * (which reads the journal and the listening events).
 */
import type { PlaylistDetail, PlaylistSummary } from '../types';
import { resolveDynamicSongKeys } from './dynamicPlaylists';
import { parseRule } from './dynamicRules';

export interface ViewerContext {
  userId: string;
  isAdmin?: boolean;
}

const TTL_MS = 60_000;
const cache = new Map<string, { at: number; songKeys: string[]; generatedAt: string }>();

export function invalidateDynamicPlaylists(): void {
  cache.clear();
}

/** Songs of one dynamic playlist for this viewer (cached 60 s: clients poll while they sync). */
async function evaluate(playlist: PlaylistSummary, ctx: ViewerContext, now: Date): Promise<{ songKeys: string[]; generatedAt: string }> {
  const key = `${playlist.id}|${ctx.userId}|${ctx.isAdmin ? 1 : 0}`;
  const hit = cache.get(key);
  if (hit && now.getTime() - hit.at < TTL_MS) return { songKeys: hit.songKeys, generatedAt: hit.generatedAt };
  const parsed = parseRule(playlist.rule);
  const songKeys = parsed.ok ? await resolveDynamicSongKeys(parsed.rule, ctx, now) : [];
  const generatedAt = now.toISOString();
  cache.set(key, { at: now.getTime(), songKeys, generatedAt });
  return { songKeys, generatedAt };
}

export const isDynamic = (p: Pick<PlaylistSummary, 'kind'>): boolean => p.kind === 'dynamic';

/** Song keys of a playlist as the viewer sees them now, plus when a dynamic one was computed. */
export async function resolveSongKeys(
  playlist: PlaylistSummary & { songKeys?: string[] },
  ctx: ViewerContext,
  now: Date = new Date(),
): Promise<{ songKeys: string[]; generatedAt?: string }> {
  if (!isDynamic(playlist)) return { songKeys: playlist.songKeys ?? [] };
  return evaluate(playlist, ctx, now);
}

/** A playlist detail whose `songKeys` / `songCount` are the live ones (dynamic playlists carry `generatedAt`). */
export async function resolveDetail<T extends PlaylistDetail>(playlist: T, ctx: ViewerContext, now: Date = new Date()): Promise<T> {
  if (!isDynamic(playlist)) return playlist;
  const { songKeys, generatedAt } = await evaluate(playlist, ctx, now);
  return { ...playlist, songKeys, songCount: songKeys.length, generatedAt };
}

/** A list of summaries with the count of dynamic playlists filled in (static ones come from the database). */
export async function resolveSummaries<T extends PlaylistSummary>(list: T[], ctx: ViewerContext, now: Date = new Date()): Promise<T[]> {
  return Promise.all(
    list.map(async (p) => {
      if (!isDynamic(p)) return p;
      const { songKeys, generatedAt } = await evaluate(p, ctx, now);
      return { ...p, songCount: songKeys.length, generatedAt };
    }),
  );
}
