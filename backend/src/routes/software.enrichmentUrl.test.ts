import { describe, expect, it } from 'vitest';
import { collectSoftwareFromEntry } from './software';
import type { Entry, EntryResults, EnrichmentResult } from '../types';

function entry(results: Partial<EntryResults>, sourceUrl = 'https://www.instagram.com/reel/DfcxxV7jeCz'): Entry {
  return {
    id: '75c141a1', sourceUrl, sourcePlatform: 'instagram', inputChannel: 'ios', inputUser: 'mike', ownerUser: 'mike',
    caption: null, thumbnailUrl: null, mediaUrl: null, status: 'completed', actionLog: [], createdAt: '2026-11-08T06:22:00Z',
    results: { songs: [], films: [], notes: [], links: [], tags: [], summary: null, ...results },
  };
}

const ENRICHMENTS: EnrichmentResult = {
  category: 'tech',
  items: [{
    label: 'Security Audit Skill',
    explanation: 'Skill open source di Cloudflare.',
    links: [{ url: 'https://github.com/cloudflare/security-audit-skill', title: 'GitHub - Security Audit Skill', snippet: 'Repository ufficiale.' }],
  }],
} as EnrichmentResult;

describe('a software mention without a link, when the entry\'s enrichment found one', () => {
  it('the Cloudflare reel: the skill the caption names gets the repository the enrichment researched', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Security Audit Skill', url: null, tag: 'repo', description: 'La skill open source di Cloudflare.' }],
      enrichments: ENRICHMENTS,
    }));
    expect(items).toEqual([{
      title: 'Security Audit Skill',
      url: 'https://github.com/cloudflare/security-audit-skill',
      tag: 'repo',
      description: 'La skill open source di Cloudflare.',
    }]);
  });

  it('a link the post itself gives is never replaced', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Security Audit Skill', url: 'https://github.com/someone-else/fork', tag: 'repo' }],
      enrichments: ENRICHMENTS,
    }));
    expect(items[0].url).toBe('https://github.com/someone-else/fork');
  });

  it('stays without a link when the enrichment is about something else (the researched product is listed beside it)', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Codex', url: null, tag: 'product' }],
      enrichments: ENRICHMENTS,
    }));
    expect(items.find((i) => i.title === 'Codex')).toEqual({ title: 'Codex', url: null, tag: 'product', description: null });
    expect(items.map((i) => i.title).sort()).toEqual(['Codex', 'Security Audit Skill']);
  });

  it('stays as it was when the entry has no enrichment at all', () => {
    const items = collectSoftwareFromEntry(entry({ software: [{ title: 'Security Audit Skill', url: null, tag: 'repo' }] }));
    expect(items).toEqual([{ title: 'Security Audit Skill', url: null, tag: 'repo', description: null }]);
  });

  it('is one item, not two, when the same repository is also among the entry\'s links', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Security Audit Skill', url: null, tag: 'repo' }],
      links: [{ url: 'https://github.com/cloudflare/security-audit-skill', label: 'repo' }],
      enrichments: ENRICHMENTS,
    }));
    expect(items).toHaveLength(1);
    expect(items[0].url).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('never turns a non-http link of the enrichment into a URL', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Security Audit Skill', url: null, tag: 'repo' }],
      enrichments: { category: 'tech', items: [{ label: 'Security Audit Skill', explanation: '', links: [{ url: 'javascript:alert(1)', title: 'x', snippet: '' }] }] } as EnrichmentResult,
    }));
    expect(items[0].url).toBeNull();
  });
});

describe('the Software page also lists what the entry\'s own research is about', () => {
  it('the Cloudflare reel when the local model found NO software at all (it is unreliable): the skill is there, with its repository', () => {
    const items = collectSoftwareFromEntry(entry({ software: [], enrichments: ENRICHMENTS }));
    expect(items).toEqual([{
      title: 'Security Audit Skill',
      url: 'https://github.com/cloudflare/security-audit-skill',
      tag: 'repo',
      description: 'Skill open source di Cloudflare.',
    }]);
  });

  it('is one item, with the model\'s description, when the model found it too', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Security Audit Skill', url: null, tag: 'repo', description: 'La skill open source di Cloudflare.' }],
      enrichments: ENRICHMENTS,
    }));
    expect(items).toHaveLength(1);
    expect(items[0].description).toBe('La skill open source di Cloudflare.');
    expect(items[0].url).toBe('https://github.com/cloudflare/security-audit-skill');
  });

  it('lists the model\'s other products next to the researched one', () => {
    const items = collectSoftwareFromEntry(entry({
      software: [{ title: 'Claude Code', url: null, tag: 'product', description: null }],
      enrichments: ENRICHMENTS,
    }));
    expect(items.map((i) => i.title).sort()).toEqual(['Claude Code', 'Security Audit Skill']);
  });

  it('adds nothing for an enrichment that is not about tech', () => {
    expect(collectSoftwareFromEntry(entry({ software: [], enrichments: { ...ENRICHMENTS, category: 'claim' } as EnrichmentResult }))).toEqual([]);
  });
});

