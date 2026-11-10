import { describe, expect, it, vi } from 'vitest';
import {
  NAMEABLE_SEEDS,
  NAMING_MAX_TOKENS,
  NAMING_SCHEMA,
  SEED_COLLECTIONS,
  SEED_GROUPS,
  VIRTUAL_TYPE_GROUP,
  buildNamingPrompt,
  canonicalName,
  chooseName,
  mayBeNamed,
  nameGroup,
  parseNaming,
  seedGroupOf,
  type NamingDeps,
  type NamingGroup,
  type NamingMember,
} from './collectionsNaming';

// ADR-0022 / spec 2026-11-09-library-collections-auto-topics-design.md §3 (what the trial taught about names), §4.5 (the seed list), §5.5 (the
// name, in order), §9 (the tests). The local model proposes, the code cleans and checks: a name from the list is accepted; a new name only if
// 1–3 words, letters only, one of its words in ≥ 30 % of the members and not «Post»/«Contenuti»/«Varie»; else the tag shared by ≥ 50 % of the
// members; else no name (the group is not published and is retried the night after). The failures of the real trial are the tests: `#Vini
// italiani`, `Intelligenza_artificiale`, `Modafair`, `Tinitus`, a broken JSON as a name, a wrong parent, «Colazioni e caffè» for restaurants.
// The texts below are invented sentences, never a real post.

const member = (text: string, tags: string[] = []): NamingMember => ({ text, tags });

/** Texts that say nothing in particular (and none of the words the tests look for). */
const FILLER = [
  'Un consiglio rapido per la giornata, senza altro da dire.',
  'Guarda cosa succede alla fine del video.',
  'Salva questo contenuto per dopo e condividilo.',
  'Ecco come si fa, passo dopo passo, in pochi secondi.',
  'Una sorpresa che nessuno si aspettava, davvero.',
];

/** `total` members: the first `withWord` say `sentence`, the others are filler. */
function crowd(total: number, withWord: number, sentence: string, tags: string[] = []): NamingMember[] {
  return Array.from({ length: total }, (_, i) => (i < withWord ? member(sentence, tags) : member(FILLER[i % FILLER.length])));
}

/** `total` members with `tag` on the first `tagged` of them, all with filler text. */
function tagged(total: number, tagged: number, tag: string, other: string[] = []): NamingMember[] {
  return Array.from({ length: total }, (_, i) => member(FILLER[i % FILLER.length], i < tagged ? [tag, ...other] : other));
}

// ---------------------------------------------------------------------------
// the seed list (spec §4.5): in ONE place
// ---------------------------------------------------------------------------

describe('the seed list', () => {
  it('is the table of the spec §4.5, headings and names, in order', () => {
    expect(SEED_COLLECTIONS.map((s) => `${s.group}: ${s.name}`)).toEqual([
      'Tipi (virtuali): Musica',
      'Tipi (virtuali): Film e serie',
      'Tipi (virtuali): Software e app',
      'Tipi (virtuali): Luoghi',
      'Tipi (virtuali): Libri',
      'Cibo e bevande: Vino',
      'Cibo e bevande: Ristoranti',
      'Cibo e bevande: Ricette',
      'Casa: Casa e design',
      'Casa: Fai da te',
      'Casa: Energia e domotica',
      'Fuori casa: Viaggi',
      'Fuori casa: Montagna e outdoor',
      'Fuori casa: Animali e natura',
      'Persone e salute: Salute',
      'Persone e salute: Sport e fitness',
      'Persone e salute: Mente e spiritualità',
      'Persone e salute: Famiglia e genitori',
      'Tecnologia: Intelligenza artificiale',
      'Tecnologia: Sicurezza informatica',
      'Tecnologia: Auto e moto',
      'Soldi e lavoro: Finanza e investimenti',
      'Soldi e lavoro: Lavoro e carriera',
      'Cultura e svago: Anime',
      'Cultura e svago: Giochi',
      'Cultura e svago: Arte e cultura',
      'Cultura e svago: Scienza',
      'Cultura e svago: Umorismo',
      'Cultura e svago: Moda e stile',
      'Cultura e svago: Foto e video',
      'Cultura e svago: Sfondi',
    ]);
  });

  it('the five virtual types are in the table but are not used for naming: they are not nameable and their heading is not a heading of the page', () => {
    expect(VIRTUAL_TYPE_GROUP).toBe('Tipi (virtuali)');
    const types = SEED_COLLECTIONS.filter((s) => s.group === VIRTUAL_TYPE_GROUP).map((s) => s.name);
    expect(types).toEqual(['Musica', 'Film e serie', 'Software e app', 'Luoghi', 'Libri']);
    expect(NAMEABLE_SEEDS.map((s) => s.name)).not.toEqual(expect.arrayContaining(['Musica']));
    expect(NAMEABLE_SEEDS).toHaveLength(SEED_COLLECTIONS.length - 5);
    expect(SEED_GROUPS).toEqual(['Cibo e bevande', 'Casa', 'Fuori casa', 'Persone e salute', 'Tecnologia', 'Soldi e lavoro', 'Cultura e svago']);
  });

  it('every name is unique, has one to three words and only letters: the rules a new name has to follow are the ones the list follows', () => {
    const names = SEED_COLLECTIONS.map((s) => s.name);
    expect(new Set(names.map((n) => n.toLowerCase())).size).toBe(names.length);
    for (const name of names) {
      const words = name.split(' ');
      expect(words.length).toBeGreaterThanOrEqual(1);
      expect(words.length).toBeLessThanOrEqual(3);
      expect(words.every((w) => /^\p{L}+$/u.test(w))).toBe(true);
    }
  });

  it('says the heading of a name of the list, and nothing for any other name or for a type', () => {
    expect(seedGroupOf('Vino')).toBe('Cibo e bevande');
    expect(seedGroupOf('Moda e stile')).toBe('Cultura e svago');
    expect(seedGroupOf('Intelligenza artificiale')).toBe('Tecnologia');
    expect(seedGroupOf('Fotovoltaico')).toBeNull();
    expect(seedGroupOf('Musica')).toBeNull();
    expect(seedGroupOf('vino')).toBeNull();                 // exact: the name as the list writes it
  });
});

