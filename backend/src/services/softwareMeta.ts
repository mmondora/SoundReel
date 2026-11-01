import type { SoftwareItem, SoftwareTag } from '../types';

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

export function isSoftwareItem(value: unknown): value is SoftwareItem {
  if (typeof value !== 'object' || value === null) return false;
  const title = (value as { title?: unknown }).title;
  return typeof title === 'string' && title.trim().length > 0;
}
