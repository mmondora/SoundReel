import { query } from '../utils/db';
import type { SoftwareMetaRecord } from '../types';

interface SoftwareMetaRow {
  software_key: string;
  description: string | null;
  published_at: Date | null;
  host: string | null;
  enriched_at: Date | null;
}

function rowToRecord(row: SoftwareMetaRow): SoftwareMetaRecord {
  return {
    softwareKey: row.software_key,
    description: row.description,
    publishedAt: row.published_at ? row.published_at.toISOString() : null,
    host: row.host,
    enrichedAt: row.enriched_at ? row.enriched_at.toISOString() : null,
  };
}

const SELECT_COLS = 'software_key, description, published_at, host, enriched_at';

export async function listSoftwareMeta(): Promise<Map<string, SoftwareMetaRecord>> {
  const rows = await query<SoftwareMetaRow>(`SELECT ${SELECT_COLS} FROM software_meta`);
  const map = new Map<string, SoftwareMetaRecord>();
  for (const row of rows) map.set(row.software_key, rowToRecord(row));
  return map;
}

export async function getSoftwareMeta(key: string): Promise<SoftwareMetaRecord | null> {
  const rows = await query<SoftwareMetaRow>(
    `SELECT ${SELECT_COLS} FROM software_meta WHERE software_key = $1`,
    [key],
  );
  return rows[0] ? rowToRecord(rows[0]) : null;
}

export async function upsertSoftwareMeta(input: {
  softwareKey: string;
  description: string | null;
  publishedAt: string | null;
  host: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO software_meta (software_key, description, published_at, host, enriched_at)
     VALUES ($1, $2, $3::timestamptz, $4, now())
     ON CONFLICT (software_key) DO UPDATE SET
       description = EXCLUDED.description,
       published_at = EXCLUDED.published_at,
       host = EXCLUDED.host,
       enriched_at = now(),
       updated_at = now()`,
    [input.softwareKey, input.description, input.publishedAt, input.host],
  );
}

/** Mark a failed/empty lookup so we do not hammer the forge on every GET. */
export async function markSoftwareMetaChecked(softwareKey: string): Promise<void> {
  await query(
    `INSERT INTO software_meta (software_key, description, published_at, host, enriched_at)
     VALUES ($1, NULL, NULL, NULL, now())
     ON CONFLICT (software_key) DO UPDATE SET
       enriched_at = now(),
       updated_at = now()`,
    [softwareKey],
  );
}

const STALE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

export function isSoftwareMetaStale(meta: SoftwareMetaRecord | null | undefined): boolean {
  if (!meta?.enrichedAt) return true;
  const t = Date.parse(meta.enrichedAt);
  if (Number.isNaN(t)) return true;
  return Date.now() - t > STALE_MS;
}
