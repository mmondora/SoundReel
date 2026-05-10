import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import path from 'path';
import {
  countEntries,
  countsByPlatform,
  countsByStatus,
  ageBuckets,
  allEntryIds,
  findEntriesByFilter,
  deleteEntriesByIds,
  getRetentionConfig,
  updateRetentionConfig,
  RetentionConfig,
} from '../utils/db';

const MEDIA_ROOT = process.env.MEDIA_ROOT || '/data/media';

interface EntryDirStat {
  entryId: string;
  bytes: number;
  files: number;
  mtime: string;
  orphan: boolean;
}

async function dirSize(dir: string): Promise<{ bytes: number; files: number; mtime: Date }> {
  let bytes = 0;
  let files = 0;
  let latest = new Date(0);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile()) {
        const s = await fs.stat(full);
        bytes += s.size;
        files += 1;
        if (s.mtime > latest) latest = s.mtime;
      } else if (e.isDirectory()) {
        const sub = await dirSize(full);
        bytes += sub.bytes;
        files += sub.files;
        if (sub.mtime > latest) latest = sub.mtime;
      }
    }
  } catch {
    // missing dir
  }
  return { bytes, files, mtime: latest };
}

async function scanMediaRoot(): Promise<EntryDirStat[]> {
  const ids = new Set(await allEntryIds());
  const results: EntryDirStat[] = [];
  try {
    const items = await fs.readdir(MEDIA_ROOT, { withFileTypes: true });
    for (const it of items) {
      if (!it.isDirectory()) continue;
      const entryId = it.name;
      const { bytes, files, mtime } = await dirSize(path.join(MEDIA_ROOT, entryId));
      results.push({
        entryId,
        bytes,
        files,
        mtime: mtime.toISOString(),
        orphan: !ids.has(entryId),
      });
    }
  } catch {
    // MEDIA_ROOT missing — fresh install
  }
  return results;
}

async function rmDirSafe(dir: string): Promise<void> {
  const absRoot = path.resolve(MEDIA_ROOT);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(absRoot + path.sep)) {
    throw new Error('rmDirSafe: path outside MEDIA_ROOT');
  }
  await fs.rm(resolved, { recursive: true, force: true });
}

export async function deleteEntryWithMedia(entryId: string): Promise<void> {
  await deleteEntriesByIds([entryId]);
  await rmDirSafe(path.join(MEDIA_ROOT, entryId));
}

export interface CleanupResult {
  orphanDirsDeleted: number;
  orphanBytesFreed: number;
  retentionEntriesDeleted: number;
  retentionDirsDeleted: number;
  retentionBytesFreed: number;
}

export async function runCleanup(now: Date = new Date()): Promise<CleanupResult> {
  const out: CleanupResult = {
    orphanDirsDeleted: 0,
    orphanBytesFreed: 0,
    retentionEntriesDeleted: 0,
    retentionDirsDeleted: 0,
    retentionBytesFreed: 0,
  };

  const retention = await getRetentionConfig();
  const stats = await scanMediaRoot();

  // Orphan cleanup: dir without matching DB entry + mtime older than orphanTtlDays
  const orphanCutoff = new Date(now.getTime() - retention.orphanTtlDays * 86_400_000);
  for (const s of stats) {
    if (!s.orphan) continue;
    const mtime = new Date(s.mtime);
    if (mtime > orphanCutoff) continue;
    try {
      await rmDirSafe(path.join(MEDIA_ROOT, s.entryId));
      out.orphanDirsDeleted += 1;
      out.orphanBytesFreed += s.bytes;
    } catch {
      // skip
    }
  }

  // Retention: delete entries older than retentionDays
  if (typeof retention.retentionDays === 'number' && retention.retentionDays > 0) {
    const toDelete = await findEntriesByFilter({ olderThanDays: retention.retentionDays });
    if (toDelete.length) {
      // Compute bytes before deleting
      const dirSizes = new Map<string, number>();
      for (const e of toDelete) {
        const d = await dirSize(path.join(MEDIA_ROOT, e.id));
        dirSizes.set(e.id, d.bytes);
      }
      const ids = toDelete.map((e) => e.id);
      out.retentionEntriesDeleted = await deleteEntriesByIds(ids);
      for (const id of ids) {
        try {
          await rmDirSafe(path.join(MEDIA_ROOT, id));
          out.retentionDirsDeleted += 1;
          out.retentionBytesFreed += dirSizes.get(id) || 0;
        } catch {
          // skip
        }
      }
    }
  }

  return out;
}

