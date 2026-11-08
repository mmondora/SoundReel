/**
 * The home media server (the FRITZ!Box, DLNA): where the replica of the music library lives and how we
 * learn what is on it. No SMB mount is involved — everything here is plain HTTP, so a dead or sleeping
 * box costs a timeout, never a hung container.
 *
 *   - catalogue: DLNA ContentDirectory `Search` (6449 items in ~30 s) → `media_index`
 *   - direct URLs: `<fileBase>/<path relative to the volume>`, verified with a HEAD before a client is
 *     ever pointed at one (`song_files.media_url`)
 *   - the replica itself is written by scripts/fritz-sync.sh (rsync to Music/SoundReel/)
 */
import { logInfo, logWarning } from '../utils/logger';
import { countMediaIndex, isJunk, replaceMediaIndex, sampleMediaIndexPath, type IndexItem } from './mediaIndex';
import {
  clearPublished,
  listPublishedOlderThan,
  listReadyUnpublished,
  markPublished,
  resetToQueued,
  type SongFile,
} from './songFiles';

export const MEDIA_STORE = 'fritz';

/** A catalogue smaller than this share of the known one is "the volume is gone", not "somebody tidied up". */
export const MIN_KEEP_RATIO = 0.5;
/** Below this many known files (a fresh install, a tiny library) the guard does not apply. */
export const MIN_INDEX_TO_GUARD = 50;

export interface MediaServerConfig {
  enabled: boolean;
  /** UPnP ContentDirectory control endpoint. */
  controlUrl: string;
  /** Base of the direct file URLs (everything before the volume-relative path). */
  fileBase: string;
  /** Folder on the volume that holds the replica of the library (`Music/SoundReel`). */
  replicaRoot: string;
}

export function mediaServerConfig(env: NodeJS.ProcessEnv = process.env): MediaServerConfig {
  return {
    enabled: !['0', 'false', 'off'].includes((env.MEDIA_SERVER_ENABLED ?? '').toLowerCase()),
    controlUrl: env.MEDIA_SERVER_CONTROL_URL || 'http://192.168.178.10:49000/MediaServer/ContentDirectory/Control',
    fileBase: (env.MEDIA_SERVER_FILE_BASE || 'http://192.168.178.10:49200/AUDIO/DLNA-1-0').replace(/\/+$/, ''),
    replicaRoot: (env.MEDIA_REPLICA_ROOT || 'Music/SoundReel').replace(/^\/+|\/+$/g, ''),
  };
}

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

const encodePath = (rel: string): string => rel.split('/').map(encodeURIComponent).join('/');

export function mediaUrlForVolumePath(volumeRel: string, cfg: MediaServerConfig = mediaServerConfig()): string {
  return `${cfg.fileBase}/${encodePath(volumeRel)}`;
}

/** Where a library file (path relative to /music) sits on the media server's volume. */
export function replicaVolumePath(libRel: string, cfg: MediaServerConfig = mediaServerConfig()): string {
  return `${cfg.replicaRoot}/${libRel}`;
}

export function volumePathFromUrl(url: string, cfg: MediaServerConfig = mediaServerConfig()): string | null {
  if (!url.startsWith(`${cfg.fileBase}/`)) return null;
  try {
    return url
      .slice(cfg.fileBase.length + 1)
      .split('/')
      .map(decodeURIComponent)
      .join('/');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// DIDL-Lite parsing (small and purpose-built: the box's output is regular)
// ---------------------------------------------------------------------------

export interface DlnaItem {
  title: string;
  artist: string;
  album: string | null;
  durationS: number | null;
  bytes: number | null;
  url: string;
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (whole, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return XML_ENTITIES[e.toLowerCase()] ?? whole;
  });
}

const textOf = (xml: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]).trim() || null : null;
};

function artistOf(item: string): string {
  const performer = /<upnp:artist\s+role="Performer"[^>]*>([^<]*)<\/upnp:artist>/.exec(item);
  if (performer?.[1].trim()) return unescapeXml(performer[1]).trim();
  const creator = textOf(item, 'dc:creator');
  if (creator) return creator;
  return textOf(item, 'upnp:artist') ?? '';
}

/** "0:03:50.000" → 230; the box reports 0 when it does not know. */
export function parseDlnaDuration(raw: string | undefined): number | null {
  const m = /^(\d+):(\d{2}):(\d{2})(?:\.\d+)?$/.exec((raw ?? '').trim());
  if (!m) return null;
  const secs = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return secs > 0 ? secs : null;
}

