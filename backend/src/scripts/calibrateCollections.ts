/**
 * Calibration of the collections (Raccolte, task 1, phase 0; spec 2026-11-09-library-collections-auto-topics-design.md §3.1 and §9; ADR-0022).
 *
 * READ-ONLY. It never touches the database and never writes to the library: it reads a JSONL EXPORT of the entries (one JSON per line: id, createdAt,
 * caption, tags, summary, hasSongs, hasContentSongs, hasFilms), makes the vectors through the local router (`nomic-embed-text`), centres them on the library
 * mean, and runs the discovery in miniature (`previewCollections`: groups → music/film gate → coherence gate → children → assignment of every entry to at
 * most two themes) for a sweep of `groupTau` and of the merge offset (`mergeTau = groupTau + offset`). It prints what the constants of
 * `collectionsParams.ts` must be chosen on: groups of at least 5, coverage, the largest group, how many collections are published, and the golden set
 * (spec §9: «Vino» ≥ 12 entries in one collection, a restaurants collection with ≥ 5 naming Milano, «Casa e design» ≥ 8), read the way the engine will read
 * it: on what each COLLECTION holds after the assignment (the group alone is shown beside it). For one chosen `groupTau` it lists every group with how close
 * its centre is to the centre of the entries that talk about music and about films (`absorbTau`), how tight it is (`minCoherence`) and what became of it.
 *
 * The export holds private posts: keep it OUTSIDE the repository (the scratchpad of the session), like the vectors cache.
 *
 *   OLLAMA_URL=http://127.0.0.1:9001 npx tsx src/scripts/calibrateCollections.ts <export.jsonl> [--cache vectors.json]
 *        [--taus 0.35,0.38,0.42,0.45,0.48] [--offsets 0.12,0.22] [--detail 0.42] [--top 40]
 *        [--assign 0.42] [--absorb 0.8] [--min-coherence 0.5] [--child-tau 0.38] [--type-share 0.7]
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { embedTexts, embeddingTextHash, entryEmbeddingText, postToRouter, type EmbedDeps } from '../services/embeddings';
import {
  assignToThemes,
  centerAndNormalize,
  cosine,
  discoverCollections,
  isTypeByMembers,
  normalizeVector,
  type Absorbed,
  type Group,
  type TypeContext,
} from '../services/collectionsCluster';
import { COLLECTION_PARAMS, type CollectionParams } from '../services/collectionsParams';

export interface ExportRow {
  id: string;
  createdAt: string;
  status: string;
  caption: string | null;
  tags: string[];
  summary: string | null;
  hasSongs: boolean;
  hasContentSongs: boolean;
  hasFilms: boolean;
}

/** One JSON per line; a row that lacks a value gets the neutral one. */
export function parseExport(jsonl: string): ExportRow[] {
  return jsonl
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const r = JSON.parse(line) as Partial<ExportRow>;
      return {
        id: String(r.id),
        createdAt: String(r.createdAt ?? ''),
        status: r.status ?? 'completed',
        caption: r.caption ?? null,
        tags: Array.isArray(r.tags) ? r.tags.filter((t): t is string => typeof t === 'string') : [],
        summary: r.summary ?? null,
        hasSongs: Boolean(r.hasSongs),
        hasContentSongs: Boolean(r.hasContentSongs),
        hasFilms: Boolean(r.hasFilms),
      };
    });
}

