/**
 * The view layer of the collections (ADR-0022, docs/collections.md, spec 2026-11-09-library-collections-auto-topics-design.md §4, §6, §8).
 *
 * The SERVER decides everything the site draws (rule P): which collections exist, their names and order, the views each one offers, the pictures of
 * its mosaic, the chips of every post, the words that say why the posts are together, the venues with the address of Google Maps. The site draws
 * what it gets and computes nothing.
 *
 * Three layers (spec §4): the TYPES (`type:music`… computed from the posts, never stored), the PLACES (`place:<slug>`, computed from the places the
 * posts name, from eight posts) and the THEMES (the rows the engine found, with the corrections of the user). Everything is for ONE user: his own
 * posts and the ones shared with him (the sources apply that visibility; an administrator sees no more than anyone: collections are strictly per user).
 *
 * The rules here are pure (the sources are injected, `services/collectionsViewData.ts` has the real ones), so they are tested without a database.
 */
import type { CollectionChip, EntrySummaryRow } from '../types';
import type { PlaceKind } from '../data/places';
import { logWarning } from '../utils/logger';
import { postUrlOf } from '../utils/mentions';
import { mapsUrl } from './entryPlaces';
import type { EntryPlaceRow, EntryVenueRow } from './collectionsStore';

// ---------------------------------------------------------------------------------------------------------------- numbers

/** The numbers of the contract (docs/collections.md «Le regole»): the site never knows them. */
export const COLLECTION_VIEW = {
  /** A place is a collection of its own from this many posts (the combination place × theme is the facet, not a collection). */
  placeCollectionMin: 8,
  /** A place is a facet «Dove» of a collection when at least this many of its posts name it. */
  placeFacetMin: 2,
  /** «New» for this many days after the collection was made. */
  newDays: 7,
  /** A collection with a post saved in the last days comes before the ones that did not move. */
  recentDays: 14,
  /** The pictures of the mosaic. */
  thumbs: 4,
  /** The grid is offered from this share of the posts with a picture, and it is the starting view from the second. */
  gridOffered: 0.25,
  gridDefault: 0.6,
  /** At most this many theme chips on a post (the place chip comes on top of them). */
  themeChips: 2,
  pageDefault: 40,
  pageMax: 100,
  /** The words and the posts that say why a theme is there. */
  whyWords: 4,
  whyEntries: 2,
  /** The songs of the music collection, newest first. */
  songKeysMax: 500,
  /** The tiles of the Home. */
  homeTiles: 12,
} as const;

const DAY_MS = 24 * 3600 * 1000;

// ---------------------------------------------------------------------------------------------------------------- types of the answer

export type CollectionKind = 'type' | 'theme' | 'place';
export type CollectionView = 'grid' | 'list' | 'play';

export interface CollectionListItem {
  /** `type:music` · a uuid (a theme) · `place:milano`. */
  id: string;
  name: string;
  kind: CollectionKind;
  /** The fixed heading of the seed list («Cibo e bevande»); null = «Altre». The types have «Tipi», the places «Luoghi». */
  group: string | null;
  parentId: string | null;
  count: number;
  isNew: boolean;
  /** Up to four pictures for the mosaic. */
  thumbs: string[];
  views: CollectionView[];
  defaultView: CollectionView;
}

export interface CollectionVenuePost {
  entryId: string;
  sourceUrl: string;
  sourcePlatform: string;
  createdAt: string;
}

/** A venue a post names: ONE row even when several posts cite it. `mapsUrl` is built here, by the server (the site never builds an address of Maps). */
export interface CollectionVenue {
  key: string;
  name: string;
  /** The key of the kind (`restaurant`, `winery`…): the site writes it in the language of the page. */
  kind: string;
  place: string | null;
  mapsUrl: string;
  posts: CollectionVenuePost[];
}

export interface CollectionFacets {
  places: Array<{ name: string; count: number }>;
  sources: Array<{ platform: string; count: number }>;
  months: Array<{ month: string; count: number }>;
}

export type CollectionEntry = EntrySummaryRow & { collections: CollectionChip[] };

export interface CollectionDetail {
  collection: CollectionListItem;
  why: { words: string[]; entryIds: string[] };
  facets: CollectionFacets;
  entries: CollectionEntry[];
  venues: CollectionVenue[];
  songKeys?: string[];
  total: number;
}

// ---------------------------------------------------------------------------------------------------------------- the ids

export const TYPE_IDS = ['type:music', 'type:films', 'type:software', 'type:places', 'type:books'] as const;
export type TypeId = (typeof TYPE_IDS)[number];

/** The names of the types, as the page «Raccolte» writes them (spec §4.1). */
export const TYPE_NAMES: Readonly<Record<TypeId, string>> = {
  'type:music': 'Musica',
  'type:films': 'Film e serie',
  'type:software': 'Software e app',
  'type:places': 'Luoghi',
  'type:books': 'Libri',
};

