import { logInfo, logWarning } from '../utils/logger';
import { safeUrl } from './songEnrichment';

export interface BookEnrichmentResult {
  bookTitle: string;
  bookAuthor: string | null;
  bookYear: number | null;
  coverUrl: string | null;
  openlibraryUrl: string | null;
}

interface OpenLibraryDoc {
  title?: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  key?: string;
}

interface OpenLibrarySearchResponse {
  docs?: OpenLibraryDoc[];
}

/**
 * OpenLibrary `key` is meant to be a work/edition path like `/works/OL...W`,
 * but the JSONB response is not schema-validated — reject anything that
 * doesn't look like a relative path before splicing it into a URL.
 */
const OPENLIBRARY_KEY_SHAPE = /^\/[A-Za-z0-9_/-]+$/;

/** lowercase, strip punctuation, collapse whitespace — for loose comparison
 * between a candidate doc title and the (raw or cleaned) query text. Books
 * only — placeEnrichment has its own normalizePlace that SPACES punctuation
 * instead of deleting it, since place names carry hyphens/parentheses that
 * would otherwise glue two words together (e.g. 'Naz-Sciaves'). */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9à-ú\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * OpenLibrary's own relevance ranking cannot be trusted blindly (live-probed:
 * ~half of first-doc hits are unrelated, e.g. note 'AI for Wood' ranking
 * 'The Twits' first) — every candidate doc is verified against the query
 * before being accepted.
 *
 * For short queries (≤2 tokens once normalized) containment is too loose —
 * e.g. 'Bunny' would loosely-contain-match 'The Runaway Bunny' — so those
 * require near-equality instead. Longer queries use loose containment either
 * direction, since OpenLibrary titles are sometimes fuller/shorter than the
 * note text (subtitles, series info, etc).
 *
 * placeEnrichment applies the same ≤2-token-requires-equality rule via its
 * own isPlaceMatch (built on normalizePlace rather than normalize above,
 * and checked against multiple name/query variants) rather than reusing
 * this function directly.
 */
export function isAcceptedMatch(title: string, query: string): boolean {
  const normTitle = normalize(title);
  const normQuery = normalize(query);
  if (!normTitle || !normQuery) return false;

  const queryTokenCount = normQuery.split(' ').filter(Boolean).length;
  if (queryTokenCount <= 2) {
    return normTitle === normQuery;
  }
  return normTitle.includes(normQuery) || normQuery.includes(normTitle);
}

function selectMatch(docs: OpenLibraryDoc[], query: string): OpenLibraryDoc | null {
  return docs.find((doc) => typeof doc.title === 'string' && isAcceptedMatch(doc.title, query)) ?? null;
}

/**
 * Note text is frequently sentence-shaped rather than a bare title (e.g.
 * 'Piranesi - Susanna Clarke, edito da Fazi Editore'), which OpenLibrary's
 * search often returns zero docs for even though the book exists. Strips
 * quoting, parentheticals, and everything after a ' - ' or ': ' separator to
 * recover a title-shaped query for a second pass.
 *
 * Exported so other providers (e.g. placeEnrichment) can share the same
 * two-pass cleaning strategy rather than duplicating it.
 */
export function cleanQuery(text: string): string {
  return text
    .replace(/[«»"'“”‘’]/g, '')
    .replace(/\([^)]*\)/g, '')
    .split(' - ')[0]
    .split(': ')[0]
    .trim();
}

async function searchOpenLibrary(query: string): Promise<OpenLibraryDoc[] | null> {
  const url =
    `https://openlibrary.org/search.json?q=${encodeURIComponent(query)}&limit=3` +
    `&fields=title,author_name,first_publish_year,cover_i,key`;
  const response = await fetch(url);
  if (!response.ok) {
    logWarning('OpenLibrary search fallita', { status: response.status });
    return null;
  }
  const data = (await response.json()) as OpenLibrarySearchResponse;
  return data.docs ?? [];
}

function toResult(doc: OpenLibraryDoc, query: string, text: string): BookEnrichmentResult {
  logInfo('Libro trovato su OpenLibrary', { text, query, title: doc.title });
  return {
    bookTitle: doc.title as string,
    bookAuthor: doc.author_name?.[0] ?? null,
    bookYear: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : null,
    // cover_i/key are OpenLibrary-assigned ids/paths, not caller-supplied
    // URLs — safeUrl is applied to the fully-built URL as defense in depth
    // (consistent with every other enrichment provider in this codebase),
    // while the typeof/shape guards prevent building a garbage or malicious
    // URL from a malformed (JSONB response is not schema-validated) field.
    coverUrl:
      typeof doc.cover_i === 'number' ? safeUrl(`https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`) : null,
    openlibraryUrl:
      typeof doc.key === 'string' && OPENLIBRARY_KEY_SHAPE.test(doc.key)
        ? safeUrl(`https://openlibrary.org${doc.key}`)
        : null,
  };
}

/**
 * OpenLibrary has no API key and asks callers to be polite (this function is
 * called at most once per book note per TTL window from the pipeline hook,
 * and rate-limited to 1 req/s by the backfill script).
 *
 * Two-pass query strategy: pass 1 searches the raw note text; if none of the
 * (up to 3) returned docs is an accepted match (see isAcceptedMatch), pass 2
 * retries with a cleaned, title-shaped query derived from the note text
 * (skipped if cleaning produced no change). All docs from a pass are
 * scanned in order — first accepted candidate wins.
 *
 * Never throws: every failure (HTTP error, network throw, malformed body, no
 * accepted match in either pass) is logged and returned as `null`, treated
 * as a miss by the caller.
 */
export async function enrichBook(text: string): Promise<BookEnrichmentResult | null> {
  try {
    const rawDocs = await searchOpenLibrary(text);
    if (rawDocs === null) return null;

    const rawMatch = selectMatch(rawDocs, text);
    if (rawMatch) return toResult(rawMatch, text, text);

    const cleaned = cleanQuery(text);
    if (cleaned && cleaned !== text) {
      const cleanedDocs = await searchOpenLibrary(cleaned);
      if (cleanedDocs) {
        const cleanedMatch = selectMatch(cleanedDocs, cleaned);
        if (cleanedMatch) return toResult(cleanedMatch, cleaned, text);
      }
    }

    return null;
  } catch (error) {
    logWarning('OpenLibrary errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}
