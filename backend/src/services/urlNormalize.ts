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

/**
 * The identity of a POST across the ways its address can be written: the Instagram shortcode, the YouTube video id
 * (`watch?v=`, `youtu.be/`, `shorts/`), the TikTok video id, the X/Twitter status id, the Reddit post id; for anything
 * else the normalized URL. Two addresses of the same post have the same key, which is what an entry must be unique on
 * (spec 2026-11-08-no-duplicates-and-post-links, D2; ADR-0017).
 */
export function postKey(input: string): string {
  const ig = extractInstagramShortcode(input);
  if (ig) return `instagram:${ig}`;
  try {
    const u = new URL(input.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const path = u.pathname;
    if (host === 'youtu.be') {
      const id = path.slice(1).split('/')[0];
      if (id) return `youtube:${id}`;
    }
    if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
      const v = u.searchParams.get('v');
      if (v) return `youtube:${v}`;
      const m = path.match(/^\/(shorts|live|embed)\/([\w-]+)/);
      if (m) return `youtube:${m[2]}`;
    }
    const tiktok = path.match(/\/video\/(\d+)/);
    if ((host === 'tiktok.com' || host.endsWith('.tiktok.com')) && tiktok) return `tiktok:${tiktok[1]}`;
    const status = path.match(/\/status\/(\d+)/);
    if ((host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) && status) return `x:${status[1]}`;
    const reddit = path.match(/\/comments\/(\w+)/);
    if ((host === 'reddit.com' || host.endsWith('.reddit.com')) && reddit) return `reddit:${reddit[1]}`;
  } catch {
    /* not a URL: fall through to the normalized text */
  }
  return `url:${normalizeUrl(input)}`;
}
