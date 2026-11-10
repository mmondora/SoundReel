/**
 * What happens to an entry once its analysis is done, for the collections (Raccolte, task 4; ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md
 * §5): a VECTOR (`nomic-embed-text` on the local router: what the post is about, for the grouping) and the PLACES and VENUES its text names (one call to
 * the local model). Both come from local models through the gpu-router, never Claude, and both are best effort: the analysis is done and answered long
 * before, and a failure here only means "not yet" (the entry has no record of the reading, so the next pass tries again).
 *
 * The rules live here and are testable without a database or a model: the store and the two calls come in through `InputsDeps`. The real ones are built
 * only when an analysis ends (`realInputsDeps`), so importing this module touches nothing.
 *
 * What is recorded (`CollectionsStore.inputHashes`): the vector keeps the hash of its text and its model, and a reading of places and venues keeps the
 * hash of the text it read AND of the version of the rules that read it (`PLACES_RULES_VERSION`), EVEN WHEN IT FOUND NOTHING. So: the same text is never
 * read twice by the same rules, an entry without a place (most of them) is not asked again by the next backfill, a reading that failed leaves no record
 * and is retried, a text that changed is read again, and so is every text when the rules or the prompt change enough to bump the version.
 *
 * `catchUpInputs` is the same rule over the whole library: the backfill script runs it, and the nightly pass can run it to heal the entries a down
 * router left behind.
 */
import type { Entry } from '../types';
import { getEntry, query } from '../utils/db';
import { logWarning } from '../utils/logger';
import { PgCollectionsStore, type CollectionsStore, type InputHashes } from './collectionsStore';
import { EMBED_MODEL, MIN_TEXT_CHARS, embedTexts, embeddingTextHash, entryEmbeddingText } from './embeddings';
import { PLACES_RULES_VERSION, generatePlacesAndVenues, placesSourceText, type ParsedPlacesAndVenues, type PlacesSource } from './entryPlaces';

/** `COLLECTIONS_AUTO=0` stops the discovery (the collections that already exist stay). */
export const collectionsAutoEnabled = (): boolean => process.env.COLLECTIONS_AUTO !== '0';

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------------------------------------------- what an entry says

const isText = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

/** What the places call reads, taken from an entry: caption, summary, tags, notes, the words of the video and the text on the screen (and on the slides). */
export function placesSourceOf(entry: Entry): PlacesSource {
  const results = entry.results;
  const notes = (Array.isArray(results?.notes) ? results.notes : []).map((note) => note?.text).filter(isText);
  const screen = [results?.overlayText, ...(Array.isArray(results?.slides) ? results.slides : []).map((slide) => slide?.ocrText)].filter(isText);
  return {
    caption: entry.caption ?? null,
    summary: results?.summary ?? null,
    tags: Array.isArray(results?.tags) ? results.tags : [],
    notes,
    transcript: [results?.transcript, results?.transcription].find(isText) ?? null,
    ocr: screen.length > 0 ? screen.join('\n') : null,
  };
}

/**
 * What a reading of places and venues is recorded with: the text it read and the version of the rules that read it (`PLACES_RULES_VERSION`). Bumping the
 * version (a new prompt, a new gate) makes every entry read once more, and nothing else does.
 */
export function placesHashOf(placesText: string): string {
  return embeddingTextHash(`${placesText}|v${PLACES_RULES_VERSION}`);
}

/** What an entry still needs: the text each step reads (null = too little to be worth a model) and whether it was already read from exactly this. */
export interface InputsPlan {
  vector: { text: string; hash: string } | null;
  places: { source: PlacesSource; hash: string } | null;
  needsVector: boolean;
  needsPlaces: boolean;
}

/**
 * THE rule of what is still to do (the pipeline and the backfill both ask it): a vector when the text of the entry (summary or caption, and its tags)
 * has 25 characters or more and the stored one is not for this text and this model; the places when the text they read (caption, summary, tags, notes,
 * transcript, text on screen) has 25 characters or more and was not read yet by the current rules. A step with too little text is not worth a model and is
 * not done.
 */
