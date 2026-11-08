import { Pool, PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Entry, ActionLogItem, EntrySummaryRow, JournalStats } from '../types';
import { extractInstagramShortcode } from '../services/urlNormalize';

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'soundreel',
  user: process.env.DB_USER || 'soundreel',
  password: process.env.DB_PASSWORD || 'soundreel',
  max: 10,
  idleTimeoutMillis: 30_000,
});

pool.on('error', (err) => {
  console.error('Postgres pool error', err);
});

export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params?: unknown[]
): Promise<T[]> {
  const result = await pool.query<T>(text, params as never);
  return result.rows;
}

export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}

export { pool };

// --- Row mapping ---

interface EntryRow {
  id: string;
  source_url: string;
  source_platform: string;
  input_channel: string;
  input_user: string | null;
  owner_user: string | null;
  caption: string | null;
  thumbnail_url: string | null;
  media_url: string | null;
  status: string;
  results: unknown;
  action_log: unknown;
  created_at: Date;
}

function rowToEntry(row: EntryRow): Entry {
  return {
    id: row.id,
    sourceUrl: row.source_url,
    sourcePlatform: row.source_platform as Entry['sourcePlatform'],
    inputChannel: row.input_channel as Entry['inputChannel'],
    inputUser: row.input_user,
    ownerUser: row.owner_user || 'mike',
    caption: row.caption,
    thumbnailUrl: row.thumbnail_url,
    mediaUrl: row.media_url,
    status: row.status as Entry['status'],
    results: row.results as Entry['results'],
    actionLog: row.action_log as ActionLogItem[],
    createdAt: row.created_at.toISOString(),
  };
}

// --- Entries CRUD ---

/**
 * Idempotency lookup scoped to an owner (Authelia user).
 * Same URL may exist once per owner_user.
 */
export async function findEntryByUrl(sourceUrl: string, ownerUser: string): Promise<Entry | null> {
  const owner = ownerUser.trim().toLowerCase() || 'mike';
  const rows = await query<EntryRow>(
    'SELECT * FROM entries WHERE source_url = $1 AND owner_user = $2 ORDER BY created_at DESC LIMIT 1',
    [sourceUrl, owner]
  );
  if (rows[0]) return rowToEntry(rows[0]);

  // Older rows still carry Instagram share params (mdxt/obrf/…). Exact match
  // on the cleaned URL misses them; fall back to the shortcode in the path.
  const shortcode = extractInstagramShortcode(sourceUrl);
  if (!shortcode) return null;

  const byCode = await query<EntryRow>(
    `SELECT * FROM entries
     WHERE source_platform = 'instagram'
       AND owner_user = $5
       AND (
         source_url LIKE $1 OR source_url LIKE $2 OR source_url LIKE $3 OR source_url LIKE $4
       )
     ORDER BY created_at DESC
     LIMIT 1`,
    [
      `%/p/${shortcode}%`,
      `%/reel/${shortcode}%`,
      `%/reels/${shortcode}%`,
      `%/tv/${shortcode}%`,
      owner,
    ],
  );
  return byCode[0] ? rowToEntry(byCode[0]) : null;
}

