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

describe('contentAnalysis prompt, with the shape imposed by a schema', () => {
  const { template } = getDefaultPrompts().contentAnalysis;
  const data = {
    caption: 'Security Audit Skill, la skill open source di Cloudflare', hasCaption: true, musicInfo: null, hasMusicInfo: false,
    transcript: 'parlato', hasTranscript: true, transcriptLanguage: 'it', ocrText: 'testo a schermo', hasOcr: true,
    visualContext: 'un uomo', hasVisualContext: true, isCarousel: false, carouselCount: 0, hasImage: true,
    outputLanguage: 'it', outputLanguageName: 'italiano',
  };

  // L'8 novembre il modello copiava come chiave JSON una riga di istruzioni e poi si scusava in chiaro; chiedergli di
  // ricopiare anche trascrizione, OCR e contesto visivo era altro rumore e altri token da spendere (e da mandare in loop).
  it('does not ask the model to copy the transcript, the OCR text or the visual context back', () => {
    for (const task of ['TRANSCRIPTION', 'VISUAL_CONTEXT', 'OVERLAY_TEXT']) expect(template).not.toContain(task);
    expect(template).not.toContain('"transcription"');
    expect(template).not.toContain('"overlayText"');
  });

  it('no longer carries a JSON skeleton with "..." placeholders for the model to echo', () => {
    expect(template).not.toMatch(/"title": "\.\.\."/);
    expect(template).not.toContain('ESCLUSIVAMENTE con JSON valido');
    expect(template).toContain('conforme allo schema richiesto');
    expect(template).toContain('Il riassunto (1-2 frasi) è sempre obbligatorio');
  });

  it('still asks for every kind of extraction, software and its URL rule included', () => {
    for (const task of ['CANZONI', 'FILM/SERIE', 'NOTE', 'SOFTWARE', 'LINK', 'TAG', 'SUMMARY']) expect(template).toContain(`- ${task}`);
    expect(template).toContain('non inventare URL');
  });

  it('renders every source of the post into the prompt', () => {
    const rendered = renderTemplate(template, data);
    expect(rendered).toContain('Security Audit Skill');
    expect(rendered).toContain('parlato');
    expect(rendered).toContain('testo a schermo');
    expect(rendered).toContain('un uomo');
    expect(rendered).toContain('italiano');
    expect(rendered).not.toContain('{{');
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