/** The headings of the computed collections (the themes bring their own, from the seed list). */
export const TYPES_GROUP = 'Tipi';
export const PLACES_GROUP = 'Luoghi';

/** Lower case, no accents, anything that is not a letter or a digit is one dash, no dash at either end: `São Paulo` → `sao-paulo`. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export const placeCollectionId = (name: string): string => `place:${slugify(name)}`;

/**
 * Only a city or a region is a collection of places. A COUNTRY is not (10 November, on the real library): «Italia» or «Cina» are named in passing far more
 * often than they are what a post is about («Italia» on a post about trading), and a place cannot be hidden by the user, so a wrong one would stay. A
 * country is still written on the post (its places) and it is still a facet inside a collection; it just has no collection and no chip of its own.
 */
export const placeMakesCollection = (kind: PlaceKind): boolean => kind !== 'country';

export type ParsedCollectionId =
  | { kind: 'type'; type: TypeId }
  | { kind: 'place'; slug: string }
  | { kind: 'theme'; id: string }
  /** `type:…` or `place:…` that is not one of ours: it is no collection, and it is not a theme either. */
  | { kind: 'unknown-computed' };

export function parseCollectionId(id: string): ParsedCollectionId {
  if ((TYPE_IDS as readonly string[]).includes(id)) return { kind: 'type', type: id as TypeId };
  if (id.startsWith('place:')) {
    const slug = id.slice('place:'.length);
    return slug ? { kind: 'place', slug } : { kind: 'unknown-computed' };
  }
  if (id.startsWith('type:')) return { kind: 'unknown-computed' };
  return { kind: 'theme', id };
}

/** Types and places have no row: they are computed, so nothing about them can be corrected. */
export const isComputedId = (id: string): boolean => parseCollectionId(id).kind !== 'theme';

// ---------------------------------------------------------------------------------------------------------------- sources

/** What the lists need to know of a post: when it was saved and its picture. */
export interface EntryFact {
  id: string;
  createdAt: string;
  thumbnailUrl: string | null;
}

// ---------------------------------------------------------------------------------------------------------------- describing

/** What a collection is before the posts are counted. `createdAt` is when the engine made a theme (null for what is computed). */
export interface CollectionBase {
  id: string;
  name: string;
  kind: CollectionKind;
  group: string | null;
  parentId: string | null;
  createdAt: string | null;
}

const validUrl = (url: string | null | undefined): string | null => {
  const text = typeof url === 'string' ? url.trim() : '';
  return text === '' ? null : text;
};

export const timeOf = (iso: string): number => {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY;
};