export function parseDidl(didl: string): DlnaItem[] {
  const out: DlnaItem[] = [];
  for (const m of didl.matchAll(/<item\b[\s\S]*?<\/item>/g)) {
    const item = m[0];
    const res = /<res\b([^>]*)>([^<]*)<\/res>/.exec(item);
    if (!res) continue;
    const attr = (name: string): string | undefined => new RegExp(`${name}="([^"]*)"`).exec(res[1])?.[1];
    const size = Number(attr('size'));
    out.push({
      title: textOf(item, 'dc:title') ?? '',
      artist: artistOf(item),
      album: textOf(item, 'upnp:album'),
      durationS: parseDlnaDuration(attr('duration')),
      bytes: Number.isFinite(size) && size > 0 ? size : null,
      url: unescapeXml(res[2]).trim(),
    });
  }
  return out;
}

export interface SearchPage {
  items: DlnaItem[];
  numberReturned: number;
  totalMatches: number;
}

export function parseSearchResponse(soapXml: string): SearchPage {
  const result = /<Result>([\s\S]*?)<\/Result>/.exec(soapXml);
  const didl = result ? unescapeXml(result[1]) : '';
  const num = (tag: string): number => Number(new RegExp(`<${tag}>(\\d+)</${tag}>`).exec(soapXml)?.[1] ?? 0);
  return { items: parseDidl(didl), numberReturned: num('NumberReturned'), totalMatches: num('TotalMatches') };
}

// ---------------------------------------------------------------------------
// Catalogue scan → media_index
// ---------------------------------------------------------------------------

const SEARCH_CRITERIA = 'upnp:class derivedfrom "object.item.audioItem"';

function searchEnvelope(start: number, count: number): string {
  return (
    '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>' +
    '<u:Search xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ContainerID>0</ContainerID>' +
    `<SearchCriteria>${SEARCH_CRITERIA.replace(/"/g, '&quot;')}</SearchCriteria>` +
    '<Filter>dc:title,dc:creator,upnp:artist,upnp:album,res,res@size,res@duration</Filter>' +
    `<StartingIndex>${start}</StartingIndex><RequestedCount>${count}</RequestedCount><SortCriteria></SortCriteria>` +
    '</u:Search></s:Body></s:Envelope>'
  );
}

export async function scanMediaServer(
  cfg: MediaServerConfig = mediaServerConfig(),
  fetchImpl: typeof fetch = fetch,
  options: { pageSize?: number; maxItems?: number } = {},
): Promise<DlnaItem[]> {
  const pageSize = options.pageSize ?? 200;
  const maxItems = options.maxItems ?? 50_000;
  const items: DlnaItem[] = [];
  let start = 0;
  for (;;) {
    const res = await fetchImpl(cfg.controlUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset="utf-8"',
        SOAPAction: '"urn:schemas-upnp-org:service:ContentDirectory:1#Search"',
      },
      body: searchEnvelope(start, pageSize),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`media server: HTTP ${res.status}`);
    const page = parseSearchResponse(await res.text());
    items.push(...page.items);
    start += page.numberReturned;
    if (page.numberReturned === 0 || start >= page.totalMatches || items.length >= maxItems) break;
  }
  return items;
}

/** DLNA item → index row; null for what is not a usable song file. */
export function toIndexItem(item: DlnaItem, cfg: MediaServerConfig = mediaServerConfig()): IndexItem | null {
  const relPath = volumePathFromUrl(item.url, cfg);
  if (!relPath || !item.artist || !item.title) return null;
  const row: IndexItem = {
    store: MEDIA_STORE,
    relPath,
    artist: item.artist,
    title: item.title,
    album: item.album,
    durationS: item.durationS,
    bytes: item.bytes,
  };
  return isJunk(row) ? null : row;
}

export interface MediaServerStatus {
  enabled: boolean;
  reachable: boolean | null;
  lastIndexAt: string | null;
  lastIndexCount: number | null;
  lastIndexError: string | null;
  lastReconcileAt: string | null;
  lastReconcile: { verified: number; dropped: number; pending: number } | null;
  /** The box answers but its media volume (the USB drive) looks gone: nothing is erased or dropped meanwhile. */
  volumeMissing: boolean;
}

const status: MediaServerStatus = {
  enabled: false,
  reachable: null,
  lastIndexAt: null,
  lastIndexCount: null,
  lastIndexError: null,
  lastReconcileAt: null,
  lastReconcile: null,
  volumeMissing: false,
};

export function getMediaServerStatus(): MediaServerStatus {
  return { ...status, enabled: mediaServerConfig().enabled };
}

