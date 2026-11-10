import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TITLE_CHARS,
  buildTitlePrompt,
  cleanTitle,
  generatePlaylistTitle,
  parseTitleResponse,
  themeKey,
  themeWords,
  titleOverlap,
  type TitleSource,
} from './autoPlaylistTitle';

const source = (over: Partial<TitleSource> = {}): TitleSource => ({
  caption: 'ecco le 5 musiche di natale 🎄 #natale',
  summary: 'Il post elenca cinque canzoni natalizie.',
  songs: [
    { title: 'Last Christmas', artist: 'Wham!' },
    { title: 'All I Want for Christmas Is You', artist: 'Mariah Carey' },
  ],
  themes: ['Jazz da ascoltare'],
  language: 'it',
  ...over,
});

describe('a title is what a person would write', () => {
  it('takes away hashtags, mentions, quotes, emoji and the «ecco i» a post starts with', () => {
    expect(cleanTitle('#Jazz da ascoltare!')).toBe('Jazz da ascoltare');
    expect(cleanTitle('"Le 5 musiche di Natale" 🎄')).toBe('Le 5 musiche di Natale');
    expect(cleanTitle('ecco gli album jazz da ascoltare')).toBe('Album jazz da ascoltare');
    expect(cleanTitle('Ecco le 5 musiche di Natale')).toBe('5 musiche di Natale');
    expect(cleanTitle('  @utente: playlist per correre  ')).toBe('Utente: playlist per correre');
  });

  it('shouting is not a name: a title in capitals becomes a sentence, a mixed one is left alone', () => {
    expect(cleanTitle('GARA DURÁN')).toBe('Gara durán');
    expect(cleanTitle('MUSICA PER LA NOTTE')).toBe('Musica per la notte');
    expect(cleanTitle('SADE Acid House')).toBe('SADE Acid House');
    expect(cleanTitle('ABBA')).toBe('ABBA');           // one word in capitals is a name or an acronym
  });

  it('starts with a capital and has no loose punctuation at the ends', () => {
    expect(cleanTitle('musica per studiare.')).toBe('Musica per studiare');
    expect(cleanTitle('- rock anni 80 -')).toBe('Rock anni 80');
    expect(cleanTitle('canzoni del 2026')).toBe('Canzoni del 2026');
  });

  it('cuts a long title at a word, never in the middle of one', () => {
    const t = cleanTitle('una playlist con moltissime canzoni bellissime da ascoltare quando fuori piove e non si ha voglia di uscire');
    expect(t).not.toBeNull();
    expect(MAX_TITLE_CHARS).toBe(60);
    expect(t!.length).toBeLessThanOrEqual(60);
    expect(t!.endsWith(' ')).toBe(false);
    expect('Una playlist con moltissime canzoni bellissime da ascoltare quando fuori piove e non si ha voglia di uscire').toContain(t!);
  });

  it('refuses what says nothing: a generic word alone, no letters, too short, not a text', () => {
    for (const bad of ['Playlist', 'musica', 'Canzoni', '#brani', 'Lista', 'Album', '123', '🎄', 'ab', '', '   ', null, undefined, 7]) {
      expect(cleanTitle(bad as never)).toBeNull();
    }
  });

  it('a generic word WITH a meaning around it is a title', () => {
    expect(cleanTitle('Musica per studiare')).toBe('Musica per studiare');
    expect(cleanTitle('Jazz')).toBe('Jazz');
  });
});

describe('one theme, however it is written', () => {
  it('«Jazz da ascoltare» and «ascoltare jazz» and «jazz, da ascoltare!» are the same key', () => {
    const key = themeKey('Jazz da ascoltare');
    expect(key).toBe('ascoltare jazz');
    expect(themeKey('ascoltare jazz')).toBe(key);
    expect(themeKey('JAZZ — da ascoltare!')).toBe(key);
    expect(themeKey('Jazz per ascoltare')).toBe(key);
  });

  it('accents do not make two themes', () => {
    expect(themeKey('Città del jazz')).toBe(themeKey('citta del jazz'));
  });

  it('keeps the meaningful words only, once, in a fixed order', () => {
    expect(themeWords('La musica della musica di Natale')).toEqual(['musica', 'natale']);
  });

  it('the overlap of two titles: 1 for the same words, 0 for none', () => {
    expect(titleOverlap('Jazz da ascoltare', 'ascoltare jazz')).toBe(1);
    expect(titleOverlap('Jazz da ascoltare', 'Rock anni 80')).toBe(0);
    expect(titleOverlap('Jazz da ascoltare oggi', 'Jazz da ascoltare')).toBeCloseTo(2 / 3, 5);
    expect(titleOverlap('', 'Jazz')).toBe(0);
  });
});