/** Up to `COLLECTION_VIEW.thumbs` pictures: those of the newest posts that have one, each once. */
function thumbsOf(entries: readonly EntryFact[]): string[] {
  const newestFirst = [...entries].sort((a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const out: string[] = [];
  for (const entry of newestFirst) {
    const url = validUrl(entry.thumbnailUrl);
    if (url !== null && !out.includes(url)) out.push(url);
    if (out.length === COLLECTION_VIEW.thumbs) break;
  }
  return out;
}

/** The views the data can fill, and the one to start on (docs/collections.md): the music plays; the others show a grid when the posts have pictures. */
function viewsOf(id: string, entries: readonly EntryFact[]): { views: CollectionView[]; defaultView: CollectionView } {
  if (id === 'type:music') return { views: ['play', 'list'], defaultView: 'play' };
  const withPicture = entries.filter((e) => validUrl(e.thumbnailUrl) !== null).length;
  const share = entries.length === 0 ? 0 : withPicture / entries.length;
  if (share < COLLECTION_VIEW.gridOffered) return { views: ['list'], defaultView: 'list' };
  return { views: ['grid', 'list'], defaultView: share >= COLLECTION_VIEW.gridDefault ? 'grid' : 'list' };
}

/** The line of the list for a collection: the fixed fields, and what the posts say (how many, the mosaic, the views, «New»). */
export function describeCollection(base: CollectionBase, entries: readonly EntryFact[], now: Date): CollectionListItem {
  const madeAt = base.createdAt === null ? Number.NaN : Date.parse(base.createdAt);
  const isNew = base.kind === 'theme' && Number.isFinite(madeAt) && now.getTime() - madeAt < COLLECTION_VIEW.newDays * DAY_MS;
  const { views, defaultView } = viewsOf(base.id, entries);
  return {
    id: base.id,
    name: base.name,
    kind: base.kind,
    group: base.group,
    parentId: base.parentId,
    count: entries.length,
    isNew,
    thumbs: thumbsOf(entries),
    views,
    defaultView,
  };
}

// ---------------------------------------------------------------------------------------------------------------- the list

export type ThemeState = 'watching' | 'active' | 'hidden' | 'merged';

/** A theme as the store holds it (without its posts). */
export interface ThemeRow {
  id: string;
  name: string;
  nameBy: 'auto' | 'user';
  groupLabel: string | null;
  /** The parent theme; for a merged one, the collection it went into. */
  parentId: string | null;
  state: ThemeState;
  createdAt: string;
}

/** The posts that name one place (one record for each spelling the store has: `Milano` as a city, `milano` as a region…). */
export interface PlaceFacts {
  name: string;
  kind: PlaceKind;
  entries: EntryFact[];
}

/** What the list needs from the journal and the store; every source answers for ONE user, the one it is asked about, and nobody else. */
export interface ListSources {
  /** The posts of every type the user reads (the types with no post may be missing). */
  typeEntries(userId: string): Promise<Partial<Record<TypeId, EntryFact[]>>>;
  /** The places the posts of the user name, with the posts. */
  placeEntries(userId: string): Promise<PlaceFacts[]>;
  /** The themes of the user, in every state. */
  themeRows(userId: string): Promise<ThemeRow[]>;
  /** The live posts of every theme of the user (the ones taken out by hand are not in it, the ones put in by hand are), by theme id. */
  themeMembers(userId: string): Promise<Record<string, EntryFact[]>>;
}

/** `computed` = a type or a place: it has no row, so no state and nothing to correct. */
export type ListedState = 'active' | 'hidden' | 'watching' | 'computed';

export interface Listed {
  item: CollectionListItem;
  state: ListedState;
}

/** The same post twice is one (a source that joins a post to two places gives it twice). */
function uniqueFacts(entries: readonly EntryFact[]): EntryFact[] {
  const seen = new Map<string, EntryFact>();
  for (const entry of entries) if (!seen.has(entry.id)) seen.set(entry.id, entry);
  return [...seen.values()];
}

/** Italian collation without case or accents, so the order of two things of the same rank does not depend on the machine. */
const collator = new Intl.Collator('it', { sensitivity: 'base', numeric: true });
const byText = (a: string, b: string): number => collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);

interface Ranked extends Listed {
  /** A post of the last two weeks (the order of the list). */
  recent: boolean;
}

function isRecent(entries: readonly EntryFact[], now: Date): boolean {
  return entries.some((e) => now.getTime() - timeOf(e.createdAt) < COLLECTION_VIEW.recentDays * DAY_MS);
}

/** The places as collections: one for each slug, with the posts that name any of its spellings, from eight posts. */
function placeCollections(places: readonly PlaceFacts[], now: Date): Ranked[] {
  const bySlug = new Map<string, PlaceFacts[]>();
  for (const place of places) {
    if (!placeMakesCollection(place.kind)) continue;
    const slug = slugify(place.name);
    if (slug === '') continue;
    bySlug.set(slug, [...(bySlug.get(slug) ?? []), place]);
  }
  const out: Ranked[] = [];
  for (const [slug, spellings] of bySlug) {
    const entries = uniqueFacts(spellings.flatMap((p) => p.entries));
    if (entries.length < COLLECTION_VIEW.placeCollectionMin) continue;
    // the name is the spelling that most posts use (then the first in alphabetical order)
    const name = [...spellings].sort((a, b) => b.entries.length - a.entries.length || (a.name < b.name ? -1 : 1))[0].name;
    const item = describeCollection({ id: `place:${slug}`, name, kind: 'place', group: PLACES_GROUP, parentId: null, createdAt: null }, entries, now);
    out.push({ item, state: 'computed', recent: isRecent(entries, now) });
  }
  return out;
}

/**
 * Every collection the user can have, with its state, in the order the list shows them: the types first (the fixed order), then the themes and the
 * places (new first, then those with a post of the last two weeks, then the others; by size inside each; then by name). A type with no post, a theme
 * with none left and a merged theme are not collections. Reads only what the sources answer for `userId`.
 */
export async function buildCollections(userId: string, src: ListSources, now: Date): Promise<Listed[]> {
  const [typeEntries, places, themes, members] = await Promise.all([
    src.typeEntries(userId), src.placeEntries(userId), src.themeRows(userId), src.themeMembers(userId),
  ]);

  const types: Listed[] = [];
  for (const id of TYPE_IDS) {
    const entries = uniqueFacts(typeEntries[id] ?? []);
    if (entries.length === 0) continue;
    types.push({
      item: describeCollection({ id, name: TYPE_NAMES[id], kind: 'type', group: TYPES_GROUP, parentId: null, createdAt: null }, entries, now),
      state: 'computed',
    });
  }

  const live = themes.filter((t) => t.state !== 'merged' && uniqueFacts(members[t.id] ?? []).length > 0);
  // a parent that the site cannot show (hidden, under observation, empty) is no parent for it
  const shownParents = new Set(live.filter((t) => t.state === 'active').map((t) => t.id));
  const ranked: Ranked[] = live.map((t) => {
    const entries = uniqueFacts(members[t.id] ?? []);
    const item = describeCollection(
      { id: t.id, name: t.name, kind: 'theme', group: t.groupLabel, parentId: t.parentId !== null && shownParents.has(t.parentId) ? t.parentId : null, createdAt: t.createdAt },
      entries,
      now,
    );
    return { item, state: t.state === 'merged' ? 'computed' : t.state, recent: isRecent(entries, now) };
  });
  ranked.push(...placeCollections(places, now));

  const rank = (c: Ranked): number => (c.item.isNew ? 0 : c.recent ? 1 : 2);
  ranked.sort((a, b) => rank(a) - rank(b) || b.item.count - a.item.count || byText(a.item.name, b.item.name) || byText(a.item.id, b.item.id));

  return [...types, ...ranked.map(({ item, state }) => ({ item, state }))];
}

/** The list the site asks for: the active collections (`active`), the ones the user hid (`hidden`), the ones under observation (`watching`). */
export async function collectionList(userId: string, which: 'active' | 'hidden' | 'watching', src: ListSources, now: Date): Promise<CollectionListItem[]> {
  const all = await buildCollections(userId, src, now);
  const wanted: ListedState[] = which === 'active' ? ['active', 'computed'] : [which];
  return all.filter((c) => wanted.includes(c.state)).map((c) => c.item);
}

/** One collection with its state, or null when there is none (a merged theme is not one). Used to answer a correction with the collection as it is now. */
export async function findCollection(userId: string, id: string, src: ListSources, now: Date): Promise<Listed | null> {
  return (await buildCollections(userId, src, now)).find((c) => c.item.id === id) ?? null;
}

// ---------------------------------------------------------------------------------------------------------------- the chips of a post

/** One membership of a post in an ACTIVE theme (hidden, merged and watching ones, and the posts taken out by hand, are not in the rows). */
export interface ChipThemeRow {
  entryId: string;
  id: string;
  name: string;
  parentId: string | null;
  score: number;
}

/** One place a post names, and how many posts of the same user name it (a place is a collection from eight). */
export interface ChipPlaceRow {
  entryId: string;
  name: string;
  kind: PlaceKind;
  entries: number;
}

export interface ChipSources {
  chipThemes(userId: string, entryIds: string[]): Promise<ChipThemeRow[]>;
  chipPlaces(userId: string, entryIds: string[]): Promise<ChipPlaceRow[]>;
}

const KIND_RANK: Record<PlaceKind, number> = { city: 0, region: 1, country: 2 };

/**
 * The chips of each post (spec §6.5, docs/collections.md): at most two themes, the one the post is surer of first, and the place on top of them.
 * A theme whose child the post is also in is skipped (the child says more). The place is the most precise one that is a collection of its own: a
 * chip leads to `/entries?raccolta=<id>`, and a collection that does not exist would answer «not there any more». `keep` is the collection that is
 * open: it is among the chips of its own posts, first, so the «not this one» of the page can always reach it.
 * A post with no chip is not in the map.
 */
export function pickChips(themeRows: readonly ChipThemeRow[], placeRows: readonly ChipPlaceRow[], opts: { keep?: string } = {}): Map<string, CollectionChip[]> {
  const themesByEntry = new Map<string, Map<string, ChipThemeRow>>();
  for (const row of themeRows) {
    const mine = themesByEntry.get(row.entryId) ?? new Map<string, ChipThemeRow>();
    const seen = mine.get(row.id);
    if (!seen || row.score > seen.score) mine.set(row.id, row);
    themesByEntry.set(row.entryId, mine);
  }
  const placesByEntry = new Map<string, ChipPlaceRow[]>();
  for (const row of placeRows) {
    if (!placeMakesCollection(row.kind) || row.entries < COLLECTION_VIEW.placeCollectionMin || slugify(row.name) === '') continue;
    placesByEntry.set(row.entryId, [...(placesByEntry.get(row.entryId) ?? []), row]);
  }

  const out = new Map<string, CollectionChip[]>();
  for (const entryId of new Set([...themesByEntry.keys(), ...placesByEntry.keys()])) {
    const candidates = [...(themesByEntry.get(entryId)?.values() ?? [])];
    const parents = new Set(candidates.map((t) => t.parentId).filter((p): p is string => p !== null));
    const byScore = (a: ChipThemeRow, b: ChipThemeRow): number => b.score - a.score || byText(a.name, b.name) || byText(a.id, b.id);
    let ordered = candidates.filter((t) => !parents.has(t.id)).sort(byScore);
    const open = opts.keep ? candidates.find((t) => t.id === opts.keep) : undefined;
    if (open) ordered = [open, ...ordered.filter((t) => t.id !== open.id)];

    const chips: CollectionChip[] = ordered.slice(0, COLLECTION_VIEW.themeChips).map((t) => ({ id: t.id, name: t.name }));
    const place = [...(placesByEntry.get(entryId) ?? [])].sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind] || b.entries - a.entries || byText(a.name, b.name))[0];
    if (place) chips.push({ id: placeCollectionId(place.name), name: place.name });
    if (chips.length > 0) out.set(entryId, chips);
  }
  return out;
}

