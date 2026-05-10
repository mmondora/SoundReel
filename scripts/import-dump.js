#!/usr/bin/env node
/* eslint-disable */
/**
 * Import Firestore dump (migration/*.json) into Postgres.
 * Usage:
 *   DB_HOST=localhost DB_PORT=5432 DB_PASSWORD=... node scripts/import-dump.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { Client } = require(path.resolve(__dirname, '../backend/node_modules/pg'));

const DUMP_DIR = path.resolve(__dirname, '../migration');

function unwrap(value) {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(unwrap);
  if (typeof value === 'object') {
    if (value.__type === 'timestamp') return value.iso;
    if (value.__type === 'geopoint') return { latitude: value.latitude, longitude: value.longitude };
    if (value.__type === 'docref') return value.path;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = unwrap(v);
    return out;
  }
  return value;
}

async function main() {
  const client = new Client({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT || 5432),
    database: process.env.DB_NAME || 'soundreel',
    user: process.env.DB_USER || 'soundreel',
    password: process.env.DB_PASSWORD || 'soundreel',
  });
  await client.connect();
  console.log('Connected to Postgres');

  const entriesPath = path.join(DUMP_DIR, 'entries.json');
  const configPath = path.join(DUMP_DIR, 'config.json');
  const logsPath = path.join(DUMP_DIR, 'logs.json');

  // Entries
  if (fs.existsSync(entriesPath)) {
    const entries = JSON.parse(fs.readFileSync(entriesPath, 'utf8'));
    console.log(`Importing ${entries.length} entries...`);
    for (const e of entries) {
      const d = unwrap(e.data) || {};
      const createdAt = d.createdAt || new Date().toISOString();
      const results = d.results || { songs: [], films: [], notes: [], links: [], tags: [], summary: null };
      const actionLog = d.actionLog || [];
      await client.query(
        `INSERT INTO entries (id, source_url, source_platform, input_channel, caption, thumbnail_url, media_url, status, results, action_log, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)
         ON CONFLICT (id) DO UPDATE SET
           source_url = EXCLUDED.source_url,
           source_platform = EXCLUDED.source_platform,
           input_channel = EXCLUDED.input_channel,
           caption = EXCLUDED.caption,
           thumbnail_url = EXCLUDED.thumbnail_url,
           media_url = EXCLUDED.media_url,
           status = EXCLUDED.status,
           results = EXCLUDED.results,
           action_log = EXCLUDED.action_log`,
        [
          e.id,
          d.sourceUrl || '',
          d.sourcePlatform || 'other',
          d.inputChannel || 'web',
          d.caption ?? null,
          d.thumbnailUrl ?? null,
          d.mediaUrl ?? null,
          d.status || 'completed',
          JSON.stringify(results),
          JSON.stringify(actionLog),
          createdAt,
        ]
      );
    }
    console.log(`Imported ${entries.length} entries`);
  }

  // Config (each doc id → config key)
  if (fs.existsSync(configPath)) {
    const configs = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    console.log(`Importing ${configs.length} config docs...`);
    for (const c of configs) {
      const value = unwrap(c.data) || {};
      await client.query(
        `INSERT INTO config (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [c.id, JSON.stringify(value)]
      );
    }
    console.log(`Imported config: ${configs.map((c) => c.id).join(', ')}`);
  }

  // Logs
  if (fs.existsSync(logsPath)) {
    const logs = JSON.parse(fs.readFileSync(logsPath, 'utf8'));
    console.log(`Importing ${logs.length} log entries (streaming)...`);
    let n = 0;
    for (const l of logs) {
      const d = unwrap(l.data) || {};
      const ts = d.timestamp || d.createdAt || new Date().toISOString();
      const level = (d.level || 'info').toLowerCase();
      const category = d.function || null;
      const entry_id = d.entryId || null;
      const message = d.message || '';
      const payload = {
        function: d.function,
        durationMs: d.durationMs ?? null,
        data: d.data ?? null,
        error: d.error ?? null,
      };
      await client.query(
        `INSERT INTO logs (ts, level, category, entry_id, message, data)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [ts, level, category, entry_id, message, JSON.stringify(payload)]
      );
      n++;
      if (n % 500 === 0) console.log(`  logs: ${n}/${logs.length}`);
    }
    console.log(`Imported ${n} logs`);
  }

  const { rows: counts } = await client.query(
    `SELECT
       (SELECT COUNT(*)::int FROM entries) AS entries,
       (SELECT COUNT(*)::int FROM config) AS config,
       (SELECT COUNT(*)::int FROM logs) AS logs`
  );
  console.log('Final counts:', counts[0]);

  await client.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
