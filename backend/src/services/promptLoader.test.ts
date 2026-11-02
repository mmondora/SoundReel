import { describe, it, expect } from 'vitest';
import { getDefaultPrompts, renderTemplate } from './promptLoader';

describe('output language instructions', () => {
  it('requires slide summaries in the configured output language', () => {
    const { template } = getDefaultPrompts().slideAnalysis;
    expect(template).toContain('{{outputLanguageName}}');
    expect(template).toContain('LINGUA DI OUTPUT');
    const rendered = renderTemplate(template, {
      slideCount: 1,
      caption: null,
      outputLanguage: 'it',
      outputLanguageName: 'Italian',
      slides: [{ indexLabel: '1 / 1', index: 0, ocrText: 'texto en español', visualDescription: null }],
    });
    expect(rendered).toContain('Italian');
    expect(rendered).toMatch(/TRADUCI/i);
  });

  it('requires contentAnalysis summary in the configured output language', () => {
    const { template } = getDefaultPrompts().contentAnalysis;
    expect(template).toContain('{{outputLanguageName}}');
    expect(template).toContain('LINGUA DI OUTPUT');
  });
});

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