/** The chips of a whole page of posts, asking each source once. */
export async function chipsForEntries(userId: string, entryIds: string[], src: ChipSources, opts: { keep?: string } = {}): Promise<Map<string, CollectionChip[]>> {
  if (entryIds.length === 0) return new Map();
  const [themes, places] = await Promise.all([src.chipThemes(userId, entryIds), src.chipPlaces(userId, entryIds)]);
  return pickChips(themes, places, opts);
}

// ---------------------------------------------------------------------------------------------------------------- «Why is it here?»

/** A post of a theme, as the explanation needs it: what it says, and how sure the grouping was that it belongs. */
export interface WhyMember {
  id: string;
  createdAt: string;
  summary: string | null;
  tags: string[];
  score: number;
  /** `auto` = found by the grouping, `user_add` = put in by hand (its score is a formality). */
  source: 'auto' | 'user_add' | 'computed';
}

/** Tags that say nothing about the subject: the words the model copies from its prompt, the handles, the tags of the platforms and of the feed. */
const NOISE_TAGS = new Set([
  'tag', 'hashtag', 'utente', 'fyp', 'viral', 'virale', 'perte', 'foryou', 'foryoupage', 'explore', 'trending', 'reels', 'reel', 'instagram', 'tiktok', 'youtube',
  'shorts', 'x', 'follow', 'like',
]);

