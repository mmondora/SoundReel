/**
 * Shazam link recognition and page reading — the single place that decides "is this
 * a Shazam song link", what its canonical form is, and what song it points to.
 *
 * What people actually paste (Shazam app → Share, or the browser's address bar):
 *   https://www.shazam.com/track/404798580?referrer=share      (Shazam track key)
 *   https://www.shazam.com/it-it/track/404798580/white-flag    (locale prefix, slug)
 *   https://www.shazam.com/song/1360212103/white-flag          (Apple Music adam id + slug)
 *
 * Not songs, so not Shazam refs here (they fall back to the generic page flow): artist / chart /
 * discovery pages, and `/song/<id>` without its slug (Shazam answers those with 204 No Content).
 *
 * Reading the song (no API, no key): the song page carries a schema.org `MusicRecording`
 * JSON-LD block. Verified 2026-11-07 against the live site:
 *   - `/track/<key>` answers 301 → `/song/<adamId>/<slug>` ONLY to a bot-style User-Agent.
 *     To browser-like agents (and plain `node`) it answers 200 with a generic page about a
 *     DIFFERENT song. Saving that would silently attach the wrong song to the entry, so the
 *     page identity is always checked against the URL we landed on, and a mismatch is an error.
 *   - the page has no link to Spotify (only Apple Music): the MP3 comes later from a
 *     YouTube search, same as any song without a Spotify link.
 *   - `shz.am` short links do not resolve (no DNS), so they are not supported.
 */

export type ShazamKind = 'track' | 'song';

export interface ShazamRef {
  kind: ShazamKind;
  id: string;
  /** `/song/<adamId>/<slug>` needs its slug (Shazam: bare id → 204, wrong slug → 404); `/track/<key>` has none. */
  slug: string | null;
  /** Canonical URL: no locale prefix, sub-page, query or fragment. What we fetch and match on. */
  url: string;
}

const PAGE_HOSTS: ReadonlySet<string> = new Set(['shazam.com', 'www.shazam.com']);
const LOCALE_RE = /^[a-z]{2}(?:-[a-z]{2})?$/i;
const ID_RE = /^\d{1,20}$/;
const SLUG_RE = /^[\w%.~-]{1,200}$/;

export function parseShazamLink(input: string): ShazamRef | null {
  const s = (input ?? '').trim();
  if (!s) return null;

  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!PAGE_HOSTS.has(u.hostname.toLowerCase())) return null;

  const parts = u.pathname.split('/').filter(Boolean);
  if (parts.length > 0 && LOCALE_RE.test(parts[0])) parts.shift();
  if (parts.length < 2) return null;

  const kind = parts[0].toLowerCase();
  const id = parts[1];
  if ((kind !== 'track' && kind !== 'song') || !ID_RE.test(id)) return null;

  if (kind === 'track') {
    // The slug is cosmetic here: Shazam redirects /track/<key> to the canonical /song page by itself.
    return { kind, id, slug: null, url: `https://www.shazam.com/track/${id}` };
  }
  const slug = parts[2];
  if (!slug || !SLUG_RE.test(slug)) return null;
  return { kind, id, slug, url: `https://www.shazam.com/song/${id}/${slug}` };
}

/** Canonical form of any Shazam song URL, or null if it is not a supported ref. */
export function canonicalShazamUrl(input: string): string | null {
  return parseShazamLink(input)?.url ?? null;
}

// ---------------------------------------------------------------------------
// Page parsing (pure)
// ---------------------------------------------------------------------------

export interface ShazamPageInfo {
  title: string;
  artist: string;
  album: string | null;
  coverUrl: string | null;
  /** The page's own URL (JSON-LD `url` / `@id`, else og:url): what identifies the song. */
  pageUrl: string | null;
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

const text = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/** schema.org names come as "Name", {name}, or a list of either. */
function nameOf(value: unknown): string | null {
  if (Array.isArray(value)) {
    const names = value.map(nameOf).filter((n): n is string => n !== null);
    return names.length ? names.join(', ') : null;
  }
  if (value && typeof value === 'object') return text((value as Record<string, unknown>).name);
  return text(value);
}

const httpUrl = (value: unknown): string | null => {
  const s = text(value);
  return s && /^https?:\/\//i.test(s) ? s : null;
};

function metaContent(html: string, key: string): string | null {
  for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of tag[0].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? '';
    }
    const name = (attrs.property ?? attrs.name ?? '').toLowerCase();
    if (name === key && attrs.content !== undefined) return text(decodeEntities(attrs.content));
  }
  return null;
}

/** Root-level JSON-LD objects only (plus `@graph`): nested lists such as `citation[]` are OTHER songs. */
function jsonLdRoots(html: string): Array<Record<string, unknown>> {
  const roots: Array<Record<string, unknown>> = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      roots.push(obj);
      if (Array.isArray(obj['@graph'])) visit(obj['@graph']);
    }
  };
  for (const block of html.matchAll(/<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      visit(JSON.parse(block[1]));
    } catch {
      /* a broken block must not hide a good one */
    }
  }
  return roots;
}

const isRecording = (obj: Record<string, unknown>): boolean => {
  const type = obj['@type'];
  return type === 'MusicRecording' || (Array.isArray(type) && type.includes('MusicRecording'));
};