export async function getEntry(entryId: string): Promise<Entry | null> {
  const rows = await query<EntryRow>('SELECT * FROM entries WHERE id = $1', [entryId]);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export interface VisibilityOpts {
  userId: string;
  /** Authelia admins also see owner_user = anonymous. */
  isAdmin?: boolean;
}

/** SQL predicate: owned, shared-with, or (admin + anonymous). Params: $userIdx = userId. */
function visibilitySql(userParam: string, isAdmin: boolean, anonLiteral = "'anonymous'"): string {
  const adminClause = isAdmin ? ` OR e.owner_user = ${anonLiteral}` : '';
  return `(
    e.owner_user = ${userParam}
    OR EXISTS (
      SELECT 1 FROM entry_shares s
      WHERE s.entry_id = e.id AND s.shared_with = ${userParam}
    )
    ${adminClause}
  )`;
}

/** Entry visible if owned by user, shared with user, or (admin browsing anonymous). */
export async function getEntryForUser(
  entryId: string,
  userId: string,
  isAdmin = false,
): Promise<Entry | null> {
  const rows = await query<EntryRow>(
    `SELECT e.* FROM entries e
     WHERE e.id = $1 AND ${visibilitySql('$2', isAdmin)}
     LIMIT 1`,
    [entryId, userId],
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function listEntries(limit = 100, visibility?: VisibilityOpts): Promise<Entry[]> {
  if (visibility?.userId) {
    const rows = await query<EntryRow>(
      `SELECT e.* FROM entries e
       WHERE ${visibilitySql('$2', !!visibility.isAdmin)}
       ORDER BY e.created_at DESC LIMIT $1`,
      [limit, visibility.userId],
    );
    return rows.map(rowToEntry);
  }
  const rows = await query<EntryRow>(
    'SELECT * FROM entries ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows.map(rowToEntry);
}

interface EntrySummaryDbRow {
  id: string;
  source_url: string;
  source_platform: string;
  caption: string | null;
  thumbnail_url: string | null;
  status: string;
  created_at: Date;
  summary: string | null;
  song_count: number;
  film_count: number;
  note_count: number;
  tags: unknown;
  total: string;
}

export async function listEntrySummaries(
  limit: number,
  offset: number,
  visibility?: VisibilityOpts,
): Promise<{ items: EntrySummaryRow[]; total: number }> {
  const scoped = visibility?.userId
    ? `FROM entries e WHERE ${visibilitySql('$3', !!visibility.isAdmin)}`
    : 'FROM entries e';
  const params: unknown[] = visibility?.userId
    ? [limit, offset, visibility.userId]
    : [limit, offset];
  const rows = await query<EntrySummaryDbRow>(
    `SELECT
       e.id,
       e.source_url,
       e.source_platform,
       e.caption,
       e.thumbnail_url,
       e.status,
       e.created_at,
       e.results->>'summary' AS summary,
       COALESCE(jsonb_array_length(e.results->'songs'), 0) AS song_count,
       COALESCE(jsonb_array_length(e.results->'films'), 0) AS film_count,
       COALESCE(jsonb_array_length(e.results->'notes'), 0) AS note_count,
       COALESCE(e.results->'tags', '[]'::jsonb) AS tags,
       COUNT(*) OVER()::text AS total
     ${scoped}
     ORDER BY e.created_at DESC
     LIMIT $1 OFFSET $2`,
    params,
  );
  const total = Number(rows[0]?.total ?? 0);
  const items: EntrySummaryRow[] = rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    sourcePlatform: r.source_platform,
    caption: r.caption,
    thumbnailUrl: r.thumbnail_url,
    status: r.status,
    createdAt: r.created_at.toISOString(),
    summary: r.summary,
    songCount: Number(r.song_count),
    filmCount: Number(r.film_count),
    noteCount: Number(r.note_count),
    tags: Array.isArray(r.tags)
      ? r.tags.filter((t): t is string => typeof t === 'string')
      : [],
  }));
  return { items, total };
}

export async function getJournalStats(visibility?: VisibilityOpts): Promise<JournalStats> {
  if (visibility?.userId) {
    const rows = await query<{
      total_entries: string;
      total_songs: string;
      total_films: string;
      total_notes: string;
      total_software: string;
    }>(
      `SELECT
         COUNT(*)::text AS total_entries,
         COALESCE(SUM(jsonb_array_length(e.results->'songs')), 0)::text AS total_songs,
         COALESCE(SUM(jsonb_array_length(e.results->'films')), 0)::text AS total_films,
         COALESCE(SUM(jsonb_array_length(e.results->'notes')), 0)::text AS total_notes,
         COALESCE(SUM(jsonb_array_length(COALESCE(e.results->'software', '[]'::jsonb))), 0)::text AS total_software
       FROM entries e
       WHERE ${visibilitySql('$1', !!visibility.isAdmin)}`,
      [visibility.userId],
    );
    const r = rows[0];
    return {
      totalEntries: Number(r?.total_entries ?? 0),
      totalSongs: Number(r?.total_songs ?? 0),
      totalFilms: Number(r?.total_films ?? 0),
      totalNotes: Number(r?.total_notes ?? 0),
      totalSoftware: Number(r?.total_software ?? 0),
    };
  }
  const rows = await query<{
    total_entries: string;
    total_songs: string;
    total_films: string;
    total_notes: string;
    total_software: string;
  }>(
    `SELECT
       (SELECT COUNT(*)::text FROM entries) AS total_entries,
       (SELECT COUNT(*)::text FROM song_meta) AS total_songs,
       (SELECT COUNT(*)::text FROM film_meta) AS total_films,
       (SELECT COUNT(*)::text FROM note_meta) AS total_notes,
       (SELECT COUNT(*)::text FROM software_meta) AS total_software`
  );
  const r = rows[0];
  return {
    totalEntries: Number(r?.total_entries ?? 0),
    totalSongs: Number(r?.total_songs ?? 0),
    totalFilms: Number(r?.total_films ?? 0),
    totalNotes: Number(r?.total_notes ?? 0),
    totalSoftware: Number(r?.total_software ?? 0),
  };
}

// --- Entry shares ---

export async function listEntryShares(entryId: string): Promise<string[]> {
  const rows = await query<{ shared_with: string }>(
    'SELECT shared_with FROM entry_shares WHERE entry_id = $1 ORDER BY shared_with',
    [entryId],
  );
  return rows.map((r) => r.shared_with);
}

export async function shareEntry(
  entryId: string,
  sharedWith: string[],
  sharedBy: string,
): Promise<string[]> {
  const targets = [...new Set(sharedWith.map((u) => u.trim().toLowerCase()).filter(Boolean))];
  for (const withUser of targets) {
    await query(
      `INSERT INTO entry_shares (entry_id, shared_with, shared_by)
       VALUES ($1, $2, $3)
       ON CONFLICT (entry_id, shared_with) DO NOTHING`,
      [entryId, withUser, sharedBy],
    );
  }
  return listEntryShares(entryId);
}

export async function unshareEntry(entryId: string, sharedWith: string): Promise<string[]> {
  await query(
    'DELETE FROM entry_shares WHERE entry_id = $1 AND shared_with = $2',
    [entryId, sharedWith.trim().toLowerCase()],
  );
  return listEntryShares(entryId);
}

// --- Telegram identities ---

export async function getTelegramIdentity(telegramKey: string): Promise<{
  ownerUser: string;
  claimedName: string;
} | null> {
  const key = telegramKey.trim().toLowerCase();
  if (!key) return null;
  const rows = await query<{ owner_user: string; claimed_name: string }>(
    'SELECT owner_user, claimed_name FROM telegram_identities WHERE telegram_key = $1',
    [key],
  );
  if (!rows[0]) return null;
  return { ownerUser: rows[0].owner_user, claimedName: rows[0].claimed_name };
}

export async function upsertTelegramIdentity(
  telegramKey: string,
  ownerUser: string,
  claimedName: string,
): Promise<void> {
  await query(
    `INSERT INTO telegram_identities (telegram_key, owner_user, claimed_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (telegram_key) DO UPDATE
       SET owner_user = EXCLUDED.owner_user,
           claimed_name = EXCLUDED.claimed_name`,
    [telegramKey.trim().toLowerCase(), ownerUser.trim().toLowerCase(), claimedName.trim()],
  );
}

// --- User config ---

export async function getUserConfigValue<T>(userId: string, key: string, fallback: T): Promise<T> {
  const rows = await query<{ value: unknown }>(
    'SELECT value FROM user_config WHERE user_id = $1 AND key = $2',
    [userId, key],
  );
  if (!rows[0]) return fallback;
  return rows[0].value as T;
}

export async function setUserConfigValue(userId: string, key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO user_config (user_id, key, value, updated_at)
     VALUES ($1, $2, $3::jsonb, NOW())
     ON CONFLICT (user_id, key) DO UPDATE
       SET value = EXCLUDED.value, updated_at = NOW()`,
    [userId, key, JSON.stringify(value)],
  );
}

export async function createEntry(entry: Omit<Entry, 'id' | 'createdAt'> & { createdAt?: string }): Promise<string> {
  const id = randomUUID();
  const owner = (entry.ownerUser || entry.inputUser || 'mike').trim().toLowerCase() || 'mike';
  await query(
    `INSERT INTO entries (id, source_url, source_platform, input_channel, input_user, owner_user, caption, thumbnail_url, media_url, status, results, action_log)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [
      id,
      entry.sourceUrl,
      entry.sourcePlatform,
      entry.inputChannel,
      entry.inputUser ?? null,
      owner,
      entry.caption,
      entry.thumbnailUrl,
      entry.mediaUrl,
      entry.status,
      JSON.stringify(entry.results),
      JSON.stringify(entry.actionLog),
    ]
  );
  return id;
}

