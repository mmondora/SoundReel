import { isJunkSoftwareTitle } from './placeholderFilter';
import type { EnrichmentResult, SoftwareItem, SoftwareTag } from '../types';

const VALID_TAGS = new Set<SoftwareTag>(['repo', 'product', 'article', 'other']);

export function normalizeSoftwareTag(raw: string | null | undefined): SoftwareTag {
  if (!raw) return 'other';
  const t = raw.trim().toLowerCase();
  if (VALID_TAGS.has(t as SoftwareTag)) return t as SoftwareTag;
  return 'other';
}

/** Stable identity for a software mention: tag + normalized url or title. */
export function softwareKey(tag: string | null | undefined, title: string, url?: string | null): string {
  const normalizedTag = normalizeSoftwareTag(tag);
  const urlPart = (url ?? '').trim().toLowerCase().replace(/\/+$/, '');
  if (urlPart) return `${normalizedTag}::url::${urlPart}`;
  return `${normalizedTag}::title::${title.trim().toLowerCase()}`;
}

/**
 * Infer a software tag from a URL when the model did not classify it.
 * GitHub/GitLab/Codeberg → repo; otherwise other (product/article need AI).
 */
export function inferSoftwareTagFromUrl(url: string): SoftwareTag {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    if (
      host === 'github.com' ||
      host === 'gitlab.com' ||
      host === 'codeberg.org' ||
      host.endsWith('.github.io')
    ) {
      return 'repo';
    }
  } catch {
    /* ignore invalid URL */
  }
  return 'other';
}

/** Title hint from a GitHub-style path: github.com/owner/repo → owner/repo */
export function titleFromSoftwareUrl(url: string, fallbackLabel: string | null): string {
  if (fallbackLabel && fallbackLabel.trim()) return fallbackLabel.trim();
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const parts = u.pathname.split('/').filter(Boolean);
    if ((host === 'github.com' || host === 'gitlab.com' || host === 'codeberg.org') && parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    if (parts.length > 0) return parts[parts.length - 1];
    return host;
  } catch {
    return url;
  }
}

/** A name reduced to what identifies it: "Security-Audit Skill" and "security audit skill" are the same product. */
const nameKey = (name: string): string =>
  name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/g, '');

/**
 * The link of a software mention that the post did not give.
 *
 * "Commenta per il link alla repo" is the way many reels hand out a repository: the caption names the product and the
 * URL goes by direct message, so the analysis finds a title and no URL. But the entry's automatic enrichment
 * (`results.enrichments`) researches the same product and writes its links: on 8 November it had found
 * github.com/cloudflare/security-audit-skill for the "Security Audit Skill" of a Cloudflare reel while the Software page
 * showed nothing. That link is what makes a mention a repository that can be looked up (stars, description, creation date).
 *
 * The enrichment item must be about the same product: names match when one contains the other (at least 4 letters or
 * digits each, so "AI" never matches "Claude"). Only http(s) links; for a repository a code host wins over any other link.
 */
export function urlFromEnrichments(title: string, tag: SoftwareTag, enrichments: EnrichmentResult | null | undefined): string | null {
  const wanted = nameKey(title);
  if (wanted.length < 4) return null;
  const items = Array.isArray(enrichments?.items) ? enrichments.items : [];
  for (const item of items) {
    const label = nameKey(typeof item?.label === 'string' ? item.label : '');
    if (label.length < 4 || !(label === wanted || label.includes(wanted) || wanted.includes(label))) continue;
    const urls = (Array.isArray(item.links) ? item.links : [])
      .map((l) => (typeof l?.url === 'string' ? l.url.trim() : ''))
      .filter((u) => /^https?:\/\//i.test(u));
    const preferred = tag === 'repo' ? urls.find((u) => inferSoftwareTagFromUrl(u) === 'repo') : undefined;
    const chosen = preferred ?? urls[0];
    if (chosen) return chosen;
  }
  return null;
}

/**
 * The software an entry's own research is about.
 *
 * The local model's `software[]` is unreliable: the same reel gave 0 or 3 items depending on the sampling (measured on
 * 8 November, two runs per variant). The automatic enrichment is a different, steadier pass: when it classifies a post as
 * "tech" its items ARE the tools, repositories or products the post talks about, each with the links it researched. On
 * the Cloudflare reel it had found "Security Audit Skill" and its repository while the Software page showed nothing.
 *
 * Only a "tech" enrichment: for "claim", "security" or "generic" an item is a claim or a verdict, not a product. Only
 * items that have an http(s) link (a mention without one is not something a person can open); a code host makes it a
 * repository, anything else a product. The explicit items of `software[]` come first in the caller, so the same product
 * seen twice is one item (its key is the URL).
 */
export function softwareFromEnrichments(enrichments: EnrichmentResult | null | undefined): SoftwareItem[] {
  if (enrichments?.category !== 'tech' || !Array.isArray(enrichments.items)) return [];
  const out: SoftwareItem[] = [];
  for (const item of enrichments.items) {
    const title = typeof item?.label === 'string' ? item.label.trim() : '';
    if (title.length < 2) continue;
    const urls = (Array.isArray(item.links) ? item.links : [])
      .map((l) => (typeof l?.url === 'string' ? l.url.trim() : ''))
      .filter((u) => /^https?:\/\//i.test(u));
    if (urls.length === 0) continue;
    const codeHost = urls.find((u) => inferSoftwareTagFromUrl(u) === 'repo');
    out.push({
      title,
      url: codeHost ?? urls[0],
      tag: codeHost ? 'repo' : 'product',
      description: typeof item.explanation === 'string' && item.explanation.trim() ? item.explanation.trim() : null,
    });
  }
  return out;
}

export function isSoftwareItem(value: unknown): value is SoftwareItem {
  if (typeof value !== 'object' || value === null) return false;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' && title.trim().length > 0 && !isJunkSoftwareTitle(title);
}
