import { describe, it, expect } from 'vitest';
import { getDefaultPrompts, renderTemplate } from './promptLoader';

describe('enrichment prompt template', () => {
  it('instructs the model to classify category and emit the new JSON shape', () => {
    const { template } = getDefaultPrompts().enrichment;
    expect(template).toContain('"category"');
    expect(template).toContain('"verdict"');
    expect(template).toContain('"tech"');
    expect(template).toContain('"security"');
    expect(template).toContain('"claim"');
    expect(template).toContain('"generic"');
    expect(template).toContain('phishing');
  });

  it('renders links into the prompt when provided', () => {
    const { template } = getDefaultPrompts().enrichment;
    const rendered = renderTemplate(template, {
      songs: [], films: [], notes: [], tags: [],
      links: [{ url: 'https://github.com/foo/bar', label: null }],
      caption: null,
    });
    expect(rendered).toContain('https://github.com/foo/bar');
  });
});
