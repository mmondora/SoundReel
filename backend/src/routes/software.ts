import type { FastifyInstance } from 'fastify';
import { listEntries } from '../utils/db';
import {
  softwareKey,
  normalizeSoftwareTag,
  isSoftwareItem,
  inferSoftwareTagFromUrl,
  titleFromSoftwareUrl,
} from '../services/softwareMeta';
import type { AggregatedSoftware, Entry, ExtractedLink, SoftwareItem } from '../types';
import { logError } from '../utils/logger';

export const LIST_ENTRIES_LIMIT = 10000;

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

export function aggregateSoftware(entries: Entry[]): Map<string, AggregatedSoftware> {
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
          existing.description = item.description ?? null;
          latestSeenCreatedAt.set(key, createdAt);
        }
      }
    }
  }

  return byKey;
}

export function registerSoftwareRoutes(app: FastifyInstance): void {
  app.get('/api/software', async (_req, reply) => {
    try {
      const entries = await listEntries(LIST_ENTRIES_LIMIT);
      const byKey = aggregateSoftware(entries);
      return reply.send({ software: [...byKey.values()] });
    } catch (err) {
      logError('GET /api/software failed', { err: String(err) });
      return reply.code(500).send({ error: 'software aggregation failed' });
    }
  });
}