const ENTRY_COLUMN_MAP: Record<string, string> = {
  sourceUrl: 'source_url',
  sourcePlatform: 'source_platform',
  inputChannel: 'input_channel',
  inputUser: 'input_user',
  ownerUser: 'owner_user',
  caption: 'caption',
  thumbnailUrl: 'thumbnail_url',
  mediaUrl: 'media_url',
  status: 'status',
  results: 'results',
  actionLog: 'action_log',
};

export async function updateEntry(
  entryId: string,
  updates: Partial<Entry> | Record<string, unknown>
): Promise<void> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  for (const [key, value] of Object.entries(updates)) {
    // Support dot-notation keys like 'results.transcript' by rewriting into jsonb_set
    if (key.startsWith('results.')) {
      const subPath = key.substring('results.'.length).split('.');
      const pathLiteral = `'{${subPath.join(',')}}'`;
      setClauses.push(`results = jsonb_set(results, ${pathLiteral}, $${idx}::jsonb, true)`);
      values.push(JSON.stringify(value));
      idx++;
      continue;
    }

    const column = ENTRY_COLUMN_MAP[key];
    if (!column) continue;
    if (column === 'results' || column === 'action_log') {
      setClauses.push(`${column} = $${idx}::jsonb`);
      values.push(JSON.stringify(value));
    } else {
      setClauses.push(`${column} = $${idx}`);
      values.push(value);
    }
    idx++;
  }

  if (!setClauses.length) return;
  values.push(entryId);
  await query(
    `UPDATE entries SET ${setClauses.join(', ')} WHERE id = $${idx}`,
    values
  );
}

