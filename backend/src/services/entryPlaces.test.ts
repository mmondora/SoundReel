import { describe, expect, it, vi } from 'vitest';
import { PLACES } from '../data/places';
import {
  MAX_VENUES,
  PLACES_RULES_VERSION,
  PLACES_SCHEMA,
  VENUE_EVIDENCE_WINDOW,
  VENUE_KINDS,
  buildPlacesPrompt,
  canonicalPlace,
  explainPlacesAndVenues,
  findPlace,
  generatePlacesAndVenues,
  isGrounded,
  mapsUrl,
  parsePlacesAndVenues,
  placesSourceText,
  venueCuesIn,
  venueKey,
  venueKindOf,
  type PlacesGenerateFn,
} from './entryPlaces';

// Raccolte (ADR-0022, spec 2026-11-09-library-collections-auto-topics-design.md §4.3 and §4.6): the PLACE an entry talks about and the VENUES it names
// are read from its text by a dedicated call of the local model, and every word of the answer is CHECKED against the text: a place or a venue the
// text does not contain is dropped (Michele: «il luogo venga identificato dal testo»; nothing is invented). The server builds the Google Maps link.

const MILANO_POST =
  'ecco i ristoranti nuovi da provare su Milano: Trattoria dei Navigli, Osteria dell\'Orto & Co. e Caffè della Stazione. Voi quale scegliete? #milano #food';

describe('the gazetteer', () => {
  const folded = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

  it('has the 20 Italian regions, every regional capital, and the world: regions, cities and countries', () => {
    const regions = ['Piemonte', 'Lombardia', 'Veneto', 'Liguria', 'Toscana', 'Umbria', 'Marche', 'Lazio', 'Abruzzo', 'Molise', 'Campania', 'Puglia', 'Basilicata', 'Calabria', 'Sicilia', 'Sardegna', 'Trentino-Alto Adige', 'Friuli-Venezia Giulia', 'Emilia-Romagna', 'Valle d\'Aosta'];
    for (const r of regions) expect(PLACES.find((p) => p.name === r)?.kind, r).toBe('region');
    const capitals = ['Torino', 'Aosta', 'Milano', 'Trento', 'Venezia', 'Trieste', 'Genova', 'Bologna', 'Firenze', 'Perugia', 'Ancona', 'Roma', 'L\'Aquila', 'Campobasso', 'Napoli', 'Bari', 'Potenza', 'Catanzaro', 'Palermo', 'Cagliari'];
    for (const c of capitals) expect(PLACES.find((p) => p.name === c)?.kind, c).toBe('city');
    expect(PLACES.filter((p) => p.kind === 'country').length).toBeGreaterThanOrEqual(190);
    expect(PLACES.filter((p) => p.kind === 'city').length).toBeGreaterThanOrEqual(330);
    expect(PLACES.find((p) => p.name === 'Italia')?.kind).toBe('country');
    expect(PLACES.find((p) => p.name === 'Parigi')?.aliases).toContain('Paris');
  });

  it('has the provincial capitals and well-known towns the library is likely to name (a sample)', () => {
    for (const n of ['Bergamo', 'Brescia', 'Verona', 'Padova', 'Parma', 'Rimini', 'Livorno', 'Siena', 'Pisa', 'Lecce', 'Matera', 'Siracusa', 'Sassari', 'Sondrio', 'Como', 'Varese', 'Bolzano', 'Sanremo', 'Positano', 'San Gimignano', 'Alberobello', 'Taormina', 'Cortina d\'Ampezzo', 'Merano', 'Bellagio', 'Sirmione']) {
      expect(PLACES.some((p) => p.name === n), n).toBe(true);
    }
  });

  it('every name is unique, and no written form (a name or an alias, without case, accents and punctuation) belongs to two places', () => {
    expect(new Set(PLACES.map((p) => p.name)).size).toBe(PLACES.length);
    const owner = new Map<string, string>();
    for (const p of PLACES) {
      for (const form of [p.name, ...p.aliases]) {
        const key = folded(form);
        expect(key.length, `${p.name}: ${form}`).toBeGreaterThan(1);
        const other = owner.get(key);
        expect(other === undefined || other === p.name, `«${form}» is in ${other} and in ${p.name}`).toBe(true);
        owner.set(key, p.name);
      }
    }
  });

  it('no form without spaces («Sanremo», «San Remo») belongs to two places either (a glued hashtag must name one place)', () => {
    const owner = new Map<string, string>();
    for (const p of PLACES) {
      for (const form of [p.name, ...p.aliases]) {
        const compact = folded(form).replace(/ /g, '');
        const other = owner.get(compact);
        expect(other === undefined || other === p.name, `«${form}» is in ${other} and in ${p.name}`).toBe(true);
        owner.set(compact, p.name);
      }
    }
  });

  it('has no coordinates anywhere (the link to Maps starts from the name)', () => {
    for (const p of PLACES) expect(Object.keys(p).filter((k) => !['name', 'kind', 'aliases', 'ambiguous'].includes(k)), p.name).toEqual([]);
  });

  it('«Milano» knows «Milan» and «Roma» knows «Rome»', () => {
    expect(PLACES.find((p) => p.name === 'Milano')?.aliases).toContain('Milan');
    expect(PLACES.find((p) => p.name === 'Roma')?.aliases).toContain('Rome');
  });
});

describe('findPlace: what the model wrote → a place of the list', () => {
  it('finds a name or an alias without case, accents, a hash, a trailing country or a note in brackets', () => {
    expect(findPlace('Milano')?.name).toBe('Milano');
    expect(findPlace('Milan')?.name).toBe('Milano');
    expect(findPlace('#Milano')?.name).toBe('Milano');
    expect(findPlace('MILANO')?.name).toBe('Milano');
    expect(findPlace('  Milano  ')?.name).toBe('Milano');
    expect(findPlace('Milano, Italia')?.name).toBe('Milano');
    expect(findPlace('Milano (MI)')?.name).toBe('Milano');
    expect(findPlace('Forli')?.name).toBe('Forlì');
    expect(findPlace('Valle d Aosta')?.name).toBe('Valle d\'Aosta');
  });

  it('a name that is not in the list, or not a name, is no place', () => {
    for (const raw of ['Montagne de Reims', 'Luogo', 'Montagna', '', '   ', '#', null, undefined, 42, {}, [], true]) expect(findPlace(raw), String(raw)).toBeNull();
  });

  it('«Città di Milano», «Provincia di Sondrio»: the kind of place before the name is not part of it; «Città di Castello» is a town', () => {
    expect(findPlace('Città di Milano')?.name).toBe('Milano');
    expect(findPlace('Provincia di Sondrio')?.name).toBe('Sondrio');
    expect(findPlace('Città di Castello')?.name).toBe('Città di Castello');
    expect(findPlace('Regione Lombardia')).toBeNull();
    expect(findPlace('Regione di Lombardia')?.name).toBe('Lombardia');
  });

  it('two cities that begin the same are two places', () => {
    expect(findPlace('Reggio Emilia')?.name).toBe('Reggio Emilia');
    expect(findPlace('Reggio Calabria')?.name).toBe('Reggio Calabria');
    expect(findPlace('Reggio')).toBeNull();
  });
});

describe('canonicalPlace: the place must be in the list AND in the text', () => {
  it('«Milan» → «Milano» when the text says Milano; «#Milano» too', () => {
    expect(canonicalPlace('Milan', MILANO_POST)).toBe('Milano');
    expect(canonicalPlace('#Milano', MILANO_POST)).toBe('Milano');
    expect(canonicalPlace('Milano', MILANO_POST)).toBe('Milano');
  });

  it('a variant in the text is enough: the model says «Milano», the post says «Milan»', () => {
    expect(canonicalPlace('Milano', 'Dinner in Milan tonight, best pizza of the city')).toBe('Milano');
  });

  it('a place of the list that the text does not contain is dropped (the model made it up, or it came from somewhere else)', () => {
    expect(canonicalPlace('Roma', 'Cinque vini italiani da provare, tra le Langhe e il Monferrato')).toBeNull();
    expect(canonicalPlace('Milano', 'Una gita in montagna, vista sul Cervino')).toBeNull();
  });

  it('«Montagne de Reims» is dropped: not in the list, even when the text names it', () => {
    expect(canonicalPlace('Montagne de Reims', 'Champagne della Montagne de Reims, due bottiglie da provare')).toBeNull();
    expect(canonicalPlace('Montagne de Reims', 'Vino rosso del Piemonte')).toBeNull();
  });

  it('a place needs a WHOLE word in the text: «Roma» is not inside «aromi» or «romagnolo»; a hashtag that begins with it counts', () => {
    expect(canonicalPlace('Roma', 'aromi di frutta e note di vaniglia')).toBeNull();
    expect(canonicalPlace('Roma', 'un piatto romagnolo')).toBeNull();
    expect(canonicalPlace('Roma', 'una cena a Roma')).toBe('Roma');
    expect(canonicalPlace('Roma', 'tre trattorie #romafood da provare')).toBe('Roma');
    expect(canonicalPlace('Roma', 'che bella la città, ROMA!')).toBe('Roma');
  });

  it('accents and apostrophes do not matter', () => {
    expect(canonicalPlace('Forlì', 'una pizzeria a Forli, in centro')).toBe('Forlì');
    expect(canonicalPlace('Forli', 'una pizzeria a Forlì, in centro')).toBe('Forlì');
    expect(canonicalPlace('L\'Aquila', 'tre locali a L\'Aquila')).toBe('L\'Aquila');
    expect(canonicalPlace('L\'Aquila', 'in giro all\'Aquila di sera')).toBe('L\'Aquila');
    expect(canonicalPlace('Reggio Emilia', 'balsamico di Reggio nell\'Emilia')).toBe('Reggio Emilia');
  });

  it('regions and countries too', () => {
    expect(canonicalPlace('Piemonte', 'i migliori vini del Piemonte')).toBe('Piemonte');
    expect(canonicalPlace('Toscana', 'un weekend in Tuscany')).toBe('Toscana');
    expect(canonicalPlace('Italia', 'il caffè più buono d\'Italia')).toBe('Italia');
  });

  it('a name that is also a common word counts only when it is written with a capital letter or as a hashtag', () => {
    expect(canonicalPlace('Prato', 'stendi la coperta sul prato verde')).toBeNull();
    expect(canonicalPlace('Prato', 'una gita a Prato domenica')).toBe('Prato');
    expect(canonicalPlace('Prato', 'tessile #prato da vedere')).toBe('Prato');
    expect(canonicalPlace('Latina', 'ballo latina e salsa')).toBeNull();
    expect(canonicalPlace('Latina', 'pizzerie a Latina')).toBe('Latina');
  });

  it('EVERY name flagged as a common word needs the capital letter or the hashtag, and has it when it is written as a name', () => {
    const flagged = PLACES.filter((p) => p.ambiguous);
    // the list is pinned: a name that is also a word must be flagged, and one that is not must not (change it on purpose, with the data)
    expect(flagged.map((p) => p.name).sort()).toEqual([
      'Alba', 'Arco', 'Biella', 'Brindisi', 'Camerino', 'Capri', 'Carpi', 'Cattolica', 'Cecina', 'Cento', 'Cervo', 'Cittadella', 'Colonia',
      "Cortina d'Ampezzo", 'Crema', 'Diamante', 'Erba', 'Fermo', 'Foggia', 'Fondi', 'Gela', 'Grado', "L'Aquila", 'Lanciano', 'Latina', 'Lavagna',
      'Lima', 'Lodi', 'Maglie', 'Mali', 'Malta', 'Marche', 'Massa', 'Mattinata', 'Minori', 'Monaco', 'Nettuno', 'Nizza', 'Noci', 'Noto', 'Ostia',
      'Palma di Maiorca', 'Palmi', 'Pizzo', 'Portici', 'Porto', 'Potenza', 'Prato', 'Riga', 'Rio de Janeiro', 'Soave', 'Spalato', 'Stilo', 'Vasto',
      'Vinci', 'Vulcano',
    ]);
    for (const p of flagged) {
      expect(canonicalPlace(p.name, `ho detto ${p.name.toLowerCase()} ieri`), `${p.name} in lowercase`).toBeNull();
      expect(canonicalPlace(p.name, `ho detto ${p.name} ieri`), `${p.name} with a capital`).toBe(p.name);
      expect(canonicalPlace(p.name, `ho detto #${p.name.toLowerCase().replace(/[^a-z0-9]+/g, '')} ieri`), `${p.name} as a hashtag`).toBe(p.name);
    }
  });

  it('«cento», «fondi», «crema», «erba», «biella» and «carpi» are words: a town only with the capital letter', () => {
    expect(canonicalPlace('Cento', 'ne vogliamo cento')).toBeNull();
    expect(canonicalPlace('Cento', 'una pizzeria a Cento')).toBe('Cento');
    expect(canonicalPlace('Fondi', 'i fondi europei')).toBeNull();
    expect(canonicalPlace('Crema', 'una crema di zucca')).toBeNull();
    expect(canonicalPlace('Erba', 'tagliare l\'erba')).toBeNull();
    expect(canonicalPlace('Biella', 'la biella del motore')).toBeNull();
    expect(canonicalPlace('Carpi', 'i carpi del lago')).toBeNull();
    expect(canonicalPlace('Carpi', 'tre locali a Carpi')).toBe('Carpi');
  });

  it('«brindisi», «potenza» and «cortina» are words too: only the capital letter or the hashtag makes them places', () => {
    expect(canonicalPlace('Brindisi', 'un brindisi con le bollicine')).toBeNull();
    expect(canonicalPlace('Brindisi', 'una vacanza a Brindisi')).toBe('Brindisi');
    expect(canonicalPlace('Potenza', 'la potenza del motore')).toBeNull();
    expect(canonicalPlace('Potenza', 'trattorie a Potenza')).toBe('Potenza');
    expect(canonicalPlace('Cortina d\'Ampezzo', 'una cortina di fumo sul palco')).toBeNull();
    expect(canonicalPlace('Cortina d\'Ampezzo', 'weekend a Cortina con gli sci')).toBe('Cortina d\'Ampezzo');
    expect(canonicalPlace('Cortina d\'Ampezzo', 'weekend a Cortina d\'Ampezzo con gli sci')).toBe('Cortina d\'Ampezzo');
  });

  it('a hashtag glued to a name counts for the LONGEST name it begins with: #romafood is Roma, #romagna is Romagna and not Roma', () => {
    expect(canonicalPlace('Roma', 'foto #romagna sempre bella')).toBeNull();
    expect(canonicalPlace('Romagna', 'foto #romagna sempre bella')).toBe('Emilia-Romagna');
    expect(canonicalPlace('Reggio Emilia', 'giro #reggioemilia e dintorni')).toBe('Reggio Emilia');
    expect(canonicalPlace('San Gimignano', 'torri #sangimignano')).toBe('San Gimignano');
    expect(canonicalPlace('Milano', 'cena #milanodavedere')).toBe('Milano');
  });

  it('a short name in a hashtag must be the whole hashtag: #usa is the United States, #usatoday is not', () => {
    expect(canonicalPlace('Stati Uniti', 'news #usa')).toBe('Stati Uniti');
    expect(canonicalPlace('Stati Uniti', 'news #usatoday')).toBeNull();
  });

  it('an acronym alias is read as written: «USA» is the United States, «usa» is a verb', () => {
    expect(canonicalPlace('Stati Uniti', 'negli USA i prezzi sono più alti')).toBe('Stati Uniti');
    expect(canonicalPlace('Stati Uniti', 'chi usa questo modello risparmia tempo')).toBeNull();
  });

  it('what is not a text answer is no place', () => {
    for (const raw of [null, undefined, 42, {}, [], false]) expect(canonicalPlace(raw, MILANO_POST)).toBeNull();
  });
});

