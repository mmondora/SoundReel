import { Pool, PoolClient, QueryResultRow } from 'pg';
import { randomUUID } from 'node:crypto';
import type { Entry, ActionLogItem } from '../types';

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

export async function findEntryByUrl(sourceUrl: string): Promise<Entry | null> {
  const rows = await query<EntryRow>(
    'SELECT * FROM entries WHERE source_url = $1 ORDER BY created_at DESC LIMIT 1',
    [sourceUrl]
  );
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function getEntry(entryId: string): Promise<Entry | null> {
  const rows = await query<EntryRow>('SELECT * FROM entries WHERE id = $1', [entryId]);
  return rows[0] ? rowToEntry(rows[0]) : null;
}

export async function listEntries(limit = 100): Promise<Entry[]> {
  const rows = await query<EntryRow>(
    'SELECT * FROM entries ORDER BY created_at DESC LIMIT $1',
    [limit]
  );
  return rows.map(rowToEntry);
}

export async function createEntry(entry: Omit<Entry, 'id' | 'createdAt'> & { createdAt?: string }): Promise<string> {
  const id = randomUUID();
  await query(
    `INSERT INTO entries (id, source_url, source_platform, input_channel, caption, thumbnail_url, media_url, status, results, action_log)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      id,
      entry.sourceUrl,
      entry.sourcePlatform,
      entry.inputChannel,
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

export async function deleteEntry(entryId: string): Promise<void> {
  await query('DELETE FROM entries WHERE id = $1', [entryId]);
}

export async function deleteAllEntries(): Promise<number> {
  const result = await pool.query('DELETE FROM entries');
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

export interface FeaturesConfig {
  cobaltEnabled: boolean;
  allowDuplicateUrls: boolean;
  autoEnrichEnabled: boolean;
  mediaAnalysisEnabled: boolean;
  useVertexAi: boolean;
  transcriptionEnabled: boolean;
  aiAnalysisEnabled: boolean;
}

const DEFAULT_FEATURES: FeaturesConfig = {
  cobaltEnabled: false,
  allowDuplicateUrls: false,
  autoEnrichEnabled: false,
  mediaAnalysisEnabled: false,
  useVertexAi: false,
  transcriptionEnabled: true,
  aiAnalysisEnabled: true,
};

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

export interface ApiKeysConfig {
  keys: string[];
}

const DEFAULT_API_KEYS: ApiKeysConfig = { keys: [] };

export async function getApiKeysConfig(): Promise<ApiKeysConfig> {
  return { ...DEFAULT_API_KEYS, ...(await getConfig<Partial<ApiKeysConfig>>('apiKeys', {})) };
}

export async function updateApiKeysConfig(updates: Partial<ApiKeysConfig>): Promise<void> {
  await mergeConfig('apiKeys', updates, DEFAULT_API_KEYS);
}

// Prompts

export async function getPromptsConfig(): Promise<Record<string, string>> {
  return await getConfig<Record<string, string>>('prompts', {});
}

export async function setPromptsConfig(value: Record<string, string>): Promise<void> {
  await setConfig('prompts', value);
}