/** The text a person would search in: summary, caption and tags, lower case, without accents and without the # of the tags. */
export function foldText(row: ExportRow): string {
  return [row.summary ?? '', row.caption ?? '', ...row.tags.map((t) => t.replace(/^#+/, ''))]
    .join(' ')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** The golden set of spec §9: a topic found by keywords independent of the vectors, and how many of its entries must end up in ONE group. */
export interface GoldenTopic {
  name: string;
  /** Does this (folded) text belong to the topic? */
  test: (text: string) => boolean;
  /** The fewest entries of the topic that one group must hold. */
  minHits: number;
}

export const GOLDEN_SET: GoldenTopic[] = [
  { name: 'Vino', test: (t) => /\b(vino|vini|vitigno|vitigni|cantina|cantine|enologi\w*|sommelier|bollicine|barolo|chianti|prosecco|franciacorta)\b/.test(t), minHits: 12 },
  { name: 'Ristoranti a Milano', test: (t) => /\b(ristorant\w*|trattori\w*|osteri\w*|pizzeri\w*)\b/.test(t) && /\bmilan\w*\b/.test(t), minHits: 5 },
  // a house AND something done to it: «casa» alone is «a casa», and «design» alone is an app
  { name: 'Casa e design', test: (t) => /\b(casa|case|abitazione|appartamento|villa|interni|interior\w*)\b/.test(t) && /\b(progett\w+|bioedil\w+|arred\w+|ristruttur\w+|interior\w*|costru\w+|architett\w*|design|bioarchitettura)\b/.test(t), minHits: 8 },
];

/** The group that holds the most of the entries of a topic (the smaller, more precise group on a tie), with what that says. */
export function bestGroupFor(groups: Array<{ members: string[] }>, hitIds: Set<string>): { groupIndex: number; size: number; hits: number; precision: number; totalHits: number } | null {
  let best: { groupIndex: number; size: number; hits: number; precision: number } | null = null;
  groups.forEach((g, groupIndex) => {
    const hits = g.members.filter((m) => hitIds.has(m)).length;
    if (hits === 0) return;
    if (!best || hits > best.hits || (hits === best.hits && g.members.length < best.size)) best = { groupIndex, size: g.members.length, hits, precision: hits / g.members.length };
  });
  return best ? { ...(best as { groupIndex: number; size: number; hits: number; precision: number }), totalHits: hitIds.size } : null;
}

/** The part of these entries that has a property (0 for none). */
export function shareOf(ids: string[], byId: Map<string, ExportRow>, has: (row: ExportRow) => boolean): number {
  if (ids.length === 0) return 0;
  return ids.filter((id) => {
    const r = byId.get(id);
    return r ? has(r) : false;
  }).length / ids.length;
}

/** What the engine needs to know about the types: the centre of the entries about music (songs from the content) and films, and who they are. */
export type PreviewContext = TypeContext;

export interface PreviewCollection {
  kind: 'group' | 'child';
  /** Index (in `collections`) of the published group a child belongs to; null for a group, and for a child whose parent is not published. */
  parent: number | null;
  /** Members of the group itself, before the assignment. */
  size: number;
  coherence: number;
  centroid: Float32Array;
  members: string[];
  /** What the collection holds: a group, every entry that is close enough to its centre (at most two themes per entry); a child, its own members. */
  assigned: string[];
}

export type { Absorbed };

export interface Preview {
  /** Every group of at least `birthSize`, whatever became of it. */
  groups: Group[];
  absorbed: Absorbed[];
  loose: Group[];
  collections: PreviewCollection[];
}

/**
 * The discovery in miniature, with the pure rules of `collectionsCluster` and nothing else (no names, no places, no database): the SAME pipeline the
 * engine runs (`discoverCollections`: groups of at least `birthSize`; music and films are TYPES, loose groups are not published, a big group is split in
 * children), then every entry joins at most `maxThemesPerEntry` of the published groups whose centre is at least `assignTau` close
 * (`assignToThemes`). Vectors are expected centred on the library mean.
 */
export function previewCollections(
  items: Array<{ id: string; vector: Float32Array }>,
  ctx: PreviewContext,
  params: CollectionParams = COLLECTION_PARAMS,
): Preview {
  const found = discoverCollections(items, ctx, params, params.birthSize);
  const collections: PreviewCollection[] = found.candidates.map((c) => ({
    kind: c.kind,
    parent: c.parent,
    size: c.group.members.length,
    coherence: c.group.coherence ?? 0,
    centroid: c.group.centroid,
    members: c.group.members,
    assigned: c.kind === 'child' ? [...c.group.members] : [],
  }));
  const tops = collections.flatMap((c, index) => (c.kind === 'group' ? [{ id: String(index), centroid: c.centroid }] : []));
  for (const [id, joined] of assignToThemes(items, tops, params)) collections[Number(id)].assigned.push(...joined.map((m) => m.entryId));
  return { groups: found.groups, absorbed: found.absorbed, loose: found.loose, collections };
}

/** The collection that holds the most of the entries of a topic AFTER the assignment (the smaller, more precise one on a tie), with what that says. */
export function bestCollectionFor(
  collections: PreviewCollection[],
  hitIds: Set<string>,
): { index: number; kind: 'group' | 'child'; size: number; hits: number; precision: number; totalHits: number } | null {
  let best: { index: number; kind: 'group' | 'child'; size: number; hits: number; precision: number } | null = null;
  collections.forEach((c, index) => {
    const hits = c.assigned.filter((m) => hitIds.has(m)).length;
    if (hits === 0) return;
    if (!best || hits > best.hits || (hits === best.hits && c.assigned.length < best.size)) best = { index, kind: c.kind, size: c.assigned.length, hits, precision: hits / c.assigned.length };
  });
  return best ? { ...(best as { index: number; kind: 'group' | 'child'; size: number; hits: number; precision: number }), totalHits: hitIds.size } : null;
}

/** A call that is tried again when it fails (a router that is waking up takes minutes to answer), waiting longer each time. */
export function retryingPost(
  post: EmbedDeps['post'],
  opts: { attempts?: number; waitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): EmbedDeps['post'] {
  const attempts = opts.attempts ?? 8;
  const waitMs = opts.waitMs ?? 5000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (url, body) => {
    let last: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        return await post(url, body);
      } catch (err) {
        last = err;
        if (attempt < attempts - 1) await sleep(waitMs * 2 ** attempt);
      }
    }
    throw last;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------
// the command
// ---------------------------------------------------------------------------------------------------------------------------------------------------

const pct = (x: number): string => `${(x * 100).toFixed(0)}%`;
const f2 = (x: number): string => x.toFixed(2);
const f3 = (x: number): string => x.toFixed(3);

function arg(argv: string[], name: string): string | undefined {
  const at = argv.indexOf(name);
  return at >= 0 ? argv[at + 1] : undefined;
}

interface Prepared {
  rows: ExportRow[];
  byId: Map<string, ExportRow>;
  ids: string[];
  vectors: Float32Array[];
  seconds: number;
}

async function prepare(file: string, cachePath: string | undefined): Promise<Prepared> {
  const rows = parseExport(readFileSync(file, 'utf8'));
  const withText = rows
    .map((row) => ({ row, text: entryEmbeddingText({ caption: row.caption, results: { summary: row.summary, tags: row.tags } }) }))
    .filter((x): x is { row: ExportRow; text: string } => x.text !== null)
    .sort((a, b) => a.row.createdAt.localeCompare(b.row.createdAt) || a.row.id.localeCompare(b.row.id));
  console.log(`entries in the export: ${rows.length}; with enough text for a vector: ${withText.length} (${rows.length - withText.length} without)`);

  let cache: Record<string, number[]> = {};
  if (cachePath && existsSync(cachePath)) cache = JSON.parse(readFileSync(cachePath, 'utf8')) as Record<string, number[]>;
  const todo = withText.filter((x) => !cache[embeddingTextHash(x.text)]);
  const t0 = Date.now();
  if (todo.length > 0) {
    console.log(`embedding ${todo.length} texts through the router (${withText.length - todo.length} from the cache)...`);
    const vectors = await embedTexts(todo.map((x) => x.text), { post: retryingPost(postToRouter) });
    todo.forEach((x, i) => { cache[embeddingTextHash(x.text)] = vectors[i].map((v) => Math.round(v * 1e6) / 1e6); });
    if (cachePath) writeFileSync(cachePath, JSON.stringify(cache));
  }
  const seconds = (Date.now() - t0) / 1000;
  console.log(`vectors ready (${todo.length} made in ${seconds.toFixed(1)} s)`);
  const raw = withText.map((x) => Float32Array.from(cache[embeddingTextHash(x.text)]));
  const { vectors } = centerAndNormalize(raw);
  return { rows, byId: new Map(rows.map((r) => [r.id, r])), ids: withText.map((x) => x.row.id), vectors, seconds };
}

function centreOf(ids: string[], index: Map<string, number>, vectors: Float32Array[]): Float32Array | null {
  const members = ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined);
  if (members.length === 0) return null;
  const sum = new Float64Array(vectors[0].length);
  for (const i of members) for (let k = 0; k < sum.length; k += 1) sum[k] += vectors[i][k];
  return normalizeVector(sum);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const file = argv[0];
  if (!file || file.startsWith('--')) throw new Error('usage: calibrateCollections <export.jsonl> [--cache vectors.json] [--taus 0.35,0.38,...] [--offsets 0.12,0.22] [--detail 0.42] [--top 40] [--assign X] [--absorb X] [--min-coherence X] [--child-tau X] [--type-share X]');
  const list = (name: string, fallback: string): number[] => (arg(argv, name) ?? fallback).split(',').map(Number);
  const taus = list('--taus', '0.35,0.38,0.42,0.45,0.48');
  const offsets = list('--offsets', '0.12,0.22');
  const detailTau = Number(arg(argv, '--detail') ?? String(COLLECTION_PARAMS.groupTau));
  const detailOffset = Number(arg(argv, '--detail-offset') ?? String(Math.round((COLLECTION_PARAMS.mergeTau - COLLECTION_PARAMS.groupTau) * 100) / 100));
  const top = Number(arg(argv, '--top') ?? '40');
  const base: CollectionParams = {
    ...COLLECTION_PARAMS,
    assignTau: Number(arg(argv, '--assign') ?? COLLECTION_PARAMS.assignTau),
    absorbTau: Number(arg(argv, '--absorb') ?? COLLECTION_PARAMS.absorbTau),
    minCoherence: Number(arg(argv, '--min-coherence') ?? COLLECTION_PARAMS.minCoherence),
    childTau: Number(arg(argv, '--child-tau') ?? COLLECTION_PARAMS.childTau),
    typeMemberShare: Number(arg(argv, '--type-share') ?? COLLECTION_PARAMS.typeMemberShare),
  };
  const prepared = await prepare(file, arg(argv, '--cache'));
  const { rows, byId, ids, vectors } = prepared;
  const index = new Map(ids.map((id, i) => [id, i]));
  const items = ids.map((id, i) => ({ id, vector: vectors[i] }));
  const texts = new Map(rows.map((r) => [r.id, foldText(r)]));
  const golden = GOLDEN_SET.map((g) => ({ ...g, hitIds: new Set(ids.filter((id) => g.test(texts.get(id) ?? ''))) }));
  console.log(`golden set in the library: ${golden.map((g) => `${g.name} ${g.hitIds.size}`).join(' · ')}`);

  const musicIds = ids.filter((id) => byId.get(id)?.hasContentSongs);
  const filmIds = ids.filter((id) => byId.get(id)?.hasFilms);
  const music = centreOf(musicIds, index, vectors);
  const films = centreOf(filmIds, index, vectors);
  console.log(`centre of the entries that talk about music: ${musicIds.length} entries; of films: ${filmIds.length} entries`);
  if (music && films) console.log(`cosine between the music centre and the films centre: ${f3(cosine(music, films))}`);
  const ctx: PreviewContext = { typeCentres: { music, films }, flagged: { music: new Set(musicIds), films: new Set(filmIds) } };
  console.log(`parameters besides the sweep: assignTau ${base.assignTau}, absorbTau ${base.absorbTau}, minCoherence ${base.minCoherence}, childTau ${base.childTau}, typeMemberShare ${base.typeMemberShare}`);

  console.log('\n=== sweep of groupTau and of the merge offset (mergeTau = groupTau + offset) ===');
  console.log('tau  | offset | groups>=5 | coverage | largest | published (groups+children) | entries with a theme | golden: group alone → collection after assignment (hits/size)');
  for (const offset of offsets) {
    for (const tau of taus) {
      const out = previewCollections(items, ctx, { ...base, groupTau: tau, mergeTau: tau + offset });
      const covered = out.groups.reduce((t, g) => t + g.members.length, 0);
      const largest = out.groups.reduce((m, g) => Math.max(m, g.members.length), 0);
      const withTheme = new Set(out.collections.flatMap((c) => c.assigned)).size;
      const cols = golden.map((g) => {
        const group = bestGroupFor(out.groups, g.hitIds);
        const col = bestCollectionFor(out.collections, g.hitIds);
        return `${group ? `${group.hits}/${group.size}` : '-'} → ${col ? `${col.hits}/${col.size}` : '-'} ${col && col.hits >= g.minHits ? 'PASS' : 'fail'}`;
      });
      console.log(`${f2(tau)} | +${f2(offset)} | ${out.groups.length} | ${pct(covered / items.length)} | ${largest} | ${out.collections.length} (${out.collections.filter((c) => c.kind === 'group').length}+${out.collections.filter((c) => c.kind === 'child').length}) | ${withTheme} | ${cols.join(' | ')}`);
    }
  }

  console.log(`\n=== what became of the groups of at least ${base.birthSize} at groupTau ${detailTau}, mergeTau ${f2(detailTau + detailOffset)} (the ${top} largest) ===`);
  console.log('size | coherence | songs(any) | content songs | films | cos music | cos films | golden hits | became');
  const params: CollectionParams = { ...base, groupTau: detailTau, mergeTau: detailTau + detailOffset };
  const out = previewCollections(items, ctx, params);
  const goldenOf = (g: Group): string => golden.map((t) => {
    const hits = g.members.filter((m) => t.hitIds.has(m)).length;
    return hits >= 3 ? `${t.name}:${hits}` : '';
  }).filter(Boolean).join(',');
  const fate = (g: Group): string => {
    const a = out.absorbed.find((x) => x.group === g);
    if (a) return `${a.type} type (by ${a.by})`;
    if (out.loose.includes(g)) return 'too loose';
    const children = out.collections.filter((c) => c.kind === 'child' && c.parent !== null && out.collections[c.parent].members === g.members).length;
    return children > 0 ? `published, ${children} children` : 'published';
  };
  for (const g of [...out.groups].sort((a, b) => b.members.length - a.members.length).slice(0, top)) {
    console.log([
      String(g.members.length).padStart(4),
      f3(g.coherence ?? NaN),
      pct(shareOf(g.members, byId, (r) => r.hasSongs)).padStart(4),
      pct(shareOf(g.members, byId, (r) => r.hasContentSongs)).padStart(4),
      pct(shareOf(g.members, byId, (r) => r.hasFilms)).padStart(4),
      music ? f3(cosine(g.centroid, music)) : 'n/a',
      films ? f3(cosine(g.centroid, films)) : 'n/a',
      goldenOf(g) || '-',
      fate(g),
    ].join(' | '));
  }
  const children = out.collections.filter((c) => c.kind === 'child');
  console.log(`children: ${children.length} published (sizes ${children.map((c) => c.size).join(', ')}); children taken for types: ${out.absorbed.filter((a) => a.kind === 'child').map((a) => `${a.group.members.length} ${a.type}`).join(', ') || 'none'}`);
  const coherences = out.groups.map((g) => g.coherence ?? 0).sort((a, b) => a - b);
  console.log(`coherence of the ${out.groups.length} groups of at least ${base.birthSize}: min ${f3(coherences[0])}, median ${f3(coherences[Math.floor(coherences.length / 2)])}, max ${f3(coherences[coherences.length - 1])}`);
  console.log(`absorbed as music or films: ${out.absorbed.length} (${out.absorbed.map((a) => `${a.group.members.length} ${a.type}/${a.by}/${a.kind}`).join(', ')}); too loose: ${out.loose.length} (sizes ${out.loose.map((g) => g.members.length).join(', ')}); published: ${out.collections.length}`);

  console.log('\n=== golden set on what the collections hold (spec §9) ===');
  for (const t of golden) {
    const best = bestCollectionFor(out.collections, t.hitIds);
    console.log(`«${t.name}»: ${best ? `${best.hits} entries in one ${best.kind} of ${best.size} (${pct(best.precision)})` : 'no collection holds it'} → ${best && best.hits >= t.minHits ? 'PASS' : 'FAIL'} (min ${t.minHits})`);
  }
  const mostly = out.collections.filter((c) => isTypeByMembers(c.members, ctx.flagged, base.typeMemberShare) !== null);
  console.log(`published collections that are mostly music or films (must be 0): ${mostly.length}`);
  const covered = new Set(out.collections.flatMap((c) => c.assigned)).size;
  console.log(`entries that belong to at least one theme: ${covered} of ${items.length} embedded (${pct(covered / items.length)})`);
  console.log(`embedding time of this run: ${prepared.seconds.toFixed(1)} s`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[calibrate-collections] error', err);
    process.exit(1);
  });
}
