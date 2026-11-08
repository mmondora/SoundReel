/**
 * Spotify link recognition — the single place that decides "is this a Spotify
 * track/album/playlist link, and what is its canonical form".
 *
 * Handles what people actually paste:
 *   https://open.spotify.com/track/ID?si=…&utm_source=copy-link
 *   https://open.spotify.com/intl-it/track/ID          (locale prefix)
 *   https://open.spotify.com/embed/track/ID
 *   spotify:track:ID                                    (URI)
 *   https://spotify.link/XXXX                           (Branch short link → resolved by redirect)
 *
 * Artist / show / episode / user links are NOT music Spooty can download, so
 * they are not Spotify refs here (they fall back to the generic page flow).
 */

export type SpotifyKind = 'track' | 'album' | 'playlist';

export interface SpotifyRef {
  kind: SpotifyKind;
  id: string;
  /** Canonical URL: no locale prefix, no query, no fragment. What we send to Spooty and match on. */
  url: string;
}

const ID_RE = /^[A-Za-z0-9]{10,32}$/;
const KINDS: readonly string[] = ['track', 'album', 'playlist'];

function build(kind: string, id: string): SpotifyRef | null {
  const k = kind.toLowerCase();
  if (!KINDS.includes(k) || !ID_RE.test(id)) return null;
  return { kind: k as SpotifyKind, id, url: `https://open.spotify.com/${k}/${id}` };
}

export function parseSpotifyLink(input: string): SpotifyRef | null {
  const s = (input ?? '').trim();
  if (!s) return null;

  const uri = /^spotify:(track|album|playlist):([A-Za-z0-9]+)$/i.exec(s);
  if (uri) return build(uri[1], uri[2]);

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.hostname.toLowerCase() !== 'open.spotify.com') return null;

  const parts = u.pathname.split('/').filter(Boolean);
  while (parts.length > 0 && (/^intl-[a-z]{2}(-[a-z]{2})?$/i.test(parts[0]) || parts[0].toLowerCase() === 'embed')) {
    parts.shift();
  }
  if (parts.length < 2) return null;
  return build(parts[0], parts[1]);
}

/** Canonical form of any Spotify URL/URI, or null if it is not a supported ref. */
export function canonicalSpotifyUrl(input: string): string | null {
  return parseSpotifyLink(input)?.url ?? null;
}

const SHORT_HOSTS = ['spotify.link', 'link.tospotify.com', 'spotify.app.link'];
// Hops we are willing to follow while resolving a short link (SSRF guard).
const HOP_HOSTS = [...SHORT_HOSTS, 'open.spotify.com'];

export function isSpotifyShortLink(input: string): boolean {
  try {
    const host = new URL((input ?? '').trim()).hostname.toLowerCase();
    return SHORT_HOSTS.includes(host);
  } catch {
    return false;
  }
}

/**
 * Follow a Spotify short link to its canonical open.spotify.com URL.
 * Only Spotify-owned hosts are ever fetched; any other hop aborts (no SSRF).
 */
export async function resolveSpotifyShortLink(
  input: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  let current = input.trim();
  for (let hop = 0; hop < 4; hop += 1) {
    let host: string;
    try {
      host = new URL(current).hostname.toLowerCase();
    } catch {
      return null;
    }
    if (!HOP_HOSTS.includes(host)) return null;
    const direct = canonicalSpotifyUrl(current);
    if (direct) return direct;

    let res: Response;
    try {
      res = await fetchImpl(current, { redirect: 'manual', signal: AbortSignal.timeout(6000) });
    } catch {
      return null;
    }
    const location = res.headers.get('location');
    if (location) {
      try {
        current = new URL(location, current).toString();
      } catch {
        return null;
      }
      continue;
    }
    // Some short links answer 200 with an HTML page that carries the target.
    const body = (await res.text().catch(() => '')).slice(0, 60_000);
    const m = /https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(?:track|album|playlist)\/[A-Za-z0-9]+/i.exec(body);
    return m ? canonicalSpotifyUrl(m[0]) : null;
  }
  return null;
}