export function planInputs(entry: Entry, recorded: InputHashes | undefined): InputsPlan {
  const text = entryEmbeddingText(entry);
  const vector = text === null ? null : { text, hash: embeddingTextHash(text) };
  const source = placesSourceOf(entry);
  const placesText = placesSourceText(source);
  const places = placesText.length >= MIN_TEXT_CHARS ? { source, hash: placesHashOf(placesText) } : null;
  return {
    vector,
    places,
    needsVector: vector !== null && (recorded?.vectorHash !== vector.hash || recorded?.model !== EMBED_MODEL),
    needsPlaces: places !== null && recorded?.placesHash !== places.hash,
  };
}

// ---------------------------------------------------------------------------------------------------------------- one entry

export interface InputsDeps {
  store: Pick<CollectionsStore, 'saveVector' | 'savePlacesAndVenues' | 'inputHashes'>;
  getEntry(entryId: string): Promise<Entry | null>;
  /** One vector for each text (the router, `nomic-embed-text`); throws when the service is down. */
  embed(texts: string[]): Promise<number[][]>;
  /** The places and venues of a text (the local model); null when it could not be read (the model is down, the answer was cut). */
  places(source: PlacesSource): Promise<ParsedPlacesAndVenues | null>;
}

/** `done`: everything that could be read is read (also when it was all there already); `no_text`: nothing worth a model; `pending`: something failed, try again. */
export type InputsOutcome = 'done' | 'no_text' | 'pending';

async function makeVector(entryId: string, vector: { text: string; hash: string }, deps: InputsDeps): Promise<boolean> {
  try {
    const vectors = await deps.embed([vector.text]);
    if (!Array.isArray(vectors) || vectors.length !== 1 || !Array.isArray(vectors[0])) throw new Error('the embedding service gave no vector');
    await deps.store.saveVector(entryId, EMBED_MODEL, vectors[0], vector.hash);
    return true;
  } catch (err) {
    logWarning('collections: the vector of an entry was not made (tried again later)', { entryId, error: errorText(err) });
    return false;
  }
}

async function readPlaces(entryId: string, places: { source: PlacesSource; hash: string }, deps: InputsDeps): Promise<boolean> {
  try {
    const parsed = await deps.places(places.source);
    if (!parsed) {
      logWarning('collections: the places of an entry were not read (tried again later)', { entryId });
      return false;
    }
    // a reading that found nothing is saved too, with its hash: the entry is not asked about again
    await deps.store.savePlacesAndVenues(entryId, parsed.place ? [parsed.place] : [], parsed.venues, places.hash);
    return true;
  } catch (err) {
    logWarning('collections: the places of an entry were not saved (tried again later)', { entryId, error: errorText(err) });
    return false;
  }
}

/** Does what the plan says is missing; each step apart from the other, so one failing never keeps the other from being done. Never throws. */
export async function applyInputsPlan(entryId: string, plan: InputsPlan, deps: InputsDeps): Promise<'done' | 'pending'> {
  const vectorOk = plan.vector !== null && plan.needsVector ? await makeVector(entryId, plan.vector, deps) : true;
  const placesOk = plan.places !== null && plan.needsPlaces ? await readPlaces(entryId, plan.places, deps) : true;
  return vectorOk && placesOk ? 'done' : 'pending';
}

/**
 * The vector and the places of one entry, as far as they are not already read. Never throws: a failure of the database, the router or the model is
 * `pending` (and in the log), and the same call later does what is left.
 */
export async function processEntryInputs(entryId: string, deps: InputsDeps): Promise<InputsOutcome> {
  let plan: InputsPlan;
  try {
    const entry = await deps.getEntry(entryId);
    if (!entry) return 'no_text';
    plan = planInputs(entry, (await deps.store.inputHashes([entryId])).get(entryId));
  } catch (err) {
    logWarning('collections: an entry could not be looked at (tried again later)', { entryId, error: errorText(err) });
    return 'pending';
  }
  if (plan.vector === null && plan.places === null) return 'no_text';
  return applyInputsPlan(entryId, plan, deps);
}