// ---------------------------------------------------------------------------
// canonicalName: what the model writes → the name of the list (or a clean name)
// ---------------------------------------------------------------------------

describe('canonicalName', () => {
  it('anything that is not text is no name', () => {
    for (const raw of [undefined, null, 42, true, {}, [], ['Vino']]) expect(canonicalName(raw)).toBeNull();
  });

  it('nothing but symbols or spaces is no name', () => {
    for (const raw of ['', '   ', '#@"*', '***', '"" ""', '#', '@@']) expect(canonicalName(raw)).toBeNull();
  });

  it.each([
    ['#Vino', 'Vino'],
    ['@Vino', 'Vino'],
    ['"Vino"', 'Vino'],
    ['*Vino*', 'Vino'],
    ['«Vino»', 'Vino'],
    ['  vino  ', 'Vino'],
    ['VINO', 'Vino'],
    ['🍷 Vino', 'Vino'],
    ['#@"*Vino*"@#', 'Vino'],
  ])('strips the symbols of the trial and finds the name of the list: %s → %s', (raw, expected) => {
    expect(canonicalName(raw)).toBe(expected);
  });

  it.each([
    ['Intelligenza_artificiale', 'Intelligenza artificiale'],
    ['IntelligenzaArtificiale', 'Intelligenza artificiale'],
    ['#intelligenzaartificiale', 'Intelligenza artificiale'],
    ['intelligenza-artificiale', 'Intelligenza artificiale'],
    ['INTELLIGENZA ARTIFICIALE', 'Intelligenza artificiale'],
    ['intelligenza   Artificiale', 'Intelligenza artificiale'],
    ['Fai_da_te', 'Fai da te'],
    ['Mente e spiritualita', 'Mente e spiritualità'],
    ['MENTE E SPIRITUALITÀ', 'Mente e spiritualità'],
    ['sport e fitness', 'Sport e fitness'],
    ['Finanza e Investimenti', 'Finanza e investimenti'],
  ])('writes the name of the list exactly, whatever the case, the accents, the underscores: %s → %s', (raw, expected) => {
    expect(canonicalName(raw)).toBe(expected);
  });

  // the WHOLE table of the near names, written out here on purpose: a name that goes missing from the code must fail a test
  it.each([
    ['#Vini italiani', 'Vino'],                // the free name of the trial for the wine group
    ['Vini', 'Vino'],
    ['Vitigni', 'Vino'],
    ['Ristorante', 'Ristoranti'],
    ['Ricetta', 'Ricette'],
    ['Casa', 'Casa e design'],
    ['Domotica', 'Energia e domotica'],
    ['Viaggio', 'Viaggi'],
    ['Montagna', 'Montagna e outdoor'],
    ['Outdoor', 'Montagna e outdoor'],
    ['Animali', 'Animali e natura'],
    ['Natura', 'Animali e natura'],
    ['Sport', 'Sport e fitness'],
    ['Fitness', 'Sport e fitness'],
    ['Spiritualità', 'Mente e spiritualità'],
    ['Mindfulness', 'Mente e spiritualità'],
    ['Famiglia', 'Famiglia e genitori'],
    ['Genitori', 'Famiglia e genitori'],
    ['#ai', 'Intelligenza artificiale'],       // the most frequent tag of the library
    ['AI', 'Intelligenza artificiale'],
    ['IA', 'Intelligenza artificiale'],
    ['Artificial intelligence', 'Intelligenza artificiale'],
    ['Cybersecurity', 'Sicurezza informatica'],
    ['Cyber security', 'Sicurezza informatica'],
    ['Auto', 'Auto e moto'],
    ['Moto', 'Auto e moto'],
    ['Finanza', 'Finanza e investimenti'],
    ['Investimenti', 'Finanza e investimenti'],
    ['Lavoro', 'Lavoro e carriera'],
    ['Carriera', 'Lavoro e carriera'],
    ['Gioco', 'Giochi'],
    ['Videogiochi', 'Giochi'],
    ['Arte', 'Arte e cultura'],
    ['Cultura', 'Arte e cultura'],
    ['Scienze', 'Scienza'],
    ['Humor', 'Umorismo'],
    ['Moda', 'Moda e stile'],
    ['Foto', 'Foto e video'],
    ['Fotografia', 'Foto e video'],
    ['Sfondo', 'Sfondi'],
    ['Wallpaper', 'Sfondi'],
    ['Wallpapers', 'Sfondi'],
  ])('the few near names that are the same thing land on the name of the list: %s → %s', (raw, expected) => {
    expect(canonicalName(raw)).toBe(expected);
  });

  it('a name that is not in the list comes out clean, with a capital, and otherwise as it is', () => {
    expect(canonicalName('#Modafair')).toBe('Modafair');
    expect(canonicalName('fotovoltaico')).toBe('Fotovoltaico');
    expect(canonicalName('  Cucina   del   mondo ')).toBe('Cucina del mondo');
    expect(canonicalName('Cucina d\'autore')).toBe("Cucina d'autore");
  });

  it('every symbol of the trial is stripped from a name that is NOT in the list too (for the names of the list the lookup hides the symbols; here they would show)', () => {
    for (const raw of ['#Modafair', '@Modafair', '"Modafair"', '“Modafair”', '*Modafair*', '«Modafair»', '`Modafair`', '<Modafair>', '🍷 Modafair', 'Modafair 🍷', '_Modafair_', '#@"*Modafair*"@#']) {
      expect(canonicalName(raw)).toBe('Modafair');
    }
    expect(canonicalName('Cucina_del_mondo')).toBe('Cucina del mondo');
  });

  it('quotes and punctuation at the edges are not part of the name, an apostrophe inside a word is', () => {
    for (const raw of ["'Modafair'", '’Modafair’', 'Modafair.', 'Modafair!', 'Modafair?', '- Modafair -', 'Modafair:', '...Modafair,', '; Modafair ;', '/Modafair/']) {
      expect(canonicalName(raw)).toBe('Modafair');
    }
    expect(canonicalName("L'orto d'autore")).toBe("L'orto d'autore");
  });

  it('a name needs a letter: digits alone are no name', () => {
    for (const raw of ['2026', '#123', '1 2 3', '3.14']) expect(canonicalName(raw)).toBeNull();
    expect(canonicalName('Top 10')).toBe('Top 10');                   // (the form rules of a NEW name refuse digits later; cleaning only asks for a letter)
  });

  it('shouting is not a name: capitals of several words become a sentence, one word in capitals (an acronym) stays', () => {
    expect(canonicalName('FOTOVOLTAICO E ACCUMULO')).toBe('Fotovoltaico e accumulo');
    expect(canonicalName('NASA')).toBe('NASA');
  });

  it('capitals inside a name are the name\'s own: only capitals ALL THROUGH are shouting', () => {
    expect(canonicalName('Harry Potter')).toBe('Harry Potter');
    expect(canonicalName('iPhone e iPad')).toBe('IPhone e iPad');
  });

  it('capitals made only of short words are acronyms, not shouting', () => {
    expect(canonicalName('DJ SET')).toBe('DJ SET');
    expect(canonicalName('AI VR')).toBe('AI VR');
    expect(canonicalName('DJ SET ITALIANO')).toBe('Dj set italiano');        // one longer word is enough to be shouting
  });

  it('the names of the five virtual types are not turned into anything: they stay what they are (and chooseName refuses them)', () => {
    for (const type of ['Musica', 'Film e serie', 'Software e app', 'Luoghi', 'Libri']) expect(canonicalName(type)).toBe(type);
    expect(canonicalName('#musica')).toBe('Musica');
  });

  it('a piece of JSON, in whatever state, is not a name', () => {
    expect(canonicalName('{"label": "Vini')).toBeNull();
    expect(canonicalName('["Vino"]')).toBeNull();
    expect(canonicalName('{label: Vino}')).toBeNull();
    expect(canonicalName('Vino}')).toBeNull();
  });

  it('a line of text, not a name, is no name: nothing longer than 60 characters', () => {
    expect(canonicalName('a'.repeat(61))).toBeNull();
    expect(canonicalName('Vino '.repeat(13).trim())).toBeNull();
    expect(canonicalName('a'.repeat(60))).toBe(`A${'a'.repeat(59)}`);
  });

  it('is not fooled by a name that only contains a name of the list', () => {
    expect(canonicalName('Vini e liquori del mondo')).toBe('Vini e liquori del mondo');
    expect(canonicalName('Casa di carta')).toBe('Casa di carta');
  });
});

