import { describe, expect, it, vi } from 'vitest';

vi.mock('../utils/logger', () => ({ logInfo: vi.fn(), logWarning: vi.fn(), logError: vi.fn() }));

import { isJunkSoftwareTitle } from './placeholderFilter';
import { isSoftwareItem } from './softwareMeta';
import { parseAnalysisResponse } from './aiAnalysis';

/**
 * 8 novembre, con lo schema che impone una stringa: sul reel di Cloudflare il modello locale ha scritto `"/repo"`, su
 * quello dei cinque plugin per Claude Code `"/"` e `"/name"`. Non sono nomi: sono frammenti di percorso o le parole
 * generiche del prompt. Il filtro e' stretto come il resto del file: mai per lunghezza (i tool veri sono corti).
 */
describe('isJunkSoftwareTitle', () => {
  it('rejects the path fragments the model wrote', () => {
    for (const t of ['/repo', '/', '/name', '\\repo', '  /x ']) expect(isJunkSoftwareTitle(t), t).toBe(true);
  });

  it('rejects titles with no letter or digit at all', () => {
    for (const t of ['-', '...', '—', '()', ' ']) expect(isJunkSoftwareTitle(t), t).toBe(true);
  });

  it('rejects the bare category words of the prompt, in any case and in Italian too', () => {
    for (const t of ['repo', 'Repository', 'TOOL', 'software', 'product', 'article', 'other', 'name', 'Nome', 'prodotto', 'titolo', 'url', 'link']) {
      expect(isJunkSoftwareTitle(t), t).toBe(true);
    }
  });

  it('rejects placeholders like the other fields do', () => {
    for (const t of ['...', 'null', 'N/A', 'nome o null']) expect(isJunkSoftwareTitle(t), t).toBe(true);
    expect(isJunkSoftwareTitle(null)).toBe(true);
    expect(isJunkSoftwareTitle(undefined)).toBe(true);
  });

  it('keeps real names, however short: real tools are tiny', () => {
    for (const t of ['Go', 'uv', 'jq', 'Zed', 'Bun', 'fd', 'Vim', 'Claude Code', 'Security Audit Skill', 'owner/repo', 'cloudflare/security-audit-skill', 'C++', '.NET', 'F#', 'o3']) {
      expect(isJunkSoftwareTitle(t), t).toBe(false);
    }
  });
});

describe('where it applies', () => {
  const input = { caption: 'c', musicInfo: null, transcript: null, transcriptLanguage: null, ocrText: null, visualContext: null, slidePaths: [], thumbnailPath: null };

  it('the analysis drops the junk titles a model wrote and keeps the real ones', () => {
    const answer = JSON.stringify({
      songs: [], films: [], notes: [], links: [], tags: [], summary: 'Un post.',
      software: [
        { title: '/repo', url: null, tag: 'other', description: null },
        { title: '/', url: null, tag: 'product', description: null },
        { title: 'Claude Code', url: null, tag: 'product', description: null },
        { title: 'uv', url: null, tag: 'repo', description: null },
      ],
    });
    const parsed = parseAnalysisResponse(answer, input);
    expect(parsed?.software?.map((s) => s.title)).toEqual(['Claude Code', 'uv']);
  });

  it('a stored junk item is not shown as software either', () => {
    expect(isSoftwareItem({ title: '/repo', url: null, tag: 'other' })).toBe(false);
    expect(isSoftwareItem({ title: 'Claude Code', url: null, tag: 'product' })).toBe(true);
    expect(isSoftwareItem({ title: 'Go', url: null, tag: 'repo' })).toBe(true);
    expect(isSoftwareItem({ title: '   ' })).toBe(false);
    expect(isSoftwareItem(null)).toBe(false);
  });
});
