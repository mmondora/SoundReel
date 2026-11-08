/**
 * One card per piece of software (spec 2026-11-08-no-duplicates-and-post-links, D1 and D4; ADR-0017).
 *
 * The aggregation keys a mention by tag + URL (or title), so the same product turned up in several cards: the official
 * page, the right repository, a repository the model invented, the same repository with `#readme`, under `repo` in one
 * post and `product` in another. Measured on 8 November on the real journal: 7 names shown more than once (10 extra
 * cards), "Claude Code" in four. Here they collapse at READ time into one card, by normalized name; nothing stored is
 * rewritten, so the rule can be refined without touching history.
 *
 * The main link is, in order: a repository the forge confirmed, a repository with owner and name, the official site
 * (any other http URL), a guessed user page, a bare forge root. Placeholder URLs ("https://github.com/...",
 * ".../your-repo-link") are dropped. The other links stay on the card as `otherUrls`.
 */
import type { AggregatedSoftware, SoftwareMetaRecord, SoftwareTag } from '../types';
import { addMention } from '../utils/mentions';

const FORGE_HOSTS = ['github.com', 'gitlab.com', 'codeberg.org'];
/** A card named after the forge itself ("GitHub") is about the platform: its link is the platform, not some repository on it. */
const FORGE_NAMES = new Map(FORGE_HOSTS.map((h) => [h.split('.')[0], h]));

/** Links a model writes when it has none: the template, not a place. */
const PLACEHOLDER = /(\.\.\.|…|<[^>]*>|\{[^}]*\}|\byour[-_ ]|\bexample\.|\bxxx+\b|link[-_]here|repo[-_]link|\busername\b|\/owner\/repo\b|\/path\/to\b|\/(?:user|org)\/(?:repo|project)\b)/i;

export function isPlaceholderUrl(url: string | null | undefined): boolean {
  if (!url) return true;
  const raw = url.trim();
  if (!/^https?:\/\//i.test(raw)) return true;
  return PLACEHOLDER.test(raw);
}

/** The same address written two ways is one address: no fragment, no trailing slash, no `.git`, no `www.`. */
export function canonicalUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.hostname = u.hostname.toLowerCase().replace(/^www\./, '');
    u.pathname = u.pathname.replace(/\.git$/i, '').replace(/\/+$/, '') || '/';
    const text = u.toString();
    return text.endsWith('/') && u.pathname === '/' ? text.slice(0, -1) : text;
  } catch {
    return url.trim();
  }
}

/** The link as shown: the address as it was written, without the fragment, the trailing slash or `.git`. */
export function displayUrl(url: string): string {
  try {
    const u = new URL(url.trim());
    u.hash = '';
    u.pathname = u.pathname.replace(/\.git$/i, '').replace(/\/+$/, '') || '/';
    const text = u.toString();
    return u.pathname === '/' && text.endsWith('/') ? text.slice(0, -1) : text;
  } catch {
    return url.trim();
  }
}

/** The name two cards must share to be one: case, accents and punctuation do not count. */
export function nameKey(title: string): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9/]+/g, ' ')
    .trim();
}

interface ForgePath {
  host: string;
  segments: number;
}

function forgePath(url: string): ForgePath | null {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (!FORGE_HOSTS.includes(host)) return null;
    return { host, segments: u.pathname.split('/').filter(Boolean).length };
  } catch {
    return null;
  }
}

/** How good a link is as THE link of a piece of software (higher wins). */
export function urlScore(url: string, forgeConfirmed: boolean): number {
  if (forgeConfirmed) return 100;
  const forge = forgePath(url);
  if (forge) {
    if (forge.segments >= 2) return 80; // owner/repo
    if (forge.segments === 1) return 30; // a user page, often a guess
    return 10; // github.com
  }
  return 50; // the official site, as far as one can tell
}

const countedTag = (tags: SoftwareTag[]): SoftwareTag => {
  const tally = new Map<SoftwareTag, number>();
  for (const t of tags) if (t !== 'other') tally.set(t, (tally.get(t) ?? 0) + 1);
  return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'other';
};

/** Collapses the cards of the same software into one; cards with no name in common are left as they are. */
export function collapseSoftware(items: AggregatedSoftware[], metaMap: Map<string, SoftwareMetaRecord> = new Map()): AggregatedSoftware[] {
  const groups = new Map<string, AggregatedSoftware[]>();
  const order: string[] = [];
  for (const item of items) {
    const key = nameKey(item.title) || `\u0000${item.softwareKey}`;
    if (!groups.has(key)) {
      groups.set(key, []);
      order.push(key);
    }
    groups.get(key)!.push(item);
  }

  return order.map((key) => {
    const members = groups.get(key)!;

    // the candidate links, once each, best first
    const candidates = new Map<string, { url: string; score: number; member: AggregatedSoftware }>();
    for (const m of members) {
      if (isPlaceholderUrl(m.url)) continue;
      const same = canonicalUrl(m.url as string); // the same address written two ways counts once...
      const score = urlScore(same, !!metaMap.get(m.softwareKey)?.host);
      const known = candidates.get(same);
      // ...and is shown the way it was written
      if (!known || score > known.score) candidates.set(same, { url: displayUrl(m.url as string), score, member: m });
    }
    const forgeHost = FORGE_NAMES.get(key);
    if (forgeHost && candidates.size > 0) {
      const root = `https://${forgeHost}`;
      const known = candidates.get(root);
      const lead0 = known?.member ?? [...candidates.values()][0].member;
      candidates.set(root, { url: root, score: 1000, member: lead0 });
    }
    const ranked = [...candidates.values()].sort(
      (a, b) => b.score - a.score || b.member.mentions.length - a.member.mentions.length,
    );
    const primary = ranked[0];

    // the member that holds the main link keeps its key (the forge's description and date hang on it)
    const lead = primary?.member ?? members[0];
    const mentions: AggregatedSoftware['mentions'] = [];
    for (const m of members) for (const mention of m.mentions) addMention(mentions, mention);
    mentions.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));

    const spellings = new Map<string, number>();
    for (const m of members) spellings.set(m.title, (spellings.get(m.title) ?? 0) + m.mentions.length);
    const title = [...spellings.entries()].sort((a, b) => b[1] - a[1])[0][0];

    const description = lead.description ?? members.find((m) => m.description)?.description ?? null;
    const publishedAt = lead.publishedAt ?? members.find((m) => m.publishedAt)?.publishedAt ?? null;
    // the tag follows the main link: a repository is `repo` (and is looked up on its forge), anything else is not
    const hasRepo = primary ? forgePath(primary.url) !== null : members.some((m) => m.tag === 'repo');
    const nonRepo = countedTag(members.map((m) => m.tag).filter((t) => t !== 'repo'));

    return {
      softwareKey: lead.softwareKey,
      title,
      url: primary ? primary.url : null,
      tag: hasRepo ? 'repo' : nonRepo !== 'other' ? nonRepo : primary ? 'product' : 'other',
      description,
      publishedAt,
      mentions,
      ...(ranked.length > 1 ? { otherUrls: ranked.slice(1, 5).map((r) => r.url) } : {}),
    };
  });
}