describe('reading the answer of the model', () => {
  it('a precise title is one_off and has no existing theme', () => {
    expect(parseTitleResponse('{"title":"Le 5 musiche di Natale","kind":"one_off","existingTheme":null}', [])).toEqual({
      aboutMusic: true, title: 'Le 5 musiche di Natale', kind: 'one_off', existingTheme: null,
    });
  });

  it('a generic title is a theme; the existing theme it names must be the same one (folded), and comes back as it is written THERE', () => {
    const plan = parseTitleResponse('{"title":"jazz da ascoltare","kind":"theme","existingTheme":"JAZZ da ascoltare"}', ['Jazz da ascoltare']);
    expect(plan).toEqual({ aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme', existingTheme: 'Jazz da ascoltare' });
  });

  it('a theme that does not exist is dropped (the model invented it)', () => {
    const plan = parseTitleResponse('{"title":"Rock anni 80","kind":"theme","existingTheme":"Metal duro"}', ['Jazz da ascoltare']);
    expect(plan).toEqual({ aboutMusic: true, title: 'Rock anni 80', kind: 'theme', existingTheme: null });
  });

  it('a post whose songs are not what it is about (aboutMusic false) is a plan with no title, not a missing title', () => {
    const plan = parseTitleResponse('{"aboutMusic":false,"title":"","kind":"one_off","existingTheme":null}', ['Jazz da ascoltare']);
    expect(plan).toEqual({ aboutMusic: false, title: '', kind: 'one_off', existingTheme: null });
    // even when the model writes a title anyway
    expect(parseTitleResponse('{"aboutMusic":false,"title":"Film da vedere","kind":"theme","existingTheme":"Jazz da ascoltare"}', ['Jazz da ascoltare'])).toEqual(plan);
  });

  it('an answer that does not say «aboutMusic» is read as a post about music (an older answer still works)', () => {
    expect(parseTitleResponse('{"title":"Jazz da ascoltare","kind":"theme","existingTheme":null}', [])).toMatchObject({ aboutMusic: true });
  });

  it('an existing theme means nothing for a one_off', () => {
    const plan = parseTitleResponse('{"title":"Le 5 musiche di Natale","kind":"one_off","existingTheme":"Jazz da ascoltare"}', ['Jazz da ascoltare']);
    expect(plan?.existingTheme).toBeNull();
  });

  it.each([
    ['not json', 'ecco una playlist'],
    ['broken json', '{"title":"Jazz","kind":'],
    ['a kind we do not know', '{"title":"Jazz da ascoltare","kind":"maybe","existingTheme":null}'],
    ['no kind', '{"title":"Jazz da ascoltare","existingTheme":null}'],
    ['a generic title', '{"title":"Playlist","kind":"theme","existingTheme":null}'],
    ['a title that is only a hashtag sign', '{"title":"#","kind":"theme","existingTheme":null}'],
    ['an empty object', '{}'],
  ])('%s is no plan', (_name, raw) => {
    expect(parseTitleResponse(raw, ['Jazz da ascoltare'])).toBeNull();
  });
});

describe('the question', () => {
  it('carries the rules, the two examples, the themes that exist, the post and the songs', () => {
    const prompt = buildTitlePrompt(source());
    expect(prompt).toContain('"one_off"');
    expect(prompt).toContain('"theme"');
    expect(prompt).toContain('Le 5 musiche di Natale');
    expect(prompt).toContain('Jazz da ascoltare');
    expect(prompt).toContain('TEMI GIÀ ESISTENTI: Jazz da ascoltare');
    expect(prompt).toContain('Wham! - Last Christmas');
    expect(prompt).toContain('in italiano');
  });

  it('says so when there is nothing yet, and in which language the title is written', () => {
    const prompt = buildTitlePrompt(source({ themes: [], caption: null, summary: null, language: 'en' }));
    expect(prompt).toContain('TEMI GIÀ ESISTENTI: (nessuno)');
    expect(prompt).toContain('Didascalia: (nessuna)');
    expect(prompt).toContain('in inglese');
  });

  it('does not send more than a dozen songs or forty themes', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ title: `Song ${i}`, artist: `Artist ${i}` }));
    const themes = Array.from({ length: 80 }, (_, i) => `Tema ${i}`);
    const prompt = buildTitlePrompt(source({ songs: many, themes }));
    expect(prompt).toContain('Artist 11 - Song 11');
    expect(prompt).not.toContain('Artist 12 - Song 12');
    expect(prompt).toContain('Tema 39');
    expect(prompt).not.toContain('Tema 40');
  });
});

describe('asking the local model', () => {
  const answer = (text: string, truncated = false) => ({ text, usageMetadata: null, truncated });

  it('gives the plan, with the schema and a short ceiling on the answer', async () => {
    const generate = vi.fn().mockResolvedValue(answer('{"title":"Jazz da ascoltare","kind":"theme","existingTheme":null}'));
    const plan = await generatePlaylistTitle(source(), { generate });
    expect(plan).toEqual({ aboutMusic: true, title: 'Jazz da ascoltare', kind: 'theme', existingTheme: null });
    expect(generate).toHaveBeenCalledWith(expect.stringContaining('POST'), expect.objectContaining({ json: true, maxTokens: 200, schema: expect.objectContaining({ required: ['aboutMusic', 'title', 'kind', 'existingTheme'] }) }));
  });

  it('an answer cut at the ceiling is no answer, even when what is left reads like one', async () => {
    const generate = vi.fn().mockResolvedValue(answer('{"aboutMusic":true,"title":"Jazz da ascoltare","kind":"theme","existingTheme":null}', true));
    expect(await generatePlaylistTitle(source(), { generate })).toBeNull();
    generate.mockResolvedValue(answer('{"title":"Jazz da asco', true));
    expect(await generatePlaylistTitle(source(), { generate })).toBeNull();
  });

  it('a model that is down is no plan, and never an exception (the analysis does not fail for it)', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('router down'));
    expect(await generatePlaylistTitle(source(), { generate })).toBeNull();
  });
});
