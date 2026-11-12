import { describe, expect, it, vi } from 'vitest';

// songMeta (where the identity of a song lives) reads the database module; nothing here talks to it
vi.mock('../utils/db', () => ({ query: vi.fn(), pool: { query: vi.fn() } }));

import {
  REEL_KINDS,
  REEL_KIND_LABEL,
  REEL_LIMITS,
  SHOWN_NOTE_CATEGORIES,
  buildReelCard,
  buildReelDetail,
  filmSheetUrl,
  reelSongs,
  type ReelItem,
  type ReelRow,
} from './reelBreakdown';
import { songKey } from './songMeta';
import type { OfflineTrack } from './offlineManifest';

// What a reel shows in Mondrop (ADR-0033, spec 2026-11-12-mondrop-home-play-loop-reels-design.md §4): the summary as the explanation and what the post contained, by
// category, with no address of the post anywhere. Pure: the rows come from the database already, and nothing here asks for anything.

const ID = '8167b826-f8e2-4298-b477-174c41bcc13b';
const ADDRESS = 'https://www.instagram.com/reel/TESTCODE123/';

function row(results: unknown, over: Partial<ReelRow> = {}): ReelRow {
  return { id: ID, createdAt: new Date('2026-11-12T08:01:00.000Z'), platform: 'instagram', thumbnailUrl: `/media/${ID}/thumbnail.jpg`, results, ...over };
}

const note = (category: unknown, text: unknown) => ({ category, text });
const song = (artist: string | null, title: string) => ({ title, artist, album: null, source: 'ai_analysis' });

/** A track as `buildTracks` makes it (only what these tests read), with the legacy `mediaUrl` the app never decodes. */
function track(artist: string, title: string): OfflineTrack {
  return {
    songKey: songKey(artist, title), title, artist, album: null, genres: [], year: null, status: 'ready', state: 'ready', source: 'ytdlp',
    downloadPath: `/api/mondrop/songs/${encodeURIComponent(songKey(artist, title))}/file`, mediaUrl: null, version: '1-2', bytes: 1, durationS: 1, error: null,
    spotifyUrl: null, entryId: ID, canEnqueueSpooty: false, coverUrl: null, coverPath: null, lyrics: null, plays: 0, lastPlayedAt: null,
  } as OfflineTrack;
}

function keysDeep(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((v) => keysDeep(v, out));
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.push(k);
      keysDeep(v, out);
    }
  }
  return out;
}