export async function appendActionLog(entryId: string, logItem: ActionLogItem): Promise<void> {
  await query(
    `UPDATE entries SET action_log = action_log || $1::jsonb WHERE id = $2`,
    [JSON.stringify([logItem]), entryId]
  );
}

// `job_queue.entry_id` references entries WITHOUT `ON DELETE CASCADE`, so deleting any entry that went
// through the queue (every Telegram / Mondrop share entry) used to fail with a foreign-key violation
// (HTTP 500 on DELETE /api/entries/:id). The queue rows go in the same statement: the NO ACTION check
// runs at the end of the statement, when none are left.
export async function deleteEntry(entryId: string): Promise<void> {
  await query(
    'WITH dropped AS (DELETE FROM job_queue WHERE entry_id = $1) DELETE FROM entries WHERE id = $1',
    [entryId],
  );
}

export async function deleteAllEntries(): Promise<number> {
  const result = await pool.query('WITH dropped AS (DELETE FROM job_queue) DELETE FROM entries');
  return result.rowCount ?? 0;
}

export async function countEntries(): Promise<number> {
  const rows = await query<{ count: string }>('SELECT COUNT(*)::text AS count FROM entries');
  return Number(rows[0]?.count ?? 0);
}

export async function latestEntryTimestamp(): Promise<string | null> {
  const rows = await query<{ created_at: Date | null }>(
    'SELECT created_at FROM entries ORDER BY created_at DESC LIMIT 1'
  );
  return rows[0]?.created_at ? rows[0].created_at.toISOString() : null;
}

