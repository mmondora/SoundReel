import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import {
  softwareKey,
  normalizeSoftwareTag,
  isSoftwareItem,
  inferSoftwareTagFromUrl,
  titleFromSoftwareUrl,
} from '../services/softwareMeta';
import {
  listSoftwareMeta,
  upsertSoftwareMeta,
  markSoftwareMetaChecked,
  isSoftwareMetaStale,
} from '../services/softwareMetaStore';
import { enrichRepoFromUrl, parseRepoUrl } from '../services/repoEnrichment';
import type {
  AggregatedSoftware,
  Entry,
  ExtractedLink,
  SoftwareItem,
  SoftwareMetaRecord,
} from '../types';
import { logError, logInfo, logWarning } from '../utils/logger';

export const LIST_ENTRIES_LIMIT = 10000;
/** Max forge lookups kicked off per GET (background). */
const ENRICH_BATCH = 8;

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

/** Explicit software[] from analysis, plus GitHub-like links harvested from results.links. */
export function collectSoftwareFromEntry(entry: Entry): SoftwareItem[] {
  const out: SoftwareItem[] = [];
  const seen = new Set<string>();

  const push = (item: SoftwareItem): void => {
    const key = softwareKey(item.tag, item.title, item.url);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(item);
  };

  for (const raw of entry.results?.software ?? []) {
    if (!isSoftwareItem(raw)) continue;
    const title = raw.title.trim();
    const url = typeof raw.url === 'string' && isHttpUrl(raw.url) ? raw.url.trim() : null;
    push({
      title,
      url,
      tag: normalizeSoftwareTag(raw.tag),
      description: typeof raw.description === 'string' ? raw.description : null,
    });
  }

  const linkCandidates: Array<{ url: string; label: string | null }> = [];
  const links: ExtractedLink[] = Array.isArray(entry.results?.links) ? entry.results.links : [];
  for (const link of links) {
    if (link?.url) linkCandidates.push({ url: link.url, label: link.label ?? link.title ?? null });
  }
  if (entry.sourceUrl) linkCandidates.push({ url: entry.sourceUrl, label: null });

  for (const link of linkCandidates) {
    if (!isHttpUrl(link.url)) continue;
    const tag = inferSoftwareTagFromUrl(link.url);
    // Only auto-harvest clear code hosts; product/article need explicit AI items.
    if (tag !== 'repo') continue;
    push({
      title: titleFromSoftwareUrl(link.url, link.label),
      url: link.url.trim(),
      tag,
      description: null,
    });
  }

  return out;
}

export function aggregateSoftware(
  entries: Entry[],
  metaMap: Map<string, SoftwareMetaRecord> = new Map(),
): Map<string, AggregatedSoftware> {
  const byKey = new Map<string, AggregatedSoftware>();
  const latestSeenCreatedAt = new Map<string, string>();

  for (const entry of entries) {
    const items = collectSoftwareFromEntry(entry);
    for (const item of items) {
      const key = softwareKey(item.tag, item.title, item.url);
      const createdAt = String(entry.createdAt ?? '');
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, {
          softwareKey: key,
          title: item.title,
          url: item.url,
          tag: item.tag,
          description: item.description ?? null,
          publishedAt: null,
          mentions: [{ entryId: entry.id, createdAt }],
        });
        latestSeenCreatedAt.set(key, createdAt);
      } else {
        existing.mentions.push({ entryId: entry.id, createdAt });
        const bestSoFar = latestSeenCreatedAt.get(key) ?? '';
        if (createdAt > bestSoFar) {
          existing.title = item.title;
          existing.url = item.url;
          existing.tag = item.tag;
          // Prefer a non-empty description from the newer mention.
          if (item.description) existing.description = item.description;
          latestSeenCreatedAt.set(key, createdAt);
        } else if (!existing.description && item.description) {
          existing.description = item.description;
        }
      }
    }
  }

  // Overlay forge meta: official description + repo creation date.
  for (const item of byKey.values()) {
    const meta = metaMap.get(item.softwareKey);
    if (!meta) continue;
    if (meta.description) item.description = meta.description;
    if (meta.publishedAt) item.publishedAt = meta.publishedAt;
  }

  return byKey;
}

async function enrichOneRepo(item: AggregatedSoftware): Promise<void> {
  if (item.tag !== 'repo' || !item.url || !parseRepoUrl(item.url)) {
    await markSoftwareMetaChecked(item.softwareKey);
    return;
  }
  try {
    const result = await enrichRepoFromUrl(item.url);
    if (!result) {
      await markSoftwareMetaChecked(item.softwareKey);
      return;
    }
    await upsertSoftwareMeta({
      softwareKey: item.softwareKey,
      description: result.description,
      publishedAt: result.publishedAt,
      host: result.host,
    });
    logInfo('Software repo enriched', {
      key: item.softwareKey,
      host: result.host,
      hasDescription: !!result.description,
      publishedAt: result.publishedAt,
    });
  } catch (err) {
    logWarning('Software repo enrichment failed', { key: item.softwareKey, error: String(err) });
    await markSoftwareMetaChecked(item.softwareKey).catch(() => undefined);
  }
}

/** Background fill for repos missing or stale forge meta. */
export function scheduleSoftwareEnrichment(
  items: AggregatedSoftware[],
  metaMap: Map<string, SoftwareMetaRecord>,
): void {
  const pending = items.filter(
    (item) =>
      item.tag === 'repo' &&
      !!item.url &&
      !!parseRepoUrl(item.url) &&
      isSoftwareMetaStale(metaMap.get(item.softwareKey)),
  );
  if (pending.length === 0) return;

  const batch = pending.slice(0, ENRICH_BATCH);
  void (async () => {
    for (const item of batch) {
      await enrichOneRepo(item);
    }
  })().catch((err) => logWarning('Software enrichment batch failed', { error: String(err) }));
}

export function registerSoftwareRoutes(app: FastifyInstance): void {
  app.get('/api/software', async (_req, reply) => {
    try {
      const [entries, metaMap] = await Promise.all([
        listEntries(LIST_ENTRIES_LIMIT),
        listSoftwareMeta(),
      ]);
      const byKey = aggregateSoftware(entries, metaMap);
      const software = [...byKey.values()];
      scheduleSoftwareEnrichment(software, metaMap);
      return reply.send({ software });
    } catch (err) {
      logError('GET /api/software failed', { err: String(err) });
      return reply.code(500).send({ error: 'software aggregation failed' });
    }
  });
}
