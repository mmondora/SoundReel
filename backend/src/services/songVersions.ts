/**
 * "Versione di …" (spec 2026-11-08-no-duplicates-and-post-links-design §7, ADR-0017 §2.6, D5; Michele's answer of
 * 8 November): a song whose title says it is a version of another one (Instrumental, Slowed + Reverb, Live, a Remix…)
 * stays its own card and carries a pointer to the original.
 *
 * Computed at READ time from titles and artists. The song key does not change (playlists, `song_files` and `song_meta`
 * are keyed by it) and nothing is stored, so the rule can be refined without touching history.
 *
 * The recognition is deliberately prudent. Measured on the real journal (795 distinct title/artist pairs, 153 with a
 * bracket, a dash or a "feat."), many parentheses are PART of the title: "(Interlude)", "(Nature Sounds)",
 * "(From "Spirited Away")", "(Main Title Theme)", "(Magic Feeling)", "(Deluxe Edition)". A group is a version only when it
 * says so in the words below; everything else stays in the title.
 */
import type { AggregatedSong, SongVersionOf } from '../types';

/** Words that, alone or together with the modifiers, make a bracket a version marker. */
const KIND_WORDS = new Set([
  'instrumental', 'instrumentals', 'karaoke',
  'slowed', 'slow', 'sped', 'speed', 'speedup', 'nightcore', 'reverb', 'pitched',
  'live', 'acoustic', 'unplugged', 'cover',
  'remix', 'mix', 'edit', 'rework', 'bootleg', 'flip', 'vip', 'dub', 'mashup', 'reinterpretation', 'rendition',
  'version', 'piano', 'orchestral', 'epic', 'lofi', '8d', 'boosted', 'extended', 'demo', 'unfinished', 'stripped', 'reprise',
]);
/** Words that may sit next to a kind ("Ultra Slowed", "Slowed to perfection", "Special Version") but do not make one. */
const MODIFIER_WORDS = new Set(['ultra', 'super', 'over', 'extra', 'special', 'mega', 'hyper', 'the', 'a', 'and', 'to', 'perfection', 'up', 'bass', 'radio', 'session']);
/** A group ending with one of these is a version whatever precedes ("Andres Luque Remix", "Curious House Mix"). */
const NAMED_ENDINGS = new Set(['remix', 'mix', 'edit', 'rework', 'bootleg', 'flip', 'dub', 'version', 'mashup', 'reinterpretation', 'rendition', 'cover']);
/** "Live at Wembley", "Live from the studio": `live` opens a version only with one of these after it ("Live Forever" is a title). */
const LIVE_FOLLOWERS = new Set(['at', 'in', 'from', 'on', 'session', 'sessions', 'version', 'performance', 'recording', 'acoustic', 'unplugged', 'studio', 'lounge']);
/** A credit. Not "with": "(With You)" is a title, and "(with Gordon Tracks)" costs nothing left where it is. */
const CREDIT_STARTS = new Set(['feat', 'ft', 'featuring', 'prod']);
const REMASTER_OK = new Set(['digital', 'version', 'stereo', 'mono', 'the', 'new']);

export type GroupKind = 'version' | 'credit' | 'remaster' | 'title';

export interface ParsedTitle {
  /** The title without the version markers, credits and remaster notes, as it was written. */
  base: string;
  /** The version markers, as written ("Slowed + Reverb"). */
  versions: string[];
  /** Credits and remaster notes, as written ("feat. Pusha T", "2008 Remaster"): the same audio under another spelling. */
  decorations: string[];
}