describe('isGrounded: is this name really in the text?', () => {
  it('compares without case, accents, punctuation and spaces', () => {
    expect(isGrounded('Caffè della Stazione', 'passate da caffe della stazione!')).toBe(true);
    expect(isGrounded('Osteria dell\'Orto & Co.', MILANO_POST)).toBe(true);
    expect(isGrounded('Trattoria da Luigi', MILANO_POST)).toBe(false);
  });

  it('a name of fewer than four letters must be a whole word', () => {
    expect(isGrounded('Bar', 'un bar in centro')).toBe(true);
    expect(isGrounded('Bar', 'barbecue sulla spiaggia')).toBe(false);
  });
});

describe('venueKey: the identity of a venue (one thing = one row, ADR-0017)', () => {
  it('is the cleaned name, a bar, and the cleaned city', () => {
    expect(venueKey('Trattoria dei Navigli', 'Milano')).toBe('trattoria dei navigli|milano');
    expect(venueKey('Osteria dell\'Orto & Co.', 'Torino')).toBe('osteria dell orto co|torino');
  });

  it('is the same for «Caffè  della Stazione» and «caffe della stazione», whatever the case and the spaces', () => {
    expect(venueKey('Caffè  della Stazione', 'Milano')).toBe(venueKey('caffe della stazione', 'Milano'));
    expect(venueKey('  CAFFÈ DELLA STAZIONE ', ' milano ')).toBe(venueKey('caffe della stazione', 'Milano'));
  });

  it('is different for the same name in another city, and a venue with no city has an empty one', () => {
    expect(venueKey('Caffè della Stazione', 'Milano')).not.toBe(venueKey('Caffè della Stazione', 'Torino'));
    expect(venueKey('Caffè della Stazione', null)).toBe('caffe della stazione|');
    expect(venueKey('Caffè della Stazione', null)).not.toBe(venueKey('Caffè della Stazione', 'Milano'));
  });
});