// --- Config K/V ---

async function getConfig<T>(key: string, fallback: T): Promise<T> {
  const rows = await query<{ value: unknown }>('SELECT value FROM config WHERE key = $1', [key]);
  if (!rows[0]) return fallback;
  return rows[0].value as T;
}

async function setConfig(key: string, value: unknown): Promise<void> {
  await query(
    `INSERT INTO config (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)]
  );
}

async function mergeConfig<T>(key: string, updates: Partial<T>, fallback: T): Promise<void> {
  const current = await getConfig<T>(key, fallback);
  const merged = { ...current, ...updates } as T;
  await setConfig(key, merged);
}

// Music folders searched next to the library (ADR-0011)

export interface MusicFolderConfig {
  id: string;
  /** Container path, inside one of the allowed roots. */
  path: string;
  label: string;
  enabled: boolean;
}

export async function getMusicFoldersConfig(): Promise<MusicFolderConfig[]> {
  const value = await getConfig<{ folders?: MusicFolderConfig[] }>('music_folders', {});
  return Array.isArray(value.folders) ? value.folders : [];
}

export async function setMusicFoldersConfig(folders: MusicFolderConfig[]): Promise<void> {
  await setConfig('music_folders', { folders });
}

// Spotify

export interface SpotifyConfig {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  playlistId: string | null;
}

export async function getSpotifyConfig(): Promise<SpotifyConfig | null> {
  const rows = await query<{ value: Partial<SpotifyConfig> }>('SELECT value FROM config WHERE key = $1', ['spotify']);
  const data = rows[0]?.value;
  if (!data?.accessToken || !data?.refreshToken) return null;
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt ?? 0,
    playlistId: data.playlistId ?? null,
  };
}

export async function updateSpotifyConfig(updates: Partial<SpotifyConfig>): Promise<void> {
  await mergeConfig('spotify', updates, {
    accessToken: '',
    refreshToken: '',
    expiresAt: 0,
    playlistId: null,
  });
}

// Features

export type OutputLanguage = 'it' | 'en';

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  mediaAnalysisEnabled: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
  pageExtractionEnabled: boolean;
  shazamEnabled: boolean;
  multiSongScanEnabled: boolean;
  youtubeDirect: boolean;
  carouselStructuredExtraction: boolean;
  /** Lingua dei testi generati dall'AI (summary, slide, note). Default italiano. */
  outputLanguage: OutputLanguage;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false,
  allowDuplicateUrls: false,
  mediaAnalysisEnabled: false,
  transcriptionEnabled: true,
  aiAnalysisEnabled: true,
  pageExtractionEnabled: true,
  shazamEnabled: true,
  multiSongScanEnabled: true,
  youtubeDirect: true,
  carouselStructuredExtraction: true,
  outputLanguage: 'it',
};

export function outputLanguageDisplayName(lang: OutputLanguage): string {
  return lang === 'en' ? 'English' : 'Italian';
}

export async function getFeaturesConfig(): Promise<FeaturesConfig> {
  return { ...DEFAULT_FEATURES, ...(await getConfig<Partial<FeaturesConfig>>('features', {})) };
}

export async function updateFeaturesConfig(updates: Partial<FeaturesConfig>): Promise<void> {
  await mergeConfig('features', updates, DEFAULT_FEATURES);
}

// Instagram cookies (kept for backward compatibility; Instaloader session is separate)

export interface InstagramConfig {
  sessionId: string | null;
  csrfToken: string | null;
  dsUserId: string | null;
  enabled: boolean;
}

const DEFAULT_INSTAGRAM: InstagramConfig = {
  sessionId: null,
  csrfToken: null,
  dsUserId: null,
  enabled: false,
};

export async function getInstagramConfig(): Promise<InstagramConfig> {
  return { ...DEFAULT_INSTAGRAM, ...(await getConfig<Partial<InstagramConfig>>('instagram', {})) };
}

export async function updateInstagramConfig(updates: Partial<InstagramConfig>): Promise<void> {
  await mergeConfig('instagram', updates, DEFAULT_INSTAGRAM);
}

// OpenAI

export interface OpenAIConfig {
  apiKey: string | null;
  enabled: boolean;
}

const DEFAULT_OPENAI: OpenAIConfig = { apiKey: null, enabled: false };

export async function getOpenAIConfig(): Promise<OpenAIConfig> {
  return { ...DEFAULT_OPENAI, ...(await getConfig<Partial<OpenAIConfig>>('openai', {})) };
}

export async function updateOpenAIConfig(updates: Partial<OpenAIConfig>): Promise<void> {
  await mergeConfig('openai', updates, DEFAULT_OPENAI);
}

// API keys (SoundReel read API)

export interface ApiKeyMeta {
  /** Authelia id the key is bound to (`mike` | `archi` | `sara`). */
  user: string;
  /** Device label the key was issued for (e.g. "iPhone di Michele"). */
  device: string;
  createdAt: string;
}

export interface ApiKeysConfig {
  keys: string[];
  /**
   * Owner bookkeeping for keys issued via /mondrop/connect, keyed by
   * `apiKeyId(key)` (sha256 prefix, never the key itself). Legacy keys have no entry.
   */
  meta?: Record<string, ApiKeyMeta>;
}

const DEFAULT_API_KEYS: ApiKeysConfig = { keys: [] };

export async function getApiKeysConfig(): Promise<ApiKeysConfig> {
  return { ...DEFAULT_API_KEYS, ...(await getConfig<Partial<ApiKeysConfig>>('apiKeys', {})) };
}

export async function updateApiKeysConfig(updates: Partial<ApiKeysConfig>): Promise<void> {
  await mergeConfig('apiKeys', updates, DEFAULT_API_KEYS);
}

// Retention

export interface RetentionConfig {
  retentionDays: number | null; // null = disabled (keep forever)
  orphanTtlDays: number;        // delete orphan media dirs after N days
}

const DEFAULT_RETENTION: RetentionConfig = {
  retentionDays: null,
  orphanTtlDays: 7,
};

export async function getRetentionConfig(): Promise<RetentionConfig> {
  return { ...DEFAULT_RETENTION, ...(await getConfig<Partial<RetentionConfig>>('retention', {})) };
}

export async function updateRetentionConfig(updates: Partial<RetentionConfig>): Promise<void> {
  await mergeConfig('retention', updates, DEFAULT_RETENTION);
}

// Admin: storage stats

export interface PlatformCount { platform: string; count: number }
export interface StatusCount { status: string; count: number }
export interface AgeBucket { label: string; count: number }
export interface EntrySummary {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  createdAt: string;
  status: string;
}

export async function countsByPlatform(): Promise<PlatformCount[]> {
  const rows = await query<{ source_platform: string; count: string }>(
    `SELECT source_platform, COUNT(*)::text AS count FROM entries GROUP BY source_platform ORDER BY 2 DESC`,
  );
  return rows.map((r) => ({ platform: r.source_platform, count: Number(r.count) }));
}

export async function countsByStatus(): Promise<StatusCount[]> {
  const rows = await query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count FROM entries GROUP BY status ORDER BY 2 DESC`,
  );
  return rows.map((r) => ({ status: r.status, count: Number(r.count) }));
}