function tokens(text: string): string[] {
  const folded = text
    .toLowerCase()
    .replace(/lo[\s-]?fi/g, 'lofi')
    .replace(/["'’“”`´]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return folded.match(/[\p{L}\p{N}]+/gu) ?? [];
}

const isNumber = (t: string): boolean => /^\d+$/.test(t);

/** What one bracket (or the text after a dash) is. Pure. */
export function classifyGroup(text: string): GroupKind {
  const all = tokens(text);
  const words = all.filter((t) => !isNumber(t));
  if (words.length === 0) return 'title';
  if (CREDIT_STARTS.has(words[0])) return 'credit';
  if (words.some((t) => t.startsWith('remaster')) && words.every((t) => t.startsWith('remaster') || REMASTER_OK.has(t))) return 'remaster';
  const known = words.every((t) => KIND_WORDS.has(t) || MODIFIER_WORDS.has(t));
  if (known && words.some((t) => KIND_WORDS.has(t))) return 'version';
  if (NAMED_ENDINGS.has(words[words.length - 1])) return 'version';
  if (words[0] === 'acoustic' || words[0] === 'unplugged') return 'version';
  if (words[0] === 'live' && words.length > 1 && LIVE_FOLLOWERS.has(words[1])) return 'version';
  return 'title';
}

/**
 * Splits a title into what it is called and the markers it carries. The brackets `( )` and `[ ]` are looked at one by
 * one; so is the text after the LAST " - " ("Beanie - Piano Version", "In The Flight - Live").
 */
export function parseSongTitle(title: string): ParsedTitle {
  const versions: string[] = [];
  const decorations: string[] = [];
  let rest = title;

  const take = (kind: GroupKind, text: string): boolean => {
    if (kind === 'version') versions.push(text.trim());
    else if (kind === 'credit' || kind === 'remaster') decorations.push(text.trim());
    else return false;
    return true;
  };

  // brackets: a group that is only a marker is cut out; any other stays in the title
  rest = rest.replace(/\(([^()]*)\)|\[([^[\]]*)\]/g, (whole, round: string | undefined, square: string | undefined) => {
    const inner = (round ?? square ?? '').trim();
    return take(classifyGroup(inner), inner) ? ' ' : whole;
  });

  // the text after the last " - ": "Naomi Sharon - I'm Not Your Toy" is a title, "Beanie - Piano Version" is a version
  const dash = rest.match(/^(.*\S)\s+[-–—]\s+([^-–—]*\S)\s*$/);
  if (dash && take(classifyGroup(dash[2]), dash[2])) rest = dash[1];

  const base = rest
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+[-–—:,]+\s*$/, '')
    .replace(/^\s*[-–—:,]+\s+/, '')
    .trim();
  return { base: base || title.trim(), versions, decorations };
}

/** The form two titles are compared in: case, accents and punctuation do not count. */
export function titleKey(title: string): string {
  return tokens(title).join(' ');
}

const NO_ARTIST = new Set(['', 'undefined', 'unknown', 'null', 'various artists', 'va']);
const ARTIST_STOP = new Set(['feat', 'ft', 'featuring', 'the', 'and', 'with', 'prod', 'music', 'official']);

function artistWords(artist: string | null | undefined): Set<string> {
  return new Set(tokens(artist ?? '').filter((t) => t.length > 2 && !ARTIST_STOP.has(t)));
}

/** Same artist enough to be the original: a name in common; a missing artist ("undefined") does not exclude. */
export function sameArtist(a: string | null | undefined, b: string | null | undefined): boolean {
  const clean = (v: string | null | undefined): string => (v ?? '').trim().toLowerCase();
  if (NO_ARTIST.has(clean(a)) || NO_ARTIST.has(clean(b))) return true;
  const wa = artistWords(a);
  const wb = artistWords(b);
  for (const w of wa) if (wb.has(w)) return true;
  return false;
}

/**
 * Adds `versionOf` to every song that is a version of another. The original is the card with the same base title and
 * the same artist, if there is exactly one; with none (or more than one) the label stays without a link, but only for a
 * real version: a credit ("feat. X") or a remaster note on its own says nothing worth a label.
 */
export function attachSongVersions(songs: Iterable<AggregatedSong>): void {
  const list = [...songs];
  const parsed = new Map<string, ParsedTitle>(list.map((s) => [s.songKey, parseSongTitle(s.title)]));
  const originals = new Map<string, AggregatedSong[]>();
  for (const s of list) {
    const p = parsed.get(s.songKey)!;
    if (p.versions.length > 0 || p.decorations.length > 0) continue; // it is a version or a variant itself, not an original
    const k = titleKey(p.base);
    if (!k) continue;
    if (!originals.has(k)) originals.set(k, []);
    originals.get(k)!.push(s);
  }

  for (const s of list) {
    const p = parsed.get(s.songKey)!;
    const marked = p.versions.length > 0 || p.decorations.length > 0;
    if (!marked) continue;
    const candidates = (originals.get(titleKey(p.base)) ?? []).filter((o) => o.songKey !== s.songKey && sameArtist(o.artist, s.artist));
    const original = candidates.length === 1 ? candidates[0] : null;
    if (!original && p.versions.length === 0) continue;
    const versionOf: SongVersionOf = {
      title: original ? original.title : p.base,
      artist: original ? original.artist || null : null,
      songKey: original ? original.songKey : null,
      labels: [...p.versions, ...p.decorations],
    };
    s.versionOf = versionOf;
  }
}
