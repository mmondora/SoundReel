import { describe, expect, it } from 'vitest';
import { softwareFromEnrichments, urlFromEnrichments } from './softwareMeta';
import type { EnrichmentResult } from '../types';

/**
 * 8 novembre, il reel di Cloudflare: la didascalia dice "Security Audit Skill è la skill open source di Cloudflare" e
 * "commenta per il link alla repo": il link va in DM. L'arricchimento dell'entry lo aveva trovato
 * (github.com/cloudflare/security-audit-skill, esiste), ma alla pagina Software la voce arrivava senza URL.
 */
const CLOUDFLARE: EnrichmentResult = {
  category: 'tech',
  items: [
    {
      label: 'Security Audit Skill',
      explanation: 'Skill open source di Cloudflare.',
      links: [{ url: 'https://github.com/cloudflare/security-audit-skill', title: 'GitHub - Security Audit Skill', snippet: 'Repository ufficiale.' }],
    },
  ],
} as EnrichmentResult;

const item = (label: string, urls: string[]): EnrichmentResult['items'][number] =>
  ({ label, explanation: '', links: urls.map((url) => ({ url, title: label, snippet: '' })) }) as EnrichmentResult['items'][number];
const enrichment = (...items: EnrichmentResult['items']): EnrichmentResult => ({ category: 'tech', items }) as EnrichmentResult;

describe('urlFromEnrichments', () => {
  it('gives the Cloudflare skill the link its enrichment found', () => {
    expect(urlFromEnrichments('Security Audit Skill', 'repo', CLOUDFLARE)).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('matches the name without caring about case, accents or punctuation', () => {
    expect(urlFromEnrichments('security-audit  SKILL', 'repo', CLOUDFLARE)).toBe('https://github.com/cloudflare/security-audit-skill');
    expect(urlFromEnrichments('Sécurity Audit Skill', 'repo', CLOUDFLARE)).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('matches when one name contains the other', () => {
    const e = enrichment(item('Claude Code CLI', ['https://docs.claude.com/claude-code']));
    expect(urlFromEnrichments('Claude Code', 'product', e)).toBe('https://docs.claude.com/claude-code');
    const longer = enrichment(item('Cursor', ['https://cursor.com']));
    expect(urlFromEnrichments('Cursor editor', 'product', longer)).toBe('https://cursor.com');
  });

  it('never matches on a short name: "AI" is not "Claude"', () => {
    const e = enrichment(item('AI tools', ['https://example.com/ai']));
    expect(urlFromEnrichments('AI', 'product', e)).toBeNull();
    expect(urlFromEnrichments('Go', 'repo', enrichment(item('Go', ['https://go.dev'])))).toBeNull();
  });

  it('does not give a product the link of another one', () => {
    expect(urlFromEnrichments('Codex', 'product', CLOUDFLARE)).toBeNull();
    expect(urlFromEnrichments('Repomix', 'repo', CLOUDFLARE)).toBeNull();
  });

  it('for a repository prefers a code host over any other link; for the rest takes the first', () => {
    const e = enrichment(item('Repomix', ['https://repomix.com/blog/launch', 'https://github.com/yamadashy/repomix']));
    expect(urlFromEnrichments('Repomix', 'repo', e)).toBe('https://github.com/yamadashy/repomix');
    expect(urlFromEnrichments('Repomix', 'product', e)).toBe('https://repomix.com/blog/launch');
  });

  it('takes only http(s) links, never something a model could slip in', () => {
    const e = enrichment(item('Security Audit Skill', ['javascript:alert(1)', 'mailto:x@y.z', 'ftp://x/y', 'data:text/html,hi']));
    expect(urlFromEnrichments('Security Audit Skill', 'repo', e)).toBeNull();
    const mixed = enrichment(item('Security Audit Skill', ['javascript:alert(1)', 'https://github.com/cloudflare/security-audit-skill']));
    expect(urlFromEnrichments('Security Audit Skill', 'repo', mixed)).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('goes on to the next matching item when the first one has no usable link', () => {
    const e = enrichment(item('Security Audit Skill', []), item('Security Audit Skill (repo)', ['https://github.com/cloudflare/security-audit-skill']));
    expect(urlFromEnrichments('Security Audit Skill', 'repo', e)).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('is null when there is nothing to read, whatever shape the stored data has', () => {
    expect(urlFromEnrichments('Security Audit Skill', 'repo', undefined)).toBeNull();
    expect(urlFromEnrichments('Security Audit Skill', 'repo', null)).toBeNull();
    expect(urlFromEnrichments('Security Audit Skill', 'repo', { category: 'tech', items: [] } as EnrichmentResult)).toBeNull();
    expect(urlFromEnrichments('Security Audit Skill', 'repo', { category: 'tech' } as unknown as EnrichmentResult)).toBeNull();
    expect(urlFromEnrichments('Security Audit Skill', 'repo', { category: 'tech', items: [{ label: 5, links: 'x' }, null] } as unknown as EnrichmentResult)).toBeNull();
  });
});

describe('softwareFromEnrichments (what the entry\'s own research is about)', () => {
  it('the Cloudflare reel: the skill, with its repository and what the research said about it', () => {
    expect(softwareFromEnrichments(CLOUDFLARE)).toEqual([{
      title: 'Security Audit Skill',
      url: 'https://github.com/cloudflare/security-audit-skill',
      tag: 'repo',
      description: 'Skill open source di Cloudflare.',
    }]);
  });

  it('only a "tech" enrichment: for a claim, a security verdict or a generic post an item is not a product', () => {
    for (const category of ['claim', 'security', 'generic'] as const) {
      expect(softwareFromEnrichments({ ...CLOUDFLARE, category }), category).toEqual([]);
    }
  });

  it('a code host makes it a repository, any other link a product', () => {
    const e = enrichment(item('Cursor', ['https://cursor.com']), item('Repomix', ['https://repomix.com/blog', 'https://github.com/yamadashy/repomix']));
    expect(softwareFromEnrichments(e)).toEqual([
      { title: 'Cursor', url: 'https://cursor.com', tag: 'product', description: null },
      { title: 'Repomix', url: 'https://github.com/yamadashy/repomix', tag: 'repo', description: null },
    ]);
  });

  it('skips an item nobody can open: no link, or only links that are not http(s)', () => {
    const e = enrichment(item('No link', []), item('Bad link', ['javascript:alert(1)', 'mailto:a@b.c']), item('Good', ['https://good.dev']));
    expect(softwareFromEnrichments(e).map((x) => x.title)).toEqual(['Good']);
  });

  it('skips an item without a name', () => {
    expect(softwareFromEnrichments(enrichment(item('', ['https://x.dev']), item(' ', ['https://y.dev'])))).toEqual([]);
  });

  it('is empty when there is nothing to read, whatever shape the stored data has', () => {
    expect(softwareFromEnrichments(undefined)).toEqual([]);
    expect(softwareFromEnrichments(null)).toEqual([]);
    expect(softwareFromEnrichments({ category: 'tech' } as unknown as EnrichmentResult)).toEqual([]);
    expect(softwareFromEnrichments({ category: 'tech', items: [null, { label: 5, links: 'x' }] } as unknown as EnrichmentResult)).toEqual([]);
  });
});

