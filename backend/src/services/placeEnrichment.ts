import { logInfo, logWarning } from '../utils/logger';
import { safeUrl } from './songEnrichment';
import { cleanQuery } from './bookEnrichment';

export interface PlaceEnrichmentResult {
  placeName: string | null;
  placeDisplayName: string | null;
  placeLat: number | null;
  placeLon: number | null;
  osmUrl: string | null;
}

/** Outcome of a Nominatim lookup with the miss/error distinction the plain
 * `PlaceEnrichmentResult | null` contract of {@link enrichPlace} collapses.
 * `backfillNoteMeta` needs this to avoid tripping its consecutive-error
 * abort on ordinary misses. */
export type PlaceEnrichmentOutcome =
  | { status: 'hit'; result: PlaceEnrichmentResult }
  | { status: 'miss' }
  | { status: 'error' };

interface NominatimNameDetails {
  name?: string;
  'name:it'?: string;
  'name:en'?: string;
  int_name?: string;
}

interface NominatimResult {
  name?: string;
  display_name?: string;
  lat?: string;
  lon?: string;
  osm_type?: string;
  osm_id?: number;
  importance?: number;
  namedetails?: NominatimNameDetails;
}

/**
 * Nominatim's usage policy (https://operations.osmfoundation.org/policies/nominatim/)
 * requires a descriptive User-Agent identifying the app and a contact — no
 * generic browser UA. Verified live against the real endpoint. Version is
 * sourced the same way as hubStatus.ts, so a redeploy doesn't require a
 * manual bump here.
 */
const NOMINATIM_USER_AGENT = `SoundReel/${process.env.npm_package_version ?? '2.5'} (personal journal app; contact: mmondora@mondora.com)`;

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

// --- Throttle --------------------------------------------------------------

// Nominatim's usage policy caps requests at 1/s. Mirrors
// waitForItunesThrottle in songEnrichment.ts: module-level state shared by
// every caller (pipeline hook — a single entry can carry ~30 place notes —
// and the backfill script's own loop), so bursts are throttled regardless
// of who fires them, not just the backfill script's own inter-note sleep.
const NOMINATIM_MIN_INTERVAL_MS = 1100;
let lastNominatimCall = -Infinity;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Test-only: resets the throttle window so each test doesn't have to wait
 * out (or fake-timer-advance past) a real 1.1s window left over from a
 * prior test/call. */
export function _resetNominatimThrottle(): void {
  lastNominatimCall = -Infinity;
}

async function waitForNominatimThrottle(): Promise<void> {
  const elapsed = Date.now() - lastNominatimCall;
  if (elapsed < NOMINATIM_MIN_INTERVAL_MS) {
    await sleep(NOMINATIM_MIN_INTERVAL_MS - elapsed);
  }
  lastNominatimCall = Date.now();
}

// --- Matching ----------------------------------------------------------

/**
 * Place-local normalize: lowercase, replace punctuation/symbols with a
 * SPACE (not delete) then collapse whitespace — e.g. 'Naz-Sciaves (BZ)' →
 * 'naz sciaves bz'. Deliberately NOT bookEnrichment's shared `normalize`
 * (which deletes punctuation instead of spacing it, live-validated for
 * books as-is): deleting the hyphen in 'Naz-Sciaves' would glue the two
 * words into 'nazsciaves', which would never equal or contain 'naz
 * sciaves'. Place names are far more likely to carry hyphens, parentheses
 * and abbreviations (province codes) than book titles.
 */