export async function ageBuckets(): Promise<AgeBucket[]> {
  const rows = await query<{ label: string; count: string }>(
    `SELECT label, COUNT(*)::text AS count FROM (
       SELECT CASE
         WHEN created_at >= NOW() - INTERVAL '1 day' THEN '<1d'
         WHEN created_at >= NOW() - INTERVAL '7 days' THEN '<7d'
         WHEN created_at >= NOW() - INTERVAL '30 days' THEN '<30d'
         WHEN created_at >= NOW() - INTERVAL '90 days' THEN '<90d'
         ELSE 'older'
       END AS label
       FROM entries
     ) t
     GROUP BY label
     ORDER BY CASE label WHEN '<1d' THEN 0 WHEN '<7d' THEN 1 WHEN '<30d' THEN 2 WHEN '<90d' THEN 3 ELSE 4 END`,
  );
  return rows.map((r) => ({ label: r.label, count: Number(r.count) }));
}

export async function allEntryIds(): Promise<string[]> {
  const rows = await query<{ id: string }>(`SELECT id FROM entries`);
  return rows.map((r) => r.id);
}

export async function entriesOlderThan(days: number): Promise<EntrySummary[]> {
  const rows = await query<{
    id: string; source_url: string; source_platform: string;
    created_at: Date; status: string;
  }>(
    `SELECT id, source_url, source_platform, created_at, status
     FROM entries
     WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
     ORDER BY created_at ASC`,
    [days],
  );
  return rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    sourcePlatform: r.source_platform,
    createdAt: r.created_at.toISOString(),
    status: r.status,
  }));
}

