/**
 * Every number of the collections in ONE place (Raccolte; spec 2026-11-09-library-collections-auto-topics-design.md §3.1, §4, §5; ADR-0022; plan task 1).
 *
 * The first block is what the discovery decides with and what the calibration of phase 0 sets on the real library (`scripts/calibrateCollections.ts`; the
 * measured table is in the spec §3.1, «Calibrazione di fase 0»). They depend on THIS library and THIS embedding model (`nomic-embed-text`, vectors centred
 * on the library mean): a new model means measuring again and making the vectors again (`model` is in the table).
 */

export interface CollectionParams {
  // --- the grouping (the vectors are centred on the library mean and have length 1) ---
  /** A vector joins the group whose centre is at least this similar (cosine); else it opens a group. */
  groupTau: number;
  /** Two groups whose centres are at least this similar are one group (groupTau + 0.22: the +0.12 of the trial glued unrelated topics, see the spec §3.1). */
  mergeTau: number;
  /** A group whose centre is at least this close to the centre of the entries that talk about music, or about films, is that TYPE and not a theme. */
  absorbTau: number;
  /** A group is published only if its members are on average at least this close to its centre. */
  minCoherence: number;
  /** An entry belongs to a theme (a theme of the library) when it is at least this close to its centre. */
  assignTau: number;
  /** The same as `groupTau`, inside a big group, to find its children (the vectors are centred on the group's own mean). */
  childTau: number;
  /** Passes that put every vector back to the nearest centre after the first pass. */
  groupingPasses: number;
  /**
   * A group (or a child) is ALSO a type when at least this share of its entries has songs from the content (music) or films (films): the centre of a
   * child inside a big group lives in another corner of the space than the centre of the whole library, so the cosine alone does not see it.
   */
  typeMemberShare: number;
  /** Two collections with the SAME NAME are one when their centres are at least this similar: lower than `mergeTau`, because the name already says it. */
  sameNameTau: number;

  // --- birth, life and death (spec §5.4, Michele Q3: «5 voci») ---
  /** A collection is born (active) at this many entries. */
  birthSize: number;
  /** From this many entries to `birthSize - 1` it is only «watching» (not shown); below it, it dies. An active one stays active down to here. */
  watchingSize: number;
  /** A new group inherits the id and the name of the old collection that holds at least this share of the OLD members. */
  inheritFraction: number;
  /** At most this many themes per entry (plus the parent of each). */
  maxThemesPerEntry: number;
  /** A collection with at least this many members and sub-groups of at least `childMinSize` splits into children. */
  splitMinMembers: number;
  childMinSize: number;

  // --- places and venues (spec §4.3, §4.6) ---
  placeFacetMin: number;
  placeCombinationMin: number;
  placeCollectionMin: number;
  maxVenuesPerEntry: number;

  // --- what the site shows ---
  /** «Nuova» for this many days. */
  newDays: number;
  /** The order puts first the collections that got entries in the last days. */
  activeRecentDays: number;
  /** The rail shows at most this many collections; the rest is in the page «Raccolte». */
  railMax: number;

  // --- names (spec §5.5) ---
  /** A new name is accepted only if one of its words is in at least this share of the members. */
  nameWordShare: number;
  /** The dominant tag names the group when this share of the members has it. */
  nameTagShare: number;
}

export const COLLECTION_PARAMS: CollectionParams = {
  groupTau: 0.42,
  mergeTau: 0.64,
  absorbTau: 0.8,
  minCoherence: 0.5,
  assignTau: 0.42,
  childTau: 0.38,
  groupingPasses: 3,
  typeMemberShare: 0.7,
  sameNameTau: 0.45,

  birthSize: 5,
  watchingSize: 3,
  inheritFraction: 0.5,
  maxThemesPerEntry: 2,
  splitMinMembers: 60,
  childMinSize: 8,

  placeFacetMin: 2,
  placeCombinationMin: 5,
  placeCollectionMin: 8,
  maxVenuesPerEntry: 20,

  newDays: 7,
  activeRecentDays: 14,
  railMax: 12,

  nameWordShare: 0.3,
  nameTagShare: 0.5,
};