interface PurgeBody {
  platform?: string | null;
  status?: string | null;
  olderThanDays?: number | null;
  emptyResultsOnly?: boolean;
  dryRun?: boolean;
  confirm?: string; // must equal literal "YES" to execute non-dry
}

export function registerAdminRoutes(app: FastifyInstance): void {
  app.get('/api/admin/storage', async (_req, reply) => {
    const [total, perPlatform, perStatus, ageDist, dirStats] = await Promise.all([
      countEntries(),
      countsByPlatform(),
      countsByStatus(),
      ageBuckets(),
      scanMediaRoot(),
    ]);

    const totalBytes = dirStats.reduce((s, d) => s + d.bytes, 0);
    const totalFiles = dirStats.reduce((s, d) => s + d.files, 0);
    const orphanCount = dirStats.filter((d) => d.orphan).length;
    const orphanBytes = dirStats.filter((d) => d.orphan).reduce((s, d) => s + d.bytes, 0);

    const topLargest = [...dirStats]
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 20);

    reply.send({
      success: true,
      mediaRoot: MEDIA_ROOT,
      totals: {
        entries: total,
        mediaDirs: dirStats.length,
        mediaFiles: totalFiles,
        mediaBytes: totalBytes,
      },
      orphans: {
        count: orphanCount,
        bytes: orphanBytes,
      },
      byPlatform: perPlatform,
      byStatus: perStatus,
      byAge: ageDist,
      topLargest,
    });
  });

  app.post<{ Body: PurgeBody }>('/api/admin/purge', async (req, reply) => {
    const b = req.body || {};
    const dryRun = b.dryRun !== false && b.confirm !== 'YES';

    const candidates = await findEntriesByFilter({
      platform: b.platform || null,
      status: b.status || null,
      olderThanDays: typeof b.olderThanDays === 'number' ? b.olderThanDays : null,
      emptyResultsOnly: !!b.emptyResultsOnly,
    });

    if (dryRun) {
      // Compute bytes that would be freed
      let bytes = 0;
      for (const e of candidates.slice(0, 500)) {
        const d = await dirSize(path.join(MEDIA_ROOT, e.id));
        bytes += d.bytes;
      }
      reply.send({
        success: true,
        dryRun: true,
        wouldDelete: candidates.length,
        sampleBytesFreedFromFirst500: bytes,
        sample: candidates.slice(0, 20),
      });
      return;
    }

    const ids = candidates.map((e) => e.id);
    // Gather bytes for reporting
    let bytesFreed = 0;
    for (const id of ids) {
      const d = await dirSize(path.join(MEDIA_ROOT, id));
      bytesFreed += d.bytes;
    }
    const deleted = await deleteEntriesByIds(ids);
    let dirsDeleted = 0;
    for (const id of ids) {
      try {
        await rmDirSafe(path.join(MEDIA_ROOT, id));
        dirsDeleted += 1;
      } catch {
        // skip
      }
    }

    reply.send({
      success: true,
      dryRun: false,
      entriesDeleted: deleted,
      dirsDeleted,
      bytesFreed,
    });
  });

  app.post('/api/admin/cleanup-orphans', async (_req, reply) => {
    const result = await runCleanup();
    reply.send({ success: true, result });
  });

  app.get('/api/admin/retention', async (_req, reply) => {
    const cfg = await getRetentionConfig();
    reply.send({ success: true, config: cfg });
  });

  app.post<{ Body: Partial<RetentionConfig> }>('/api/admin/retention', async (req, reply) => {
    const b = req.body || {};
    const updates: Partial<RetentionConfig> = {};
    if (b.retentionDays === null || typeof b.retentionDays === 'number') {
      updates.retentionDays = b.retentionDays;
    }
    if (typeof b.orphanTtlDays === 'number' && b.orphanTtlDays >= 0) {
      updates.orphanTtlDays = b.orphanTtlDays;
    }
    await updateRetentionConfig(updates);
    const cfg = await getRetentionConfig();
    reply.send({ success: true, config: cfg });
  });
}