export async function refreshMediaIndex(
  cfg: MediaServerConfig = mediaServerConfig(),
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  try {
    const scanned = await scanMediaServer(cfg, fetchImpl);
    const rows = scanned.map((i) => toIndexItem(i, cfg)).filter((r): r is IndexItem => r !== null);
    // The USB drive of the box can be unplugged (it is also the car's drive): the box then keeps answering, with a
    // catalogue of a handful of entries. Replacing the index with that would erase everything we know about it.
    const previous = await countMediaIndex(MEDIA_STORE);
    if (previous >= MIN_INDEX_TO_GUARD && rows.length < previous * MIN_KEEP_RATIO) {
      status.reachable = true;
      status.volumeMissing = true;
      status.lastIndexAt = new Date().toISOString();
      status.lastIndexError = `catalogo del media server ridotto (${rows.length} voci contro ${previous}): chiavetta scollegata? indice non sostituito`;
      logWarning('media_index NOT replaced: the catalogue collapsed', { scanned: scanned.length, usable: rows.length, previous });
      return previous;
    }
    status.volumeMissing = false;
    const count = await replaceMediaIndex(MEDIA_STORE, rows);
    status.reachable = true;
    status.lastIndexAt = new Date().toISOString();
    status.lastIndexCount = count;
    status.lastIndexError = null;
    logInfo('media_index refreshed', { scanned: scanned.length, indexed: count });
    return count;
  } catch (err) {
    status.reachable = false;
    status.lastIndexAt = new Date().toISOString();
    status.lastIndexError = err instanceof Error ? err.message : String(err);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Replica verification
// ---------------------------------------------------------------------------

export type VerifyResult = { ok: true } | { ok: false; reason: 'missing' | 'size' | 'network' };

export type HeadResult =
  /** There; `bytes` / `lastModifiedMs` are null when the box does not say. */
  | { kind: 'ok'; bytes: number | null; lastModifiedMs: number | null }
  | { kind: 'missing' }
  /** Dead or sleeping box, or any answer that says nothing about the file. */
  | { kind: 'unreachable' };

/** HEAD a file on the media server (a one-byte range request when the box refuses HEAD). Never throws. */
export async function headMediaFile(url: string, fetchImpl: typeof fetch = fetch): Promise<HeadResult> {
  try {
    let res = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(8_000) });
    if (res.status === 405 || res.status === 501) {
      res = await fetchImpl(url, { headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(8_000) });
      await res.body?.cancel().catch(() => undefined);
    }
    if (res.status === 404 || res.status === 410) return { kind: 'missing' };
    if (res.status !== 200 && res.status !== 206) return { kind: 'unreachable' };
    const total =
      res.status === 206
        ? Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1])
        : Number(res.headers.get('content-length'));
    const modified = Date.parse(res.headers.get('last-modified') ?? '');
    return {
      kind: 'ok',
      bytes: Number.isFinite(total) && total > 0 ? total : null,
      lastModifiedMs: Number.isFinite(modified) ? modified : null,
    };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** HEAD the direct URL; the file counts only if it is there and as big as expected (rsync may be mid-copy). */
export async function verifyMediaUrl(
  url: string,
  expectedBytes: number | null,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const head = await headMediaFile(url, fetchImpl);
  if (head.kind === 'missing') return { ok: false, reason: 'missing' };
  if (head.kind === 'unreachable') return { ok: false, reason: 'network' };
  if (expectedBytes !== null && head.bytes !== null && head.bytes !== expectedBytes) return { ok: false, reason: 'size' };
  return { ok: true };
}

/**
 * Is the box's media volume (the USB drive) there? HEADs one file the catalogue says exists. No sample (an empty
 * catalogue) means "cannot tell" and counts as absent: callers then wait instead of acting on a 404.
 */
export async function mediaVolumePresent(cfg: MediaServerConfig = mediaServerConfig(), fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const sample = await sampleMediaIndexPath(MEDIA_STORE).catch(() => null);
  if (!sample) return false;
  return (await headMediaFile(mediaUrlForVolumePath(sample, cfg), fetchImpl)).kind === 'ok';
}

/**
 * Point clients at the replica once it is really there: unpublished ready files get their `media_url`,
 * published ones are re-checked now and then and dropped if the file left the stick.
 */