/** The real dependencies: the database and the local models. Built when an analysis ends, never when the module is loaded. */
export function realInputsDeps(): InputsDeps {
  return {
    store: new PgCollectionsStore(),
    getEntry,
    embed: (texts) => embedTexts(texts),
    places: (source) => generatePlacesAndVenues(source),
  };
}

/** Places an entry in the collections it is close to (the fast lane of the engine, `assignOne`); answers the ids of the collections it joined. */
export type AssignToCollections = (userId: string, entryId: string) => Promise<string[]>;

/** The real fast lane. The engine is loaded only when an entry has been read, so importing this module opens nothing. */
export async function assignInRealCollections(userId: string, entryId: string): Promise<string[]> {
  const [{ assignOne }, { realAssignOneDeps }] = await Promise.all([import('./collectionsEngine'), import('./collectionsEngineData')]);
  return assignOne(userId, entryId, realAssignOneDeps());
}

/**
 * The entry joins the collections of its OWNER (a family member it was shared with gets it at night, with the pass). Best effort like the rest: whatever goes
 * wrong is a warning, and the night puts the entry where it belongs.
 */
async function joinCollections(entryId: string, deps: InputsDeps, assign: AssignToCollections): Promise<void> {
  try {
    const entry = await deps.getEntry(entryId);
    if (!entry?.ownerUser || entry.ownerUser === 'anonymous') return;
    await assign(entry.ownerUser, entryId);
  } catch (err) {
    logWarning('collections: the new entry could not join the collections now (the night puts it there)', { entryId, error: errorText(err) });
  }
}

// One at a time: two analyses that end together must not both ask the router (it is shared with the analyses, and the second one would only wait).
let chain: Promise<unknown> = Promise.resolve();

/**
 * Called when an analysis ends well. NOT meant to be awaited (the answer to Telegram, the share outcome and the next job do not wait for two local
 * models); it never rejects. Does nothing when `COLLECTIONS_AUTO=0`. When the inputs of the entry are all there (`done`: the vector is stored) it also
 * puts the entry in the collections it is close to (`assign`, the fast lane of the engine by default), still in the same turn.
 */
export function onEntryAnalyzedForCollections(entryId: string, deps?: InputsDeps, assign: AssignToCollections = assignInRealCollections): Promise<void> {
  if (!collectionsAutoEnabled()) return Promise.resolve();
  const next = chain
    .then(async () => {
      const inputs = deps ?? realInputsDeps();
      if ((await processEntryInputs(entryId, inputs)) === 'done') await joinCollections(entryId, inputs, assign);
    })
    .then(
      () => undefined,
      (err: unknown) => {
        logWarning('collections: the inputs of an entry failed (the analysis is done anyway)', { entryId, error: errorText(err) });
      },
    );
  chain = next;
  return next;
}

// ---------------------------------------------------------------------------------------------------------------- the whole library

export interface CatchUpDeps extends InputsDeps {
  /** Every entry id (of one owner, or of all), newest first. */
  listEntryIds(owner: string | null): Promise<string[]>;
  sleep(ms: number): Promise<void>;
  say?(line: string): void;
}

export interface CatchUpOptions {
  /** false = only count what is missing (no model, nothing written). */
  apply: boolean;
  /** At most this many entries that need something (the newest first); no limit when absent. */
  limit?: number | null;
  owner?: string | null;
  /** Pause between two entries a model is asked about (the router is shared with the analyses). */
  delayMs?: number;
  /** How many entries are looked at with one question to the store. */
  chunk?: number;
}