/** Rule P: nothing in an answer is an address of the post, whatever the post carried in the fields the builder reads. */
function expectNoAddress(output: unknown): void {
  const keys = keysDeep(output);
  for (const forbidden of ['sourceUrl', 'mediaUrl', 'imdbUrl', 'url']) expect(keys).not.toContain(forbidden);
  const text = JSON.stringify(output);
  expect(text).not.toContain(ADDRESS);
  expect(text).not.toMatch(/https?:\/\//i);
}

/** A post that carries an address in every field a post can: the answers must not. */
const WITH_ADDRESSES = {
  summary: `Una guida. Vedi ${ADDRESS} per il resto.`,
  songs: [{ ...song('Yom', 'Garden of Eden'), spotifyUrl: 'https://open.spotify.com/track/1', youtubeUrl: 'https://youtube.com/watch?v=1' }],
  films: [{ title: 'Dune', director: 'Denis Villeneuve', year: '2021', imdbUrl: 'https://imdb.com/title/tt1', posterUrl: 'https://img.test/p.jpg' }],
  software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product', description: 'Appunti, vedi https://notion.so/help' }],
  notes: [note('place', 'Trattoria da Gino')],
  links: [{ url: ADDRESS, label: 'il reel' }],
  tags: ['#claude'],
  slides: [{ index: 0, imageUrl: '/media/x/slide-0.jpg', summary: `Prima slide ${ADDRESS}`, links: [{ url: ADDRESS, label: 'x' }] }],
  enrichments: { category: 'generic', items: [{ label: 'Software: Notion', explanation: `Un'app. Fonte: ${ADDRESS}`, links: [{ url: ADDRESS, title: 'x', snippet: 'y' }] }] },
};

describe('the categories', () => {
  it('are the ones of the contract, in this order', () => {
    expect([...REEL_KINDS]).toEqual(['music', 'film', 'software', 'place', 'book', 'product', 'brand', 'person', 'event', 'quote']);
    expect(REEL_KIND_LABEL).toEqual({
      music: 'Musica', film: 'Film', software: 'Software', place: 'Luoghi', book: 'Libri', product: 'Prodotti', brand: 'Marchi', person: 'Persone', event: 'Eventi', quote: 'Citazioni',
    });
  });

  it('take their notes from the seven categories of things, and from no other', () => {
    expect([...SHOWN_NOTE_CATEGORIES]).toEqual(['place', 'book', 'product', 'brand', 'person', 'event', 'quote']);
  });
});

describe('buildReelCard: the card of the list', () => {
  it('has exactly the fields of the contract and nothing else', () => {
    const card = buildReelCard(row({ summary: 'Di cosa parla.', software: [{ title: 'Notion', tag: 'product' }] }));
    expect(Object.keys(card).sort()).toEqual(['counts', 'createdAt', 'id', 'imagePath', 'platform', 'summary']);
    expect(card).toEqual({
      id: ID,
      createdAt: '2026-11-12T08:01:00.000Z',
      platform: 'instagram',
      summary: 'Di cosa parla.',
      imagePath: `/api/mondrop/reels/${ID}/image`,
      counts: [{ kind: 'software', label: 'Software', count: 1, names: ['Notion'] }],
    });
  });

  it('takes the date as a Date or as text and always says it in ISO', () => {
    expect(buildReelCard(row({}, { createdAt: '2026-11-12T10:01:00+02:00' })).createdAt).toBe('2026-11-12T08:01:00.000Z');
    expect(buildReelCard(row({}, { createdAt: new Date('2026-01-02T03:04:05.678Z') })).createdAt).toBe('2026-01-02T03:04:05.678Z');
  });

  it('says «other» for a post whose platform is not known', () => {
    expect(buildReelCard(row({}, { platform: null })).platform).toBe('other');
    expect(buildReelCard(row({}, { platform: '  ' })).platform).toBe('other');
    expect(buildReelCard(row({}, { platform: 'TikTok' })).platform).toBe('tiktok');
  });

  it('has an image only when the thumbnail is a file of the server, never the address of someone else\'s CDN', () => {
    expect(buildReelCard(row({})).imagePath).toBe(`/api/mondrop/reels/${ID}/image`);
    expect(buildReelCard(row({}, { thumbnailUrl: 'https://scontent.cdninstagram.com/v/t51/x.jpg' })).imagePath).toBeNull();
    expect(buildReelCard(row({}, { thumbnailUrl: null })).imagePath).toBeNull();
    expect(buildReelCard(row({}, { thumbnailUrl: '' })).imagePath).toBeNull();
  });

  it('lists the categories that have something, with how many and the first three names, in the order of the categories', () => {
    const card = buildReelCard(row({
      summary: 'x',
      notes: [note('quote', 'Chi ben comincia è a metà dell\'opera'), note('product', 'iPhone'), note('place', 'Milano'), note('person', 'Steve Jobs'), note('book', 'Dune'), note('event', 'Natale'), note('brand', 'Apple')],
      software: [{ title: 'Notion', tag: 'product' }, { title: 'Gmail', tag: 'product' }, { title: 'Slack', tag: 'product' }, { title: 'Zoom', tag: 'product' }],
      films: [{ title: 'Arrival', director: null, year: null }],
      songs: [song('Yom', 'Garden of Eden'), song('Dua Lipa', 'Houdini')],
    }));
    expect(card.counts.map((c) => [c.kind, c.label, c.count])).toEqual([
      ['music', 'Musica', 2], ['film', 'Film', 1], ['software', 'Software', 4], ['place', 'Luoghi', 1], ['book', 'Libri', 1],
      ['product', 'Prodotti', 1], ['brand', 'Marchi', 1], ['person', 'Persone', 1], ['event', 'Eventi', 1], ['quote', 'Citazioni', 1],
    ]);
    expect(card.counts.find((c) => c.kind === 'music')?.names).toEqual(['Garden of Eden', 'Houdini']);
    expect(card.counts.find((c) => c.kind === 'software')?.names).toEqual(['Notion', 'Gmail', 'Slack']);   // at most three, the fourth is only counted
  });

  it('says nothing of a category with nothing in it', () => {
    expect(buildReelCard(row({ summary: 'x' })).counts).toEqual([]);
    expect(buildReelCard(row({ songs: [], films: [], software: [], notes: [] })).counts).toEqual([]);
  });

  it('keeps the explanation of the post, cleaned, or none', () => {
    expect(buildReelCard(row({ summary: '  Una   frase \n su due righe.  ' })).summary).toBe('Una frase su due righe.');
    expect(buildReelCard(row({ summary: '' })).summary).toBeNull();
    expect(buildReelCard(row({ summary: '...' })).summary).toBeNull();
    expect(buildReelCard(row({ summary: 'null' })).summary).toBeNull();
    expect(buildReelCard(row({ summary: '#tag' })).summary).toBeNull();
    expect(buildReelCard(row({ summary: 42 })).summary).toBeNull();
    expect(buildReelCard(row({})).summary).toBeNull();
  });

  it('cuts a very long explanation with «…» at the limit', () => {
    const summary = buildReelCard(row({ summary: 'a'.repeat(REEL_LIMITS.summary + 500) })).summary ?? '';
    expect([...summary]).toHaveLength(REEL_LIMITS.summary);
    expect(summary.endsWith('…')).toBe(true);
  });

  it('does not show the category «other» of the notes, nor what is not a category of things (tag, note, empty, a number)', () => {
    const card = buildReelCard(row({
      notes: [note('other', 'qualcosa'), note('tag', 'x1'), note('tags', 'x2'), note('note', 'x3'), note('', 'x4'), note(null, 'x5'), note(7, 'x6'), note('persona', 'x7'), { text: 'x8' }],
    }));
    expect(card.counts).toEqual([]);
  });

  it('reads the category of a note without caring for capitals or spaces', () => {
    const card = buildReelCard(row({ notes: [note(' Place ', 'Milano'), note('PERSON', 'Steve')] }));
    expect(card.counts.map((c) => c.kind)).toEqual(['place', 'person']);
  });

  it('leaves out what is only the placeholder of the model, an empty text and a text of only signs', () => {
    const card = buildReelCard(row({
      notes: [note('product', '#tag'), note('product', '@utente'), note('product', '#hashtag'), note('product', '...'), note('product', 'null'), note('product', ''), note('product', '  '), note('product', '---'), note('product', '/n'), note('product', null), note('product', 12), note('product', 'Veri')],
      software: [{ title: '/repo', tag: 'repo' }, { title: 'tool', tag: 'other' }, { title: '' }, { title: 'jq', tag: 'product' }],
      films: [{ title: '...', director: null, year: null }, { title: 'anno o null' }, { title: 'Dune' }],
      songs: [song('x', '...'), song('x', ''), song('Yom', 'Garden of Eden')],
    }));
    expect(card.counts.map((c) => [c.kind, c.names])).toEqual([['music', ['Garden of Eden']], ['film', ['Dune']], ['software', ['jq']], ['product', ['Veri']]]);
  });

  it('takes off the quotes a model puts around a name', () => {
    const card = buildReelCard(row({ notes: [note('brand', "'AGENTI'"), note('brand', '"Nike"'), note('brand', '«Adidas»')] }));
    expect(card.counts[0].names).toEqual(['AGENTI', 'Nike', 'Adidas']);
  });

  it('shows the same thing once: a name that is also a product stays in the first category (Software before Prodotti)', () => {
    const card = buildReelCard(row({ software: [{ title: 'Notion', tag: 'product' }], notes: [note('product', 'notion'), note('product', 'Linear'), note('brand', 'NOTION!')] }));
    expect(card.counts.map((c) => [c.kind, c.names])).toEqual([['software', ['Notion']], ['product', ['Linear']]]);
  });

  it('compares without capitals, accents and punctuation', () => {
    const card = buildReelCard(row({ notes: [note('place', 'Café  de Paris'), note('brand', 'cafe de paris!!'), note('person', 'CAFÈ DE PARIS')] }));
    expect(card.counts.map((c) => [c.kind, c.count])).toEqual([['place', 1]]);
  });

  it('keeps a film and a book that share a title, and a name that is also a quote: a work is not a product, a book is not a film', () => {
    const card = buildReelCard(row({ films: [{ title: 'Dune', year: '2021' }], notes: [note('book', 'Dune'), note('quote', 'dune'), note('product', 'Dune')] }));
    expect(card.counts.map((c) => [c.kind, c.names])).toEqual([['film', ['Dune']], ['book', ['Dune']], ['product', ['Dune']], ['quote', ['dune']]]);
  });

  it('merges the same name only among the things the model mixes up (software, places, products, brands, people, events), the first category wins', () => {
    const card = buildReelCard(row({
      software: [{ title: 'Notion', tag: 'product' }], notes: [note('event', 'Apple'), note('person', 'Apple'), note('brand', 'APPLE'), note('product', 'Notion'), note('place', 'Apple')],
    }));
    expect(card.counts.map((c) => [c.kind, c.names])).toEqual([['software', ['Notion']], ['place', ['Apple']]]);
  });

  it('keeps a song and a film that share a title: they are not the same thing (the identity of a song is its key)', () => {
    const card = buildReelCard(row({ songs: [song('Yom', 'Garden of Eden')], films: [{ title: 'Garden of Eden', year: '2025' }] }));
    expect(card.counts.map((c) => [c.kind, c.names])).toEqual([['music', ['Garden of Eden']], ['film', ['Garden of Eden']]]);
  });

  it('counts a song named twice once (same artist and title, whatever the capitals)', () => {
    const card = buildReelCard(row({ songs: [song('Yom', 'Garden of Eden'), song('yom', 'garden  of eden'), song('Dua Lipa', 'Houdini')] }));
    expect(card.counts[0]).toMatchObject({ kind: 'music', count: 2, names: ['Garden of Eden', 'Houdini'] });
  });

  it('accepts a song without an artist, a null one and a text one, and refuses an artist that is not text', () => {
    const card = buildReelCard(row({ songs: [song(null, 'Solo titolo'), { title: 'Senza campo' }, { title: 'Numero', artist: 7 }] }));
    expect(card.counts[0]).toMatchObject({ kind: 'music', count: 2 });
  });

  it('cuts a title at 140 characters (a quote at 280, a name of the card at 60) with «…»', () => {
    const long = 'x'.repeat(500);
    const card = buildReelCard(row({ notes: [note('product', long), note('quote', long)] }));
    const product = card.counts.find((c) => c.kind === 'product');
    const quote = card.counts.find((c) => c.kind === 'quote');
    expect([...(product?.names[0] ?? '')]).toHaveLength(REEL_LIMITS.name);
    expect(product?.names[0].endsWith('…')).toBe(true);
    expect([...(quote?.names[0] ?? '')]).toHaveLength(REEL_LIMITS.name);
    const detail = buildReelDetail(row({ notes: [note('product', long), note('quote', long)] }), null);
    const items = (kind: string) => detail.sections.find((s) => s.kind === kind && 'items' in s);
    expect([...((items('product') as { items: { title: string }[] }).items[0].title)]).toHaveLength(REEL_LIMITS.title);
    expect([...((items('quote') as { items: { title: string }[] }).items[0].title)]).toHaveLength(REEL_LIMITS.quote);
  });

  it('holds at most 20 things per category and 50 songs, and counts what it holds (the card says what the page shows)', () => {
    const notes = Array.from({ length: 30 }, (_, i) => note('product', `Prodotto ${i}`));
    const songs = Array.from({ length: 70 }, (_, i) => song('Art', `Brano ${i}`));
    const card = buildReelCard(row({ notes, songs }));
    expect(card.counts.find((c) => c.kind === 'product')?.count).toBe(REEL_LIMITS.perSection);
    expect(card.counts.find((c) => c.kind === 'music')?.count).toBe(REEL_LIMITS.tracks);
  });

  it('does not let repeated things eat the room of the limit', () => {
    const notes = [...Array.from({ length: 25 }, () => note('product', 'Sempre lo stesso')), note('product', 'Un altro')];
    expect(buildReelCard(row({ notes })).counts[0]).toMatchObject({ count: 2, names: ['Sempre lo stesso', 'Un altro'] });
  });

  it('reads a damaged post as a post with nothing in it, never as an error', () => {
    for (const results of [null, undefined, 7, 'testo', [], { songs: 'x', films: {}, notes: 3, software: true }, { notes: ['stringa', 4, null, [], { text: 'senza categoria' }] }, { songs: [null, 4, 'x', []] }]) {
      expect(() => buildReelCard(row(results))).not.toThrow();
      expect(buildReelCard(row(results)).counts).toEqual([]);
      expect(() => buildReelDetail(row(results), null)).not.toThrow();
    }
  });

  it('has no address of the post, nor of anything, in any field (rule P)', () => {
    expectNoAddress(buildReelCard(row(WITH_ADDRESSES)));
  });
});

describe('the debris a model leaves in a name (measured on the 1 665 reels of 12 November)', () => {
  /** Every title of a category, as the page shows them (the card only names the first three). */
  const namesOf = (results: unknown, kind: string): string[] => {
    const section = buildReelDetail(row(results), null).sections.find((s) => s.kind === kind);
    return section && 'items' in section ? section.items.map((i) => i.title) : [];
  };

  it('takes off the signs of a broken JSON from the edges of a name and keeps the name', () => {
    const software = [{ title: '> vLLM' }, { title: '}TypeScript' }, { title: ']}code' }, { title: '>Yourchatgptguide' }, { title: 'Zed {' }, { title: '* Ollama *' }, { title: '| Bun' }];
    expect(namesOf({ software }, 'software')).toEqual(['vLLM', 'TypeScript', 'code', 'Yourchatgptguide', 'Zed', 'Ollama', 'Bun']);
  });

  it('leaves out a name that still holds the pieces of a broken JSON, or of Markdown, after that', () => {
    const software = [{ title: '}] }**}]}* * **{***}}` ```json``` {``}` ` `` ' }, { title: 'a{b' }, { title: 'x`y' }, { title: 'bold**word' }, { title: 'Notion' }];
    expect(namesOf({ software }, 'software')).toEqual(['Notion']);
  });

  it('keeps the signs that are part of a real name', () => {
    const software = [{ title: '.NET' }, { title: 'C++' }, { title: '@angular/core' }, { title: '[REC]' }, { title: 'Node.js (LTS)' }];
    expect(namesOf({ software }, 'software')).toEqual(['.NET', 'C++', '@angular/core', '[REC]', 'Node.js (LTS)']);
  });

  it('leaves out a note that is only the word of its own category, in either language', () => {
    const notes = [note('event', 'event'), note('product', 'Product'), note('person', 'persona'), note('brand', 'marchio'), note('place', 'Luogo'), note('book', 'libro'), note('quote', 'Quote'), note('event', 'Natale')];
    expect(buildReelCard(row({ notes })).counts.map((c) => [c.kind, c.names])).toEqual([['event', ['Natale']]]);
  });
});

describe('a note that is a whole sentence (650 of the 5 000 notes of 12 November)', () => {
  const LONG = "Timorasso Derthona, Vigneti Massa (Piemonte) - vitigno salvato dall'estinzione da Walter Massa, bianco potente e longevo, circa 25 euro";
  const itemsOf = (results: unknown, kind: string) => {
    const section = buildReelDetail(row(results), null).sections.find((s) => s.kind === kind);
    return section && 'items' in section ? section.items : [];
  };

  it('is a name and its words when it has a separator near the start: the name is the title, the rest the detail', () => {
    expect(itemsOf({ notes: [note('product', LONG)] }, 'product')).toEqual([
      { title: 'Timorasso Derthona, Vigneti Massa (Piemonte)', detail: "vitigno salvato dall'estinzione da Walter Massa, bianco potente e longevo, circa 25 euro" },
    ]);
    expect(buildReelCard(row({ notes: [note('product', LONG)] })).counts[0].names).toEqual(['Timorasso Derthona, Vigneti Massa (Piemonte)']);   // the card names the thing, not the sentence
  });

  it('splits at the first of « - », « – », « — » and «: », the one that comes first', () => {
    const tail = 'una frase che spiega di cosa si tratta e che è abbastanza lunga da fare una nota intera';
    for (const [separator, head] of [[' - ', 'Alfa'], [' – ', 'Beta'], [' — ', 'Gamma'], [': ', 'Delta']] as const) {
      expect(itemsOf({ notes: [note('event', `${head}${separator}${tail}`)] }, 'event')).toEqual([{ title: head, detail: tail }]);
    }
    expect(itemsOf({ notes: [note('event', `Capitolo 'La Luce': ${tail} - e poi altro`)] }, 'event')[0].title).toBe("Capitolo 'La Luce'");
  });

  it('is left whole when it is short (a name with a dash is a name), has no separator, or the name would be long or too short', () => {
    expect(itemsOf({ notes: [note('place', 'Ristorante - Da Gino')] }, 'place')).toEqual([{ title: 'Ristorante - Da Gino', detail: null }]);
    const noSeparator = "'Stack Diagram' è uno strumento per Claude Code che genera diagrammi di architettura interattivi a partire da una singola frase. Utile perché elimina il tempo perso nel disegnare a mano ogni schema.";
    expect(itemsOf({ notes: [note('event', noSeparator)] }, 'event')[0].detail).toBeNull();
    expect([...itemsOf({ notes: [note('event', noSeparator)] }, 'event')[0].title]).toHaveLength(REEL_LIMITS.title);
    const longHead = `${'p'.repeat(90)} - una frase che spiega di cosa si tratta e che è abbastanza lunga da fare una nota intera`;
    expect(itemsOf({ notes: [note('event', longHead)] }, 'event')[0].detail).toBeNull();
    const tinyHead = 'Ab - una frase che spiega di cosa si tratta e che è abbastanza lunga da fare una nota intera, senza altro';
    expect(itemsOf({ notes: [note('event', tinyHead)] }, 'event')[0].detail).toBeNull();
  });

  it('cuts the detail at 200 characters with «…»', () => {
    const detail = itemsOf({ notes: [note('event', `Titolo - ${'d'.repeat(500)}`)] }, 'event')[0].detail ?? '';
    expect([...detail]).toHaveLength(REEL_LIMITS.detail);
    expect(detail.endsWith('…')).toBe(true);
  });

  it('counts the same thing once whatever its words: two notes with the same name and different sentences are one', () => {
    const a = `Notion - ${'una frase lunga '.repeat(8)}`;
    const b = `NOTION: ${'un\'altra frase lunga '.repeat(8)}`;
    expect(buildReelCard(row({ notes: [note('product', a), note('product', b)] })).counts[0]).toMatchObject({ count: 1, names: ['Notion'] });
  });
});

describe('reelSongs: the songs of a post, by the identity the journal uses', () => {
  it('gives the key of each song as the journal makes it (artist and title as written), once, in the order of the post', () => {
    const songs = reelSongs({ songs: [song('Yom', 'Garden of Eden'), song('Dua Lipa', 'Houdini'), song('YOM', 'garden of eden')] });
    expect(songs.map((s) => s.key)).toEqual([songKey('Yom', 'Garden of Eden'), songKey('Dua Lipa', 'Houdini')]);
    expect(songs.map((s) => [s.artist, s.title])).toEqual([['Yom', 'Garden of Eden'], ['Dua Lipa', 'Houdini']]);
  });

  it('takes the key from the words as written: cleaning the title for the eye never changes the key the journal looks up', () => {
    const [one] = reelSongs({ songs: [song("  'Quoted'  ", '  Spaced   title ')] });
    expect(one.key).toBe(songKey("  'Quoted'  ", '  Spaced   title '));
  });

  it('leaves out a song with a title that is only the placeholder of the model, and holds at most 50', () => {
    expect(reelSongs({ songs: [song('a', '...'), song('a', 'null')] })).toEqual([]);
    expect(reelSongs({ songs: Array.from({ length: 80 }, (_, i) => song('a', `t${i}`)) })).toHaveLength(REEL_LIMITS.tracks);
    expect(reelSongs(null)).toEqual([]);
  });
});

describe('buildReelDetail: the page of a reel', () => {
  const RESULTS = {
    summary: 'Il post promuove una guida gratuita per costruire agenti AI.',
    songs: [song('Yom', 'Garden of Eden'), song('Dua Lipa', 'Houdini')],
    films: [{ title: 'Dune', director: 'Denis Villeneuve', year: '2021' }, { title: 'Arrival', director: null, year: null }, { title: 'Heat', director: 'Michael Mann', year: null }, { title: 'Alien', director: null, year: '1979' }],
    software: [{ title: 'Notion', tag: 'product', description: 'Appunti e database' }, { title: 'Claude Code', tag: 'repo' }, { title: 'Come usare jq', tag: 'article', description: 'Una guida' }, { title: 'Zed', tag: 'other' }],
    notes: [note('place', 'Trattoria da Gino, Milano'), note('book', 'Dune'), note('person', 'Steve Jobs')],
    tags: ['#claude', '@AGENTI', '#Claude', '#tag', '@utente', '#hashtag', 'aiperbusiness'],
  };
  const TRACKS = [track('Yom', 'Garden of Eden'), track('Dua Lipa', 'Houdini')];

  it('has exactly the fields of the contract', () => {
    const detail = buildReelDetail(row(RESULTS), TRACKS);
    expect(Object.keys(detail).sort()).toEqual(['createdAt', 'id', 'imagePath', 'insights', 'platform', 'sections', 'slides', 'summary', 'tags', 'verdict']);
    expect(detail.id).toBe(ID);
    expect(detail.createdAt).toBe('2026-11-12T08:01:00.000Z');
    expect(detail.platform).toBe('instagram');
    expect(detail.summary).toBe('Il post promuove una guida gratuita per costruire agenti AI.');
    expect(detail.imagePath).toBe(`/api/mondrop/reels/${ID}/image`);
    expect(detail.insights).toEqual([]);
    expect(detail.verdict).toBeNull();
    expect(detail.slides).toEqual([]);
  });

  it('has the sections in the order of the categories, the music with its tracks and the others with their things', () => {
    const detail = buildReelDetail(row(RESULTS), TRACKS);
    expect(detail.sections.map((s) => [s.kind, s.title])).toEqual([
      ['music', 'Musica'], ['film', 'Film'], ['software', 'Software'], ['place', 'Luoghi'], ['book', 'Libri'], ['person', 'Persone'],
    ]);
    const music = detail.sections[0];
    expect('tracks' in music && music.tracks.map((t) => t.songKey)).toEqual(TRACKS.map((t) => t.songKey));
    expect('items' in music).toBe(false);
    const place = detail.sections.find((s) => s.kind === 'place');
    expect(place && 'items' in place && place.items).toEqual([{ title: 'Trattoria da Gino, Milano', detail: null }]);
  });

  it('says of a film the year and the director, and of a software its kind and its description', () => {
    const detail = buildReelDetail(row(RESULTS), TRACKS);
    const items = (kind: string) => {
      const section = detail.sections.find((s) => s.kind === kind);
      return section && 'items' in section ? section.items : [];
    };
    expect(items('film')).toEqual([
      { title: 'Dune', detail: '2021 · regia di Denis Villeneuve' },
      { title: 'Arrival', detail: null },
      { title: 'Heat', detail: 'regia di Michael Mann' },
      { title: 'Alien', detail: '1979' },
    ]);
    expect(items('software')).toEqual([
      { title: 'Notion', detail: 'prodotto · Appunti e database' },
      { title: 'Claude Code', detail: 'repo' },
      { title: 'Come usare jq', detail: 'articolo · Una guida' },
      { title: 'Zed', detail: null },
    ]);
  });

  it('gives only a year that is a year, and cuts a long description', () => {
    const detail = buildReelDetail(row({
      films: [{ title: 'A', year: 'anno o null' }, { title: 'B', year: 'forse 1999 o 2000' }, { title: 'C', year: 'molto tempo fa' }],
      software: [{ title: 'Tool X', tag: 'product', description: 'd'.repeat(400) }],
    }), null);
    const film = detail.sections.find((s) => s.kind === 'film');
    expect(film && 'items' in film && film.items.map((i) => i.detail)).toEqual([null, '1999', null]);
    const software = detail.sections.find((s) => s.kind === 'software');
    const words = software && 'items' in software ? software.items[0].detail ?? '' : '';
    expect([...words]).toHaveLength(REEL_LIMITS.detail);                // the whole detail, kind and description, is cut at 200
    expect(words.startsWith('prodotto · ')).toBe(true);
    expect(words.endsWith('…')).toBe(true);
  });

  it('has no music section when there are no tracks (a journal that could not be read, a song it does not know), and still has the rest', () => {
    for (const tracks of [null, []]) {
      const detail = buildReelDetail(row(RESULTS), tracks);
      expect(detail.sections.map((s) => s.kind)).toEqual(['film', 'software', 'place', 'book', 'person']);
    }
  });

  it('leaves the legacy mediaUrl off the tracks: no address in the answer', () => {
    const detail = buildReelDetail(row(RESULTS), TRACKS);
    const music = detail.sections[0];
    const tracks = 'tracks' in music ? music.tracks : [];
    expect(tracks).toHaveLength(2);
    for (const t of tracks) {
      expect('mediaUrl' in t).toBe(false);
      expect(t.downloadPath).toContain('/api/mondrop/songs/');   // everything else of the track is the one of the library
      expect(t.state).toBe('ready');
    }
  });

  it('holds at most 50 tracks', () => {
    const many = Array.from({ length: 70 }, (_, i) => track('Art', `Brano ${i}`));
    const music = buildReelDetail(row(RESULTS), many).sections[0];
    expect('tracks' in music && music.tracks).toHaveLength(REEL_LIMITS.tracks);
  });

  it('has the key words without the signs, without the placeholders of the model, once, at most 12', () => {
    expect(buildReelDetail(row(RESULTS), null).tags).toEqual(['claude', 'AGENTI', 'aiperbusiness']);
    const many = Array.from({ length: 30 }, (_, i) => `#tag${i}x`);
    expect(buildReelDetail(row({ tags: many }), null).tags).toHaveLength(REEL_LIMITS.tags);
    expect(buildReelDetail(row({ tags: 'claude' }), null).tags).toEqual([]);
    expect(buildReelDetail(row({ tags: [3, null, '#', '@', '  ', '##tag'] }), null).tags).toEqual([]);
  });

  it('has the explanations of the model («approfondimenti»): at most 8, each at most 600 characters, never without a text', () => {
    const items = [
      { label: 'Software: Notion', explanation: 'Un\'app per appunti.', links: [] },
      { label: 'Brand: AGENTI', explanation: '', links: [] },
      { label: '', explanation: 'Senza etichetta', links: [] },
      { label: 'Segnaposto', explanation: '...', links: [] },
      { label: 'Software: Notion', explanation: 'Ripetuta', links: [] },
      ...Array.from({ length: 12 }, (_, i) => ({ label: `Voce ${i}`, explanation: 'y'.repeat(900), links: [] })),
    ];
    const detail = buildReelDetail(row({ enrichments: { category: 'generic', items } }), null);
    expect(detail.insights).toHaveLength(REEL_LIMITS.insights);
    expect(detail.insights[0]).toEqual({ label: 'Software: Notion', text: "Un'app per appunti." });
    expect(detail.insights.map((i) => i.label)).not.toContain('Brand: AGENTI');   // an explanation with no words is no explanation
    expect(detail.insights.map((i) => i.label)).not.toContain('Segnaposto');
    expect(detail.insights.filter((i) => i.label === 'Software: Notion')).toHaveLength(1);   // the same label twice is one
    for (const insight of detail.insights.slice(1)) expect([...insight.text]).toHaveLength(REEL_LIMITS.insightText);
    expect(Object.keys(detail.insights[0]).sort()).toEqual(['label', 'text']);   // the links of an approfondimento are not carried
  });

  it('has the verdict when the post has one: its label and its words, without the confidence', () => {
    const verdict = { label: 'dubbio', confidence: 0.62, explanation: 'Non ci sono fonti.' };
    expect(buildReelDetail(row({ enrichments: { category: 'claim', verdict, items: [] } }), null).verdict).toEqual({ label: 'dubbio', explanation: 'Non ci sono fonti.' });
    expect(buildReelDetail(row({ enrichments: { category: 'claim', verdict: { label: 'vero', confidence: 0.9 }, items: [] } }), null).verdict).toEqual({ label: 'vero', explanation: '' });
    expect(buildReelDetail(row({ enrichments: { category: 'claim', verdict: { label: '', explanation: 'x' }, items: [] } }), null).verdict).toBeNull();
    expect(buildReelDetail(row({ enrichments: { category: 'generic', items: [] } }), null).verdict).toBeNull();
    expect(buildReelDetail(row({ enrichments: 'x' }), null).verdict).toBeNull();
  });

  it('has the slides that have an explanation, as number and words, and nothing of the picture or of its text', () => {
    const slides = [
      { index: 0, imageUrl: '/media/x/0.jpg', ocrText: 'testo grande', visualDescription: 'una foto', summary: 'La prima slide spiega il problema.', links: [] },
      { index: 1, imageUrl: null, ocrText: 'solo ocr', summary: null },
      { index: 2, summary: '   ' },
      { summary: 'Senza numero' },
      { index: 4, summary: 's'.repeat(900) },
    ];
    const detail = buildReelDetail(row({ slides }), null);
    expect(detail.slides.map((s) => s.index)).toEqual([0, 3, 4]);   // a slide without a number takes its place in the list
    expect(detail.slides[0]).toEqual({ index: 0, summary: 'La prima slide spiega il problema.' });
    expect([...detail.slides[2].summary]).toHaveLength(REEL_LIMITS.slideSummary);
    expect(JSON.stringify(detail)).not.toContain('testo grande');
  });

  it('reads a damaged post (enrichments, slides, tags of the wrong kind) as one without, never as an error', () => {
    const detail = buildReelDetail(row({ enrichments: { items: 'x', verdict: [] }, slides: { a: 1 }, tags: { a: 1 } }), null);
    expect(detail).toMatchObject({ insights: [], verdict: null, slides: [], tags: [], sections: [] });
  });

  it('shows in each category the things the card counts (the card says what the page shows)', () => {
    const card = buildReelCard(row(RESULTS));
    const detail = buildReelDetail(row(RESULTS), TRACKS);
    for (const count of card.counts) {
      const section = detail.sections.find((s) => s.kind === count.kind);
      expect(section).toBeDefined();
      const held = section && 'tracks' in section ? section.tracks.length : section && 'items' in section ? section.items.length : -1;
      expect(held).toBe(count.count);
    }
    expect(detail.sections.map((s) => s.kind)).toEqual(card.counts.map((c) => c.kind));
  });

  it('has no address of the post, nor of anything, in any field, in the words of the model too (rule P)', () => {
    const detail = buildReelDetail(row(WITH_ADDRESSES), [track('Yom', 'Garden of Eden')]);
    expectNoAddress(detail);
    expect(detail.summary).toBe('Una guida. Vedi per il resto.');                 // the address is taken out of the words, the words stay
    expect(detail.insights[0].text).toBe("Un'app. Fonte:");
    expect(detail.slides[0].summary).toBe('Prima slide');
  });
});

// «Q3 si apri sulla scheda» (Michele, 12 November; spec 2026-11-12-mondrop-home-play-loop-reels-design.md M5, ADR-0033 amended): the page of a FILM carries «Apri» on the sheet of the film
// on IMDb — never the post, never a software (the analysis almost never has an address for one: 1 of 1 370 on the real reels), never an address as the model or the post wrote it.
describe('«Apri» on the sheet of a film', () => {
  const SHEET = 'https://www.imdb.com/title/tt1160419/';
  const filmItems = (films: unknown[], over: Record<string, unknown> = {}): ReelItem[] => {
    const section = buildReelDetail(row({ films, ...over }), null).sections.find((s) => s.kind === 'film');
    return section && 'items' in section ? section.items : [];
  };

  describe('filmSheetUrl', () => {
    it('is the title page of IMDb, built from the id: https, www, the id and a closing slash', () => {
      expect(filmSheetUrl(SHEET)).toBe(SHEET);
      expect(filmSheetUrl('https://www.imdb.com/title/tt1160419')).toBe(SHEET);
      expect(filmSheetUrl('http://imdb.com/title/tt1160419/')).toBe(SHEET);
      expect(filmSheetUrl('https://m.imdb.com/title/tt1160419/?ref_=fn_al_tt_1#cast')).toBe(SHEET);
      expect(filmSheetUrl('  https://www.imdb.com/title/tt1160419/  ')).toBe(SHEET);
      expect(filmSheetUrl('https://www.imdb.com/title/tt1160419/reviews')).toBe(SHEET);          // the sheet, not a sub page that the model made up
      expect(filmSheetUrl('HTTPS://WWW.IMDB.COM/title/TT1160419/')).toBe(SHEET);                  // written in capitals, built the same way: lower case id
    });

    it('takes ids of 7 to 10 digits (the old ones and the new ones) and no other', () => {
      expect(filmSheetUrl('https://www.imdb.com/title/tt0000001/')).toBe('https://www.imdb.com/title/tt0000001/');
      expect(filmSheetUrl('https://www.imdb.com/title/tt10872600/')).toBe('https://www.imdb.com/title/tt10872600/');
      expect(filmSheetUrl('https://www.imdb.com/title/tt1234567890/')).toBe('https://www.imdb.com/title/tt1234567890/');
      expect(filmSheetUrl('https://www.imdb.com/title/tt123456/')).toBeNull();                      // too short
      expect(filmSheetUrl('https://www.imdb.com/title/tt1/')).toBeNull();
      expect(filmSheetUrl('https://www.imdb.com/title/tt12345678901/')).toBeNull();                 // too long
    });

    it.each([
      ['a person', 'https://www.imdb.com/name/nm0000093/'],
      ['a search', 'https://www.imdb.com/find?q=dune'],
      ['another site with the same path', 'https://example.test/title/tt1160419/'],
      ['a host that only starts like IMDb', 'https://imdb.com.evil.test/title/tt1160419/'],
      ['a host that ends like IMDb', 'https://evilimdb.com/title/tt1160419/'],
      ['credentials that make the host another', 'https://www.imdb.com@evil.test/title/tt1160419/'],
      ['credentials before the host', 'https://user:pass@www.imdb.com/title/tt1160419/'],
      ['a port', 'https://www.imdb.com:8443/title/tt1160419/'],
      ['a script', 'javascript:alert(1)//imdb.com/title/tt1160419/'],
      ['a scheme that is not the web', 'ftp://www.imdb.com/title/tt1160419/'],
      ['the id with something glued to it', 'https://www.imdb.com/title/tt1160419x/'],
      ['the address of the post', 'https://www.instagram.com/reel/TESTCODE123/'],
      ['the id in the words only', 'vedi imdb.com/title/tt1160419 sul sito'],
      ['an address inside the address', 'https://evil.test/?u=https://www.imdb.com/title/tt1160419/'],
      ['nothing', ''],
      ['blank', '   '],
    ])('is no address for %s', (_why, value) => {
      expect(filmSheetUrl(value)).toBeNull();
    });

    it.each([[null], [undefined], [42], [{}], [['https://www.imdb.com/title/tt1160419/']], [true]])('is no address for a %j that is not text', (value) => {
      expect(filmSheetUrl(value)).toBeNull();
    });
  });

  it('is on a film that has the page of IMDb, after its year and director, and on no other key of the item', () => {
    const [dune, arrival] = filmItems([
      { title: 'Dune', director: 'Denis Villeneuve', year: '2021', imdbUrl: 'https://www.imdb.com/title/tt1160419/?ref_=x', posterUrl: 'https://img.test/p.jpg' },
      { title: 'Arrival', director: null, year: null, imdbUrl: null },
    ]);
    expect(dune).toEqual({ title: 'Dune', detail: '2021 · regia di Denis Villeneuve', openUrl: SHEET });
    expect(Object.keys(dune)).toEqual(['title', 'detail', 'openUrl']);
    expect(Object.keys(arrival)).toEqual(['title', 'detail']);                                      // no key at all, not null
  });

  it('is not on a film whose address is not the title page of IMDb: the film stays, without «Apri»', () => {
    const items = filmItems([
      { title: 'A', imdbUrl: 'https://www.instagram.com/reel/TESTCODE123/' },
      { title: 'B', imdbUrl: 'https://imdb.com.evil.test/title/tt1160419/' },
      { title: 'C', imdbUrl: 'https://www.imdb.com/name/nm0000093/' },
      { title: 'D', imdbUrl: 7 },
      { title: 'E' },
    ]);
    expect(items.map((i) => i.title)).toEqual(['A', 'B', 'C', 'D', 'E']);
    for (const item of items) expect(Object.keys(item)).not.toContain('openUrl');
  });

  it('is on films only: a software, a place or a note never has one, whatever address the post gave it', () => {
    const detail = buildReelDetail(row({
      software: [{ title: 'Notion', url: 'https://notion.so', tag: 'product' }, { title: 'Dune Tool', url: SHEET, tag: 'other' }],
      notes: [note('place', `Cinema Arlecchino ${SHEET}`), note('book', 'Dune'), note('quote', 'https://notion.so')],
      films: [{ title: 'Dune', imdbUrl: SHEET }],
    }), null);
    const withSheet = detail.sections.flatMap((s) => ('items' in s ? s.items.map((i) => [s.kind, i] as const) : [])).filter(([, i]) => i.openUrl !== undefined);
    expect(withSheet.map(([kind]) => kind)).toEqual(['film']);
    expect(JSON.stringify(detail).split('openUrl').length - 1).toBe(1);
  });

  it('stays on the film when it is named twice: the first mention keeps its place and takes the sheet of the second when it had none', () => {
    expect(filmItems([{ title: 'Dune', year: '2021' }, { title: 'DUNE', imdbUrl: SHEET }])).toEqual([{ title: 'Dune', detail: '2021', openUrl: SHEET }]);
    expect(filmItems([{ title: 'Dune', imdbUrl: SHEET }, { title: 'dune', imdbUrl: 'https://www.imdb.com/title/tt0087182/' }])).toEqual([{ title: 'Dune', detail: null, openUrl: SHEET }]);
    expect(filmItems([{ title: 'Dune', imdbUrl: SHEET }, { title: 'dune' }])).toEqual([{ title: 'Dune', detail: null, openUrl: SHEET }]);
  });

  it('is not given by a mention that the limit left out (the same room rule as before)', () => {
    const films = Array.from({ length: REEL_LIMITS.perSection + 1 }, (_, i) => ({ title: `Film ${i}`, imdbUrl: i === REEL_LIMITS.perSection ? SHEET : null }));
    const items = filmItems(films);
    expect(items).toHaveLength(REEL_LIMITS.perSection);
    expect(items.some((i) => i.openUrl !== undefined)).toBe(false);
  });

  it('is nowhere on the card of the list (the card is names and counts), nor is any address', () => {
    const card = buildReelCard(row({ films: [{ title: 'Dune', imdbUrl: SHEET }], software: [{ title: 'Notion', url: 'https://notion.so' }] }));
    expect(keysDeep(card)).not.toContain('openUrl');
    expect(JSON.stringify(card)).not.toMatch(/https?:\/\//i);
  });

  it('is the only address in the words and things of the page, whatever else the post carried (the tracks of the library keep their own cover address)', () => {
    const detail = buildReelDetail(row({ ...WITH_ADDRESSES, films: [{ title: 'Dune', imdbUrl: SHEET }] }), [track('Yom', 'Garden of Eden')]);
    const text = JSON.stringify(detail);
    expect(text.match(/https?:\/\/[^"\s]*/gi)).toEqual([SHEET]);
    expect(text).not.toContain(ADDRESS);
    const keys = keysDeep(detail);
    for (const forbidden of ['sourceUrl', 'mediaUrl', 'imdbUrl', 'url', 'posterUrl', 'streamingUrls']) expect(keys).not.toContain(forbidden);
    expect(keys.filter((k) => k === 'openUrl')).toHaveLength(1);
  });
});
