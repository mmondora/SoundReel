import { logInfo, logWarning } from '../utils/logger';
import { safeUrl } from './songEnrichment';
import { cleanQuery, isAcceptedMatch } from './bookEnrichment';

export interface PlaceEnrichmentResult {
  placeName: string | null;
  placeDisplayName: string | null;
  placeLat: number | null;
  placeLon: number | null;
  osmUrl: string | null;
}

interface NominatimResult {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  osm_type?: string;
  osm_id?: number;
  type?: string;
  importance?: number;
}

/**
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires a descriptive User-Agent identifying the app and a contact — no
 * generic browser UA. Verified live against the real endpoint.
 */
const NOMINATIM_USER_AGENT = 'SoundReel/2.5 (personal journal app; contact: mmondora@mondora.com)';

const OSM_URL_TYPES: ReadonlySet<string> = new Set(['node', 'way', 'relation']);

/**
 * osm_type/osm_id are Nominatim-assigned identifiers, not caller-supplied —
 * but the JSON response is not schema-validated, so shape-guard before
 * splicing them into a URL (defense in depth, consistent with the other
 * enrichment providers).
 */
function buildOsmUrl(result: NominatimResult): string | null {
  const type = result.osm_type;
  const id = result.osm_id;
  if (
    typeof type === 'string' &&
    OSM_URL_TYPES.has(type) &&
    typeof id === 'number' &&
    Number.isInteger(id) &&
    id > 0
  ) {
    return safeUrl(`https://www.openstreetmap.org/${type}/${id}`);
  }
  return null;
}

async function searchNominatim(query: string): Promise<NominatimResult[] | null> {
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&limit=3&accept-language=it`;
  const response = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
  if (!response.ok) {
    logWarning('Nominatim search fallita', { status: response.status });
    return null;
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as NominatimResult[]) : [];
}

/**
 * Scans candidates in order and returns the first one that (a) is an
 * accepted match per isAcceptedMatch (mirrors bookEnrichment's anti-junk
 * verification — Nominatim's own ranking cannot be trusted blindly either)
 * and (b) has finite, usable coordinates. A name-accepted candidate with
 * non-finite lat/lon is skipped (not treated as a fatal miss) so a later,
 * usable candidate in the same pass can still be picked.
 */
function firstUsableMatch(results: NominatimResult[], query: string, text: string): PlaceEnrichmentResult | null {
  for (const candidate of results) {
    if (typeof candidate.name !== 'string' || !isAcceptedMatch(candidate.name, query)) continue;

    const lat = typeof candidate.lat === 'string' ? parseFloat(candidate.lat) : NaN;
    const lon = typeof candidate.lon === 'string' ? parseFloat(candidate.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    logInfo('Luogo trovato su Nominatim', { text, query, name: candidate.name });
    return {
      placeName: candidate.name,
      placeDisplayName: typeof candidate.display_name === 'string' ? candidate.display_name : null,
      placeLat: lat,
      placeLon: lon,
      osmUrl: buildOsmUrl(candidate),
    };
  }
  return null;
}

/**
 * Nominatim's usage policy caps requests at 1/s (enforced by the backfill
 * script's sleep, and this is called at most once per place note per TTL
 * window from the pipeline hook) and mandates the User-Agent above.
 *
 * Two-pass query strategy, mirroring enrichBook: pass 1 searches the raw
 * note text; if no candidate is both an accepted match and has usable
 * coordinates, pass 2 retries with a cleaned, place-name-shaped query
 * (skipped if cleaning produced no change). All candidates from a pass are
 * scanned in order — first accepted + usable candidate wins.
 *
 * Never throws: every failure (HTTP error, network throw, malformed body,
 * no accepted/usable match in either pass) is logged and returned as
 * `null`, treated as a miss by the caller.
 */
export async function enrichPlace(text: string): Promise<PlaceEnrichmentResult | null> {
  try {
    const rawResults = await searchNominatim(text);
    if (rawResults === null) return null;

    const rawMatch = firstUsableMatch(rawResults, text, text);
    if (rawMatch) return rawMatch;

    const cleaned = cleanQuery(text);
    if (cleaned && cleaned !== text) {
      const cleanedResults = await searchNominatim(cleaned);
      if (cleanedResults) {
        const cleanedMatch = firstUsableMatch(cleanedResults, cleaned, text);
        if (cleanedMatch) return cleanedMatch;
      }
    }

    return null;
  } catch (error) {
    logWarning('Nominatim errore rete', { error: error instanceof Error ? error.message : error });
    return null;
  }
}
