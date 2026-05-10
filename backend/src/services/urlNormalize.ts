const TRACKING_PARAM_PATTERNS: RegExp[] = [
  /^utm_/i,
  /^fbclid$/i,
  /^gclid$/i,
  /^mc_/i,
  /^igshid$/i,
  /^_ga$/i,
  /^ref$/i,
  /^ref_src$/i,
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