/** The words of the grammar and of the way a summary is written («il post parla di…»): they are in every summary and say nothing. */
const STOP_WORDS = new Set((
  'alla alle allo agli anche ancora altra altre altri altro avere come cosa cose cosi dalla dalle dallo dagli dall dell della delle dello degli dopo dove ' +
  'ecco essere fanno fare forse fino hanno loro molto molti molte nella nelle nello negli nell niente nostro nostra perche perché piu più poco pochi quale quali ' +
  'quando quanto quella quelle quello quelli quell questa queste questo questi quindi sempre senza sono stata state stati stato sulla sulle sullo sugli sull ' +
  'tutti tutte tutto tutta ogni ogni modo volta volte stesso stessa puoi puo può dire fatto fanno due tre ' +
  'post video reel reels instagram tiktok youtube link parla parlano mostra mostrano spiega spiegano presenta presentano illustra descrive consiglia ' +
  'elenca elenco lista consigli alcuni alcune diversi diverse vari varie contenuto autore persona utente account pagina canale clip ' +
  'that this with from your have what when where which their about into more most some than then them these those very will would could should been were ' +
  'also just like here there only over after before because while video videos about'
).split(/\s+/).filter(Boolean));

/** Lower case, no accents: the way two spellings of a word are told to be one. */
const foldWord = (s: string): string => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '');

/** The key of a word: no accents, and no last vowel (so «vino» and «vini», «cantina» and «cantine» are one). */
const stemKey = (word: string): string => foldWord(word).replace(/[aeiou]$/, '');

function mostCommon(counts: Map<string, number>): string {
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0][0];
}

interface Candidate {
  /** surface form → how many posts write it that way */
  forms: Map<string, number>;
  posts: number;
}

const bump = (map: Map<string, number>, key: string): void => { map.set(key, (map.get(key) ?? 0) + 1); };