/** "Title - Artist: Song Lyrics, Music Videos & Concerts" (the suffix has no colon). */
function fromOgTitle(html: string): { title: string; artist: string } | null {
  const raw = metaContent(html, 'og:title') ?? text(decodeEntities(/<title>([^<]*)<\/title>/i.exec(html)?.[1] ?? ''));
  if (!raw) return null;
  const m = /^(.+) - (.+?):\s[^:]+$/.exec(raw);
  const title = m ? text(m[1]) : null;
  const artist = m ? text(m[2]) : null;
  return title && artist ? { title, artist } : null;
}

export function parseShazamPage(html: string): ShazamPageInfo | null {
  if (!html) return null;
  const cover = httpUrl(metaContent(html, 'og:image'));
  const ogUrl = text(metaContent(html, 'og:url'));

  const recording = jsonLdRoots(html).find((r) => isRecording(r) && text(r.name));
  if (recording) {
    const title = text(recording.name);
    const artist = nameOf(recording.byArtist) ?? nameOf(recording.creator);
    if (title && artist) {
      const thumb = recording.thumbnail as Record<string, unknown> | undefined;
      return {
        title,
        artist,
        album: nameOf(recording.inAlbum),
        coverUrl: cover ?? httpUrl(recording.thumbnailUrl) ?? httpUrl(thumb?.url),
        pageUrl: text(recording.url) ?? text(recording['@id']) ?? ogUrl,
      };
    }
  }

  const og = fromOgTitle(html);
  return og ? { title: og.title, artist: og.artist, album: null, coverUrl: cover, pageUrl: ogUrl } : null;
}

// ---------------------------------------------------------------------------
// Fetching (SSRF-safe, bounded, identity-checked)
// ---------------------------------------------------------------------------

/**
 * Do not change without re-verifying against the live site: bot-style agents get the canonical
 * redirect and the right page, browser-like ones get a generic page about another song.
 */
export const SHAZAM_USER_AGENT = 'SoundReel/2.6 (+https://soundreel.casamon.dev)';

const MAX_REDIRECTS = 4;
const FETCH_TIMEOUT_MS = 12_000;
// The real page is ~1 MB; the JSON-LD block ends ~135 KB in. Stop reading as soon as it is complete.
const MAX_BYTES = 1_500_000;

export type ShazamFetchErrorCode = 'network' | 'status' | 'host' | 'redirect' | 'mismatch' | 'parse';

export class ShazamFetchError extends Error {
  constructor(
    readonly code: ShazamFetchErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ShazamFetchError';
  }
}

export interface ShazamTrackInfo extends Omit<ShazamPageInfo, 'pageUrl'> {
  pageUrl: string;
}

function assertShazamHost(url: string): void {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new ShazamFetchError('redirect', 'URL di redirect non valida');
  }
  if (u.protocol !== 'https:' || !PAGE_HOSTS.has(u.hostname.toLowerCase())) {
    throw new ShazamFetchError('host', `Redirect fuori da shazam.com rifiutato (${u.hostname})`);
  }
}

const hasCompleteJsonLd = (html: string): boolean => {
  const start = html.indexOf('application/ld+json');
  return start >= 0 && html.indexOf('</script>', start) >= 0;
};

async function readHead(res: Response): Promise<string> {
  if (!res.body) return (await res.text()).slice(0, MAX_BYTES);
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let html = '';
  let bytes = 0;
  try {
    while (bytes < MAX_BYTES) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (hasCompleteJsonLd(html)) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return html;
}

/** The page must be the song we asked for: its own URL has to match where we landed. */
function verifyIdentity(ref: ShazamRef, finalUrl: string, info: ShazamPageInfo): ShazamTrackInfo {
  const page = info.pageUrl ? parseShazamLink(info.pageUrl) : null;
  const landed = parseShazamLink(finalUrl);
  const consistent =
    page !== null &&
    landed !== null &&
    info.pageUrl !== null &&
    page.kind === 'song' &&
    landed.kind === 'song' &&
    page.id === landed.id &&
    (ref.kind !== 'song' || ref.id === landed.id);
  if (!consistent || info.pageUrl === null) {
    throw new ShazamFetchError('mismatch', 'Shazam ha risposto con la pagina di un altro brano');
  }
  return { ...info, pageUrl: info.pageUrl };
}

/**
 * Read the song behind a Shazam ref. Only shazam.com over https is ever fetched, every redirect hop
 * is re-checked, the body read is bounded. Throws `ShazamFetchError` (never returns a wrong song).
 */
export async function fetchShazamTrack(ref: ShazamRef, fetchImpl: typeof fetch = fetch): Promise<ShazamTrackInfo> {
  let current = ref.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    assertShazamHost(current);

    let res: Response;
    try {
      res = await fetchImpl(current, {
        redirect: 'manual',
        headers: { 'User-Agent': SHAZAM_USER_AGENT, Accept: 'text/html', 'Accept-Language': 'en' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new ShazamFetchError('network', err instanceof Error ? err.message : String(err));
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) throw new ShazamFetchError('redirect', `HTTP ${res.status} senza Location`);
      try {
        current = new URL(location, current).toString();
      } catch {
        throw new ShazamFetchError('redirect', 'Location non valida');
      }
      continue;
    }

    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new ShazamFetchError('status', `Shazam ha risposto HTTP ${res.status}`);
    }

    let html: string;
    try {
      html = await readHead(res);
    } catch (err) {
      throw new ShazamFetchError('network', err instanceof Error ? err.message : String(err));
    }

    const info = parseShazamPage(html);
    if (!info) throw new ShazamFetchError('parse', 'Nessun brano riconoscibile nella pagina Shazam');
    return verifyIdentity(ref, current, info);
  }
  throw new ShazamFetchError('redirect', 'Troppi redirect');
}