describe('mapsUrl: the address the server builds (no key, no call to Google)', () => {
  it('is name and city, encoded', () => {
    expect(mapsUrl('Trattoria dei Navigli', 'Milano')).toBe('https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli%2C%20Milano');
  });

  it('is just the name when there is no city', () => {
    expect(mapsUrl('Trattoria dei Navigli')).toBe('https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli');
    expect(mapsUrl('Trattoria dei Navigli', null)).toBe('https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli');
    expect(mapsUrl('Trattoria dei Navigli', '')).toBe('https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli');
    expect(mapsUrl('Trattoria dei Navigli', '   ')).toBe('https://www.google.com/maps/search/?api=1&query=Trattoria%20dei%20Navigli');
  });

  it('encodes the apostrophe and the ampersand of «Osteria dell\'Orto & Co.»', () => {
    const url = mapsUrl('Osteria dell\'Orto & Co.', null);
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=Osteria%20dell%27Orto%20%26%20Co.');
    expect(url.split('query=')[1]).not.toMatch(/['&]/);
  });

  it('encodes accents and the other characters that would break a link', () => {
    expect(mapsUrl('Caffè della Stazione', 'Forlì')).toBe('https://www.google.com/maps/search/?api=1&query=Caff%C3%A8%20della%20Stazione%2C%20Forl%C3%AC');
    const hard = mapsUrl('Bar (Centro) *nuovo*! #1', 'Milano').split('query=')[1];
    expect(hard).not.toMatch(/[ '()*!#&]/);
  });

  it('cleans the spaces of the name and of the city', () => {
    expect(mapsUrl('  Bar   Basso ', ' Milano ')).toBe('https://www.google.com/maps/search/?api=1&query=Bar%20Basso%2C%20Milano');
  });

  it('is a plain function of its arguments: the same address every time', () => {
    expect(mapsUrl('A', 'B')).toBe(mapsUrl('A', 'B'));
    expect(mapsUrl('A', 'B')).not.toBe(mapsUrl('A', 'C'));
  });
});

const answer = (o: unknown): string => JSON.stringify(o);

describe('parsePlacesAndVenues: the answer of the model, cleaned and checked against the text', () => {
  it('a post that lists venues in Milano: the place and three venues, each with its key', () => {
    const out = parsePlacesAndVenues(
      answer({
        place: 'Milan',
        venues: [
          { name: 'Trattoria dei Navigli', kind: 'restaurant', city: null },
          { name: 'Osteria dell\'Orto & Co.', kind: 'restaurant', city: null },
          { name: 'Caffè della Stazione', kind: 'cafe', city: null },
        ],
      }),
      MILANO_POST,
    );
    expect(out.place).toEqual({ name: 'Milano', kind: 'city' });
    expect(out.venues.map((v) => v.name)).toEqual(['Trattoria dei Navigli', 'Osteria dell\'Orto & Co.', 'Caffè della Stazione']);
    expect(out.venues.map((v) => v.kind)).toEqual(['restaurant', 'restaurant', 'cafe']);
    expect(out.venues.every((v) => v.place === 'Milano')).toBe(true);
    expect(out.venues.map((v) => v.key)).toEqual([venueKey('Trattoria dei Navigli', 'Milano'), venueKey('Osteria dell\'Orto & Co.', 'Milano'), venueKey('Caffè della Stazione', 'Milano')]);
  });

  it('a post that names a place and no venues gives the place and venues []', () => {
    const out = parsePlacesAndVenues(answer({ place: 'Piemonte', venues: [] }), 'Il Barolo è il re dei vini del Piemonte');
    expect(out).toEqual({ place: { name: 'Piemonte', kind: 'region' }, venues: [] });
  });

  it('a place the text does not contain is dropped, and the venues stay', () => {
    const out = parsePlacesAndVenues(answer({ place: 'Torino', venues: [{ name: 'Trattoria dei Navigli', kind: 'restaurant', city: null }] }), MILANO_POST);
    expect(out.place).toBeNull();
    expect(out.venues).toHaveLength(1);
    expect(out.venues[0].place).toBeNull();
    expect(out.venues[0].key).toBe(venueKey('Trattoria dei Navigli', null));
  });

  it('broken JSON, an answer that is not an object, or a wrong shape: no place and no venues, no exception', () => {
    const nothing = { place: null, venues: [] };
    expect(parsePlacesAndVenues('{"place": "Milano", "venues": [{"name": "Tr', MILANO_POST)).toEqual(nothing);
    expect(parsePlacesAndVenues('', MILANO_POST)).toEqual(nothing);
    expect(parsePlacesAndVenues('[]', MILANO_POST)).toEqual(nothing);
    expect(parsePlacesAndVenues('"Milano"', MILANO_POST)).toEqual(nothing);
    expect(parsePlacesAndVenues('null', MILANO_POST)).toEqual(nothing);
    expect(parsePlacesAndVenues(answer({ place: 'Milano', venues: 'molti' }), MILANO_POST)).toEqual({ place: { name: 'Milano', kind: 'city' }, venues: [] });
    expect(parsePlacesAndVenues(answer({ place: 5, venues: [null, 3, 'x', {}] }), MILANO_POST)).toEqual(nothing);
  });

  it('a venue whose name is not in the text is dropped (nothing is invented)', () => {
    const out = parsePlacesAndVenues(answer({ place: 'Milano', venues: [{ name: 'Trattoria dei Navigli', kind: 'restaurant' }, { name: 'Da Mario al Duomo', kind: 'restaurant' }] }), MILANO_POST);
    expect(out.venues.map((v) => v.name)).toEqual(['Trattoria dei Navigli']);
  });

  it('a generic name is not a venue: «un ristorante», «il locale», «la pizzeria», «ristorante nuovo»; a proper name with a generic word is', () => {
    const text = 'un ristorante, il locale, la pizzeria, ristorante nuovo, Bar Roma, Trattoria dei Navigli, Pizzeria Da Gennaro, il Bar Basso';
    const names = ['un ristorante', 'il locale', 'la pizzeria', 'ristorante nuovo', 'Ristorante', 'il bar', 'Bar Roma', 'Trattoria dei Navigli', 'Pizzeria Da Gennaro', 'il Bar Basso'];
    const out = parsePlacesAndVenues(answer({ place: null, venues: names.map((name) => ({ name, kind: 'restaurant' })) }), text);
    expect(out.venues.map((v) => v.name)).toEqual(['Bar Roma', 'Trattoria dei Navigli', 'Pizzeria Da Gennaro', 'il Bar Basso']);
  });

  it('a venue word that the list of generic words does not know is no name either, with an adjective: «Hostel Nuovo», «Enoteche Storiche», «Birrerie Tipiche»', () => {
    const names = ['Hostel Nuovo', 'Enoteche Storiche', 'Birrerie Tipiche', 'Caffetterie Storiche', 'Resort Migliore', 'Pasticcerie Tipiche'];
    expect(kept(names.join(', '), ...names.map((name) => ({ name })))).toEqual([]);
    expect(kept('Hostel Roma, Resort Bellavista', { name: 'Hostel Roma' }, { name: 'Resort Bellavista' })).toEqual(['Hostel Roma', 'Resort Bellavista']);
  });

  it('the words that say what a venue is are no name in any form: «HOTELS», «Pizzerie», «Club», «Store», «Trattorie Nuove», «Pub Bar»; a name with one more word is a name', () => {
    const names = ['HOTELS', 'Pizzerie', 'Club', 'Store', 'Trattorie Nuove', 'Pub Bar', 'Ristoranti', 'Enoteche'];
    expect(kept(names.join(', '), ...names.map((name) => ({ name })))).toEqual([]);
    expect(kept('Hotel Roma, Club Tropicana', { name: 'Hotel Roma' }, { name: 'Club Tropicana' })).toEqual(['Hotel Roma', 'Club Tropicana']);
  });

  it('a venue that is only the name of a place is no venue («Milano» listed as a restaurant)', () => {
    const out = parsePlacesAndVenues(answer({ place: 'Milano', venues: [{ name: 'Milano', kind: 'restaurant' }, { name: 'Milan', kind: 'bar' }, { name: 'Bar Basso', kind: 'bar' }] }), MILANO_POST + ' Bar Basso');
    expect(out.venues.map((v) => v.name)).toEqual(['Bar Basso']);
  });

  it('at most 20 venues, the first 20 that pass', () => {
    const names = Array.from({ length: 25 }, (_, i) => `Osteria Numero${String.fromCharCode(97 + i)}${String.fromCharCode(97 + ((i * 7) % 26))}`);
    expect(MAX_VENUES).toBe(20);
    const out = parsePlacesAndVenues(answer({ place: null, venues: names.map((name) => ({ name, kind: 'restaurant' })) }), names.join(', '));
    expect(out.venues).toHaveLength(20);
    expect(out.venues.map((v) => v.name)).toEqual(names.slice(0, 20));
  });

  it('the same venue twice is one (also written with other case or accents)', () => {
    const out = parsePlacesAndVenues(
      answer({ place: 'Milano', venues: [{ name: 'Caffè della Stazione', kind: 'cafe' }, { name: 'caffe della stazione', kind: 'bar' }, { name: 'Caffè della Stazione', kind: 'cafe', city: 'Milano' }] }),
      MILANO_POST,
    );
    expect(out.venues).toHaveLength(1);
    expect(out.venues[0].kind).toBe('cafe');
  });

  it('a venue can have a city of its own, when the text names it; a city the text does not name falls back to the city of the post', () => {
    const text = 'Milano è bellissima: Trattoria dei Navigli. E se andate a Torino: Caffè Al Bicerin. Poi Bar Basso.';
    const out = parsePlacesAndVenues(
      answer({ place: 'Milano', venues: [
        { name: 'Trattoria dei Navigli', kind: 'restaurant', city: null },
        { name: 'Caffè Al Bicerin', kind: 'cafe', city: 'Torino' },
        { name: 'Bar Basso', kind: 'bar', city: 'Napoli' },
      ] }),
      text,
    );
    expect(out.venues.map((v) => [v.name, v.place])).toEqual([['Trattoria dei Navigli', 'Milano'], ['Caffè Al Bicerin', 'Torino'], ['Bar Basso', 'Milano']]);
  });

  it('the kind of a kept venue is the kind its evidence says (the model\'s own is only a fallback): «other» is never kept', () => {
    expect(VENUE_KINDS).toEqual(['restaurant', 'pizzeria', 'bar', 'cafe', 'hotel', 'refuge', 'winery', 'shop', 'other']);   // «other» stays for the rows stored before
    const text = 'Trattoria dei Navigli, Pizzeria Da Gennaro, Bar Basso, Caffè Al Bicerin, Hotel Danieli, Rifugio Auronzo, Cantina Gaja, Libreria Hoepli';
    const out = parsePlacesAndVenues(
      answer({ place: null, venues: [
        { name: 'Trattoria dei Navigli', kind: 'hotel' }, { name: 'Pizzeria Da Gennaro', kind: 'bar' }, { name: 'Bar Basso', kind: 'cafe' },
        { name: 'Caffè Al Bicerin', kind: 'restaurant' }, { name: 'Hotel Danieli', kind: 'shop' }, { name: 'Rifugio Auronzo', kind: 'winery' },
        { name: 'Cantina Gaja', kind: 'refuge' }, { name: 'Libreria Hoepli', kind: 'museo' },
      ] }),
      text,
    );
    expect(out.venues.map((v) => [v.name, v.kind])).toEqual([
      ['Trattoria dei Navigli', 'restaurant'], ['Pizzeria Da Gennaro', 'pizzeria'], ['Bar Basso', 'bar'], ['Caffè Al Bicerin', 'cafe'],
      ['Hotel Danieli', 'hotel'], ['Rifugio Auronzo', 'refuge'], ['Cantina Gaja', 'winery'], ['Libreria Hoepli', 'shop'],
    ]);
  });

  it('a note in brackets at the end is not part of the name, with a comma in it or after it, and with quotes around everything', () => {
    const text = 'Bar Basso (Milano, Italia). Trattoria dei Navigli. Osteria Da Mario (storica) e Hotel Roma';
    const out = parsePlacesAndVenues(answer({ place: null, venues: ['Bar Basso (Milano, Italia)', '"Trattoria dei Navigli (Milano)"', 'Osteria Da Mario (storica), Roma', 'Hotel Roma: (centro)'].map((name) => ({ name })) }), text);
    expect(out.venues.map((v) => v.name)).toEqual(['Bar Basso', 'Trattoria dei Navigli', 'Osteria Da Mario', 'Hotel Roma']);
  });

  it.each(['"', '\'', '“', '”', '‘', '’', '«', '»', '`', '´', '*', '_', ';', ':'])('a «%s» at the end of the name is not part of it', (c) => {
    expect(kept('Cena al Bar Luce', { name: `Bar Luce${c}` })).toEqual(['Bar Luce']);
    expect(kept('Cena al Bar Luce', { name: `Bar Luce ${c}${c} ` })).toEqual(['Bar Luce']);
  });

  it('a quote, a colon and a space at the end go together, in any order: «Bar Luce " : »', () => {
    for (const name of ['Bar Luce " : ', 'Bar Luce : " ', 'Bar Luce “ ; ’ ', 'Bar Luce * _ `']) expect(kept('Cena al Bar Luce', { name }), name).toEqual(['Bar Luce']);
  });

  it('square brackets are no note: «Bar Basso [Milano]» is junk', () => {
    expect(kept('Bar Basso [Milano]', { name: 'Bar Basso [Milano]' })).toEqual([]);
    expect(kept('Bar Basso [Milano', { name: 'Bar Basso [Milano' })).toEqual([]);
  });

  it('only a note at the END is a note: «Osteria (storica) Da Mario» keeps its bracket, «Osteria (storica) Da Mario (Roma)» loses the last one only', () => {
    const text = 'Osteria (storica) Da Mario (Roma)';
    expect(kept(text, { name: 'Osteria (storica) Da Mario' })).toEqual(['Osteria (storica) Da Mario']);
    expect(kept(text, { name: 'Osteria (storica) Da Mario (Roma)' })).toEqual(['Osteria (storica) Da Mario']);
  });

  it('the spaces of a name are one space: «Bar   Luce», «Bar\tLuce», «Bar\nLuce»', () => {
    for (const name of ['Bar   Luce', 'Bar\tLuce', 'Bar\nLuce', '  Bar Luce  ']) expect(kept('Cena al Bar Luce', { name }), JSON.stringify(name)).toEqual(['Bar Luce']);
  });

  it('a letter with an accent can start a name: «Ècò Bar»', () => {
    expect(kept('Ècò Bar', { name: 'Ècò Bar' })).toEqual(['Ècò Bar']);
    expect(kept('Öl Bar', { name: 'Öl Bar' })).toEqual(['Öl Bar']);
  });

  it('a name with a note in brackets at the end keeps the name; quotes around it are cleaned', () => {
    const out = parsePlacesAndVenues(answer({ place: null, venues: [{ name: '  Bar Basso (Milano) ', kind: 'bar' }, { name: '"Trattoria dei Navigli"', kind: 'restaurant' }] }), MILANO_POST + ' Bar Basso');
    expect(out.venues.map((v) => v.name)).toEqual(['Bar Basso', 'Trattoria dei Navigli']);
  });

  it('a venue with no name, or too short to be one, is dropped', () => {
    const out = parsePlacesAndVenues(answer({ place: null, venues: [{ kind: 'bar' }, { name: '', kind: 'bar' }, { name: 'A', kind: 'bar' }, { name: 'Z', kind: 'bar' }, { name: 12, kind: 'bar' }] }), 'A 12 bar Z');
    expect(out.venues).toEqual([]);
  });

  it('the number of a list: one or two digits, a dot or a bracket, a space; «2.5 Bar Luce» and «3.Bar Mario» are names with a number', () => {
    const text = 'Bar Basso, Bar Luce, 2.5 Bar Luce, 123. Bar Basso, 3.Bar Mario';
    for (const name of ['1. Bar Basso', '12. Bar Basso', '1) Bar Basso', '12) Bar Basso', '  1. Bar Basso', '\t- 1) Bar Basso']) expect(kept(text, { name }), name).toEqual(['Bar Basso']);
    expect(kept(text, { name: '2.5 Bar Luce' })).toEqual(['2.5 Bar Luce']);
    expect(kept(text, { name: '123. Bar Basso' })).toEqual([]);   // three digits are not the number of a list: it stays, and «123.» is not a plain number (less than 70% letters)
    expect(kept(text, { name: '3.Bar Mario' })).toEqual(['3.Bar Mario']);
    // only at the start: a number with a dot inside a name is a number
    expect(kept('Bar 2. Luce', { name: 'Bar 2. Luce' })).toEqual(['Bar 2. Luce']);
    expect(kept('Hotel 5) Bellavista', { name: 'Hotel 5) Bellavista' })).toEqual(['Hotel 5) Bellavista']);
  });

  it('a bullet or the number of a list is not part of the name («1. Bar Basso»); a name that begins with a number keeps it', () => {
    const text = 'Bar Basso, Trattoria dei Navigli, 24 Ore Bar';
    const out = parsePlacesAndVenues(answer({ place: null, venues: [{ name: '1. Bar Basso', kind: 'bar' }, { name: '- Trattoria dei Navigli', kind: 'restaurant' }, { name: '24 Ore Bar', kind: 'bar' }] }), text);
    expect(out.venues.map((v) => v.name)).toEqual(['Bar Basso', 'Trattoria dei Navigli', '24 Ore Bar']);
  });
});

const SOURCE = { caption: 'Ecco i ristoranti nuovi da provare su Milano', summary: 'Tre locali di Milano', tags: ['milano', 'food', '#tag', '@utente'], notes: ['Trattoria dei Navigli'], transcript: null, ocr: 'Osteria dell\'Orto' };

// ---------------------------------------------------------------------------------------------------------------------------- the evidence gate
// 10 November, dress rehearsal on a copy of the real entries: 73 posts gave 127 «venues» and nearly all were garbage (apps, brands, people, accounts, text
// read off the screen). The model only PROPOSES venues; the code decides, and a venue stays only when the text itself shows a place to go (spec §4.6:
// «meglio nessun locale che uno inventato»). The rules, as the tests below pin them:
//   1. the NAME has a strong or a common venue word («Trattoria dei Navigli», «Bar Luce»): a venue, of the kind of that word;
//   2. the name has a WEAK word («Club Tropicana», «Coach Store»): a venue only with one more sign within 120 characters, a strong word or a mark of a place;
//   3. the name has none: a venue only with TWO signs within 120 characters, a strong word AND a mark of a place (a pin, an address, a table, a menu),
//      and written with a capital letter. The kind is always the one of the venue word; what the model wrote as a kind is never used.

/** The names kept from a text, for the candidates the model proposed (the kind the model writes does not matter: «restaurant» unless said). */
const kept = (text: string, ...items: Array<{ name: string; kind?: string; city?: string | null }>): string[] =>
  parsePlacesAndVenues(answer({ place: null, venues: items.map((item) => ({ kind: 'restaurant', ...item })) }), text).venues.map((v) => v.name);

/** The kind of the venue kept for one candidate (undefined when it was dropped). */
const keptKind = (text: string, name: string, kind = 'restaurant'): string | undefined =>
  parsePlacesAndVenues(answer({ place: null, venues: [{ name, kind }] }), text).venues[0]?.kind;

/** The whole verdict for one candidate. */
const explain = (text: string, name: string, kind = 'restaurant') => explainPlacesAndVenues(answer({ place: null, venues: [{ name, kind }] }), text)[0];

const capitalised = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** [as the text writes it, the kind it means]. A STRONG word makes a name a venue, and it corroborates a name with a weak word when it is written near it. */
const STRONG_WORDS: Array<[string, string]> = [
  ['restaurant', 'restaurant'], ['restaurants', 'restaurant'], ['ristorante', 'restaurant'], ['ristoranti', 'restaurant'], ['ristorantino', 'restaurant'],
  ['trattoria', 'restaurant'], ['trattorie', 'restaurant'], ['osteria', 'restaurant'], ['osterie', 'restaurant'], ['locanda', 'restaurant'], ['locande', 'restaurant'],
  ['bistrot', 'restaurant'], ['bistro', 'restaurant'], ['steakhouse', 'restaurant'], ['braceria', 'restaurant'], ['brasserie', 'restaurant'],
  ['pizzeria', 'pizzeria'], ['pizzerie', 'pizzeria'],
  ['caffetteria', 'cafe'], ['caffetterie', 'cafe'], ['pasticceria', 'cafe'], ['pasticcerie', 'cafe'], ['gelateria', 'cafe'], ['gelaterie', 'cafe'],
  ['bakery', 'cafe'], ['panificio', 'cafe'], ['panifici', 'cafe'],
  ['birreria', 'bar'], ['birrerie', 'bar'], ['enoteca', 'bar'], ['enoteche', 'bar'], ['vineria', 'bar'], ['vinerie', 'bar'],
  ['hotel', 'hotel'], ['hotels', 'hotel'], ['albergo', 'hotel'], ['alberghi', 'hotel'], ['B&B', 'hotel'], ['bnb', 'hotel'], ['bed and breakfast', 'hotel'],
  ['ostello', 'hotel'], ['ostelli', 'hotel'], ['hostel', 'hotel'], ['hostels', 'hotel'], ['agriturismo', 'hotel'], ['agriturismi', 'hotel'],
  ['rifugio', 'refuge'], ['rifugi', 'refuge'], ['baita', 'refuge'], ['baite', 'refuge'], ['malga', 'refuge'], ['malghe', 'refuge'],
  ['winery', 'winery'], ['wineries', 'winery'], ['cantina', 'winery'], ['cantine', 'winery'],
  ['boutique', 'shop'], ['bottega', 'shop'], ['botteghe', 'shop'], ['salumeria', 'shop'], ['salumerie', 'shop'], ['macelleria', 'shop'], ['macellerie', 'shop'],
  ['emporio', 'shop'], ['supermercato', 'shop'],
];

/** A COMMON word makes a name a venue («Bar Luce») but written next to a name it says nothing («al bar», «il pub»). */
const COMMON_WORDS: Array<[string, string]> = [
  ['taverna', 'restaurant'], ['tavernetta', 'restaurant'], ['bar', 'bar'], ['pub', 'bar'], ['discoteca', 'bar'], ['resort', 'hotel'],
  ['capanna', 'refuge'], ['bivacco', 'refuge'], ['vigneto', 'winery'], ['tenuta', 'winery'],
];

/** A WEAK word in a name needs one more sign («Coach Store», «White Whale Café», «The Market for Lemons» are not venues); next to a name it says nothing. */
const WEAK_WORDS: Array<[string, string]> = [
  ['cafe', 'cafe'], ['caffe', 'cafe'], ['caffè', 'cafe'], ['coffee', 'cafe'], ['forno', 'cafe'],
  ['lounge', 'bar'], ['club', 'bar'],
  ['residence', 'hotel'], ['pensione', 'hotel'],
  ['negozio', 'shop'], ['negozi', 'shop'], ['libreria', 'shop'], ['librerie', 'shop'], ['shop', 'shop'], ['store', 'shop'], ['mercato', 'shop'], ['market', 'shop'],
  ['gastronomia', 'shop'],
];

/** A kind that is NOT the one expected, to show that the model's kind counts for nothing. */
const otherKind = (kind: string): string => (kind === 'bar' ? 'hotel' : 'bar');

/** A cue and a name with exactly `gap` characters between them (the filler is one long word, so it is no cue itself). */
const cueBefore = (cue: string, name: string, gap: number): string => `${cue} ${'x'.repeat(gap - 2)} ${name}`;
const cueAfter = (name: string, cue: string, gap: number): string => `${name} ${'x'.repeat(gap - 2)} ${cue}`;

describe('the evidence gate: the real garbage of the rehearsal is no venue', () => {
  const GARBAGE: Array<{ name: string; kind: string; text: string }> = [
    { name: 'Claude Code', kind: 'other', text: 'Ho provato Claude Code su tre repository: i suoi agenti scrivono i test da soli.' },
    { name: 'Claude.ai', kind: 'hotel', text: 'Apri Claude.ai, incolla il link e chiedi un riassunto del video.' },
    { name: 'Cursor', kind: 'cafe', text: 'Cursor e Claude Code a confronto: quale editor scegliere per programmare con la AI?' },
    { name: 'PimEyes', kind: 'shop', text: 'PimEyes trova il tuo volto su internet: ecco come toglierti dai risultati di ricerca.' },
    { name: 'Pink Floyd', kind: 'hotel', text: 'Tutti gli album dei Pink Floyd dal peggiore al migliore: The Wall, Animals, Meddle.' },
    { name: 'kettlebellgrant', kind: 'cafe', text: 'Segui @kettlebellgrant per gli allenamenti con i kettlebell.' },
    { name: '@kettlebellgrant', kind: 'cafe', text: 'Segui @kettlebellgrant per gli allenamenti con i kettlebell.' },
    { name: 'REPO', kind: 'winery', text: 'Il REPO su GitHub ha già diecimila stelle: lo trovi nel link in bio.' },
    { name: "SILVER' FOR MY GUIDE.", kind: 'shop', text: "SILVER' FOR MY GUIDE." },
    { name: '+ Répondre a Claude...', kind: 'bar', text: '+ Répondre a Claude...' },
    { name: 'Cos m ogonie', kind: 'hotel', text: 'Cos m ogonie' },
    { name: 'rivoluzione.della.mente', kind: 'other', text: 'Segui rivoluzione.della.mente per altri consigli.' },
    { name: '/Electron/', kind: 'shop', text: 'Costruito con /Electron/ e React.' },
  ];

  it.each(GARBAGE)('«$name» (the model said «$kind») is no venue', ({ name, kind, text }) => {
    expect(kept(text, { name, kind })).toEqual([]);
  });

  it('all of them together, in one answer, are no venues; one real venue among them stays', () => {
    const text = GARBAGE.map((g) => g.text).join('\n') + '\nPranzo alla Trattoria dei Navigli.';
    const venues = [...GARBAGE.map(({ name, kind }) => ({ name, kind })), { name: 'Trattoria dei Navigli', kind: 'restaurant' }];
    expect(parsePlacesAndVenues(answer({ place: null, venues }), text).venues.map((v) => v.name)).toEqual(['Trattoria dei Navigli']);
  });

  it('what the name itself gives away is dropped whatever is around it: a restaurant on each side changes nothing', () => {
    for (const name of ['Claude Code', 'Claude.ai', '@kettlebellgrant', 'rivoluzione.della.mente', '/Electron/', '+ Répondre a Claude...', 'Cos m ogonie', "SILVER' FOR MY GUIDE."]) {
      expect(kept(`ristorante ${name} ristorante`, { name }), name).toEqual([]);
    }
  });

  it('a software post that says «bar», «caffè» or «libreria» is no list of venues: those words are too common to be evidence next to a name', () => {
    expect(kept('Mentre Cursor lavora puoi andare al bar a prenderti un caffè', { name: 'Cursor', kind: 'cafe' })).toEqual([]);
    expect(kept('Installa la libreria Cursor e apri il negozio online', { name: 'Cursor', kind: 'shop' })).toEqual([]);
  });
});

describe('the evidence gate: a name that cannot be the name of a venue', () => {
  const GOOD = 'Bar Luce';
  it('the control: a plain name with the word of its kind in it is kept', () => {
    expect(kept(GOOD, { name: GOOD })).toEqual([GOOD]);
  });

  it.each(['@', '#', '+', '/', '\\', '|', '=', '<', '>', '[', ']', '{', '}', '«', '»', '_', '~', '^', '*'])('a «%s» inside the name makes it junk', (c) => {
    const name = `Bar ${c} Luce`;
    expect(kept(name, { name })).toEqual([]);
  });

  it('a handle or a hashtag is junk wherever it is: before, inside or after the name', () => {
    expect(kept('Bar Luce @barluce', { name: 'Bar Luce @barluce' })).toEqual([]);
    expect(kept('Bar #Luce', { name: 'Bar #Luce' })).toEqual([]);
    expect(kept('@barluce', { name: '@barluce' })).toEqual([]);
    expect(kept('#barluce', { name: '#barluce' })).toEqual([]);
    expect(kept('Bar Luce', { name: '#Bar Luce' })).toEqual([]);
  });

  it('an address on the web is junk: a dot between letters («Luce.it», «www.barluce.it»), «http»', () => {
    expect(kept('Bar Luce.it', { name: 'Bar Luce.it' })).toEqual([]);
    expect(kept('bar www.barluce.it', { name: 'www.barluce.it' })).toEqual([]);
    expect(kept('bar barluce.com', { name: 'barluce.com' })).toEqual([]);
    expect(kept('Bar http Luce', { name: 'Bar http Luce' })).toEqual([]);
    expect(kept('Bar Http Luce', { name: 'Bar Http Luce' })).toEqual([]);
    expect(kept('Bar WWW Luce', { name: 'Bar WWW Luce' })).toEqual([]);
    expect(kept('Bar https Luce', { name: 'Bar https Luce' })).toEqual([]);
    expect(kept('Bar HTTPS Luce', { name: 'Bar HTTPS Luce' })).toEqual([]);
  });

  it('words that only contain the letters of an address are not an address: «Awwwa», «Panel Videos»', () => {
    expect(kept('Bar Awwwa Luce', { name: 'Bar Awwwa Luce' })).toEqual(['Bar Awwwa Luce']);
    expect(kept('Bar Panel Videos', { name: 'Bar Panel Videos' })).toEqual(['Bar Panel Videos']);
    expect(kept('Bar Luce2.com', { name: 'Bar Luce2.com' })).toEqual([]);
    expect(kept('Bar Ge.O', { name: 'Bar Ge.O' })).toEqual(['Bar Ge.O']);
  });

  it('accents are letters: «Bar Àèìòù» is a name', () => {
    expect(kept('Bar Àèìòù', { name: 'Bar Àèìòù' })).toEqual(['Bar Àèìòù']);
  });

  it('a name of two letters is a name when the text shows it: «Ba»', () => {
    expect(kept('Ba 📍 ristorante', { name: 'Ba' })).toEqual(['Ba']);
  });

  it('but the dots of an abbreviation are not an address: «Osteria dell\'Orto & Co.», «Bar S.r.l.», «Hotel N.5»', () => {
    expect(kept('Osteria dell\'Orto & Co.', { name: 'Osteria dell\'Orto & Co.' })).toEqual(['Osteria dell\'Orto & Co.']);
    expect(kept('Bar Roma S.r.l.', { name: 'Bar Roma S.r.l.' })).toEqual(['Bar Roma S.r.l.']);
    expect(kept('Hotel N.5', { name: 'Hotel N.5' })).toEqual(['Hotel N.5']);
    expect(kept('Bar S.Pietro', { name: 'Bar S.Pietro' })).toEqual(['Bar S.Pietro']);   // «S.» is an initial, «Pietro» a name: not an address
    expect(kept('Bar Roma S.r.l', { name: 'Bar Roma S.r.l' })).toEqual(['Bar Roma S.r.l']);
  });

  it('an ellipsis is junk (a line cut by the screen)', () => {
    expect(kept('Bar Luce...', { name: 'Bar Luce...' })).toEqual([]);
    expect(kept('Bar Luce..', { name: 'Bar Luce..' })).toEqual([]);
    expect(kept('Bar Luce…', { name: 'Bar Luce…' })).toEqual([]);
  });

  it('an address is not the name of a venue: «Via Sant\'Ampellio 16» with the restaurant next to it and a pin before it', () => {
    for (const name of ['Via Sant\'Ampellio 16', 'Piazza del Duomo 3', 'VIA TOLEDO 12', 'Corso Como, 10', 'viale Monza n. 5']) {
      expect(kept(`ristorante vegano 📍 ${name}, Milano`, { name, kind: 'restaurant' }), name).toEqual([]);
    }
    // an address inside a longer name is another matter: «Osteria Via Roma 12» and «Via Roma 12 Pizzeria» are names
    expect(kept('Via Roma 12 Pizzeria', { name: 'Via Roma 12 Pizzeria' })).toEqual(['Via Roma 12 Pizzeria']);
    expect(kept('Osteria Via Roma 12', { name: 'Osteria Via Roma 12' })).toEqual(['Osteria Via Roma 12']);
    expect(kept('📍 Corso Como Cafe', { name: 'Corso Como Cafe', kind: 'cafe' })).toEqual(['Corso Como Cafe']);
  });

  it('an indefinite article in front is a description, not a name: «un ristorante ad Aspen», «Una pizzeria a Napoli», «un\'osteria»; «Unione Bar» and «Una» inside are fine', () => {
    for (const name of ['un ristorante ad Aspen', 'Un Bar Luce', 'Una pizzeria a Napoli', 'uno Bar Luce', 'un\'osteria Luce', 'un’osteria Luce', 'UN BAR LUCE']) {
      expect(kept(name, { name }), name).toEqual([]);
    }
    for (const name of ['Unione Bar', 'Bar Unico', 'Bar Una Luce', 'Hotel Un Poco']) expect(kept(name, { name }), name).toEqual([name]);
  });

  it('seven words are a sentence, six are a name', () => {
    expect(kept('Trattoria da Gigi al Borgo Vecchio', { name: 'Trattoria da Gigi al Borgo Vecchio' })).toEqual(['Trattoria da Gigi al Borgo Vecchio']);
    expect(kept('Trattoria da Gigi al Borgo Vecchio Antico', { name: 'Trattoria da Gigi al Borgo Vecchio Antico' })).toEqual([]);
  });

  it('fewer than 70% letters is OCR: «Bar A1B2C3D4», «Bar Lu1234c» (6 of 10); 7 of 10 and a plain number are fine: «Bar Luc123e», «Bar 24», «Bar 1950»', () => {
    expect(kept('Bar A1B2C3D4', { name: 'Bar A1B2C3D4' })).toEqual([]);
    expect(kept('Bar Lu1234c', { name: 'Bar Lu1234c' })).toEqual([]);
    expect(kept('Bar Luc123e', { name: 'Bar Luc123e' })).toEqual(['Bar Luc123e']);
    expect(kept('Bar 24', { name: 'Bar 24' })).toEqual(['Bar 24']);
    expect(kept('Osteria 1950', { name: 'Osteria 1950' })).toEqual(['Osteria 1950']);
    expect(kept('Bar 12345', { name: 'Bar 12345' })).toEqual([]);
  });

  it('a letter alone between words is OCR («Cos m ogonie», «Caffè m Luce»); «e», «a», «o», «i», «y» are words; a capital initial is a name', () => {
    expect(kept('Caffè m Luce', { name: 'Caffè m Luce' })).toEqual([]);
    expect(kept('Caffè e Pasticceria Luce', { name: 'Caffè e Pasticceria Luce' })).toEqual(['Caffè e Pasticceria Luce']);
    expect(kept('Bar a Luce', { name: 'Bar a Luce' })).toEqual(['Bar a Luce']);
    expect(kept('Bar o Luce', { name: 'Bar o Luce' })).toEqual(['Bar o Luce']);
    expect(kept('Bar i Luce', { name: 'Bar i Luce' })).toEqual(['Bar i Luce']);
    expect(kept('Bar y Luce', { name: 'Bar y Luce' })).toEqual(['Bar y Luce']);
    expect(kept('Hotel B', { name: 'Hotel B' })).toEqual(['Hotel B']);
    expect(kept('Bar x Luce', { name: 'Bar x Luce' })).toEqual([]);
    expect(kept('Bar u Luce', { name: 'Bar u Luce' })).toEqual([]);
    expect(kept('Bar m Luce', { name: 'Bar m Luce' })).toEqual([]);
  });

  it('a quote that closes nothing is junk («SILVER\' FOR»); the apostrophe of an elision is not («dell\'Orto», «L\'Osteria»)', () => {
    expect(kept('Bar SILVER\' Luce', { name: 'Bar SILVER\' Luce' })).toEqual([]);
    expect(kept('Bar Luce\' Roma', { name: 'Bar Luce\' Roma' })).toEqual([]);
    expect(kept('Bar dell\'Orto', { name: 'Bar dell\'Orto' })).toEqual(['Bar dell\'Orto']);
    expect(kept('L\'Osteria del Borgo', { name: 'L\'Osteria del Borgo' })).toEqual(['L\'Osteria del Borgo']);
    expect(kept('Bar Luce’ Roma', { name: 'Bar Luce’ Roma' })).toEqual([]);
    expect(kept('Bar Luce‘ Roma', { name: 'Bar Luce‘ Roma' })).toEqual([]);
  });

  it.each(['citato', 'citata', 'citati', 'citate', 'menzionato', 'menzionata', 'mentioned', 'marchio', 'brand', 'software', 'piattaforma', 'account', 'profilo'])(
    'a name that explains itself is a sentence, not a name: «Bar Luce %s»',
    (word) => {
      expect(kept(`Bar Luce ${word}`, { name: `Bar Luce ${word}` })).toEqual([]);
    },
  );

  it('«nel video», «nel post», «nel reel» too: «Bar Luce nel video»', () => {
    for (const where of ['nel video', 'nel post', 'nel reel']) expect(kept(`Bar Luce ${where}`, { name: `Bar Luce ${where}` }), where).toEqual([]);
  });

  it.each(['claude', 'chatgpt', 'gpt', 'openai', 'anthropic', 'gemini', 'copilot', 'github', 'gitlab', 'instagram', 'tiktok', 'youtube', 'facebook', 'whatsapp', 'telegram', 'linkedin', 'twitter'])(
    'the name of a platform or of an AI tool is not a venue, with a restaurant right next to it: «%s»',
    (word) => {
      expect(kept(`📍 ristorante ${capitalised(word)}`, { name: capitalised(word) })).toEqual([]);
      expect(kept(`Bar ${capitalised(word)}`, { name: `Bar ${capitalised(word)}` })).toEqual([]);
      expect(kept(`📍 ristorante Da ${capitalised(word)}`, { name: `Da ${capitalised(word)}` })).toEqual([]);
    },
  );

  it('a name that only looks like such a word is fine: «Hotel Brandolini», «Bar Gemelli», «Osteria Profilati»', () => {
    expect(kept('Hotel Brandolini', { name: 'Hotel Brandolini' })).toEqual(['Hotel Brandolini']);
    expect(kept('Bar Gemelli', { name: 'Bar Gemelli' })).toEqual(['Bar Gemelli']);
    expect(kept('Osteria Profilati', { name: 'Osteria Profilati' })).toEqual(['Osteria Profilati']);
  });
});

describe('the evidence gate (1): the name has a strong or a common venue word', () => {
  const REAL: Array<{ name: string; kind: string; text: string }> = [
    { name: 'Trattoria dei Navigli', kind: 'restaurant', text: 'Cena alla Trattoria dei Navigli: ottima la cotoletta alla milanese.' },
    { name: 'Bar Luce', kind: 'bar', text: 'La colazione più bella è al Bar Luce, quello di Wes Anderson.' },
    { name: 'Osteria del Vino Buono', kind: 'restaurant', text: 'Prenotate subito l\'Osteria del Vino Buono, sono bravissimi.' },
    { name: 'Pizzeria Da Gennaro', kind: 'pizzeria', text: 'Pizzeria Da Gennaro: la margherita migliore di Napoli.' },
    { name: 'Rifugio Monte Rosa', kind: 'refuge', text: 'Dormire al Rifugio Monte Rosa con vista sul ghiacciaio.' },
    { name: 'Cantina Ferrero', kind: 'winery', text: 'Degustazione di Barolo alla Cantina Ferrero, a due passi da Alba.' },
    { name: 'Hotel Bellavista', kind: 'hotel', text: 'Una notte all\'Hotel Bellavista, camere sul lago.' },
  ];

  it.each(REAL)('«$name» is a $kind, whatever the model said, with or without anything else in the text', ({ name, kind, text }) => {
    expect(keptKind(text, name, otherKind(kind))).toBe(kind);
    expect(keptKind(text, name, kind)).toBe(kind);
    expect(keptKind(name, name, 'museo')).toBe(kind);
    expect(explain(name, name)).toMatchObject({ kept: true, evidence: 'name', distance: null, kind });
  });

  it.each([...STRONG_WORDS, ...COMMON_WORDS])('the word «%s» in a name makes it a venue of kind %s, whatever the model said', (word, kind) => {
    const name = `${capitalised(word)} Gennaro`;
    expect(keptKind(name, name, otherKind(kind))).toBe(kind);
    expect(explain(name, name)).toMatchObject({ kept: true, evidence: 'name', distance: null });
  });

  it('the first venue word of the name tells the kind: «Hotel Ristorante Bellavista» is a hotel, «Ristorante Hotel Bellavista» a restaurant', () => {
    expect(keptKind('Hotel Ristorante Bellavista', 'Hotel Ristorante Bellavista', 'bar')).toBe('hotel');
    expect(keptKind('Ristorante Hotel Bellavista', 'Ristorante Hotel Bellavista', 'bar')).toBe('restaurant');
  });

  it('the word of the name wins over a different one next to it', () => {
    expect(keptKind('pizzeria Hotel Bellavista pizzeria', 'Hotel Bellavista', 'bar')).toBe('hotel');
  });

  it('the name is written with a capital letter on a word that is not a venue word, or has a number: «tavolo al ristorante» is a description, not a name', () => {
    expect(kept('cena alla trattoria dei navigli', { name: 'trattoria dei navigli' })).toEqual([]);
    expect(kept('cena alla trattoria dei Navigli', { name: 'trattoria dei navigli' })).toEqual(['trattoria dei navigli']);
    expect(kept('cena alla Trattoria dei navigli', { name: 'trattoria dei navigli' })).toEqual([]);   // only the venue word has a capital: no name
    expect(kept('ristorante Ba', { name: 'ristorante Ba' })).toEqual(['ristorante Ba']);
    expect(kept('Ristorante', { name: 'Ristorante Dei' })).toEqual([]);
    expect(kept('Prenota un tavolo al ristorante', { name: 'tavolo al ristorante' })).toEqual([]);
    expect(kept('Il Tavolo Al Ristorante', { name: 'Tavolo al Ristorante' })).toEqual([]);   // «tavolo» is a generic word, whatever its case
    expect(kept('Bar 24', { name: 'Bar 24' })).toEqual(['Bar 24']);
    expect(kept('osteria 1950', { name: 'osteria 1950' })).toEqual(['osteria 1950']);
    expect(kept('ristorante 24 luglio', { name: '24 luglio' })).toEqual([]);   // a number is enough only next to a venue word of the name itself
  });

  it.each(['tavolo', 'tavoli', 'prenotazione', 'prenotazioni', 'cena', 'cene', 'pranzo', 'pranzi', 'colazione', 'colazioni', 'aperitivo', 'aperitivi', 'brunch', 'menu', 'piatto', 'piatti', 'cibo'])(
    '«%s» is a generic word: «Ristorante %s» is no name',
    (word) => {
      const name = `Ristorante ${capitalised(word)}`;
      expect(kept(name, { name })).toEqual([]);
    },
  );

  it('the name is what comes before the first comma: «Cantina Isola, bottiglieria in via Paolo Sarpi» is «Cantina Isola»', () => {
    const text = 'Cantina Isola, bottiglieria in via Paolo Sarpi. Cantina Santadi, Carignano del Sulcis. Osteria Da Mario. Hotel Roma, Roma. Bar Luce';
    const out = parsePlacesAndVenues(answer({ place: null, venues: ['Cantina Isola, bottiglieria in via Paolo Sarpi', 'Cantina Santadi, Carignano del Sulcis', ', Osteria Da Mario', '"Hotel Roma", Roma', 'Bar Luce,'].map((name) => ({ name })) }), text);
    expect(out.venues.map((v) => v.name)).toEqual(['Cantina Isola', 'Cantina Santadi', 'Osteria Da Mario', 'Hotel Roma', 'Bar Luce']);
    // the address is looked at before the cut: «Corso Como, 10» is an address, «Corso Como» is not what it names
    expect(kept('Cena al ristorante Corso Como, 10 📍', { name: 'Corso Como, 10' })).toEqual([]);
  });

  it('a sign in front of the name is not part of it: a pin, an emoji, a bullet, a quote, a bracket', () => {
    for (const name of ['📍 Ristorante Monferrato', '🍝 Ristorante Monferrato', '• Ristorante Monferrato', '"Ristorante Monferrato"', '(Ristorante Monferrato', '📍📍 Ristorante Monferrato', '— Ristorante Monferrato']) {
      expect(kept('Cena al Ristorante Monferrato, Torino', { name }), name).toEqual(['Ristorante Monferrato']);
    }
  });

  it('a word glued to another is not the word, at the start or at the end: «Barolo», «Hotelier», «Pubblico», «Clubbing», «Storer», «Superhotel», «Megaclub», «Altrebar»', () => {
    for (const name of ['Barolo Gennaro', 'Hotelier Gennaro', 'Pubblico Gennaro', 'Clubbing Gennaro', 'Storer Gennaro', 'Barone Gennaro', 'Superhotel Gennaro', 'Megaclub Gennaro', 'Altrebar Gennaro']) expect(kept(name, { name }), name).toEqual([]);
  });

  it('the words of the dishes are not venue words: «Pizza Margherita», a post about pizza is no list of pizzerias', () => {
    expect(kept('Ricetta della Pizza Margherita di Gabriele Bonci', { name: 'Pizza Margherita' })).toEqual([]);
    expect(kept('la pizza di Gabriele Bonci', { name: 'Gabriele Bonci' })).toEqual([]);
  });

  it('a painting, a film or a song with a venue word in its title is the limit of the gate («Hotel Room» in a list of paintings): the prompt has to keep it out', () => {
    expect(kept('Edward Hopper: Hotel Room (1931), Morning Sun (1952)', { name: 'Hotel Room' })).toEqual(['Hotel Room']);
  });
});

describe('the evidence gate (2): the name has a weak venue word and needs one more sign', () => {
  const NAME = 'Club Gennaro';

  it('a weak word alone is no venue: «Coach Store», «WHITE WHALE CAFÈ», «The Market for Lemons», «Club Tropicana» next to nothing', () => {
    for (const name of ['Coach Store', 'WHITE WHALE CAFÈ', 'The Market for Lemons', 'Club Tropicana', 'Volt Club Milano']) {
      expect(kept(`Il post parla del ${name} e di altro`, { name }), name).toEqual([]);
    }
  });

  it.each(WEAK_WORDS)('«%s» in a name: alone nothing; with a strong word or a pin near it a venue of kind %s, the kind of the weak word whatever else is near', (word, kind) => {
    const name = `${capitalised(word)} Gennaro`;
    expect(kept(name, { name })).toEqual([]);
    expect(keptKind(`${name} ristorante`, name, otherKind(kind))).toBe(kind);
    expect(keptKind(`${name} 📍`, name, otherKind(kind))).toBe(kind);
    expect(keptKind(`hotel ${name}`, name, otherKind(kind))).toBe(kind);
    expect(keptKind(`ristorante ${name} 📍 pizzeria`, name, otherKind(kind))).toBe(kind);
  });

  it('a strong word within 120 characters, before or after the name, edges included, is the sign; at 121 it is not', () => {
    expect(VENUE_EVIDENCE_WINDOW).toBe(120);
    for (const text of [cueBefore('ristorante', NAME, 3), cueBefore('ristorante', NAME, 119), cueBefore('ristorante', NAME, 120), cueAfter(NAME, 'ristorante', 3), cueAfter(NAME, 'ristorante', 119), cueAfter(NAME, 'ristorante', 120)]) {
      expect(kept(text, { name: NAME }), text.slice(0, 24)).toEqual([NAME]);
    }
    for (const text of [cueBefore('ristorante', NAME, 121), cueBefore('ristorante', NAME, 122), cueBefore('ristorante', NAME, 300), cueAfter(NAME, 'ristorante', 121), cueAfter(NAME, 'ristorante', 122), cueAfter(NAME, 'ristorante', 300)]) {
      expect(kept(text, { name: NAME }), text.slice(0, 24)).toEqual([]);
    }
  });

  it('a mark of a place within 120 characters is the sign too; at 121 it is not', () => {
    for (const text of [cueBefore('📍', NAME, 3), cueBefore('📍', NAME, 119), cueBefore('📍', NAME, 120), cueAfter(NAME, '📍', 3), cueAfter(NAME, '📍', 119), cueAfter(NAME, '📍', 120)]) {
      expect(kept(text, { name: NAME }), text.slice(0, 24)).toEqual([NAME]);
    }
    for (const text of [cueBefore('📍', NAME, 121), cueBefore('📍', NAME, 300), cueAfter(NAME, '📍', 121), cueAfter(NAME, '📍', 300)]) {
      expect(kept(text, { name: NAME }), text.slice(0, 24)).toEqual([]);
    }
  });

  it('the distance of the evidence is the nearer of the two signs', () => {
    expect(explain(cueBefore('ristorante', NAME, 50), NAME)).toMatchObject({ evidence: 'near', distance: 50, kind: 'bar' });
    expect(explain(`ristorante ${'x'.repeat(48)} ${NAME} ${'x'.repeat(98)} 📍`, NAME)).toMatchObject({ distance: 50 });
    expect(explain(`ristorante ${'x'.repeat(98)} ${NAME} ${'x'.repeat(28)} 📍`, NAME)).toMatchObject({ distance: 30 });
  });

  it('a common or a weak word near the name is no sign («il bar», «un pub», «App Store»)', () => {
    for (const [word] of [...COMMON_WORDS, ...WEAK_WORDS]) {
      expect(kept(`${word} ${NAME}`, { name: NAME }), word).toEqual([]);
      expect(kept(`${NAME} ${word}`, { name: NAME }), word).toEqual([]);
    }
  });

  it('the name is written with a capital letter: «shop suezzi» next to a restaurant is a handle or a word, «Shop Suezzi» a name', () => {
    expect(kept('shop suezzi ristorante', { name: 'shop suezzi' })).toEqual([]);
    expect(kept('Shop Suezzi ristorante', { name: 'shop suezzi' })).toEqual(['shop suezzi']);
    expect(kept('shop Suezzi ristorante', { name: 'shop suezzi' })).toEqual(['shop suezzi']);
    expect(kept('Shop suezzi ristorante', { name: 'shop suezzi' })).toEqual([]);   // the capital letter of the venue word is not the capital letter of a name
    expect(kept('📍 volt club milano', { name: 'Volt Club Milano' })).toEqual([]);
    expect(kept('📍 Volt club milano', { name: 'Volt Club Milano' })).toEqual(['Volt Club Milano']);
  });

  it('a venue word inside an account does not count: «@ristorante_da_gennaro»', () => {
    expect(kept('Club Gennaro @ristorante_da_gennaro', { name: NAME })).toEqual([]);
    expect(kept('Club Gennaro ristorante @ristorante_da_gennaro', { name: NAME })).toEqual([NAME]);
  });
});

describe('the evidence gate (3): the name has no venue word and needs two signs, a strong word AND a mark of a place, and a capital letter', () => {
  const NAME = 'Da Gennaro';

  it('a strong word alone is no venue: a brand, a film, a wine, a person next to «ristorante», «bakery», «cantine», «hotels»', () => {
    for (const text of ['Maison Roussel, a Paris bakery', 'Il film Temple of Dreams. HOTELS Temple of Dreams HOTELS', 'Moscato di Saracena prodotto dalle cantine del Pollino', 'Massimo Bottura, il ristorante più premiato']) {
      const name = text.startsWith('Maison') ? 'Maison Roussel' : text.startsWith('Il film') ? 'Temple of Dreams' : text.startsWith('Moscato') ? 'Moscato di Saracena' : 'Massimo Bottura';
      expect(kept(text, { name }), name).toEqual([]);
    }
    expect(kept(`ristorante ${NAME}`, { name: NAME })).toEqual([]);
    expect(kept(`${NAME} ristorante`, { name: NAME })).toEqual([]);
  });

  it('a mark alone is no venue: a radio station, a fairground, a dish next to a pin', () => {
    expect(kept('📍 Da Gennaro', { name: NAME })).toEqual([]);
    expect(kept('Da Gennaro 📍', { name: NAME, kind: 'pizzeria' })).toEqual([]);
    expect(kept('Ascolta la radio 📍 Fiera Milano Rho', { name: 'Fiera Milano Rho', kind: 'hotel' })).toEqual([]);
  });

  it('both signs, near: the venue', () => {
    expect(kept('ristorante 📍 Da Gennaro', { name: NAME })).toEqual([NAME]);
    expect(kept('📍 Da Gennaro, pizzeria', { name: NAME })).toEqual([NAME]);
    expect(kept('Dal ristorante Da Gennaro, Via Toledo 12, Napoli', { name: NAME })).toEqual([NAME]);
  });

  it('the strong word reaches 120 characters on each side (with the mark right there on the other side), edges included, and not 121', () => {
    for (const gap of [119, 120]) {
      expect(kept(`ristorante ${'x'.repeat(gap - 2)} ${NAME} 📍`, { name: NAME }), `before ${gap}`).toEqual([NAME]);
      expect(kept(`📍 ${NAME} ${'x'.repeat(gap - 2)} ristorante`, { name: NAME }), `after ${gap}`).toEqual([NAME]);
    }
    for (const gap of [121, 122, 300]) {
      expect(kept(`ristorante ${'x'.repeat(gap - 2)} ${NAME} 📍`, { name: NAME }), `before ${gap}`).toEqual([]);
      expect(kept(`📍 ${NAME} ${'x'.repeat(gap - 2)} ristorante`, { name: NAME }), `after ${gap}`).toEqual([]);
    }
  });

  it('the mark reaches 120 characters on each side (with the strong word right there on the other side), edges included, and not 121', () => {
    for (const gap of [119, 120]) {
      expect(kept(`📍 ${'x'.repeat(gap - 2)} ${NAME} ristorante`, { name: NAME }), `before ${gap}`).toEqual([NAME]);
      expect(kept(`ristorante ${NAME} ${'x'.repeat(gap - 2)} 📍`, { name: NAME }), `after ${gap}`).toEqual([NAME]);
    }
    for (const gap of [121, 122, 300]) {
      expect(kept(`📍 ${'x'.repeat(gap - 2)} ${NAME} ristorante`, { name: NAME }), `before ${gap}`).toEqual([]);
      expect(kept(`ristorante ${NAME} ${'x'.repeat(gap - 2)} 📍`, { name: NAME }), `after ${gap}`).toEqual([]);
    }
  });

  it('the kind is the one of the strong word: the nearest, the first of two at the same distance, whatever the model said', () => {
    expect(keptKind('hotel Da Gennaro pizzeria 📍', NAME, 'bar')).toBe('hotel');
    expect(keptKind('pizzeria Da Gennaro hotel 📍', NAME, 'bar')).toBe('pizzeria');
    expect(keptKind(`pizzeria ${'x'.repeat(50)} ${NAME} ${'x'.repeat(10)} hotel 📍`, NAME, 'bar')).toBe('hotel');
    expect(keptKind(`hotel ${'x'.repeat(10)} ${NAME} ${'x'.repeat(50)} pizzeria 📍`, NAME, 'bar')).toBe('hotel');
    expect(keptKind(`hotel ${'x'.repeat(50)} ${NAME} ${'x'.repeat(10)} pizzeria 📍`, NAME, 'bar')).toBe('pizzeria');
    expect(keptKind(`pizzeria ${'x'.repeat(10)} ${NAME} ${'x'.repeat(50)} hotel 📍`, NAME, 'bar')).toBe('pizzeria');
  });

  it('the distance of the evidence is the farthest of the two signs it needed', () => {
    expect(explain(`📍 ${NAME} ${'x'.repeat(58)} ristorante`, NAME)).toMatchObject({ evidence: 'near', distance: 60, kind: 'restaurant' });
    expect(explain(`ristorante ${NAME} ${'x'.repeat(38)} 📍`, NAME)).toMatchObject({ evidence: 'near', distance: 40, kind: 'restaurant' });
    expect(explain(`ristorante ${'x'.repeat(28)} ${NAME} ${'x'.repeat(78)} 📍`, NAME)).toMatchObject({ distance: 80 });
  });

  it.each(STRONG_WORDS)('«%s» next to a name, with a pin, is a venue of kind %s, whatever the model said', (word, kind) => {
    expect(keptKind(`📍 ${word} Da Gennaro`, NAME, otherKind(kind))).toBe(kind);
    expect(keptKind(`Da Gennaro 📍 ${capitalised(word)}`, NAME, otherKind(kind))).toBe(kind);
  });

  it.each([...COMMON_WORDS, ...WEAK_WORDS])('«%s» next to a name, with a pin, is NOT a sign (kind %s would be too common)', (word) => {
    expect(kept(`📍 ${word} Da Gennaro`, { name: NAME })).toEqual([]);
    expect(kept(`Da Gennaro 📍 ${word}`, { name: NAME })).toEqual([]);
  });

  it('the name is written with a capital letter at least once (at least one of its words): a dish, a word of the sentence is not a venue', () => {
    expect(kept('ristorante 📍 carpione', { name: 'Carpione' })).toEqual([]);
    expect(kept('Cena al ristorante 📍 carpione', { name: 'Carpione' })).toEqual([]);   // a capital letter elsewhere in the text is not the name's
    expect(kept('ristorante 📍 Carpione', { name: 'carpione' })).toEqual(['carpione']);
    expect(kept('ristorante 📍 da Gennaro', { name: NAME })).toEqual([NAME]);
    expect(kept('ristorante 📍 da gennaro', { name: NAME })).toEqual([]);
    expect(kept('ristorante 📍 DA GENNARO', { name: NAME })).toEqual([NAME]);
    expect(kept('ristorante 📍 da gennaro e poi Da Gennaro', { name: NAME })).toEqual([NAME]);
    expect(kept('ristorante 📍 24 luglio', { name: '24 Luglio' })).toEqual([]);
  });

  it('an account is neither a venue word nor a name: «@ristorante_da_gennaro», «@DaGennaro»', () => {
    expect(kept('📍 Da Gennaro @ristorante_da_gennaro', { name: NAME })).toEqual([]);
    expect(kept('📍 Da Gennaro ristorante @ristorante_da_gennaro', { name: NAME })).toEqual([NAME]);
    // the whole account goes: its underscores, its dots, its digits too
    expect(kept('📍 Da Gennaro @ba_restaurant', { name: NAME })).toEqual([]);
    expect(kept('📍 Da Gennaro @dagennaro.ristorante', { name: NAME })).toEqual([]);
    expect(kept('📍 Da Gennaro @Ristorante_2', { name: NAME })).toEqual([]);
    expect(kept('📍 ristorante @DaGennaro', { name: 'DaGennaro' })).toEqual([]);
    expect(kept('📍 ristorante @DaGennaro DaGennaro', { name: 'DaGennaro' })).toEqual(['DaGennaro']);
    expect(kept('📍 ristorante @info@dagennaro.it Da Gennaro', { name: NAME })).toEqual([NAME]);
  });

  it('the name can be written more than once: the nearest of its places counts, for each of the two signs', () => {
    const far = 'x'.repeat(300);
    expect(kept(`${NAME} ${far} 📍 ristorante ${NAME}`, { name: NAME })).toEqual([NAME]);
    expect(kept(`📍 ristorante ${NAME} ${far} ${NAME}`, { name: NAME })).toEqual([NAME]);
    expect(kept(`${NAME} ${far} 📍 ristorante ${far} ${NAME}`, { name: NAME })).toEqual([]);
  });

  it('a name that overlaps itself («Luce Luce» in «Luce Luce Luce») is written at two places, and the nearer one counts', () => {
    // «Luce Luce» ends 5 characters nearer to the word at its second place: 120 away there, 125 at the first
    expect(kept(`📍 Luce Luce Luce ${'x'.repeat(118)} ristorante`, { name: 'Luce Luce' })).toEqual(['Luce Luce']);
    expect(kept(`📍 Luce Luce Luce ${'x'.repeat(119)} ristorante`, { name: 'Luce Luce' })).toEqual([]);
  });

  it('a strong word is not found inside another word: «bottegai», «hoteldieu», «cantinaro», «ristorantissimo»', () => {
    for (const word of ['bottegai', 'hoteldieu', 'cantinaro', 'ristorantissimo']) expect(kept(`📍 ${word} Da Gennaro`, { name: NAME }), word).toEqual([]);
  });

  it('a software post that talks about a «libreria», an «App Store» or a «mercato» has no venues', () => {
    expect(kept('Installa la libreria Perplexity con pip', { name: 'Perplexity', kind: 'shop' })).toEqual([]);
    expect(kept('Perplexity è nell\'App Store e nel Play Store', { name: 'Perplexity', kind: 'shop' })).toEqual([]);
    expect(kept('Il mercato dell\'AI: Perplexity e Mistral', { name: 'Perplexity', kind: 'shop' })).toEqual([]);
  });

  it('a list of restaurants with no address and no pin («i ristoranti da provare a Roma: Roscioli, Da Enzo») gives none: the gate wants two signs, a missed venue beats a wrong one', () => {
    const text = 'I ristoranti da provare a Roma: Roscioli, Da Enzo, Felice a Testaccio e Armando al Pantheon. Prenotate!';
    expect(kept(text, ...['Roscioli', 'Da Enzo', 'Felice a Testaccio', 'Armando al Pantheon'].map((name) => ({ name })))).toEqual([]);
  });

  it('a list with a pin or an address for each: the venues, each of the kind of the nearest strong word', () => {
    const text = 'Dove mangiare a Roma: 📍 Roscioli, salumeria, Via dei Giubbonari 21. 📍 Da Enzo al 29, trattoria, Via dei Vascellari 29.';
    const out = parsePlacesAndVenues(answer({ place: 'Roma', venues: [{ name: 'Roscioli', kind: 'other' }, { name: 'Da Enzo al 29', kind: 'other' }] }), text);
    expect(out.venues.map((v) => [v.name, v.kind, v.place])).toEqual([['Roscioli', 'shop', 'Roma'], ['Da Enzo al 29', 'restaurant', 'Roma']]);
  });
});

describe('the evidence gate: the marks of a place (a pin, a street with its number, a table to book, a menu to taste)', () => {
  const NAME = 'Da Gennaro';
  /** A name with a strong word right before it: only the mark varies. */
  const withMark = (mark: string): string => `ristorante ${NAME}, ${mark}`;

  it('the pin 📍', () => {
    expect(kept(withMark('📍'), { name: NAME })).toEqual([NAME]);
    expect(kept('Dove si mangia? ristorante 📍Da Gennaro, Napoli', { name: NAME })).toEqual([NAME]);
    expect(kept(`ristorante ${NAME}, 📌 Napoli`, { name: NAME })).toEqual([]);
  });

  it('a street word, a capitalised name and a house number: «Via Toledo 12», «Piazza del Duomo 3», «Corso Como, 10», «VIA TOLEDO 12»', () => {
    for (const address of ['Via Toledo 12', 'via Toledo 12', 'Via Toledo, 12', 'Via Toledo n. 12', 'Via Toledo n.12', 'Via Toledo 12/A', 'Piazza del Duomo 3', 'Corso Como, 10', 'VIA TOLEDO 12', 'Via Dante Alighieri 12', 'Corso Vittorio Emanuele II, 22', 'Via XX Settembre 5', 'Via Roma 1234']) {
      expect(kept(`ristorante ${NAME} - ${address}, Napoli`, { name: NAME }), address).toEqual([NAME]);
      expect(kept(`${address} ristorante ${NAME}`, { name: NAME }), address).toEqual([NAME]);
    }
  });

  it.each(['via', 'viale', 'piazza', 'piazzale', 'corso', 'largo', 'vicolo', 'lungomare', 'Via', 'Viale', 'Piazza', 'Piazzale', 'Corso', 'Largo', 'Vicolo', 'Lungomare', 'VIA', 'VIALE', 'PIAZZA', 'PIAZZALE', 'CORSO', 'LARGO', 'VICOLO', 'LUNGOMARE'])(
    '«%s» is a street word',
    (street) => {
      expect(kept(withMark(`${street} Garibaldi 7`), { name: NAME })).toEqual([NAME]);
    },
  );

  it.each(['di', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'dal', 'dalla', 'de', 'in'])('«%s» is a small word of a street name, at the start of it or after the first word', (small) => {
    expect(kept(withMark(`Piazza ${small} Popolo 3`), { name: NAME })).toEqual([NAME]);
    expect(kept(withMark(`Via Santa Maria ${small} Popolo 3`), { name: NAME })).toEqual([NAME]);
  });

  it('«dell\'», «dell’», «d\'», «d’» too, glued to the name: «Via dell\'Orto 7», «Via d’Azeglio 6»', () => {
    for (const address of ['Via dell\'Orto 7', 'Via dell’Orto 7', 'Via d\'Azeglio 6', 'Via d’Azeglio 6', 'Via Santa Maria dell\'Anima 3', 'Via Santa Maria dell’Anima 3', 'Via Massimo d\'Azeglio 6']) {
      expect(kept(withMark(address), { name: NAME }), address).toEqual([NAME]);
    }
  });

  it('a street name has up to four words: «Via Aaa Bbb Ccc Ddd 5» yes, «Via Aaa Bbb Ccc Ddd Eee 5» no', () => {
    expect(kept(withMark('Via Aaa Bbb Ccc Ddd 5'), { name: NAME })).toEqual([NAME]);
    expect(kept(withMark('Via Aaa Bbb Ccc Ddd Eee 5'), { name: NAME })).toEqual([]);
  });

  it('the number can be written «n. 12», «n.12», «n° 12», «n 12», «N. 12»; «num. 12» and «numero 12» are not what the street pattern knows', () => {
    for (const number of ['n. 12', 'n.12', 'n° 12', 'n°12', 'n 12', 'N. 12']) expect(kept(withMark(`Via Toledo ${number}`), { name: NAME }), number).toEqual([NAME]);
    for (const number of ['num. 12', 'numero 12']) expect(kept(withMark(`Via Toledo ${number}`), { name: NAME }), number).toEqual([]);
  });

  it('but a street with no number, a street whose name is not capitalised, a number alone, a number of five digits are not an address', () => {
    for (const mark of ['Via Toledo vecchia 12', 'via Toledo a Napoli', 'via email 12', 'via toledo 12', 'via 12', 'Via Roma 12345', 'vialetto Roma 12', 'Pervia Roma 12']) {
      expect(kept(withMark(mark), { name: NAME }), mark).toEqual([]);
    }
  });

  it('a table to book: «prenota un tavolo», «prenotazione del tavolo», «prenota subito un tavolo»; a call or a demo is not a table', () => {
    for (const mark of ['prenota un tavolo al 081 123456', 'prenotare il tavolo con anticipo', 'prenotazione del tavolo obbligatoria', 'prenota subito un tavolo', 'Prenotate un tavolo', 'prenota subito online il tavolo', 'prenotare i tavoli']) {
      expect(kept(withMark(mark), { name: NAME }), mark).toEqual([NAME]);
    }
    for (const mark of ['prenota una demo gratis', 'un tavolo per due', 'prenota una call con il team e poi il tavolo di lavoro', 'tavolo', 'prenota subito online per il tavolo']) {
      expect(kept(withMark(mark), { name: NAME }), mark).toEqual([]);
    }
  });

  it('a menu to taste: «menù degustazione», «menu alla carta», «menu del giorno», «menu fisso», «menu dello chef»; the menu of a program, or «menù» alone, is not', () => {
    for (const menu of ['menù degustazione', 'menu degustazione', 'Menù alla carta', 'menu alla carta', 'menu del giorno', 'menù fisso', 'Menu dello chef', 'MENU  ALLA   CARTA']) {
      expect(kept(withMark(`${menu} di pesce`), { name: NAME }), menu).toEqual([NAME]);
    }
    for (const mark of ['il menu di Cursor', 'apri il menu File', 'il menuetto', 'il menù File', 'menù', 'menu degustazion']) expect(kept(withMark(mark), { name: NAME }), mark).toEqual([]);
  });

  it('every address of the text is a mark, not only the first one', () => {
    expect(kept(`Via Toledo 12 ${'x'.repeat(300)} Via Roma 5 ristorante ${NAME}`, { name: NAME })).toEqual([NAME]);
    expect(kept(`prenota un tavolo ${'x'.repeat(300)} prenota un tavolo ristorante ${NAME}`, { name: NAME })).toEqual([NAME]);
    expect(kept(`menu fisso ${'x'.repeat(300)} menu fisso ristorante ${NAME}`, { name: NAME })).toEqual([NAME]);
    expect(kept(`📍 ${'x'.repeat(300)} 📍 ristorante ${NAME}`, { name: NAME })).toEqual([NAME]);
  });

  it('«indirizzo» alone is not a mark: an email, an IP, a wallet have one', () => {
    expect(kept(withMark('scrivi al mio indirizzo email'), { name: NAME })).toEqual([]);
  });

  it('the street, the table and the menu reach 120 characters too, and not 121', () => {
    for (const cue of ['Via Toledo 12', 'prenota un tavolo', 'menu fisso']) {
      expect(kept(`ristorante ${NAME} ${'x'.repeat(118)} ${cue}`, { name: NAME }), cue).toEqual([NAME]);
      expect(kept(`ristorante ${NAME} ${'x'.repeat(119)} ${cue}`, { name: NAME }), cue).toEqual([]);
      expect(kept(`${cue} ${'x'.repeat(118)} ${NAME} ristorante`, { name: NAME }), cue).toEqual([NAME]);
      expect(kept(`${cue} ${'x'.repeat(119)} ${NAME} ristorante`, { name: NAME }), cue).toEqual([]);
    }
  });

  it('a street with its number before the name has the mark next to it; a name right after an address, in the same line, is not part of it', () => {
    expect(kept('ristorante Via Toledo 12 Da Gennaro', { name: NAME })).toEqual([NAME]);
  });
});

describe('explainPlacesAndVenues: why each candidate was kept or dropped (to check the gate on real posts)', () => {
  it('gives the reason for each candidate, and what the evidence was for those kept', () => {
    const gap = ` ${'x'.repeat(200)} `;
    const text = ['Trattoria dei Navigli e il ristorante nuovo. Milano.', 'Cursor.', 'Da Mario al Duomo no.', 'Claude.ai', '📍 Da Gennaro ristorante', 'Club Pino ristorante', 'Club Gigi'].join(gap);
    const out = explainPlacesAndVenues(
      answer({ place: null, venues: [
        { name: 'Trattoria dei Navigli', kind: 'bar' },
        { name: 'Cursor', kind: 'cafe' },
        { name: 'Da Mario al Duomo Antico', kind: 'bar' },
        { name: 'il ristorante nuovo', kind: 'restaurant' },
        { name: 'Milano', kind: 'restaurant' },
        { name: 'Claude.ai', kind: 'hotel' },
        { name: 'Da Gennaro', kind: 'bar' },
        { name: 'Club Pino', kind: 'hotel' },
        { name: 'Club Gigi', kind: 'bar' },
        { name: 'A', kind: 'bar' },
        'x',
      ] }),
      text,
    );
    expect(out.map((v) => [v.name, v.kept, v.reason, v.evidence, v.kind])).toEqual([
      ['Trattoria dei Navigli', true, null, 'name', 'restaurant'],
      ['Cursor', false, 'evidence', null, null],
      ['Da Mario al Duomo Antico', false, 'not_in_text', null, null],
      ['il ristorante nuovo', false, 'generic', null, null],
      ['Milano', false, 'place', null, null],
      ['Claude.ai', false, 'junk', null, null],
      ['Da Gennaro', true, null, 'near', 'restaurant'],
      ['Club Pino', true, null, 'near', 'bar'],
      ['Club Gigi', false, 'evidence', null, null],
      ['A', false, 'name', null, null],
      ['', false, 'shape', null, null],
    ]);
  });

  it('is the same decision as parsePlacesAndVenues (the venues kept are the same names, once each)', () => {
    const text = `Osteria Roscioli, Osteria Da Enzo, Osteria Roscioli. ${'x'.repeat(200)} Cursor`;
    const raw = answer({ place: 'Roma', venues: ['Osteria Roscioli', 'Osteria Da Enzo', 'Osteria Roscioli', 'Cursor'].map((name) => ({ name, kind: 'bar' })) });
    const explained = explainPlacesAndVenues(raw, text).filter((v) => v.kept).map((v) => v.name);
    expect([...new Set(explained)]).toEqual(parsePlacesAndVenues(raw, text).venues.map((v) => v.name));
  });

  it('a broken answer explains nothing', () => {
    for (const raw of ['', '{"place":', '[]', 'null', '"x"', answer({ place: null, venues: 'molti' }), answer({ place: null })]) expect(explainPlacesAndVenues(raw, 'ristorante').length, raw).toBe(0);
  });

  it('says how far the evidence reached: null when the name itself said it or when the venue was dropped', () => {
    expect(explain('Trattoria dei Navigli', 'Trattoria dei Navigli').distance).toBeNull();
    expect(explain(`ristorante ${'x'.repeat(200)} Club Gennaro`, 'Club Gennaro').distance).toBeNull();
    expect(explain('Club Gennaro ristorante', 'Club Gennaro').distance).toBe(1);
  });
});

describe('venueCuesIn: the venue words and the marks a text has (to pick the posts to look at with the gate\'s own words)', () => {
  it('lists the strong, the common and the weak words in the order of the text, in folded form, and counts the marks; an account has none', () => {
    expect(venueCuesIn('Dal Ristorante Da Gennaro al Bar Luce, Caffè Roma: hotel B&B @ristorante_x. 📍 Via Toledo 12, prenota un tavolo. Menù degustazione')).toEqual({
      strong: ['ristorante', 'hotel', 'b b'],
      common: ['bar'],
      weak: ['caffe'],
      marks: 7,   // the pin (1), and a mark before and after each of the street, the table and the menu (3 x 2)
    });
  });

  it('is empty for a text with none, and never throws', () => {
    expect(venueCuesIn('Ho provato Claude Code su tre repository')).toEqual({ strong: [], common: [], weak: [], marks: 0 });
    expect(venueCuesIn('')).toEqual({ strong: [], common: [], weak: [], marks: 0 });
  });
});

describe('PLACES_RULES_VERSION: a change of the rules reads the posts again', () => {
  it('is a whole number, 2 or more (1 was the first reading, with no gate)', () => {
    expect(Number.isInteger(PLACES_RULES_VERSION)).toBe(true);
    expect(PLACES_RULES_VERSION).toBeGreaterThanOrEqual(2);
  });
});

describe('placesSourceText: the text the model reads and the text every answer is checked against (one and the same)', () => {
  it('joins the caption, the summary, the tags, the notes, the transcript and the text on the screen', () => {
    const text = placesSourceText({ ...SOURCE, transcript: 'parlato del video' });
    for (const part of ['Ecco i ristoranti nuovi da provare su Milano', 'Tre locali di Milano', 'milano food', 'Trattoria dei Navigli', 'parlato del video', 'Osteria dell\'Orto']) expect(text).toContain(part);
  });

  it('leaves the placeholder tags out and is empty when there is nothing', () => {
    expect(placesSourceText(SOURCE)).not.toContain('@utente');
    expect(placesSourceText(SOURCE)).not.toContain('#tag');
    expect(placesSourceText({ caption: null, summary: null, tags: [], notes: [] })).toBe('');
    expect(placesSourceText({ caption: '  ', summary: '', tags: ['#tag'], notes: [''] })).toBe('');
  });

  it('is cut: a very long transcript does not make a very long prompt', () => {
    const text = placesSourceText({ caption: 'x'.repeat(5000), summary: 'y'.repeat(5000), tags: [], notes: Array.from({ length: 10 }, () => 'n'.repeat(5000)), transcript: 't'.repeat(9000), ocr: 'o'.repeat(9000) });
    expect(text.length).toBeLessThan(9000);
    // every part is cut on its own: the caption is not the whole budget
    expect(text).toContain('y'.repeat(100));
    expect(text).toContain('t'.repeat(100));
    expect(text).toContain('o'.repeat(100));
  });

  it('is the same for the same source (the caller hashes it)', () => {
    expect(placesSourceText(SOURCE)).toBe(placesSourceText({ ...SOURCE }));
    expect(placesSourceText(SOURCE)).not.toBe(placesSourceText({ ...SOURCE, caption: 'altro' }));
  });
});

describe('buildPlacesPrompt', () => {
  it('is in Italian, has the examples of the spec and the text of the post', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    expect(prompt).toContain('Esempio 1');
    expect(prompt).toContain('Esempio 2');
    expect(prompt).toContain('ecco i ristoranti nuovi da provare su Milano');
    expect(prompt).toContain('"venues":[]');
    expect(prompt).toContain('CONTENUTO');
    expect(prompt).toContain('Trattoria dei Navigli');
  });

  it('asks only for what the text says, and no coordinates', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    expect(prompt).toMatch(/non inventare|Non inventarlo|non inventare/i);
    expect(prompt).not.toMatch(/latitudine|longitudine|coordinat/i);
  });

  it('says what a venue is: a physical place to go and eat, drink, sleep or shop', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    for (const word of ['ristoranti', 'pizzerie', 'bar', 'caffè', 'hotel', 'rifugi', 'cantine', 'negozi', 'andare di persona']) expect(prompt, word).toContain(word);
  });

  it('says what a venue is NOT: apps, software, AI tools, sites, repositories, brands, products, companies, people, accounts, artists, bands, books, films, songs, institutions, platforms', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    for (const word of [
      'app', 'software', 'intelligenza artificiale', 'siti web', 'repository GitHub', 'marchi', 'prodotti', 'aziende', 'persone', 'account social', '@nome', 'nome utente',
      'artisti', 'gruppi musicali', 'libri', 'film', 'canzoni', 'album', 'università', 'istituzioni', 'piattaforma',
    ]) {
      expect(prompt, word).toContain(word);
    }
    expect(prompt).toMatch(/NON sono locali/);
  });

  it('says that most posts have no venue at all and that [] is then the right answer', () => {
    expect(buildPlacesPrompt(SOURCE)).toMatch(/La maggior parte dei post non nomina nessun locale/);
  });

  it('has the negative examples: a post on Claude Code and GitHub repositories, one on Pink Floyd albums, one that credits «@kirtandopamine on X»: all answer "venues":[]', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    const examples = prompt.slice(prompt.indexOf('Esempio 1')).split('CONTENUTO:\n' + SOURCE.caption)[0].split(/\n\n(?=Esempio \d)/);
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const [marker, also] of [['Claude Code', 'repository GitHub'], ['Pink Floyd', 'album'], ['@kirtandopamine', 'su X']]) {
      const example = examples.find((e) => e.includes(marker));
      expect(example, marker).toBeDefined();
      expect(example, marker).toContain(also);
      expect(example, marker).toMatch(/RISPOSTA:\n\{"place":(?:null|"[^"]+"),"venues":\[\]\}/);
    }
    // the examples that name venues are still there
    expect(examples.some((e) => e.includes('Trattoria Da Gigi') && e.includes('"kind":"restaurant"'))).toBe(true);
  });

  it('does not offer the kind «other»: it is how everything else got in', () => {
    const prompt = buildPlacesPrompt(SOURCE);
    expect(prompt).not.toMatch(/\bother\b|oppure other/);
    for (const kind of ['restaurant', 'pizzeria', 'bar', 'cafe', 'hotel', 'refuge', 'winery', 'shop']) expect(prompt, kind).toContain(kind);
  });
});