export interface CatchUpSummary {
  scanned: number;
  /** Entries that need at least one of the two things (the ones a run works on, and the ones `limit` counts). */
  needAny: number;
  /** Entries that need a vector / need their places read (one entry can be in both). */
  needVector: number;
  needPlaces: number;
  upToDate: number;
  /** Nothing worth a model (or the entry is gone). */
  noText: number;
  done: number;
  /** Failed (or could not be read): the next run asks again. */
  pending: number;
}

export const DEFAULT_CATCH_UP_DELAY_MS = 300;
export const DEFAULT_CATCH_UP_CHUNK = 50;
/** A line of progress every this many entries worked on. */
export const CATCH_UP_PROGRESS_EVERY = 25;

/**
 * Every entry that still needs a vector or its places, one at a time: the same decision as the pipeline (`planInputs`), so a second run finds nothing to
 * do and a run that stopped half way goes on where it was. Never throws for one entry: a failure is counted `pending` and the run goes on.
 */
export async function catchUpInputs(deps: CatchUpDeps, opts: CatchUpOptions): Promise<CatchUpSummary> {
  const delayMs = opts.delayMs ?? DEFAULT_CATCH_UP_DELAY_MS;
  const chunkSize = Math.max(1, opts.chunk ?? DEFAULT_CATCH_UP_CHUNK);
  const limit = opts.limit ?? null;
  const summary: CatchUpSummary = { scanned: 0, needAny: 0, needVector: 0, needPlaces: 0, upToDate: 0, noText: 0, done: 0, pending: 0 };
  const ids = await deps.listEntryIds(opts.owner ?? null);
  let worked = 0;
  let asked = 0;
  const reached = (): boolean => limit !== null && worked >= limit;

  for (let from = 0; from < ids.length && !reached(); from += chunkSize) {
    const chunk = ids.slice(from, from + chunkSize);
    let recorded: Map<string, InputHashes>;
    try {
      recorded = await deps.store.inputHashes(chunk);
    } catch (err) {
      logWarning('collections: what was read could not be asked (this stretch is tried again next time)', { error: errorText(err) });
      summary.scanned += chunk.length;
      summary.pending += chunk.length;
      continue;
    }
    for (const id of chunk) {
      if (reached()) break;
      summary.scanned += 1;
      let plan: InputsPlan | null;
      try {
        const entry = await deps.getEntry(id);
        plan = entry ? planInputs(entry, recorded.get(id)) : null;
      } catch (err) {
        logWarning('collections: an entry could not be looked at (tried again next time)', { entryId: id, error: errorText(err) });
        summary.pending += 1;
        continue;
      }
      if (plan === null || (plan.vector === null && plan.places === null)) {
        summary.noText += 1;
        continue;
      }
      if (!plan.needsVector && !plan.needsPlaces) {
        summary.upToDate += 1;
        continue;
      }
      worked += 1;
      summary.needAny += 1;
      if (plan.needsVector) summary.needVector += 1;
      if (plan.needsPlaces) summary.needPlaces += 1;
      if (!opts.apply) continue;

      if (asked > 0 && delayMs > 0) await deps.sleep(delayMs);
      asked += 1;
      if ((await applyInputsPlan(id, plan, deps)) === 'done') {
        summary.done += 1;
      } else {
        summary.pending += 1;
        deps.say?.(`  ${id}: da riprovare (si rifà alla prossima passata)`);
      }
      if (worked % CATCH_UP_PROGRESS_EVERY === 0) {
        deps.say?.(`  ${worked} voci fatte (${summary.pending} da riprovare), ${summary.scanned} guardate su ${ids.length}`);
      }
    }
  }
  return summary;
}

/** The real dependencies of the whole-library run (the backfill script, the nightly pass). */
export function realCatchUpDeps(say?: (line: string) => void): CatchUpDeps {
  return {
    ...realInputsDeps(),
    listEntryIds: async (owner) =>
      (await query<{ id: string }>('SELECT id FROM entries WHERE ($1::text IS NULL OR owner_user = $1) ORDER BY created_at DESC, id', [owner])).map((r) => r.id),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    say,
  };
}
