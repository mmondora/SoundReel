import { logInfo, logWarning } from '../utils/logger';
import { isAcceptedMatch, cleanQuery } from './bookEnrichment';
import { safeUrl } from './songEnrichment';

export interface ArchiveEnrichmentResult {
  identifier: string;
  title: string;
  year: string | null;
  pageUrl: string;
  fileUrl: string | null;
}

/** Mirrors the miss/error distinction the other enrichment providers expose,
 * so a backfill can tell "no public-domain copy exists" from "Archive is
 * down" and avoid tripping its consecutive-error abort on ordinary misses. */
export type ArchiveEnrichmentOutcome =
  | { status: 'hit'; result: ArchiveEnrichmentResult }
  | { status: 'miss' }
  | { status: 'error' };

const SEARCH_ENDPOINT = 'https://archive.org/advancedsearch.php';
const METADATA_ENDPOINT = 'https://archive.org/metadata';
const REQUEST_TIMEOUT_MS = 15_000;

/** Archive.org asks identified traffic to carry a descriptive User-Agent with
 * a contact, same policy shape as Nominatim. */
const USER_AGENT = `SoundReel/${process.env.npm_package_version ?? '2.5'} (personal journal app; contact: mmondora@mondora.com)`;

interface ArchiveDoc {
  identifier?: unknown;
  title?: unknown;
  year?: unknown;
}

interface ArchiveFile {
  name?: unknown;
  format?: unknown;
  size?: unknown;
}

/** Archive metadata is user-supplied and inconsistent about release year vs
 * upload year, so a one-year drift is tolerated; anything wider is treated as
 * a different film. */
function yearMatches(docYear: unknown, wanted: string | null): boolean {
  if (!wanted) return true;
  const a = Number(String(docYear ?? '').slice(0, 4));
  const b = Number(wanted.slice(0, 4));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= 1;
}

function selectDoc(docs: ArchiveDoc[], query: string, year: string | null): ArchiveDoc | null {
  return (
    docs.find(
      (doc) =>
        typeof doc.title === 'string' &&
        typeof doc.identifier === 'string' &&
        isAcceptedMatch(doc.title, query) &&
        yearMatches(doc.year, year)
    ) ?? null
  );
}

async function getJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`archive.org ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function buildSearchUrl(title: string, year: string | null): string {
  const clauses = [`title:("${title.replace(/"/g, '')}")`, 'mediatype:(movies)'];
  if (year) clauses.push(`year:[${Number(year) - 1} TO ${Number(year) + 1}]`);
  const params = new URLSearchParams({
    q: clauses.join(' AND '),
    rows: '10',
    output: 'json',
  });
  params.append('fl[]', 'identifier');
  params.append('fl[]', 'title');
  params.append('fl[]', 'year');
  return `${SEARCH_ENDPOINT}?${params.toString()}`;
}

/** Picks the largest playable file: Archive items routinely carry several
 * encodes plus non-video derivatives, and the biggest mp4 is the full-quality
 * one rather than a preview. */
function selectFileUrl(identifier: string, files: ArchiveFile[]): string | null {
  const playable = files
    .filter((f) => typeof f.name === 'string' && /\.(mp4|m4v)$/i.test(f.name))
    .map((f) => ({ name: String(f.name), size: Number(f.size ?? 0) }))
    .sort((a, b) => b.size - a.size);
  if (playable.length === 0) return null;
  return safeUrl(`https://archive.org/download/${encodeURIComponent(identifier)}/${playable[0].name}`);
}

async function searchOnce(query: string, year: string | null): Promise<ArchiveDoc | null> {
  const payload = (await getJson(buildSearchUrl(query, year))) as {
    response?: { docs?: ArchiveDoc[] };
  };
  const docs = payload?.response?.docs ?? [];
  return selectDoc(docs, query, year);
}

/**
 * Looks up a film on Internet Archive. Two passes, mirroring bookEnrichment:
 * the raw title first, then a cleaned form for titles carrying edition or
 * subtitle noise.
 */
export async function enrichFilmFromArchive(
  title: string,
  year: string | null
): Promise<ArchiveEnrichmentOutcome> {
  const raw = title.trim();
  if (!raw) return { status: 'miss' };

  try {
    let doc = await searchOnce(raw, year);

    if (!doc) {
      const cleaned = cleanQuery(raw);
      if (cleaned && cleaned !== raw) {
        doc = await searchOnce(cleaned, year);
      }
    }

    if (!doc) {
      logInfo('archive.org: nessun match', { title: raw, year });
      return { status: 'miss' };
    }

    const identifier = String(doc.identifier);
    const metadata = (await getJson(`${METADATA_ENDPOINT}/${encodeURIComponent(identifier)}`)) as {
      files?: ArchiveFile[];
    };
    const fileUrl = selectFileUrl(identifier, metadata?.files ?? []);
    const pageUrl = safeUrl(`https://archive.org/details/${encodeURIComponent(identifier)}`);

    if (!pageUrl) return { status: 'miss' };

    logInfo('archive.org: match trovato', { title: raw, identifier, hasFile: !!fileUrl });
    return {
      status: 'hit',
      result: {
        identifier,
        title: String(doc.title),
        year: doc.year != null ? String(doc.year) : null,
        pageUrl,
        fileUrl,
      },
    };
  } catch (err) {
    logWarning('archive.org: lookup fallito', { title: raw, err: String(err) });
    return { status: 'error' };
  }
}
