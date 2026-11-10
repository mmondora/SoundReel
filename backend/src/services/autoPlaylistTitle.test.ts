import { describe, expect, it, vi } from 'vitest';
import {
  MAX_TITLE_CHARS,
  buildTitlePrompt,
  cleanTitle,
  generatePlaylistTitle,
  parseTitleResponse,
  SINGLE_SCHEMA,
  SINGLE_THEMES,
  THEME_GENRES,
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

  it('an apostrophe inside a title stays, quotes around it go', () => {
    expect(cleanTitle("L'estate dei Måneskin")).toBe("L'estate dei Måneskin");
    expect(cleanTitle("Canzoni dell'anno")).toBe("Canzoni dell'anno");
    expect(cleanTitle("'Jazz da ascoltare'")).toBe('Jazz da ascoltare');
    expect(cleanTitle("The Most Beautiful Albums I've Ever Heard")).toBe("The Most Beautiful Albums I've Ever Heard");
    expect(cleanTitle('« Musica per la cena »')).toBe('Musica per la cena');
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
    expect(prompt).toContain('SEMPRE in italiano, anche se il post è in un\'altra lingua');
    expect(prompt).toContain('5 canzoni per guidare di notte');   // a post in English gets an Italian title
  });

  it('says so when there is nothing yet, and in which language the title is written', () => {
    const prompt = buildTitlePrompt(source({ themes: [], caption: null, summary: null, language: 'en' }));
    expect(prompt).toContain('TEMI GIÀ ESISTENTI: (nessuno)');
    expect(prompt).toContain('Didascalia: (nessuna)');
    expect(prompt).toContain('always in English');
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

  const withModel = async (value: string, run: () => Promise<unknown>) => {
    process.env.AUTO_PLAYLIST_MODEL = value;
    try {
      return await run();
    } finally {
      delete process.env.AUTO_PLAYLIST_MODEL;
    }
  };
  const good = '{"aboutMusic":true,"title":"Jazz da ascoltare","kind":"theme","existingTheme":null}';

  it('with AUTO_PLAYLIST_MODEL a list post is asked to that model, with a ceiling that leaves room to think', async () => {
    const generate = vi.fn().mockResolvedValue(answer(good));
    await withModel('gpt-oss:120b', () => generatePlaylistTitle(source(), { generate }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(generate).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ model: 'gpt-oss:120b', maxTokens: 1500 }));
    // and without it: the default model, the short ceiling, no model field at all
    generate.mockClear();
    await generatePlaylistTitle(source(), { generate });
    const opts = generate.mock.calls[0][1] as Record<string, unknown>;
    expect(opts.maxTokens).toBe(200);
    expect('model' in opts).toBe(false);
  });

  it('a big model that is down, cut short or says nothing usable falls back to the default model', async () => {
    for (const failure of [
      () => Promise.reject(new Error('vulcano asleep')),
      () => Promise.resolve(answer(good, true)),
      () => Promise.resolve(answer('not json')),
      () => Promise.resolve(answer('{"aboutMusic":true,"title":"Playlist","kind":"theme","existingTheme":null}')),
    ]) {
      const generate = vi.fn().mockImplementationOnce(failure).mockResolvedValueOnce(answer(good));
      const plan = await withModel('gpt-oss:120b', () => generatePlaylistTitle(source(), { generate }));
      expect(plan).toMatchObject({ title: 'Jazz da ascoltare' });
      expect(generate).toHaveBeenCalledTimes(2);
      expect((generate.mock.calls[0][1] as { model?: string }).model).toBe('gpt-oss:120b');
      expect('model' in (generate.mock.calls[1][1] as object)).toBe(false);
    }
  });

  it('when both fail it is no plan', async () => {
    const generate = vi.fn().mockRejectedValue(new Error('down'));
    expect(await withModel('gpt-oss:120b', () => generatePlaylistTitle(source(), { generate }))).toBeNull();
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it('a post with ONE song is always asked to the default model (hundreds of them, a short list of genres)', async () => {
    const generate = vi.fn().mockResolvedValue(answer(good));
    await withModel('gpt-oss:120b', () => generatePlaylistTitle(source({ mode: 'single' }), { generate }));
    expect(generate).toHaveBeenCalledTimes(1);
    expect('model' in (generate.mock.calls[0][1] as object)).toBe(false);
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


describe('a post with ONE song (single mode): the model only chooses a theme of a closed list', () => {
  const single = (over: Partial<TitleSource> = {}) => source({ mode: 'single', songs: [{ title: 'Nightcall', artist: 'Kavinsky' }], ...over });

  it('the question: the rules, the list to choose from, the examples, the song; no free title and no list of existing themes', () => {
    const prompt = buildTitlePrompt(single({ themes: ['Qualcosa che non conta'] }));
    expect(prompt).toContain('UNA canzone');
    expect(prompt).toContain('SCEGLI UNO');
    for (const theme of ['Jazz da ascoltare', 'Synthwave da ascoltare', 'Colonne sonore da ascoltare', 'Musica italiana da ascoltare', 'Musica per la notte']) expect(prompt).toContain(theme);
    expect(prompt).toContain('Kavinsky - Nightcall');
    expect(prompt).toContain('carbonara');                   // the example of a post that is not about music
    expect(prompt).not.toContain('Le 5 musiche di Natale');  // the list examples are not in it
    expect(prompt).not.toContain('TEMI GIÀ ESISTENTI');
    expect(prompt).not.toContain('Qualcosa che non conta');
  });

  it('the closed list: 31 genres «… da ascoltare» and 5 occasions, every title unique and clean', () => {
    expect(THEME_GENRES.length).toBe(31);
    expect(SINGLE_THEMES.length).toBe(36);
    expect(new Set(SINGLE_THEMES).size).toBe(SINGLE_THEMES.length);
    for (const title of SINGLE_THEMES) expect(cleanTitle(title)).toBe(title);
    expect(SINGLE_SCHEMA.properties.theme.enum).toContain('');
    expect(SINGLE_SCHEMA.properties.theme.enum).toContain('Elettronica da ascoltare');
  });

  it('a theme of the list is the plan: the title is OURS, exact, whatever the case', () => {
    expect(parseTitleResponse('{"aboutMusic":true,"theme":"synthwave DA ascoltare"}', [], 'single')).toEqual({ aboutMusic: true, title: 'Synthwave da ascoltare', kind: 'theme', existingTheme: null });
  });

  it('a theme that is not in the list is no answer (no invented title ever gets in)', () => {
    expect(parseTitleResponse('{"aboutMusic":true,"theme":"Synthwave de Ascolare"}', [], 'single')).toBeNull();
    expect(parseTitleResponse('{"aboutMusic":true,"theme":""}', [], 'single')).toBeNull();
    expect(parseTitleResponse('{"aboutMusic":true}', [], 'single')).toBeNull();
    expect(parseTitleResponse('not json', [], 'single')).toBeNull();
  });

  it('not about music is a plan with no title', () => {
    expect(parseTitleResponse('{"aboutMusic":false,"theme":""}', [], 'single')).toEqual({ aboutMusic: false, title: '', kind: 'theme', existingTheme: null });
  });

  it('the list question is the default, and the schema follows the mode', async () => {
    expect(buildTitlePrompt(source())).toContain('Le 5 musiche di Natale');
    const generate = vi.fn().mockResolvedValue({ text: '{"aboutMusic":true,"theme":"Jazz da ascoltare"}', usageMetadata: null });
    expect(await generatePlaylistTitle(single(), { generate })).toMatchObject({ title: 'Jazz da ascoltare', kind: 'theme' });
    expect((generate.mock.calls[0][1] as { schema: { required: string[] } }).schema.required).toEqual(['aboutMusic', 'theme']);
    generate.mockClear();
    generate.mockResolvedValue({ text: '{"aboutMusic":true,"title":"Jazz da ascoltare","kind":"theme","existingTheme":null}', usageMetadata: null });
    await generatePlaylistTitle(source(), { generate });
    expect((generate.mock.calls[0][1] as { schema: { required: string[] } }).schema.required).toEqual(['aboutMusic', 'title', 'kind', 'existingTheme']);
  });
});