export async function reconcilePublished(
  cfg: MediaServerConfig = mediaServerConfig(),
  fetchImpl: typeof fetch = fetch,
  options: { limit?: number; recheckAfterMs?: number } = {},
): Promise<{ verified: number; dropped: number; pending: number }> {
  const todo = await listReadyUnpublished(options.limit ?? 200);
  const recheck = await listPublishedOlderThan(options.recheckAfterMs ?? 6 * 60 * 60 * 1000, 100);
  let verified = 0;
  let dropped = 0;
  let pending = 0;
  let networkErrors = 0;
  let controlUrl: string | null = null; // a file that just verified OK in this run
  let volumeChecked: boolean | null = null;

  /**
   * Before a file is dropped as "gone": is the volume there at all? With the USB drive unplugged the box answers 404 for
   * EVERY file; dropping them all would also turn every song that is only a file of the box into a download job.
   * A file that verified OK in this run, or a catalogue sample, is HEADed as a control. No control = cannot tell = keep.
   */
  const volumePresent = async (): Promise<boolean> => {
    if (volumeChecked !== null) return volumeChecked;
    let url = controlUrl;
    if (!url) {
      const sample = await sampleMediaIndexPath(MEDIA_STORE).catch(() => null);
      url = sample ? mediaUrlForVolumePath(sample, cfg) : null;
    }
    volumeChecked = url ? (await headMediaFile(url, fetchImpl)).kind === 'ok' : false;
    status.volumeMissing = !volumeChecked;
    if (!volumeChecked) logWarning('media volume looks gone: published files are not dropped this round');
    return volumeChecked;
  };

  const handle = async (file: SongFile, wasPublished: boolean): Promise<void> => {
    // a song that IS a file of the box (adopted, no copy of ours) is verified at its own path, a local file at its replica path
    const volumeRel = file.mediaRelPath ?? (file.relPath ? replicaVolumePath(file.relPath, cfg) : null);
    if (!volumeRel) return;
    const url = mediaUrlForVolumePath(volumeRel, cfg);
    const result = await verifyMediaUrl(url, file.bytes, fetchImpl);
    if (result.ok) {
      networkErrors = 0;
      controlUrl ??= url;
      await markPublished(file.songKey, url);
      if (!wasPublished) verified += 1;
    } else if (result.reason === 'network') {
      networkErrors += 1;
      if (!wasPublished) pending += 1;
    } else {
      networkErrors = 0;
      if (wasPublished) {
        // 404 for a file that was there: only believe it when the rest of the volume is there too
        if (result.reason === 'missing' && !(await volumePresent())) {
          pending += 1;
          return;
        }
        // a local file just loses its replica URL; a song that was only on the box has nothing else: it becomes a job again
        if (file.relPath) await clearPublished(file.songKey);
        else await resetToQueued(file.songKey);
        dropped += 1;
      } else {
        pending += 1;
      }
    }
  };

  for (const [files, wasPublished] of [[todo, false], [recheck, true]] as const) {
    for (const file of files) {
      // The box is probably asleep or unreachable: stop knocking, try again next round.
      if (networkErrors >= 3) {
        if (!wasPublished) pending += 1;
        continue;
      }
      await handle(file, wasPublished);
    }
  }
  status.reachable = networkErrors < 3;
  status.lastReconcileAt = new Date().toISOString();
  status.lastReconcile = { verified, dropped, pending };
  if (verified || dropped) logInfo('media replica reconciled', { verified, dropped, pending });
  return { verified, dropped, pending };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export function startMediaServerSync(
  options: { indexEveryMs?: number; reconcileEveryMs?: number; firstRunDelayMs?: number } = {},
): () => void {
  const cfg = mediaServerConfig();
  status.enabled = cfg.enabled;
  if (!cfg.enabled) {
    logInfo('media server sync disabled (MEDIA_SERVER_ENABLED=0)');
    return () => undefined;
  }
  const indexEvery = options.indexEveryMs ?? 60 * 60 * 1000;
  const reconcileEvery = options.reconcileEveryMs ?? 5 * 60 * 1000;
  const firstDelay = options.firstRunDelayMs ?? 30_000;
  let running = { index: false, reconcile: false };

  const runIndex = async (): Promise<void> => {
    if (running.index) return;
    running.index = true;
    try {
      await refreshMediaIndex(cfg);
    } catch (err) {
      logWarning('media_index refresh failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running.index = false;
    }
  };
  const runReconcile = async (): Promise<void> => {
    if (running.reconcile) return;
    running.reconcile = true;
    try {
      await reconcilePublished(cfg);
    } catch (err) {
      logWarning('media replica reconcile failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running.reconcile = false;
    }
  };

  const timers = [
    setTimeout(() => void runIndex(), firstDelay),
    setTimeout(() => void runReconcile(), firstDelay + 5_000),
    setInterval(() => void runIndex(), indexEvery),
    setInterval(() => void runReconcile(), reconcileEvery),
  ];
  for (const t of timers) t.unref();
  return () => {
    for (const t of timers) {
      clearTimeout(t);
      clearInterval(t);
    }
    running = { index: false, reconcile: false };
  };
}