/** The candidates ranked: the most posts first, then in alphabetical order of the key; each with the surface form most posts use. */
function ranked(candidates: Map<string, Candidate>, minPosts: number): Array<{ key: string; word: string; posts: number }> {
  return [...candidates]
    .filter(([, c]) => c.posts >= minPosts)
    .map(([key, c]) => ({ key, word: mostCommon(c.forms), posts: c.posts }))
    .sort((a, b) => b.posts - a.posts || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * Why the posts of a theme are together (spec §9 item 9: «3–4 parole che la definiscono e le due voci più centrali»). The posts are the two the
 * grouping was surest of (the ones put in by hand come after: their score is a formality). The words are the tags that at least two posts share (once
 * for a post, without the hash, no noise), the most common first, and then, up to four in all, the words that a quarter of the posts with a summary repeat.
 */
export function explainTheme(members: readonly WhyMember[]): { words: string[]; entryIds: string[] } {
  const newestFirst = (a: WhyMember, b: WhyMember): number => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const typical = [
    ...members.filter((m) => m.source !== 'user_add').sort((a, b) => b.score - a.score || newestFirst(a, b)),
    ...members.filter((m) => m.source === 'user_add').sort(newestFirst),
  ];
  const entryIds = typical.slice(0, COLLECTION_VIEW.whyEntries).map((m) => m.id);

  const tags = new Map<string, Candidate>();
  for (const member of members) {
    const mine = new Set<string>();
    for (const raw of member.tags) {
      const tag = raw.trim().replace(/^#+/, '').trim();
      if (tag.length < 2 || tag.startsWith('@') || raw.trim().startsWith('@')) continue;
      const key = foldWord(tag).replace(/[^a-z0-9]+/g, '');
      if (key === '' || NOISE_TAGS.has(key) || mine.has(key)) continue;
      mine.add(key);
      const entry = tags.get(key) ?? { forms: new Map<string, number>(), posts: 0 };
      entry.posts += 1;
      bump(entry.forms, tag);
      tags.set(key, entry);
    }
  }
  const words = ranked(tags, 2).slice(0, COLLECTION_VIEW.whyWords).map((t) => t.word);

  if (words.length < COLLECTION_VIEW.whyWords) {
    const taken = new Set(ranked(tags, 2).map((t) => stemKey(t.word)));
    const summarised = members.filter((m) => typeof m.summary === 'string' && m.summary.trim() !== '');
    const found = new Map<string, Candidate>();
    for (const member of summarised) {
      const mine = new Set<string>();
      for (const raw of (member.summary as string).toLowerCase().match(/\p{L}+/gu) ?? []) {
        if (raw.length < 4 || STOP_WORDS.has(raw) || STOP_WORDS.has(foldWord(raw))) continue;
        const key = stemKey(raw);
        if (mine.has(key) || taken.has(key)) continue;
        mine.add(key);
        const entry = found.get(key) ?? { forms: new Map<string, number>(), posts: 0 };
        entry.posts += 1;
        bump(entry.forms, raw);
        found.set(key, entry);
      }
    }
    const minPosts = Math.max(2, Math.ceil(summarised.length * 0.25));
    for (const w of ranked(found, minPosts)) {
      if (words.length === COLLECTION_VIEW.whyWords) break;
      words.push(w.word);
    }
  }
  return { words, entryIds };
}

// ---------------------------------------------------------------------------------------------------------------- the venues

/** The post a venue is cited in: where it lives and when it was saved. */
export interface VenueEntryRef {
  id: string;
  sourceUrl: string;
  sourcePlatform: string;
  createdAt: string;
}

/** The value most rows agree on (a tie goes to the one of the newest post: the rows come newest first). */
function majority<T>(values: readonly T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, n] of counts) {
    if (n > bestCount) {
      best = v;
      bestCount = n;
    }
  }
  return best;
}

/**
 * The venues of the posts, ONE row for each (ADR-0017: the same venue in three posts is one row with three links to the posts), the posts that cite
 * it newest first. The venue is called what most of its posts call it (the newest wins a tie) and its kind is what most of them say, `other` only when
 * none says better. The address of Google Maps is built HERE, from the name and the city (rule P: no client builds it). A post the collection does
 * not hold is not invented, and a venue left with no post is dropped. Ordered by how many posts cite it, then by name, then by key.
 */
export function groupVenues(rows: readonly EntryVenueRow[], entries: ReadonlyMap<string, VenueEntryRef>): CollectionVenue[] {
  const byKey = new Map<string, Array<{ row: EntryVenueRow; entry: VenueEntryRef }>>();
  const seen = new Set<string>();
  for (const row of rows) {
    const entry = entries.get(row.entryId);
    if (!entry || seen.has(`${row.key}\u0000${row.entryId}`)) continue;
    seen.add(`${row.key}\u0000${row.entryId}`);
    byKey.set(row.key, [...(byKey.get(row.key) ?? []), { row, entry }]);
  }
  const venues: CollectionVenue[] = [];
  for (const [key, cited] of byKey) {
    const newestFirst = [...cited].sort((a, b) => timeOf(b.entry.createdAt) - timeOf(a.entry.createdAt) || (a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0));
    const name = majority(newestFirst.map((c) => c.row.name)) ?? newestFirst[0].row.name;
    const kind = majority(newestFirst.map((c) => c.row.kind).filter((k) => k !== 'other')) ?? 'other';
    const place = majority(newestFirst.map((c) => c.row.place).filter((p): p is string => p !== null)) ?? null;
    venues.push({
      key,
      name,
      kind,
      place,
      mapsUrl: mapsUrl(name, place),
      posts: newestFirst.map(({ entry }) => ({ entryId: entry.id, sourceUrl: postUrlOf(entry.sourceUrl) ?? entry.sourceUrl, sourcePlatform: entry.sourcePlatform, createdAt: entry.createdAt })),
    });
  }
  return venues.sort((a, b) => b.posts.length - a.posts.length || byText(a.name, b.name) || byText(a.key, b.key));
}

// ---------------------------------------------------------------------------------------------------------------- one collection

/** A post of a collection, as the list of entries gives it, with how sure the grouping was and where it came from (themes only). */
export interface MemberRow extends EntrySummaryRow {
  score: number;
  source: 'auto' | 'user_add' | 'computed';
}

/** Which posts to read: the ones of a type, the ones that name a place (any of its spellings), the live ones of a theme. */
export type MemberRef =
  | { kind: 'type'; type: TypeId }
  | { kind: 'place'; names: string[] }
  | { kind: 'theme'; id: string };

export interface DetailSources extends Pick<ListSources, 'themeRows' | 'placeEntries'>, ChipSources {
  /** The summary rows of the posts of ONE collection of the user, newest first (themes carry the score and where the post came from). */
  members(userId: string, ref: MemberRef): Promise<MemberRow[]>;
  placesOf(entryIds: string[]): Promise<EntryPlaceRow[]>;
  venuesOf(entryIds: string[]): Promise<EntryVenueRow[]>;
  /** The songs of the user's posts: the key and the date of the newest post that names it. */
  songs(userId: string): Promise<Array<{ key: string; at: string }>>;
}

/** Everything the view layer reads: the lists, one collection, the chips. The real sources implement it all; a test may implement what it asks for. */
export interface ViewSources extends ListSources, DetailSources {}

export interface DetailQuery {
  /** A place of the facet «where». */
  dove?: string;
  /** A platform. */
  fonte?: string;
  /** `AAAA-MM`. */
  quando?: string;
  /** Free words: every one must be in the summary, the caption or the tags. */
  q?: string;
  offset: number;
  limit: number;
}

/** Lower case, no accents, words of letters and digits separated by one space: how a search and a post are compared. */
const foldText = (s: string): string =>
  s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();

/** The month of a date, in UTC (`2026-11`), or null when it is not a date. */
function monthOf(iso: string): string | null {
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toISOString().slice(0, 7) : null;
}

/** The posts that pass the filters of the query. */
function filterMembers(rows: readonly MemberRow[], placesByEntry: ReadonlyMap<string, string[]>, query: DetailQuery): MemberRow[] {
  const words = query.q ? foldText(query.q).split(' ').filter(Boolean) : [];
  const dove = query.dove ? foldText(query.dove) : '';
  const fonte = query.fonte ? query.fonte.trim().toLowerCase() : '';
  return rows.filter((row) => {
    if (fonte !== '' && row.sourcePlatform.toLowerCase() !== fonte) return false;
    if (query.quando && monthOf(row.createdAt) !== query.quando) return false;
    if (dove !== '' && !(placesByEntry.get(row.id) ?? []).some((name) => foldText(name) === dove)) return false;
    if (words.length > 0) {
      const text = foldText(`${row.summary ?? ''} ${row.caption ?? ''} ${row.tags.join(' ')}`);
      if (!words.every((w) => text.includes(w))) return false;
    }
    return true;
  });
}

/** The facets of ALL the posts of the collection (so the user can still choose another after choosing one): places named by two, sources, months. */
function facetsOf(rows: readonly MemberRow[], placesByEntry: ReadonlyMap<string, string[]>, leaveOut: readonly string[]): CollectionFacets {
  const left = new Set(leaveOut.map(foldText));
  const places = new Map<string, number>();
  const sources = new Map<string, number>();
  const months = new Map<string, number>();
  for (const row of rows) {
    for (const name of new Set(placesByEntry.get(row.id) ?? [])) if (!left.has(foldText(name))) places.set(name, (places.get(name) ?? 0) + 1);
    if (row.sourcePlatform) sources.set(row.sourcePlatform, (sources.get(row.sourcePlatform) ?? 0) + 1);
    const month = monthOf(row.createdAt);
    if (month !== null) months.set(month, (months.get(month) ?? 0) + 1);
  }
  return {
    places: [...places].filter(([, n]) => n >= COLLECTION_VIEW.placeFacetMin).map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count || byText(a.name, b.name)),
    sources: [...sources].map(([platform, count]) => ({ platform, count })).sort((a, b) => b.count - a.count || (a.platform < b.platform ? -1 : a.platform > b.platform ? 1 : 0)),
    months: [...months].map(([month, count]) => ({ month, count })).sort((a, b) => (a.month < b.month ? 1 : a.month > b.month ? -1 : 0)),
  };
}

