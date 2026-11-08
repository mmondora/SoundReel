import { describe, expect, it } from 'vitest';
import { canonicalUrl, collapseSoftware, isPlaceholderUrl, nameKey, urlScore } from './softwareCollapse';
import type { AggregatedSoftware, SoftwareMetaRecord } from '../types';

const m = (entryId: string, createdAt = '2026-11-08T07:00:00Z', url = `https://www.instagram.com/reel/${entryId}`) => ({ entryId, createdAt, sourceUrl: url, sourcePlatform: 'instagram' });
const sw = (title: string, url: string | null, tag: AggregatedSoftware['tag'], mentions = [m('e1')], over: Partial<AggregatedSoftware> = {}): AggregatedSoftware => ({
  softwareKey: `${tag}::url::${(url ?? title).toLowerCase()}`, title, url, tag, description: null, publishedAt: null, mentions, ...over,
});

describe('isPlaceholderUrl: the template, not a place', () => {
  it.each([
    ['https://github.com/...', true],
    ['https://github.com/your-ecc-repo-link', true],
    ['https://github.com/<owner>/<repo>', true],
    ['https://github.com/owner/repo', true],
    ['https://example.com/tool', true],
    ['https://github.com/username/project', true],
    ['not a url', true],
    ['', true],
    [null, true],
    ['https://github.com/anthropics/claude-code', false],
    ['https://www.claude.com/product/claude-code', false],
    ['https://gittrend.io', false],
    ['https://github.com', false],
  ])('%s → %s', (url, expected) => {
    expect(isPlaceholderUrl(url as string | null)).toBe(expected);
  });
});

describe('canonicalUrl: the same address written two ways is one address', () => {
  it.each([
    ['https://github.com/tonhowtf/omniget#readme', 'https://github.com/tonhowtf/omniget'],
    ['https://github.com/tonhowtf/omniget/', 'https://github.com/tonhowtf/omniget'],
    ['https://www.GitHub.com/a/b.git', 'https://github.com/a/b'],
    ['https://github.com', 'https://github.com'],
    ['https://higgsfield.com/', 'https://higgsfield.com'],
  ])('%s → %s', (url, expected) => {
    expect(canonicalUrl(url)).toBe(expected);
  });
});

describe('nameKey and urlScore', () => {
  it('names match without case, accents or punctuation', () => {
    expect(nameKey('Claude Code')).toBe(nameKey('claude  code'));
    expect(nameKey('Café-App')).toBe(nameKey('cafe app'));
    expect(nameKey('tonhowtf/omniget')).toBe('tonhowtf/omniget');
  });

  it('a confirmed repository beats an owner/repo beats the official site beats a guessed user page beats a bare forge', () => {
    const scores = [urlScore('https://github.com/a/b', true), urlScore('https://github.com/a/b', false), urlScore('https://higgsfield.com', false), urlScore('https://github.com/higgsfield', false), urlScore('https://github.com', false)];
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(new Set(scores).size).toBe(5);
  });
});