// ---------------------------------------------------------------------------
// chooseName: a name of the list, a new name with evidence, the dominant tag, or nothing
// ---------------------------------------------------------------------------

describe('chooseName: the name of the list is accepted', () => {
  it('without looking at the posts', () => {
    expect(chooseName('Vino', [])).toEqual({ name: 'Vino', fromSeed: true });
    expect(chooseName('Vino', crowd(10, 0, 'x'))).toEqual({ name: 'Vino', fromSeed: true });
  });

  it('written dirty or in another way: the name of the list, marked as such', () => {
    expect(chooseName('#Vini italiani', crowd(10, 10, 'Vini italiani e vitigni'))).toEqual({ name: 'Vino', fromSeed: true });
    expect(chooseName('Intelligenza_artificiale', [])).toEqual({ name: 'Intelligenza artificiale', fromSeed: true });
  });
});

describe('chooseName: a new name needs evidence', () => {
  it('is accepted when one of its words is in at least 30 % of the members (3 of 10), not when it is in 2 of 10', () => {
    expect(chooseName('Fotovoltaico', crowd(10, 3, 'Impianto fotovoltaico da 6 kW con accumulo'))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
    expect(chooseName('Fotovoltaico', crowd(10, 2, 'Impianto fotovoltaico da 6 kW con accumulo'))).toBeNull();
  });

  it('the share is counted over the members, whatever their number (1 of 3 is enough, 1 of 4 is not)', () => {
    expect(chooseName('Fotovoltaico', crowd(3, 1, 'Impianto fotovoltaico da 6 kW'))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
    expect(chooseName('Fotovoltaico', crowd(4, 1, 'Impianto fotovoltaico da 6 kW'))).toBeNull();
  });

  it('any word of the name will do, and the small words do not count', () => {
    const posts = crowd(10, 3, 'Piatti di cucina da provare nel weekend');
    expect(chooseName('Cucina del mondo', posts)).toEqual({ name: 'Cucina del mondo', fromSeed: false });
    expect(chooseName('Del e da', posts)).toBeNull();                   // nothing but little words: nothing to check
    expect(chooseName('Per', crowd(10, 10, 'per tutti per sempre'))).toBeNull();
  });

  // the little words, written out in full on purpose: one that goes missing from the code must fail a test
  it.each([
    'a', 'ad', 'al', 'alla', 'alle', 'allo', 'agli', 'con', 'da', 'dal', 'dalla', 'dalle', 'dei', 'del', 'della', 'delle', 'degli', 'dello', 'di',
    'e', 'ed', 'il', 'in', 'la', 'le', 'lo', 'i', 'gli', 'nel', 'nella', 'nelle', 'negli', 'nei', 'per', 'su', 'sul', 'sulla', 'tra', 'fra', 'un',
    'una', 'uno', 'o', 'ma', 'che', 'd', 'l', 'dell', 'all', 'dall', 'nell', 'sull', 'the', 'of', 'and', 'for', 'to',
  ])('«%s» is a little word: a name made of it alone has nothing to check, even when every member says it', (word) => {
    expect(chooseName(word, crowd(10, 10, word))).toBeNull();
    expect(chooseName(word, crowd(10, 10, `una ${word} cosa`))).toBeNull();
  });

  it('the tags of the members count as their text', () => {
    expect(chooseName('Fotovoltaico', crowd(10, 0, 'x').map((m, i) => (i < 4 ? member(m.text, ['fotovoltaico']) : m)))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
  });

  it('singular and plural are the same word, a word inside another word is not evidence', () => {
    expect(chooseName('Fotovoltaico', crowd(10, 4, 'I nuovi impianti fotovoltaici costano meno'))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
    expect(chooseName('Orto', crowd(10, 4, 'Si apre il portone e si entra'))).toBeNull();
    expect(chooseName('Orto', crowd(10, 4, 'Gli orti sul balcone si fanno così'))).toEqual({ name: 'Orto', fromSeed: false });
  });

  it('a short word is not cut down to its root: «Ski» is not «ska» (both would be «sk»), and «Ski» still finds itself', () => {
    expect(chooseName('Ski', crowd(10, 5, 'Una serata di ska e punk'))).toBeNull();
    expect(chooseName('Ski', crowd(10, 5, 'Una settimana di ski sulle Alpi'))).toEqual({ name: 'Ski', fromSeed: false });
  });

  it('a misspelt name (the trial gave «Tinitus» and «Alzhaimer») is not evidence-backed: the posts spell it right', () => {
    expect(chooseName('Tinitus', crowd(10, 6, 'Che cos\'è il tinnitus e come si cura'))).toBeNull();
    expect(chooseName('Tinnitus', crowd(10, 6, 'Che cos\'è il tinnitus e come si cura'))).toEqual({ name: 'Tinnitus', fromSeed: false });
  });

  it('an invented name (the trial gave «Modafair») is no name when no member says it', () => {
    expect(chooseName('Modafair', crowd(10, 7, 'Un armadio sostenibile con pochi capi di qualità'))).toBeNull();
  });

  it('has a capital first letter, and shouting is a sentence', () => {
    expect(chooseName('fotovoltaico', crowd(10, 5, 'Impianto fotovoltaico da 6 kW'))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
    expect(chooseName('FOTOVOLTAICO E ACCUMULO', crowd(10, 5, 'Impianto fotovoltaico da 6 kW'))).toEqual({ name: 'Fotovoltaico e accumulo', fromSeed: false });
  });

  it('is not asked for evidence when there are no members at all: nothing', () => {
    expect(chooseName('Fotovoltaico', [])).toBeNull();
  });
});

describe('chooseName: the form of a new name', () => {
  const posts = crowd(10, 10, 'Cucina italiana del nord, cucina di casa, cucina veloce e cucina di mare');

  it('one, two or three words are fine; four are too many (even with evidence)', () => {
    expect(chooseName('Cucina', posts)?.name).toBe('Cucina');
    expect(chooseName('Cucina italiana', posts)?.name).toBe('Cucina italiana');
    expect(chooseName('Cucina italiana veloce', posts)?.name).toBe('Cucina italiana veloce');
    expect(chooseName('Cucina italiana del nord', posts)).toBeNull();
  });

  it('letters only: no digits, no symbols', () => {
    for (const bad of ['Cucina2026', 'Cucina 2026', 'Cucina & pasta', 'Cucina+', 'Cucina/Pasta', 'Cucina: pasta', 'Cucina (pasta)']) {
      expect(chooseName(bad, posts)).toBeNull();
    }
  });

  it('an apostrophe or a hyphen between letters is a letter of the word', () => {
    expect(chooseName("Cucina d'autore", posts)?.name).toBe("Cucina d'autore");
    expect(chooseName('Cucina anti-spreco', posts)?.name).toBe('Cucina anti-spreco');
  });

  it.each(['Post', 'Posts', 'Contenuti', 'Contenuto', 'Varie', 'Vari', 'VARIE', 'altro', 'Altri', 'Altre', 'Generale', 'Generali', 'Raccolta', 'Raccolte', 'Misto', 'Miscellanea'])('«%s» says nothing, so it is not a name (even when every member says it)', (word) => {
    const same = crowd(10, 10, `post posts ${word.toLowerCase()} contenuti contenuto varie vari altro altri altre generale generali raccolta raccolte misto miscellanea`);
    expect(chooseName(word, same)).toBeNull();
  });

  it('only a name made of such words alone says nothing: next to a real word they are fine («Contenuti di cucina»)', () => {
    expect(chooseName('Contenuti di cucina', posts)?.name).toBe('Contenuti di cucina');
    expect(chooseName('Post e Varie', posts)).toBeNull();
  });

  it('the names of the five virtual types are taken: a group is not called «Musica» (there is a collection of that name already)', () => {
    for (const type of ['Musica', 'Film e serie', 'Software e app', 'Luoghi', 'Libri']) {
      expect(chooseName(type, crowd(10, 10, 'musica film serie software app luoghi libri'))).toBeNull();
    }
  });
});

describe('chooseName: when the name is not good, the tag that most posts share', () => {
  it('is the tag shared by at least 50 % of the members (5 of 10), not by 4 of 10', () => {
    expect(chooseName(null, tagged(10, 5, '#fotovoltaico'))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
    expect(chooseName(null, tagged(10, 4, '#fotovoltaico'))).toBeNull();
  });

  it('comes after an invented name: «Modafair», then the dominant tag #vino → «Vino»', () => {
    const posts = tagged(10, 8, '#vino');
    expect(chooseName('Modafair', posts)).toEqual({ name: 'Vino', fromSeed: true });
  });

  it('comes after a name with the wrong spelling and after a broken answer (no name at all)', () => {
    const posts = tagged(10, 6, '#vino');
    expect(chooseName('Tinitus', posts)).toEqual({ name: 'Vino', fromSeed: true });
    expect(chooseName(null, posts)).toEqual({ name: 'Vino', fromSeed: true });
  });

  it('the restaurants of the trial, called «Colazioni e caffè» with no place: no member says it, so the dominant tag gives the name of the list', () => {
    const posts = Array.from({ length: 7 }, (_, i) => member(`I ristoranti nuovi da provare, locale numero ${i}`, ['#ristoranti', '#milano']));
    expect(chooseName('Colazioni e caffè', posts)).toEqual({ name: 'Ristoranti', fromSeed: true });
  });

  it('a name with evidence wins over the tag', () => {
    const posts = Array.from({ length: 10 }, () => member('Impianto fotovoltaico da 6 kW', ['#vino']));
    expect(chooseName('Fotovoltaico', posts)).toEqual({ name: 'Fotovoltaico', fromSeed: false });
  });

  it('counts a tag once for each member, whatever its case, its hash, or how many times it is written', () => {
    const posts = [
      member('uno', ['#Vino', 'vino', '#VINO']),
      member('due', ['#vino']),
      member('tre', ['vini']),
      member('quattro', []),
      member('cinque', []),
      member('sei', []),
    ];
    expect(chooseName(null, posts)).toEqual({ name: 'Vino', fromSeed: true });                // 3 of 6 = 50 %
    expect(chooseName(null, posts.slice(0, 6).concat([member('sette', [])]).concat([member('otto', [])]))).toBeNull();   // 3 of 8 = 37 %
  });

  it('the placeholders of the model, the mentions and the tags of the platforms are never a name', () => {
    for (const tag of ['#tag', '@utente', '#utente', '#hashtag', '#fyp', '#viral', '#virale', '#perte', '#foryou', '#foryoupage', '#reels', '#reel', '#instagram', '#explore', '#trending', '#x', '#shorts', '#follow', '#like', '@qualcuno', '#tiktok', '#youtube', '#Reels', '#FYP']) {
      expect(chooseName(null, tagged(10, 10, tag))).toBeNull();
    }
  });

  it('with two tags over 50 % the one that most members have wins (even when the other comes first in the alphabet); the same share goes to the first in alphabetical order', () => {
    const posts = Array.from({ length: 10 }, (_, i) => member('x', i < 8 ? ['#zanzara', ...(i < 6 ? ['#acqua'] : [])] : []));
    expect(chooseName(null, posts)).toEqual({ name: 'Zanzara', fromSeed: false });            // 8 of 10 beats 6 of 10
    const level = Array.from({ length: 10 }, () => member('x', ['#zanzara', '#acqua']));
    expect(chooseName(null, level)).toEqual({ name: 'Acqua', fromSeed: false });              // 10 and 10: alphabetical
  });

  it('a name of the list wins over a tag that more members have', () => {
    const posts = Array.from({ length: 10 }, (_, i) => member('x', ['#zanzara', ...(i < 6 ? ['#vino'] : [])]));
    expect(chooseName(null, posts)).toEqual({ name: 'Vino', fromSeed: true });
  });

  it('a tag that is not a good name (digits, too many words, a type, a forbidden word) is skipped for the next one', () => {
    const posts = Array.from({ length: 10 }, () => member('x', ['#ai2026', '#musica', '#post', '#fotovoltaico']));
    expect(chooseName(null, posts)).toEqual({ name: 'Fotovoltaico', fromSeed: false });
  });

  it('a tag that is no name at all (a piece of JSON) is not counted as the name it looks like', () => {
    const posts = Array.from({ length: 10 }, (_, i) => member('x', i < 4 ? ['#vino'] : i < 8 ? ['{vino}'] : []));
    expect(chooseName(null, posts)).toBeNull();                          // 4 of 10 say «vino»; the 4 broken ones are not «vino»
  });

  it('a tag the list knows under another form gives the name of the list (#ai → «Intelligenza artificiale»), and #vini and #vino count together', () => {
    expect(chooseName(null, tagged(10, 8, '#ai'))).toEqual({ name: 'Intelligenza artificiale', fromSeed: true });
    const mixed = Array.from({ length: 10 }, (_, i) => member('x', [i % 2 ? '#vino' : '#vini']));
    expect(chooseName(null, mixed)).toEqual({ name: 'Vino', fromSeed: true });
  });

  it('no tag at all, or no members: no name', () => {
    expect(chooseName(null, crowd(10, 0, 'x'))).toBeNull();
    expect(chooseName(null, [])).toBeNull();
    expect(chooseName('Modafair', [])).toBeNull();
  });
});

describe('chooseName: members that are not what they should be (they come out of stored JSON)', () => {
  it('never throws: what is not a list is no members', () => {
    for (const members of [undefined, null, 'x', 42, {}]) {
      expect(chooseName('Fotovoltaico', members as unknown as NamingMember[])).toBeNull();
      expect(chooseName(null, members as unknown as NamingMember[])).toBeNull();
    }
  });

  it('a member that is not an object counts as a member with nothing to say, and the tags that are not text are skipped', () => {
    const odd = [
      null,
      undefined,
      42,
      { text: 7, tags: 'vino' },
      { text: 'x', tags: ['#vino', 42, null, {}, ['#vino']] },
      { text: 'x', tags: ['#vino'] },
      { text: 'x', tags: ['#vino'] },
      { text: 'x', tags: ['#vino'] },
    ] as unknown as NamingMember[];
    expect(chooseName(null, odd)).toEqual({ name: 'Vino', fromSeed: true });                // 4 of 8
    expect(chooseName('Fotovoltaico', odd)).toEqual({ name: 'Vino', fromSeed: true });    // nobody says it: the tag
  });

  it('a member with no text says nothing at all (not even the word «undefined»)', () => {
    const empty = Array.from({ length: 10 }, () => ({ tags: [] }) as unknown as NamingMember);
    expect(chooseName('Undefined', empty)).toBeNull();
    expect(chooseName('Fotovoltaico', Array.from({ length: 10 }, () => ({ tags: ['fotovoltaico'] }) as unknown as NamingMember))).toEqual({ name: 'Fotovoltaico', fromSeed: false });
  });
});

// ---------------------------------------------------------------------------
// parseNaming
// ---------------------------------------------------------------------------

describe('parseNaming', () => {
  it('reads the label (cleaned and found in the list) and the heading', () => {
    expect(parseNaming('{"label":"#Vino","parent":"Cibo e bevande"}')).toEqual({ label: 'Vino', parent: 'Cibo e bevande' });
    expect(parseNaming('{"label":"Intelligenza_artificiale","parent":"Tecnologia"}')).toEqual({ label: 'Intelligenza artificiale', parent: 'Tecnologia' });
    expect(parseNaming('{"label":"Fotovoltaico","parent":null}')).toEqual({ label: 'Fotovoltaico', parent: null });
  });

  it('the heading is the exact one of the table, or nothing: «Tipi (virtuali)» and anything invented are not headings', () => {
    expect(parseNaming('{"label":"Vino","parent":"cibo e bevande"}').parent).toBe('Cibo e bevande');
    expect(parseNaming('{"label":"Vino","parent":"CULTURA E SVAGO"}').parent).toBe('Cultura e svago');
    expect(parseNaming('{"label":"Vino","parent":"Tipi (virtuali)"}').parent).toBeNull();
    expect(parseNaming('{"label":"Vino","parent":"Mente"}').parent).toBeNull();
    expect(parseNaming('{"label":"Vino","parent":42}').parent).toBeNull();
    expect(parseNaming('{"label":"Vino"}').parent).toBeNull();
  });

  it('a broken or empty answer is no label and no heading', () => {
    for (const raw of ['{"label": "Vini', '', '   ', 'null', '[]', '"Vino"', '42', 'non è JSON', '{"label":']) {
      expect(parseNaming(raw)).toEqual({ label: null, parent: null });
    }
  });

  it('never throws on something that is not even text', () => {
    for (const raw of [undefined, null, 42, true, {}, ['x'], { label: 'Vino' }]) {
      expect(parseNaming(raw as unknown as string)).toEqual({ label: null, parent: null });
    }
  });

  it('a label that is not text, or is a piece of JSON, or says nothing, is no label (and the heading is still read)', () => {
    expect(parseNaming('{"label":42,"parent":"Casa"}')).toEqual({ label: null, parent: 'Casa' });
    expect(parseNaming('{"label":null,"parent":null}')).toEqual({ label: null, parent: null });
    expect(parseNaming('{"label":"{\\"nome\\": \\"Vini","parent":null}')).toEqual({ label: null, parent: null });
    expect(parseNaming('{"label":"#@\\"*","parent":null}')).toEqual({ label: null, parent: null });
  });

  it('an answer wrapped in a code fence is still read', () => {
    expect(parseNaming('```json\n{"label":"Vino","parent":"Cibo e bevande"}\n```')).toEqual({ label: 'Vino', parent: 'Cibo e bevande' });
  });

  it('other fields are ignored', () => {
    expect(parseNaming('{"label":"Vino","parent":"Cibo e bevande","why":"perché sì","score":0.9}')).toEqual({ label: 'Vino', parent: 'Cibo e bevande' });
  });
});

// ---------------------------------------------------------------------------
// the prompt and the schema
// ---------------------------------------------------------------------------

describe('buildNamingPrompt', () => {
  const sample = ['Come scegliere un vino rosso per l\'inverno', 'I vitigni italiani più amati', 'Il prezzo giusto per una bottiglia'];

  it('is in Italian and gives the list: every name that can be used, under its heading, and not the five types', () => {
    const prompt = buildNamingPrompt(sample, ['vino', 'cantina'], []);
    expect(prompt).toContain('Regole');
    const from = prompt.indexOf('ELENCO');
    const to = prompt.indexOf('POST\n');
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const list = prompt.slice(from, to);
    for (const seed of NAMEABLE_SEEDS) expect(list).toContain(seed.name);
    for (const group of SEED_GROUPS) expect(list).toContain(`- ${group}: `);
    expect(list).toContain('- Cibo e bevande: Vino; Ristoranti; Ricette\n');
    for (const type of ['Musica', 'Film e serie', 'Software e app', 'Luoghi', 'Libri']) expect(list).not.toContain(type);
    expect(list).not.toContain('Tipi (virtuali)');
    expect(prompt).toMatch(/non usare[^\n]*Musica[^\n]*Libri/i);            // the types are named, as a thing NOT to use
  });

  it('asks for one name of the list or a short new one (1–3 words, letters only, a word that is in the posts) and for the heading', () => {
    const prompt = buildNamingPrompt(sample, [], []);
    expect(prompt).toMatch(/identico/i);
    expect(prompt).toMatch(/da 1 a 3 parole/i);
    expect(prompt).toMatch(/solo lettere/i);
    expect(prompt).toMatch(/compari/i);
    expect(prompt).toMatch(/"label"[^\n]*elenco/i);
    expect(prompt).toMatch(/"parent"[^\n]*intestazione/i);
    expect(prompt).toMatch(/mai[^\n]*"Post"[^\n]*"Contenuti"[^\n]*"Varie"/i);          // the names that say nothing are named, as a thing NOT to write
  });

  it('shows the posts, numbered, at most 8, each cut at 170 characters', () => {
    const many = Array.from({ length: 12 }, (_, i) => `Post numero ${i + 1} ${'x'.repeat(300)}`);
    const prompt = buildNamingPrompt(many, [], []);
    expect(prompt).toContain('1. Post numero 1 ');
    expect(prompt).toContain('8. Post numero 8 ');
    expect(prompt).not.toContain('9. Post numero 9');
    const line = prompt.split('\n').find((l) => l.startsWith('1. ')) as string;
    expect(line.length).toBe('1. '.length + 170 + 1);                  // 170 characters and the ellipsis
    expect(line.endsWith('…')).toBe(true);
  });

  it('a post of exactly 170 characters is not cut, one of 171 is', () => {
    expect(buildNamingPrompt(['x'.repeat(170)], [], [])).toContain(`1. ${'x'.repeat(170)}\n`);
    expect(buildNamingPrompt(['x'.repeat(171)], [], [])).toContain(`1. ${'x'.repeat(170)}…\n`);
  });

  it('a short post is not cut, spaces and control characters are tidied, empty posts are left out', () => {
    const prompt = buildNamingPrompt(['  Un   vino\u0000 rosso\n\ncon   calma ', '', '   '], [], []);
    expect(prompt).toContain('1. Un vino rosso con calma\n');
    expect(prompt).not.toContain('2. ');
  });

  it('gives the tags of the group and the names already in use, or says there are none', () => {
    const withBoth = buildNamingPrompt(sample, ['vino', 'cantina'], ['Ristoranti', 'Viaggi']);
    expect(withBoth).toContain('vino, cantina');
    expect(withBoth).toContain('Ristoranti; Viaggi');
    const bare = buildNamingPrompt(sample, [], []);
    expect(bare).toContain('TAG PIÙ FREQUENTI: (nessuno)\n');
    expect(bare).toMatch(/NOMI GIÀ IN USO[^\n]*: \(nessuno\)\n/);
  });

  it('says «(nessuno)» for the posts too when there is none to show', () => {
    expect(buildNamingPrompt([], [], [])).toMatch(/POST\n\(nessuno\)\n/);
    expect(buildNamingPrompt(['', '  '], [], [])).toMatch(/POST\n\(nessuno\)\n/);
    expect(buildNamingPrompt(sample, [], [])).not.toMatch(/POST\n\(nessuno\)/);
  });

  it('the names already in use are cut at 60 characters, and the empty ones are left out', () => {
    const prompt = buildNamingPrompt(sample, [], ['  ', '', 'Viaggi', 'x'.repeat(100)]);
    const line = prompt.split('\n').find((l) => l.startsWith('NOMI GIÀ IN USO')) as string;
    expect(line.endsWith(`: Viaggi; ${'x'.repeat(60)}…`)).toBe(true);
    const none = buildNamingPrompt(sample, [], ['', '   ']);
    expect(none).toMatch(/NOMI GIÀ IN USO[^\n]*: \(nessuno\)\n/);
    const exact = buildNamingPrompt(sample, [], ['y'.repeat(60)]);
    expect(exact).toContain(`: ${'y'.repeat(60)}\n`);                    // exactly 60: not cut
  });

  it('is told that a name already in use is for another subject', () => {
    expect(buildNamingPrompt(sample, [], ['Viaggi'])).toMatch(/già in uso/i);
  });

  it('has an example with a name of the list and an example with a new name', () => {
    const prompt = buildNamingPrompt(sample, [], []);
    expect(prompt).toContain('Esempio 1');
    expect(prompt).toContain('Esempio 2');
  });
});

describe('the schema of the answer', () => {
  it('asks for a label and a heading, nothing else', () => {
    expect(NAMING_SCHEMA.required).toEqual(['label', 'parent']);
    expect(Object.keys(NAMING_SCHEMA.properties).sort()).toEqual(['label', 'parent']);
    expect(NAMING_SCHEMA.properties.label).toEqual({ type: 'string', maxLength: 60 });         // a label is short: the model cannot write a sentence
    expect(NAMING_SCHEMA.properties.parent).toEqual({ type: ['string', 'null'] });
    expect(NAMING_MAX_TOKENS).toBeGreaterThan(0);
    expect(NAMING_MAX_TOKENS).toBeLessThanOrEqual(300);          // two short fields: a looping model must not run to the general ceiling
  });
});

// ---------------------------------------------------------------------------
// nameGroup
// ---------------------------------------------------------------------------

type Generate = NamingDeps['generate'];
const answer = (text: string, truncated = false) => async () => ({ text, usageMetadata: null, truncated });

function group(members: NamingMember[], over: Partial<NamingGroup> = {}): NamingGroup {
  return { members, ...over };
}

const wine = Array.from({ length: 8 }, (_, i) => member(`Vino rosso numero ${i}: cantina e vitigni`, ['#vino', '#cantina']));

describe('nameGroup', () => {
  it('asks the local model once (JSON schema, a small ceiling of tokens) and returns the name of the list with ITS heading', async () => {
    const generate = vi.fn<Generate>(answer('{"label":"#Vino","parent":"Cibo e bevande"}'));
    const out = await nameGroup(group(wine), { generate });
    expect(out).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, opts] = generate.mock.calls[0];
    expect(prompt).toContain('Vino rosso numero 0');
    expect(opts).toMatchObject({ json: true, schema: NAMING_SCHEMA, maxTokens: NAMING_MAX_TOKENS });
  });

  it('the heading is the one of the table: a wrong parent of the model (sustainable fashion under «Cibo e bevande») decides nothing', async () => {
    const fashion = Array.from({ length: 6 }, (_, i) => member(`Un armadio sostenibile, capo ${i}`, ['#moda']));
    const out = await nameGroup(group(fashion), { generate: async () => ({ text: '{"label":"Moda e stile","parent":"Cibo e bevande"}', usageMetadata: null }) });
    expect(out).toEqual({ name: 'Moda e stile', group: 'Cultura e svago' });
  });

  it('a new name with evidence goes under «Altre» (no heading), whatever heading the model gave', async () => {
    const posts = crowd(10, 5, 'Impianto fotovoltaico da 6 kW con accumulo');
    const out = await nameGroup(group(posts), { generate: answer('{"label":"Fotovoltaico","parent":"Casa"}') });
    expect(out).toEqual({ name: 'Fotovoltaico', group: null });
  });

  it('an invented name, with no dominant tag, is no name: the group is not published (it stays watching and is tried again)', async () => {
    const posts = crowd(10, 7, 'Un armadio sostenibile con pochi capi');
    expect(await nameGroup(group(posts), { generate: answer('{"label":"Modafair","parent":"Cibo e bevande"}') })).toBeNull();
    expect(await nameGroup(group(posts), { generate: answer('{"label":"Tinitus","parent":null}') })).toBeNull();
  });

  it('an invented name with a dominant tag gives the tag: «Modafair» → #vino → «Vino», under its own heading', async () => {
    const out = await nameGroup(group(wine), { generate: answer('{"label":"Modafair","parent":"Cibo e bevande"}') });
    expect(out).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
  });

  it('a broken answer is no name, or the dominant tag when there is one', async () => {
    const posts = crowd(10, 7, 'Un armadio sostenibile con pochi capi');
    expect(await nameGroup(group(posts), { generate: answer('{"label": "Vini') })).toBeNull();
    expect(await nameGroup(group(wine), { generate: answer('{"label": "Vini') })).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
  });

  it('an answer cut short at the ceiling of tokens counts as no answer', async () => {
    const posts = crowd(10, 7, 'Un armadio sostenibile con pochi capi');
    expect(await nameGroup(group(posts), { generate: answer('{"label":"Vino","parent":"Cibo e bevande"}', true) })).toBeNull();
    expect(await nameGroup(group(wine), { generate: answer('{"label":"Ristoranti","parent":"Cibo e bevande"}', true) })).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
  });

  it('never throws: a model that is down, asleep or says something odd is no name (or the tag)', async () => {
    const posts = crowd(10, 7, 'Un armadio sostenibile con pochi capi');
    for (const boom of [new Error('connect ECONNREFUSED'), 'plain string', null, undefined, { code: 503 }]) {
      const generate: Generate = async () => { throw boom; };
      await expect(nameGroup(group(posts), { generate })).resolves.toBeNull();
      await expect(nameGroup(group(wine), { generate })).resolves.toEqual({ name: 'Vino', group: 'Cibo e bevande' });
    }
    const weird = (async () => ({ text: undefined, usageMetadata: null })) as unknown as Generate;
    await expect(nameGroup(group(posts), { generate: weird })).resolves.toBeNull();
    const nothing = (async () => undefined) as unknown as Generate;
    await expect(nameGroup(group(posts), { generate: nothing })).resolves.toBeNull();
  });

  it('never throws on a group that is not what it should be', async () => {
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await expect(nameGroup(undefined as unknown as NamingGroup, { generate })).resolves.toBeNull();
    await expect(nameGroup({} as NamingGroup, { generate })).resolves.toBeNull();
    await expect(nameGroup({ members: null } as unknown as NamingGroup, { generate })).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('never throws, even when reading the group itself throws', async () => {
    const hostile = { get members(): NamingMember[] { throw new Error('boom'); } } as unknown as NamingGroup;
    await expect(nameGroup(hostile, { generate: answer('{"label":"Vino","parent":null}') })).resolves.toBeNull();
  });

  it('odd members and odd names in use are read for what they are: the group is still named', async () => {
    const odd = [null, 42, { text: 7, tags: 'vino' }, ...wine] as unknown as NamingMember[];
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":"Cibo e bevande"}'));
    const out = await nameGroup(group(odd, { existing: ['Viaggi', 42, null, {}] as unknown as string[] }), { generate });
    expect(out).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
    const line = generate.mock.calls[0][0].split('\n').find((l) => l.startsWith('NOMI GIÀ IN USO')) as string;
    expect(line.endsWith(': Viaggi')).toBe(true);                       // the names that are not text are gone
  });

  it('a group with no member has nothing to be named after: no name, and the model is not asked', async () => {
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    expect(await nameGroup(group([]), { generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('a collection the user renamed is never named again: no name, and the model is not asked', async () => {
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":"Cibo e bevande"}'));
    expect(await nameGroup(group(wine, { nameBy: 'user' }), { generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
    expect(await nameGroup(group(wine, { nameBy: 'auto' }), { generate })).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
    expect(await nameGroup(group(wine, { nameBy: null }), { generate })).toEqual({ name: 'Vino', group: 'Cibo e bevande' });
  });

  it('shows the model 8 posts spread over the whole group (the first and the last are in), and the names already in use', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => member(`Testo del post ${String(i).padStart(2, '0')}`, ['#vino']));
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await nameGroup(group(twenty, { existing: ['Ristoranti', 'Viaggi'] }), { generate });
    const prompt = generate.mock.calls[0][0];
    expect(prompt).toContain('Testo del post 00');
    expect(prompt).toContain('Testo del post 19');
    expect(prompt.match(/Testo del post \d\d/g)).toHaveLength(8);
    expect(prompt).toContain('Ristoranti; Viaggi');
  });

  it('gives the model the most frequent tags of the group, the placeholders and the platforms left out', async () => {
    const posts = Array.from({ length: 6 }, () => member('Un vino rosso', ['#vino', '#tag', '@utente', '#fyp', '#instagram', '#cantina']));
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await nameGroup(group(posts), { generate });
    const line = generate.mock.calls[0][0].split('\n').find((l) => l.startsWith('TAG PIÙ FREQUENTI')) as string;
    expect(line).toContain('vino');
    expect(line).toContain('cantina');
    for (const noise of ['tag,', 'utente', 'fyp', 'instagram']) expect(line.replace('TAG PIÙ FREQUENTI:', '')).not.toContain(noise);
    expect(line).toBe('TAG PIÙ FREQUENTI: cantina, vino');             // no #, and the same count goes alphabetically
  });

  it('counts a tag once for each post, most frequent first, the same count alphabetically, and leaves out a tag with no letter in it', async () => {
    const posts = [
      member('uno', ['#cantina', '#cantina', 'Cantina']),         // three times on one post: once
      member('due', ['#vino']),
      member('tre', ['#vino']),
      member('quattro', ['#vino', '#', '🍷', '#2026']),           // nothing to show for «#», «🍷»; «2026» is a tag like any other
      member('cinque', ['#zeta', '#alfa']),
    ];
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await nameGroup(group(posts), { generate });
    const line = generate.mock.calls[0][0].split('\n').find((l) => l.startsWith('TAG PIÙ FREQUENTI')) as string;
    expect(line).toBe('TAG PIÙ FREQUENTI: vino, 2026, alfa, cantina, zeta');
  });

  it('shows at most 15 tags, the most frequent ones', async () => {
    const names = Array.from({ length: 20 }, (_, k) => `a${String(k).padStart(2, '0')}`);      // a00 … a19: the tag a_k is on k + 1 posts
    const posts = Array.from({ length: 20 }, (_, i) => member(`post ${i}`, names.filter((_n, k) => k >= i).map((n) => `#${n}`)));
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await nameGroup(group(posts), { generate });
    const line = generate.mock.calls[0][0].split('\n').find((l) => l.startsWith('TAG PIÙ FREQUENTI')) as string;
    expect(line).toBe(`TAG PIÙ FREQUENTI: ${names.slice(5).reverse().join(', ')}`);            // a19 … a05
  });

  it('asks the default local model: no model is named, and nothing leaves the house', async () => {
    const generate = vi.fn<Generate>(answer('{"label":"Vino","parent":null}'));
    await nameGroup(group(wine), { generate });
    expect(generate.mock.calls[0][1]).not.toHaveProperty('model');
  });
});

describe('mayBeNamed: the engine asks before it names', () => {
  it('a name the user wrote is never touched again; a collection with no name, or named by the engine, may be named', () => {
    expect(mayBeNamed('user')).toBe(false);
    expect(mayBeNamed('auto')).toBe(true);
    expect(mayBeNamed(null)).toBe(true);
    expect(mayBeNamed(undefined)).toBe(true);
  });
});