/** The keys of the songs, the newest first (a tie by key, a song with no readable date at the end), at most `songKeysMax`. */
function songKeysOf(songs: ReadonlyArray<{ key: string; at: string }>): string[] {
  return [...songs]
    .sort((a, b) => timeOf(b.at) - timeOf(a.at) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .slice(0, COLLECTION_VIEW.songKeysMax)
    .map((s) => s.key);
}

const factOf = (row: MemberRow): EntryFact => ({ id: row.id, createdAt: row.createdAt, thumbnailUrl: row.thumbnailUrl });

/**
 * One collection with everything its page draws (docs/collections.md): its line, why it is a collection, the facets, the posts of the page (newest
 * first, narrowed by the filters), the venues of all its posts, and, for the music, the songs to play. null = there is no such collection for this user:
 * an id that is none of ours, a merged theme, a theme under observation (unless `includeWatching`), a place of fewer than eight posts, or no post at all.
 * A failure of the chips or of the songs costs only them (and is logged); any other source failing fails the whole.
 */
export async function collectionDetail(
  userId: string,
  id: string,
  query: DetailQuery,
  src: DetailSources,
  now: Date,
  opts: { includeWatching?: boolean } = {},
): Promise<CollectionDetail | null> {
  const parsed = parseCollectionId(id);
  let base: CollectionBase;
  let ref: MemberRef;
  /** The place itself, which a place collection does not offer as a facet. */
  let ownPlaces: string[] = [];

  if (parsed.kind === 'unknown-computed') return null;
  if (parsed.kind === 'type') {
    base = { id: parsed.type, name: TYPE_NAMES[parsed.type], kind: 'type', group: TYPES_GROUP, parentId: null, createdAt: null };
    ref = { kind: 'type', type: parsed.type };
  } else if (parsed.kind === 'place') {
    const spellings = (await src.placeEntries(userId)).filter((p) => placeMakesCollection(p.kind) && slugify(p.name) === parsed.slug);
    if (uniqueFacts(spellings.flatMap((p) => p.entries)).length < COLLECTION_VIEW.placeCollectionMin) return null;
    ownPlaces = [...new Set(spellings.map((p) => p.name))];
    const name = [...spellings].sort((a, b) => b.entries.length - a.entries.length || (a.name < b.name ? -1 : 1))[0].name;
    base = { id: `place:${parsed.slug}`, name, kind: 'place', group: PLACES_GROUP, parentId: null, createdAt: null };
    ref = { kind: 'place', names: ownPlaces };
  } else {
    const themes = await src.themeRows(userId);
    const row = themes.find((t) => t.id === parsed.id);
    if (!row || row.state === 'merged' || (row.state === 'watching' && !opts.includeWatching)) return null;
    const parentShown = row.parentId !== null && themes.some((t) => t.id === row.parentId && t.state === 'active');
    base = { id: row.id, name: row.name, kind: 'theme', group: row.groupLabel, parentId: parentShown ? row.parentId : null, createdAt: row.createdAt };
    ref = { kind: 'theme', id: row.id };
  }

  const members = (await src.members(userId, ref)).sort(
    (a, b) => timeOf(b.createdAt) - timeOf(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  if (members.length === 0) return null;
  const collection = describeCollection(base, members.map(factOf), now);

  const memberIds = members.map((m) => m.id);
  const [placeRows, venueRows] = await Promise.all([src.placesOf(memberIds), src.venuesOf(memberIds)]);
  const placesByEntry = new Map<string, string[]>();
  for (const p of placeRows) placesByEntry.set(p.entryId, [...(placesByEntry.get(p.entryId) ?? []), p.name]);

  const filtered = filterMembers(members, placesByEntry, query);
  const page = filtered.slice(query.offset, query.offset + query.limit);

  let chips = new Map<string, CollectionChip[]>();
  try {
    chips = await chipsForEntries(userId, page.map((m) => m.id), src, parsed.kind === 'theme' ? { keep: id } : {});
  } catch (err) {
    logWarning('collections: the chips of a page could not be read (the posts are answered without them)', { collection: id, error: err instanceof Error ? err.message : String(err) });
  }

  const refs = new Map<string, VenueEntryRef>(members.map((m) => [m.id, { id: m.id, sourceUrl: m.sourceUrl, sourcePlatform: m.sourcePlatform, createdAt: m.createdAt }]));

  const detail: CollectionDetail = {
    collection,
    why: parsed.kind === 'theme'
      ? explainTheme(members.map((m) => ({ id: m.id, createdAt: m.createdAt, summary: m.summary, tags: m.tags, score: m.score, source: m.source })))
      : { words: [], entryIds: [] },
    facets: facetsOf(members, placesByEntry, ownPlaces),
    entries: page.map(({ score: _score, source: _source, ...row }): CollectionEntry => ({ ...row, collections: chips.get(row.id) ?? [] })),
    venues: groupVenues(venueRows, refs),
    total: filtered.length,
  };
  if (collection.views.includes('play')) {
    try {
      detail.songKeys = songKeysOf(await src.songs(userId));
    } catch (err) {
      logWarning('collections: the songs of the music could not be read (the page is answered with nothing to play)', { error: err instanceof Error ? err.message : String(err) });
      detail.songKeys = [];
    }
  }
  return detail;
}
