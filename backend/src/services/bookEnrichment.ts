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
 * OpenLibrary has no API key and asks callers to be polite (this function is
 * called at most once per book note per TTL window from the pipeline hook,
 * and rate-limited to 1 req/s by the backfill script). Picks the first doc
 * unconditionally — OpenLibrary's own relevance ranking is trusted, unlike
 * Deezer/iTunes which need loose-match verification against the input.
 * Never throws: every failure (HTTP error, network throw, malformed body, no
 * docs) is logged and returned as `null`, treated as a miss by the caller.
 */
export async function enrichBook(text: string): Promise<BookEnrichmentResult | null> {
  try {
    const url =
      `https://openlibrary.org/search.json?q=${encodeURIComponent(text)}&limit=3` +
      `&fields=title,author_name,first_publish_year,cover_i,key`;
    const response = await fetch(url);
    if (!response.ok) {
      logWarning('OpenLibrary search fallita', { status: response.status });
      return null;
    }

    const data = (await response.json()) as OpenLibrarySearchResponse;
    const doc = data.docs?.[0];
    if (!doc || typeof doc.title !== 'string') {
      return null;
    }

    logInfo('Libro trovato su OpenLibrary', { text, title: doc.title });
    return {
      bookTitle: doc.title,
      bookAuthor: doc.author_name?.[0] ?? null,
      bookYear: typeof doc.first_publish_year === 'number' ? doc.first_publish_year : null,
      // cover_i/key are OpenLibrary-assigned ids/paths, not caller-supplied
      // URLs — safeUrl is applied to the fully-built URL as defense in depth
      // (consistent with every other enrichment provider in this codebase),
      // while the typeof guards prevent building a garbage URL from a
      // malformed (JSONB response is not schema-validated) field.
      coverUrl:
        typeof doc.cover_i === 'number' ? safeUrl(`https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg`) : null,
      openlibraryUrl: typeof doc.key === 'string' ? safeUrl(`https://openlibrary.org${doc.key}`) : null,
    };
  } catch (error) {
    logWarning('OpenLibrary errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}
