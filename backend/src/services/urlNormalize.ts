const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_/i,
  /^igshid$/i,
  /^igsh$/i,
  /^igsi$/i,
  /^_ga$/i,
  /^ref$/i,
  /^ref_src$/i,
  // Instagram share / deep-link junk: the param *name* rotates per share
  // (mdxt, obrf, srtk, …) while the shortcode stays the same. Leaving them
  // made `/?mdxt=…` and `/?obrf=…` look like different posts.
  /^mdxt$/i,
  /^obrf$/i,
  /^srtk$/i,
  /^exln$/i,
  /^vrfl$/i,
  /^rpxt$/i,
  /^cplk$/i,
  /^dlrf$/i,
  /^psln$/i,
  /^xtok$/i,
  /^stkn$/i,
  /^img_index$/i,
];

/**
 * Normalize a URL for idempotency comparison and storage.
 * - Lowercase host.
 * - Strip well-known tracking query params.
 * - Drop the URL fragment.
 * - Remove a single trailing slash from the path (but keep "/" as-is).
 */
export function normalizeUrl(input: string): string {
  let parsed: URL;
  try {
    parsed = new URL(input.trim());
  } catch {
    return input.trim();
  }

  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.hash = '';

  const keep: [string, string][] = [];
  for (const [k, v] of parsed.searchParams.entries()) {
    if (!TRACKING_PARAM_PATTERNS.some((re) => re.test(k))) {
      keep.push([k, v]);
    }
  }
  parsed.search = '';
  for (const [k, v] of keep) parsed.searchParams.append(k, v);

  if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
    parsed.pathname = parsed.pathname.slice(0, -1);
  }

  return parsed.toString();
}

/**
 * Instagram post/reel/TV shortcode from a path like `/p/DfM5C7FjfzZ/` or
 * `/reel/abc123`. Null when the URL is not an Instagram content link.
 */
export function extractInstagramShortcode(input: string): string | null {
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    if (host !== 'instagram.com' && host !== 'instagr.am') return null;
    const m = u.pathname.match(/^\/(p|reel|tv|reels)\/([A-Za-z0-9_-]+)/i);
    return m ? m[2] : null;
  } catch {
    return null;
  }
}
