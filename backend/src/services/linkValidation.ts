/**
 * Reject URLs that are not plausibly real.
 *
 * The main extraction pipeline guards against hallucinated links by requiring
 * the URL to appear literally in the source text. Suggested links cannot use
 * that check — the slide says "Plex" and the whole point is to resolve it to
 * plex.tv, an address that by definition is not in the source — so they need a
 * shape check instead.
 *
 * Note that `new URL()` alone is not enough: WHATWG happily parses
 * "https://..." with "..." as the hostname, which is exactly the placeholder a
 * model emits when it has nothing real to offer.
 */
export function isPlausibleUrl(input: string): boolean {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  // A real host has at least one dot separating labels, and no label may be
  // empty or made of dots ("...", "a..b", ".com").
  const labels = url.hostname.split('.');
  if (labels.length < 2) return false;
  return labels.every((label) => /^[a-z0-9-]+$/i.test(label));
}