describe('collapseSoftware: one card per piece of software', () => {
  it('"Claude Code" in four cards becomes one: the real repository leads, the official site is kept, the invented ones are not', () => {
    const items = [
      sw('Claude Code', 'https://www.claude.com/product/claude-code', 'product', [m('e1', '2026-11-01T00:00:00Z')]),
      sw('Claude Code', 'https://github.com/Anthropic/claude-code', 'repo', [m('e2', '2026-11-05T00:00:00Z')]),
      sw('Claude Code', 'https://intelligentui.art/install.sh', 'product', [m('e3', '2026-11-03T00:00:00Z')]),
      sw('Claude Code', 'https://github.com/claudecode', 'repo', [m('e4', '2026-11-02T00:00:00Z'), m('e5', '2026-11-04T00:00:00Z')]),
    ];
    const [one, ...rest] = collapseSoftware(items);
    expect(rest).toHaveLength(0);
    expect(one.url).toBe('https://github.com/Anthropic/claude-code');
    expect(one.tag).toBe('repo');
    expect(one.otherUrls?.[0]).toBe('https://www.claude.com/product/claude-code');
    expect(one.mentions.map((x) => x.entryId)).toEqual(['e2', 'e5', 'e3', 'e4', 'e1']); // every post, newest first
  });

  it('placeholder URLs are dropped; a card left with none shows no link', () => {
    const [ecc] = collapseSoftware([
      sw('ECC', 'https://github.com/...', 'repo', [m('e1'), m('e2')]),
      sw('ECC', 'https://github.com/your-ecc-repo-link', 'repo', [m('e3')]),
      sw('ECC', 'https://github.com/affaan-m/ECC', 'repo', [m('e4'), m('e5')]),
    ]);
    expect(ecc.url).toBe('https://github.com/affaan-m/ECC');
    expect(ecc.otherUrls ?? []).toEqual([]);
    expect(ecc.mentions).toHaveLength(5);
    const [lonely] = collapseSoftware([sw('ECC', 'https://github.com/...', 'repo')]);
    expect(lonely.url).toBeNull();
  });

  it('the same repository with #readme or a trailing slash is one link, not two', () => {
    const [one] = collapseSoftware([
      sw('tonhowtf/omniget', 'https://github.com/tonhowtf/omniget', 'repo', [m('e1')]),
      sw('tonhowtf/omniget', 'https://github.com/tonhowtf/omniget#readme', 'repo', [m('e2')]),
    ]);
    expect(one.url).toBe('https://github.com/tonhowtf/omniget');
    expect(one.otherUrls).toBeUndefined();
    expect(one.mentions).toHaveLength(2);
  });

  it('a confirmed repository (the forge answered) leads even when another repository has more mentions', () => {
    const confirmed = sw('REA', 'https://github.com/morluto/rea', 'repo', [m('e1')]);
    const guessed = sw('REA', 'https://github.com/rea-app/rea', 'repo', [m('e2'), m('e3'), m('e4')]);
    const meta = new Map<string, SoftwareMetaRecord>([[confirmed.softwareKey, { softwareKey: confirmed.softwareKey, host: 'github.com', description: 'A tool', publishedAt: null, checkedAt: null } as never]]);
    const [one] = collapseSoftware([guessed, confirmed], meta);
    expect(one.url).toBe('https://github.com/morluto/rea');
    expect(one.softwareKey).toBe(confirmed.softwareKey); // the forge's data hangs on this key
  });

  it('an official site beats a guessed user page', () => {
    const [one] = collapseSoftware([sw('Higgsfield', 'https://github.com/higgsfield', 'repo'), sw('Higgsfield', 'https://higgsfield.com', 'product', [m('e2')])]);
    expect(one.url).toBe('https://higgsfield.com');
    expect(one.tag).toBe('product');
    expect(one.otherUrls).toEqual(['https://github.com/higgsfield']);
  });

  it('keeps the commonest spelling, a description, and the forge date', () => {
    const [one] = collapseSoftware([
      sw('claude code', 'https://github.com/a/claude-code', 'repo', [m('e1')], { description: 'The agent', publishedAt: '2025-02-01' }),
      sw('Claude Code', 'https://claude.com', 'product', [m('e2'), m('e3')]),
    ]);
    expect(one.title).toBe('Claude Code');
    expect(one.description).toBe('The agent');
    expect(one.publishedAt).toBe('2025-02-01');
  });

  it('an entry that names the same software twice counts once', () => {
    const [one] = collapseSoftware([sw('Cursor', 'https://cursor.com', 'product', [m('e1')]), sw('Cursor', 'https://github.com/getcursor/cursor', 'repo', [m('e1')])]);
    expect(one.mentions).toHaveLength(1);
  });

  it('different software is left alone, in the same order', () => {
    const out = collapseSoftware([sw('Zed', 'https://zed.dev', 'product'), sw('Bun', 'https://bun.sh', 'product'), sw('Zed', 'https://github.com/zed-industries/zed', 'repo')]);
    expect(out.map((x) => x.title)).toEqual(['Zed', 'Bun']);
  });

  it('a card named after the forge ("GitHub") links to the platform, not to some repository on it', () => {
    const [one] = collapseSoftware([
      sw('GitHub', 'https://github.com', 'repo', [m('e1'), m('e2')]),
      sw('GitHub', 'https://github.com/debpalash/voicestudio', 'repo', [m('e3')]),
    ]);
    expect(one.url).toBe('https://github.com');
    expect(one.otherUrls).toEqual(['https://github.com/debpalash/voicestudio']);
    expect(one.mentions).toHaveLength(3);
  });

  it('a card with no URL and no tag information stays usable', () => {
    const [one] = collapseSoftware([sw('Strix', null, 'other')]);
    expect(one).toMatchObject({ title: 'Strix', url: null, tag: 'other' });
  });
});