export async function findEntriesByFilter(filter: {
  platform?: string | null;
  status?: string | null;
  olderThanDays?: number | null;
  emptyResultsOnly?: boolean;
}): Promise<EntrySummary[]> {
  const where: string[] = [];
  const params: unknown[] = [];
  let idx = 1;
  if (filter.platform) {
    where.push(`source_platform = $${idx++}`);
    params.push(filter.platform);
  }
  if (filter.status) {
    where.push(`status = $${idx++}`);
    params.push(filter.status);
  }
  if (typeof filter.olderThanDays === 'number' && filter.olderThanDays >= 0) {
    where.push(`created_at < NOW() - ($${idx++}::int * INTERVAL '1 day')`);
    params.push(filter.olderThanDays);
  }
  if (filter.emptyResultsOnly) {
    // empty results = no songs and no films
    where.push(
      `(COALESCE(jsonb_array_length(results->'songs'), 0) = 0
        AND COALESCE(jsonb_array_length(results->'films'), 0) = 0)`,
    );
  }
  const sql = `SELECT id, source_url, source_platform, created_at, status FROM entries
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY created_at ASC`;
  const rows = await query<{
    id: string; source_url: string; source_platform: string;
    created_at: Date; status: string;
  }>(sql, params);
  return rows.map((r) => ({
    id: r.id,
    sourceUrl: r.source_url,
    sourcePlatform: r.source_platform,
    createdAt: r.created_at.toISOString(),
    status: r.status,
  }));
}

export async function deleteEntriesByIds(ids: string[]): Promise<number> {
  if (!ids.length) return 0;
  const result = await pool.query('DELETE FROM entries WHERE id = ANY($1::text[])', [ids]);
  return result.rowCount ?? 0;
}

// Prompts

export async function getPromptsConfig(): Promise<Record<string, string>> {
  return await getConfig<Record<string, string>>('prompts', {});
}

export async function setPromptsConfig(value: Record<string, string>): Promise<void> {
  await setConfig('prompts', value);
}

// Re-export createActionLog so routes can import it from a single place (../utils/db)
export { createActionLog } from './logger';