describe('the schema', () => {
  it('asks for a place (or null) and a list of venues with a name, a kind of the list and an optional city', () => {
    expect(PLACES_SCHEMA.required).toEqual(['place', 'venues']);
    expect(PLACES_SCHEMA.properties.venues.items.required).toEqual(['name', 'kind']);
  });

  it('offers the eight kinds of a place that exists, NOT «other» (which stays in VENUE_KINDS for the rows stored before)', () => {
    expect(PLACES_SCHEMA.properties.venues.items.properties.kind.enum).toEqual(['restaurant', 'pizzeria', 'bar', 'cafe', 'hotel', 'refuge', 'winery', 'shop']);
    expect(PLACES_SCHEMA.properties.venues.items.properties.kind.enum).toEqual(VENUE_KINDS.filter((kind) => kind !== 'other'));
    expect(VENUE_KINDS).toContain('other');
  });
});

describe('generatePlacesAndVenues: ONE call, never throws', () => {
  const good: PlacesGenerateFn = async () => ({
    text: answer({ place: 'Milan', venues: [{ name: 'Trattoria dei Navigli', kind: 'restaurant', city: null }] }),
    usageMetadata: null,
    truncated: false,
  });

  it('asks the local model once, with the schema and a short ceiling, and returns the place and the venues of the answer', async () => {
    const generate = vi.fn(good);
    const out = await generatePlacesAndVenues(SOURCE, { generate });
    expect(generate).toHaveBeenCalledTimes(1);
    const [prompt, images, opts] = generate.mock.calls[0];
    expect(prompt).toContain('Trattoria dei Navigli');
    expect(images).toEqual([]);
    expect(opts.json).toBe(true);
    expect(opts.schema).toBe(PLACES_SCHEMA);
    expect(opts.maxTokens).toBeGreaterThan(0);
    expect(opts.maxTokens).toBeLessThanOrEqual(1500);
    expect(out).toEqual({
      place: { name: 'Milano', kind: 'city' },
      venues: [{ name: 'Trattoria dei Navigli', kind: 'restaurant', place: 'Milano', key: venueKey('Trattoria dei Navigli', 'Milano') }],
    });
  });

  it('an answer that is not usable JSON is «no place, no venues» (a broken JSON is no place), not a failure', async () => {
    const generate: PlacesGenerateFn = async () => ({ text: '{"place": "Mil', usageMetadata: null, truncated: false });
    expect(await generatePlacesAndVenues(SOURCE, { generate })).toEqual({ place: null, venues: [] });
  });

  it('a call that fails is null (the caller tries again later), never an exception', async () => {
    const boom: PlacesGenerateFn = async () => { throw new Error('router asleep'); };
    expect(await generatePlacesAndVenues(SOURCE, { generate: boom })).toBeNull();
    const never: PlacesGenerateFn = () => { throw new Error('sync boom'); };
    expect(await generatePlacesAndVenues(SOURCE, { generate: never })).toBeNull();
  });

  it('an answer that was cut is «no place, no venues», an ANSWER the caller records: a long list of venues is what gets cut, and asking again every night costs about forty seconds each time for nothing', async () => {
    const cut: PlacesGenerateFn = async () => ({ text: '{"place":"Milano","venues":[', usageMetadata: null, truncated: true });
    expect(await generatePlacesAndVenues(SOURCE, { generate: cut })).toEqual({ place: null, venues: [] });
    // the flag decides, not what the half answer happens to parse to: a cut answer is never read, even if it looks whole
    const looksWhole: PlacesGenerateFn = async () => ({ text: '{"place":"Milano","venues":[]}', usageMetadata: null, truncated: true });
    expect(await generatePlacesAndVenues(SOURCE, { generate: looksWhole })).toEqual({ place: null, venues: [] });
    expect(await generatePlacesAndVenues(SOURCE, { generate: async () => ({ text: '{"place":"Milano","venues":[]}', usageMetadata: null, truncated: false }) })).toEqual({ place: { name: 'Milano', kind: 'city' }, venues: [] });
  });

  it('with no text there is nothing to read: null, and the model is not asked', async () => {
    const generate = vi.fn(good);
    expect(await generatePlacesAndVenues({ caption: null, summary: null, tags: [], notes: [] }, { generate })).toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });

  it('checks every word of the answer against the text the model was given (the venues of ANOTHER post are dropped)', async () => {
    const lies: PlacesGenerateFn = async () => ({
      text: answer({ place: 'Roma', venues: [{ name: 'Trattoria dei Navigli', kind: 'restaurant' }, { name: 'Da Cesare al Casaletto', kind: 'restaurant' }] }),
      usageMetadata: null,
      truncated: false,
    });
    const out = await generatePlacesAndVenues(SOURCE, { generate: lies });
    expect(out?.place).toBeNull();
    expect(out?.venues.map((v) => v.name)).toEqual(['Trattoria dei Navigli']);
  });
});