function normalizePlace(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9à-ú\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Nominatim's `name` is localized to the accept-language (it) — a query for
 * 'Paris' returns display name 'Parigi' with `name: 'Parigi'`, which fails
 * equality against the query even though it's the right place. `namedetails`
 * (requested via namedetails=1) exposes the untranslated/alternate names —
 * 'name:en', 'name:it', int_name — so the query can match against whichever
 * variant it was actually phrased in. The first display_name segment is
 * included as a last-resort variant for results with no `name`/namedetails
 * at all. Deduped, empties dropped.
 */
function nameVariants(candidate: NominatimResult): string[] {
  const raw = [
    candidate.name,
    candidate.namedetails?.name,
    candidate.namedetails?.['name:it'],
    candidate.namedetails?.['name:en'],
    candidate.namedetails?.int_name,
    typeof candidate.display_name === 'string' ? candidate.display_name.split(',')[0] : undefined,
  ];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    const trimmed = typeof v === 'string' ? v.trim() : '';
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Query variants tried against every candidate's name variants: the raw note
 * text, bookEnrichment's cleanQuery() output (title-shaped: strips quoting/
 * parentheticals/subtitle), and the text before the first comma (place notes
 * are frequently 'Place, Region' — e.g. 'Dolceacqua, Liguria' — where the
 * comma-head alone is the actual toponym Nominatim indexes). Deduped, empties
 * dropped; order is also the fetch-attempt order (raw first).
 */
function queryVariants(text: string): string[] {
  const raw = text.trim();
  const cleaned = cleanQuery(text).trim();
  const commaHead = text.split(',')[0].trim();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [raw, cleaned, commaHead]) {
    if (v && !seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * A single (name variant, query variant) comparison. Containment (either
 * direction) is too loose for short queries — e.g. 'Milan' would loosely
 * contain-match many unrelated multi-word names — so once the query side
 * normalizes to ≤2 tokens, equality is required instead. This mirrors
 * isAcceptedMatch's queryTokenCount rule from bookEnrichment, applied
 * per-pair rather than to a single title string.
 */
function isPlaceMatch(nameVariant: string, queryVariant: string): boolean {
  const normName = normalizePlace(nameVariant);
  const normQuery = normalizePlace(queryVariant);
  if (!normName || !normQuery) return false;

  const queryTokenCount = normQuery.split(' ').filter(Boolean).length;
  if (queryTokenCount <= 2) {
    return normName === normQuery;
  }
  return normName.includes(normQuery) || normQuery.includes(normName);
}

/**
 * A candidate is accepted when ANY of its name variants matches ANY of the
 * query variants (isPlaceMatch, above) — not just the specific query string
 * that produced this Nominatim response. This is what lets 'Dolceacqua,
 * Liguria' accept a candidate named just 'Dolceacqua' (comma-head variant
 * equals it) even when the fetch that returned the candidate used the raw
 * 3-token query, and what lets a query for 'Paris' accept Nominatim's
 * localized 'Parigi' (name:en variant 'Paris' equals the query).
 */
function isCandidateAccepted(candidate: NominatimResult, allQueryVariants: string[]): boolean {
  const names = nameVariants(candidate);
  if (names.length === 0) return false;
  return allQueryVariants.some((query) => names.some((name) => isPlaceMatch(name, query)));
}

function parseImportance(candidate: NominatimResult): number {
  const raw = candidate.importance;
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  const parsed = typeof raw === 'string' ? parseFloat(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Among the candidates in one Nominatim response that are both accepted
 * (isCandidateAccepted) and have usable (finite) coordinates, picks the one
 * with the highest `importance` — Nominatim's own relevance score — rather
 * than trusting array order. This is what lets a query for 'Paris' prefer
 * Nominatim's #1-importance 'Parigi, France' candidate over a lower-ranked
 * 'Paris, Texas' one, once both are accepted by name.
 */
function selectBestCandidate(results: NominatimResult[], allQueryVariants: string[]): NominatimResult | null {
  let best: NominatimResult | null = null;
  let bestImportance = -Infinity;
  for (const candidate of results) {
    if (!isCandidateAccepted(candidate, allQueryVariants)) continue;

    const lat = typeof candidate.lat === 'string' ? parseFloat(candidate.lat) : NaN;
    const lon = typeof candidate.lon === 'string' ? parseFloat(candidate.lon) : NaN;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;

    const importance = parseImportance(candidate);
    if (importance > bestImportance) {
      bestImportance = importance;
      best = candidate;
    }
  }
  return best;
}

function toResult(candidate: NominatimResult, text: string, query: string): PlaceEnrichmentResult {
  const lat = typeof candidate.lat === 'string' ? parseFloat(candidate.lat) : NaN;
  const lon = typeof candidate.lon === 'string' ? parseFloat(candidate.lon) : NaN;
  const placeName = candidate.name ?? nameVariants(candidate)[0] ?? null;
  logInfo('Luogo trovato su Nominatim', { text, query, name: placeName });
  return {
    placeName,
    placeDisplayName: typeof candidate.display_name === 'string' ? candidate.display_name : null,
    placeLat: lat,
    placeLon: lon,
    osmUrl: buildOsmUrl(candidate),
  };
}

// --- Fetch ---------------------------------------------------------------

/** Returns `null` on HTTP failure (caller treats it as an error, not a
 * miss), an array (possibly empty) on success. namedetails=1 adds the
 * localized/alternate name fields needed for isCandidateAccepted;
 * accept-language=it is kept for a human-friendly display_name. */
async function searchNominatim(query: string): Promise<NominatimResult[] | null> {
  await waitForNominatimThrottle();
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}` +
    `&format=jsonv2&limit=3&accept-language=it&namedetails=1`;
  const response = await fetch(url, { headers: { 'User-Agent': NOMINATIM_USER_AGENT } });
  if (!response.ok) {
    logWarning('Nominatim search fallita', { status: response.status });
    return null;
  }
  const data = (await response.json()) as unknown;
  return Array.isArray(data) ? (data as NominatimResult[]) : [];
}

// --- Public API ------------------------------------------------------------

/**
 * At most 2 Nominatim calls per note: pass 1 always searches the raw note
 * text. If no candidate from pass 1 is accepted (against ALL query
 * variants — see isCandidateAccepted) and usable, pass 2 retries with the
 * best remaining query variant (cleanQuery output, or the comma-head if
 * cleaning produced no change) — skipped if there's no remaining variant
 * distinct from the raw one already tried.
 *
 * Distinguishes HTTP/network failure ('error') from a clean no-match
 * ('miss') so callers that count consecutive failures (backfillNoteMeta)
 * don't mistake an ordinary miss for a systemic outage.
 */
export async function enrichPlaceDetailed(text: string): Promise<PlaceEnrichmentOutcome> {
  try {
    const variants = queryVariants(text);
    if (variants.length === 0) return { status: 'miss' };

    const [raw, ...rest] = variants;
    const rawResults = await searchNominatim(raw);
    if (rawResults === null) return { status: 'error' };

    const rawBest = selectBestCandidate(rawResults, variants);
    if (rawBest) return { status: 'hit', result: toResult(rawBest, text, raw) };

    if (rest.length > 0) {
      const second = rest[0];
      const secondResults = await searchNominatim(second);
      if (secondResults === null) return { status: 'error' };

      const secondBest = selectBestCandidate(secondResults, variants);
      if (secondBest) return { status: 'hit', result: toResult(secondBest, text, second) };
    }

    return { status: 'miss' };
  } catch (error) {
    logWarning('Nominatim errore rete', { error: error instanceof Error ? error.message : error });
    return { status: 'error' };
  }
}

/**
 * Pipeline-facing wrapper: collapses enrichPlaceDetailed's miss/error
 * distinction back into a single `null` (contract unchanged for every
 * existing caller except backfillNoteMeta, which uses Detailed directly).
 * Never throws.
 */
export async function enrichPlace(text: string): Promise<PlaceEnrichmentResult | null> {
  const outcome = await enrichPlaceDetailed(text);
  return outcome.status === 'hit' ? outcome.result : null;
}
