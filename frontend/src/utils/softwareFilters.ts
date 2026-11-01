import type { AggregatedSoftware, SoftwareTag } from '../types';

export type SoftwareSortMode = 'date' | 'mentions' | 'title';

export interface SoftwareFilterOptions {
  tags: SoftwareTag[];
  text?: string;
}

const CANONICAL_TAG_ORDER: SoftwareTag[] = ['repo', 'product', 'article', 'other'];

export function collectSoftwareTags(items: AggregatedSoftware[]): SoftwareTag[] {
  const present = new Set<SoftwareTag>();
  for (const item of items) present.add(item.tag);
  return CANONICAL_TAG_ORDER.filter((t) => present.has(t));
}

export function filterSoftware(
  items: AggregatedSoftware[],
  opts: SoftwareFilterOptions
): AggregatedSoftware[] {
  const query = opts.text?.trim().toLowerCase() ?? '';
  return items.filter((item) => {
    if (opts.tags.length > 0 && !opts.tags.includes(item.tag)) return false;
    if (query) {
      const haystack = [item.title, item.description, item.url];
      if (!haystack.some((f) => f != null && f.toLowerCase().includes(query))) return false;
    }
    return true;
  });
}

function latestMentionTime(item: AggregatedSoftware): number {
  return item.mentions[0] ? new Date(item.mentions[0].createdAt).getTime() : 0;
}

export function sortSoftware(items: AggregatedSoftware[], mode: SoftwareSortMode): AggregatedSoftware[] {
  const byDate = (a: AggregatedSoftware, b: AggregatedSoftware) => latestMentionTime(b) - latestMentionTime(a);
  const sorted = [...items];
  if (mode === 'mentions') {
    sorted.sort((a, b) => b.mentions.length - a.mentions.length || byDate(a, b));
  } else if (mode === 'title') {
    sorted.sort((a, b) => a.title.localeCompare(b.title) || byDate(a, b));
  } else {
    sorted.sort(byDate);
  }
  return sorted;
}
