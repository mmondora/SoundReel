/**
 * The places a post can be about (collections, spec 2026-11-09-library-collections-auto-topics-design.md §4.3, ADR-0022).
 *
 * A place is accepted for an entry only when it is in THIS list and its name (or one of its other written forms) really appears in the
 * text of the entry: «Montagne de Reims» from a post about wine that does not name it, «Luogo» → Cremona and «Montagna» → Reims (what the
 * geocoding of the old notes did) are not places. Names only: no coordinates anywhere (the link to Google Maps starts from the name).
 *
 * Written as `Name|alias|alias` for brevity. The name is how the place is stored and shown (Italian); the aliases are other written forms
 * that the text can use («Milan» for Milano, «Friuli» for Friuli-Venezia Giulia, «USA» for Stati Uniti). A leading `*` marks a name that is
 * also a common word (prato, latina, brindisi, potenza, noto, fermo…): in a text it counts only when it is written with a capital letter
 * or as a hashtag. An alias written all in capitals («USA», «UK») is an acronym and counts only in capitals («usa» is a verb).
 * No written form (without case, accents and punctuation) may belong to two places: the test of this file checks it.
 */

export type PlaceKind = 'city' | 'region' | 'country';

export interface Place {
  /** The canonical name: what is stored and shown. */
  name: string;
  kind: PlaceKind;
  /** Other written forms: another language («Milan»), a short form («Friuli»), an acronym («USA»). */
  aliases: string[];
  /** The name is also a common word: it counts only when written with a capital letter or as a hashtag. */
  ambiguous?: boolean;
}

function place(spec: string, kind: PlaceKind): Place {
  const ambiguous = spec.startsWith('*');
  const [name, ...aliases] = (ambiguous ? spec.slice(1) : spec).split('|');
  return ambiguous ? { name, kind, aliases, ambiguous: true } : { name, kind, aliases };
}

// ---------- the 20 Italian regions ----------
const REGIONS: string[] = [
  'Piemonte|Piedmont', "Valle d'Aosta|Val d'Aosta|Aosta Valley|Vallée d'Aoste", 'Lombardia|Lombardy',
  'Trentino-Alto Adige|Trentino|Alto Adige|Sudtirol', 'Veneto', 'Friuli-Venezia Giulia|Friuli|FVG', 'Liguria',
  'Emilia-Romagna|Romagna', 'Toscana|Tuscany', 'Umbria', '*Marche', 'Lazio', 'Abruzzo|Abruzzi', 'Molise', 'Campania',
  'Puglia|Apulia', 'Basilicata|Lucania', 'Calabria', 'Sicilia|Sicily', 'Sardegna|Sardinia',
];

// ---------- the 107 provincial capitals ----------
const PROVINCIAL_CAPITALS: string[] = [
  // Piemonte
  'Torino|Turin', 'Alessandria', 'Asti', '*Biella', 'Cuneo', 'Novara', 'Verbania', 'Vercelli',
  // Valle d'Aosta
  'Aosta',
  // Lombardia
  'Milano|Milan', 'Bergamo', 'Brescia', 'Como', 'Cremona', 'Lecco', '*Lodi', 'Mantova|Mantua', 'Monza', 'Pavia', 'Sondrio', 'Varese',
  // Trentino-Alto Adige
  'Trento', 'Bolzano|Bozen',
  // Veneto
  'Venezia|Venice', 'Belluno', 'Padova|Padua', 'Rovigo', 'Treviso', 'Verona', 'Vicenza',
  // Friuli-Venezia Giulia
  'Trieste', 'Gorizia', 'Pordenone', 'Udine',
  // Liguria
  'Genova|Genoa', 'Imperia', 'La Spezia|Spezia', 'Savona',
  // Emilia-Romagna
  'Bologna', 'Ferrara', 'Forlì', 'Modena', 'Parma', 'Piacenza', 'Ravenna', "Reggio Emilia|Reggio nell'Emilia", 'Rimini',
  // Toscana
  'Firenze|Florence', 'Arezzo', 'Grosseto', 'Livorno|Leghorn', 'Lucca', '*Massa', 'Pisa', 'Pistoia', '*Prato', 'Siena',
  // Umbria
  'Perugia', 'Terni',
  // Marche
  'Ancona', 'Ascoli Piceno', '*Fermo', 'Macerata', 'Pesaro',
  // Lazio
  'Roma|Rome', 'Frosinone', '*Latina', 'Rieti', 'Viterbo',
  // Abruzzo
  "*L'Aquila|Aquila", 'Chieti', 'Pescara', 'Teramo',
  // Molise
  'Campobasso', 'Isernia',
  // Campania
  'Napoli|Naples', 'Avellino', 'Benevento', 'Caserta', 'Salerno',
  // Puglia
  'Bari', 'Barletta', '*Brindisi', '*Foggia', 'Lecce', 'Taranto',
  // Basilicata
  '*Potenza', 'Matera',
  // Calabria
  'Catanzaro', 'Cosenza', 'Crotone', 'Reggio Calabria|Reggio di Calabria', 'Vibo Valentia',
  // Sicilia
  'Palermo', 'Agrigento', 'Caltanissetta', 'Catania', 'Enna', 'Messina', 'Ragusa', 'Siracusa|Syracuse', 'Trapani',
  // Sardegna
  'Cagliari', 'Sassari', 'Nuoro', 'Oristano', 'Carbonia',
];

// ---------- other Italian towns people name in posts (holiday towns, wine and food towns, big towns that are not a capital) ----------
const OTHER_ITALIAN_TOWNS: string[] = [
  // Piemonte
  'Stresa', '*Alba', 'Acqui Terme', 'Casale Monferrato', 'Domodossola', 'Ivrea', 'Pinerolo', 'Sestriere', 'Bardonecchia',
  'Orta San Giulio', 'Cannobio', 'Moncalieri', 'Chieri', 'Saluzzo', 'Mondovì', 'Barolo', 'La Morra', 'Canelli', 'Nizza Monferrato',
  'Susa', 'Arona', 'Omegna', 'Borgomanero',
  // Valle d'Aosta
  'Courmayeur', 'Cervinia|Breuil-Cervinia', 'Cogne', 'Gressoney-Saint-Jean', 'La Thuile', 'Saint-Vincent',
  // Lombardia
  'Bellagio', 'Sirmione', 'Desenzano del Garda', 'Salò', 'Gardone Riviera', 'Limone sul Garda', 'Varenna', 'Menaggio', 'Tremezzo',
  'Cernobbio', 'Livigno', 'Bormio', 'Madesimo', 'Tirano', 'Chiavenna', 'Morbegno', 'Berbenno di Valtellina', 'Ponte in Valtellina',
  'Talamona', 'Aprica', 'Teglio', 'Vigevano', 'Legnano', 'Busto Arsizio', 'Gallarate', 'Saronno', 'Rho', 'Sesto San Giovanni',
  'Cinisello Balsamo', 'Abbiategrasso', '*Crema', 'Iseo', 'Lovere', 'Sarnico', 'Treviglio', 'Seregno', 'Desio', 'Cantù', '*Erba',
  'Clusone', 'Rozzano', 'San Donato Milanese', 'Segrate', 'Lissone', 'Castiglione delle Stiviere', 'Montichiari', 'Gargnano',
  'Lonato del Garda', 'Manerba del Garda', 'Toscolano-Maderno',
  // Trentino-Alto Adige
  'Merano|Meran', 'Bressanone|Brixen', 'Brunico|Bruneck', 'Vipiteno|Sterzing', 'San Candido|Innichen', 'Dobbiaco|Toblach', 'Ortisei',
  'Selva di Val Gardena', 'Madonna di Campiglio', 'Riva del Garda', 'Rovereto', '*Arco', 'Cavalese', 'Canazei', 'Pinzolo', 'Moena',
  'Folgaria', 'Levico Terme', 'Molveno', 'Corvara in Badia', 'Caldaro|Kaltern', 'Termeno|Tramin',
  // Veneto
  "*Cortina d'Ampezzo|Cortina", 'Bassano del Grappa', 'Chioggia', 'Jesolo', 'Asolo', 'Conegliano', 'Valdobbiadene', '*Soave',
  'Lazise', 'Peschiera del Garda', 'Bardolino', 'Caorle', 'Bibione', 'Mestre', 'Montebelluna', 'Schio', 'Thiene', '*Cittadella',
  'Abano Terme', 'Montegrotto Terme', 'Arquà Petrarca', 'Garda', 'Malcesine', 'Torri del Benaco', 'Sottomarina', 'Cavallino-Treporti',
  'Feltre', 'Auronzo di Cadore', 'Vittorio Veneto', 'Castelfranco Veneto', 'Marostica', 'Oderzo',
  // Friuli-Venezia Giulia
  'Lignano Sabbiadoro', '*Grado', 'Cividale del Friuli', 'Aquileia', 'Tarvisio', 'Sacile', 'Palmanova', 'San Daniele del Friuli',
  'Gemona del Friuli', 'Cormons', 'Monfalcone', 'Duino', 'Sappada', 'Spilimbergo', 'Muggia',
  // Liguria
  'Sanremo|San Remo', 'Portofino', 'Santa Margherita Ligure', 'Rapallo', 'Camogli', 'Chiavari', 'Lerici', 'Portovenere|Porto Venere',
  'Levanto', 'Monterosso al Mare', 'Vernazza', 'Manarola', 'Riomaggiore', 'Corniglia', 'Alassio', 'Finale Ligure', 'Albenga',
  'Bordighera', 'Ventimiglia', 'Diano Marina', 'Laigueglia', 'Varazze', 'Celle Ligure', 'Sestri Levante', '*Lavagna', 'Recco', 'Zoagli',
  'Bogliasco', 'Pietra Ligure', 'Loano', 'Sarzana', 'Dolceacqua', '*Cervo',
  // Emilia-Romagna
  'Cesena', 'Faenza', 'Imola', 'Riccione', '*Cattolica', 'Cesenatico', '*Carpi', 'Sassuolo', 'Cervia', 'Comacchio', 'Bobbio', 'Fidenza',
  'Salsomaggiore Terme', 'Bertinoro', 'Santarcangelo di Romagna', 'Bellaria-Igea Marina', 'Misano Adriatico', 'Dozza', 'Brisighella',
  "Castell'Arquato", 'Busseto', 'Vignola', 'Maranello', '*Cento', 'Argenta', 'Lugo', 'Scandiano', 'Guastalla', 'Correggio', 'Mirandola',
  'San Leo', 'Bagnacavallo',
  // Toscana
  'San Gimignano', 'Montepulciano', 'Montalcino', 'Cortona', 'Volterra', 'Viareggio', 'Forte dei Marmi', 'Pienza', 'Carrara',
  'Empoli', 'Piombino', 'Portoferraio', 'Porto Ercole', 'Porto Santo Stefano', 'Castiglione della Pescaia', 'Greve in Chianti',
  'Radda in Chianti', 'Castellina in Chianti', 'Gaiole in Chianti', 'Montecatini Terme', 'Pietrasanta', 'Camaiore', 'Follonica',
  'Orbetello', 'Capalbio', 'Massa Marittima', "Colle di Val d'Elsa", 'Poppi', 'Bibbiena', 'Sansepolcro', 'Anghiari', 'Certaldo',
  '*Vinci', 'San Miniato', 'Pontedera', '*Cecina', 'Bolgheri', 'Suvereto', 'Pitigliano', 'Saturnia', 'Abetone', 'Barga',
  'Castelnuovo di Garfagnana', 'Bagni di Lucca', 'Monteriggioni', 'Fiesole', 'Sesto Fiorentino', 'Scandicci',
  // Umbria
  'Assisi', 'Orvieto', 'Spoleto', 'Gubbio', 'Foligno', 'Todi', 'Narni', 'Spello', 'Norcia', 'Città di Castello', 'Cascia',
  'Montefalco', 'Bevagna', 'Castiglione del Lago', 'Umbertide',
  // Marche
  'Urbino', 'Senigallia', 'Jesi', 'Fano', 'Recanati', 'Loreto', 'San Benedetto del Tronto', 'Civitanova Marche', 'Osimo', '*Camerino',
  'Sirolo', 'Numana', 'Fabriano', 'Corinaldo', 'Gradara', 'Grottammare', "Porto Sant'Elpidio", 'Porto San Giorgio',
  'Falconara Marittima',
  // Lazio
  'Anzio', 'Civitavecchia', 'Tivoli', 'Fiumicino', 'Pomezia', '*Ostia', 'Terracina', 'Sperlonga', 'Gaeta', 'Formia', 'Frascati',
  'Castel Gandolfo', 'Subiaco', 'Anagni', '*Nettuno', 'Cassino', 'Ariccia', 'Albano Laziale', 'Velletri', 'Grottaferrata', 'Bracciano',
  'Cerveteri', 'Tarquinia', 'Ladispoli', 'Sabaudia', 'San Felice Circeo', 'Ponza', 'Ventotene', 'Bolsena', 'Civita di Bagnoregio',
  'Tuscania', 'Montefiascone', '*Fondi', 'Sermoneta',
  // Abruzzo
  'Sulmona', '*Vasto', '*Lanciano', 'Avezzano', 'Roccaraso', 'Giulianova', 'Montesilvano', 'Francavilla al Mare', 'Scanno', 'Silvi',
  'Alba Adriatica', 'Pescasseroli', 'Roseto degli Abruzzi', 'Atri', 'Ortona', 'Celano', 'Rivisondoli', 'Pescocostanzo',
  // Molise
  'Termoli', 'Agnone', 'Larino', 'Venafro',
  // Campania
  'Positano', 'Amalfi', 'Sorrento', '*Capri', 'Ischia', 'Procida', 'Pozzuoli', 'Pompei', 'Ravello', 'Torre del Greco',
  'Castellammare di Stabia', 'Giugliano in Campania', 'Nola', 'Aversa', "Cava de' Tirreni", 'Paestum', 'Agropoli', 'Vietri sul Mare',
  'Maiori', '*Minori', 'Cetara', 'Praiano', 'Massa Lubrense', 'Vico Equense', 'Ercolano', '*Portici', 'Acerra', 'Afragola', 'Casoria',
  'Bacoli', 'Capua', "Sant'Agata de' Goti", 'Castellabate', 'Palinuro', 'Sapri', 'Ariano Irpino',
  // Puglia
  'Alberobello', 'Polignano a Mare', 'Ostuni', 'Otranto', 'Gallipoli', 'Monopoli', 'Martina Franca', 'Trani', 'Andria', 'Molfetta',
  'Altamura', 'Vieste', 'Peschici', 'Locorotondo', 'Cisternino', 'Manfredonia', 'Castellana Grotte', 'Fasano', 'Conversano',
  'Mola di Bari', 'Bisceglie', 'Giovinazzo', 'Santa Maria di Leuca', 'Santa Cesarea Terme', 'Castro', 'Tricase', 'Nardò', 'Galatina',
  '*Maglie', 'Gravina in Puglia', 'Grottaglie', 'Lucera', 'San Giovanni Rotondo', '*Mattinata', 'Rodi Garganico', 'Porto Cesareo',
  'Carovigno', 'Putignano', '*Noci', 'Bitonto', 'Ruvo di Puglia', 'Corato',
  // Basilicata
  'Maratea', 'Melfi', 'Policoro', 'Venosa', 'Pisticci', 'Rionero in Vulture', 'Craco', 'Castelmezzano', 'Pietrapertosa', 'Metaponto',
  'Lauria',
  // Calabria
  'Tropea', 'Scilla', '*Pizzo', 'Soverato', 'Lamezia Terme', 'Gerace', 'Corigliano-Rossano|Rossano', 'Corigliano Calabro',
  'Praia a Mare', 'Scalea', '*Diamante', 'Amantea', 'Paola', 'Ricadi', 'Nicotera', '*Palmi', 'Bagnara Calabra', 'Locri', 'Siderno',
  'Roccella Jonica', 'Cirò Marina', 'Isola di Capo Rizzuto', 'Camigliatello Silano', 'Serra San Bruno', '*Stilo', 'Badolato',
  // Sicilia
  'Taormina', 'Cefalù', '*Noto', 'Modica', 'Marsala', 'Mazara del Vallo', 'Bagheria', '*Gela', 'Vittoria', 'Acireale', 'Lipari',
  'Erice', 'Scicli', 'Ortigia', 'Sciacca', 'Milazzo', 'Giardini Naxos', 'Piazza Armerina', 'Caltagirone', 'Ispica', 'Pozzallo',
  'Marzamemi', 'Scopello', 'San Vito Lo Capo', 'Castellammare del Golfo', 'Favignana', 'Pantelleria', 'Lampedusa', 'Stromboli',
  '*Vulcano', 'Monreale', 'Terrasini', 'Mondello', 'Licata', 'Menfi', 'Castelbuono', 'Savoca', 'Randazzo', 'Linguaglossa', 'Nicolosi',
  'Zafferana Etnea', 'Aci Castello', 'Aci Trezza', 'Augusta', 'Avola', 'Pachino', 'Portopalo di Capo Passero',
  // Sardegna
  'Alghero', 'Olbia', 'Porto Cervo', 'Santa Teresa Gallura', 'Arzachena', 'La Maddalena', 'Stintino', 'Villasimius', 'Castelsardo',
  'Bosa', 'Iglesias', 'Tempio Pausania', 'Dorgali', 'Orosei', 'Cala Gonone', 'San Teodoro', 'Budoni', 'Pula', 'Cabras', 'Muravera',
  'Carloforte', 'Calasetta', "Sant'Antioco", 'Teulada', 'Posada', 'Siniscola', 'Baunei', 'Lanusei', 'Tortolì', 'Arbatax', 'Macomer',
  'Ozieri',
];

// ---------- about 130 major cities of the world ----------
const WORLD_CITIES: string[] = [
  // Europa
  'Parigi|Paris', 'Londra|London', 'Berlino|Berlin', 'Madrid', 'Barcellona|Barcelona', 'Lisbona|Lisbon', 'Amsterdam', 'Rotterdam',
  "L'Aia|The Hague|Den Haag", 'Bruxelles|Brussels', 'Anversa|Antwerp', 'Bruges', 'Vienna|Wien', 'Salisburgo|Salzburg', 'Innsbruck',
  'Praga|Prague', 'Budapest', 'Varsavia|Warsaw', 'Cracovia|Krakow|Cracow', 'Atene|Athens', 'Salonicco|Thessaloniki',
  'Istanbul|Costantinopoli', 'Mosca|Moscow', 'San Pietroburgo|Saint Petersburg|St. Petersburg|Pietroburgo', 'Stoccolma|Stockholm',
  'Copenaghen|Copenhagen', 'Oslo', 'Helsinki', 'Reykjavik', 'Dublino|Dublin', 'Edimburgo|Edinburgh', 'Glasgow', 'Manchester',
  'Liverpool', 'Oxford', 'Cambridge', 'Zurigo|Zurich', 'Ginevra|Geneva|Genève', 'Basilea|Basel', 'Berna|Bern|Berne', 'Lugano',
  'Zermatt', 'St. Moritz|Sankt Moritz|Saint Moritz', 'Monaco di Baviera|Munich|München', 'Francoforte|Frankfurt', 'Amburgo|Hamburg',
  '*Colonia|Cologne|Köln', 'Düsseldorf', 'Stoccarda|Stuttgart', 'Dresda|Dresden', 'Lipsia|Leipzig', 'Norimberga|Nuremberg|Nürnberg',
  'Lione|Lyon', 'Marsiglia|Marseille', '*Nizza|Nice', 'Cannes', 'Bordeaux', 'Strasburgo|Strasbourg', 'Tolosa|Toulouse', 'Nantes',
  'Valencia', 'Siviglia|Seville|Sevilla', 'Granada', 'Bilbao', 'Malaga', 'Ibiza', '*Palma di Maiorca|Palma de Mallorca|Palma',
  '*Porto', 'Dubrovnik', '*Spalato|Split', 'Zagabria|Zagreb', 'Lubiana|Ljubljana', 'Belgrado|Belgrade', 'Sarajevo', 'Tirana', 'Skopje',
  'Sofia', 'Bucarest|Bucharest', 'Tallinn', '*Riga', 'Vilnius', 'Kiev|Kyiv', 'Odessa', 'Leopoli|Lviv', 'Minsk',
  // Americhe
  'New York|NYC|New York City', 'Los Angeles', 'San Francisco', 'Las Vegas', 'Miami', 'Chicago', 'Boston',
  'Washington|Washington D.C.|Washington DC', 'Seattle', 'Orlando', 'New Orleans|Nuova Orleans', 'Houston', 'Toronto',
  'Montreal|Montréal', 'Vancouver', 'Città del Messico|Mexico City|CDMX', 'Cancun|Cancún', '*Rio de Janeiro|Rio', 'São Paulo|Sao Paulo',
  'Buenos Aires', '*Lima', 'Bogotà', "L'Avana|Havana|La Habana", 'Caracas', 'Quito', 'Montevideo',
  // Asia
  'Tokyo|Tokio', 'Kyoto|Kioto', 'Osaka', 'Seul|Seoul', 'Pechino|Beijing', 'Shanghai', 'Hong Kong', 'Macao', 'Bangkok', 'Hanoi',
  'Ho Chi Minh|Saigon|Ho Chi Minh City', 'Dubai', 'Abu Dhabi', 'Doha', 'Tel Aviv', 'Gerusalemme|Jerusalem', 'Mumbai|Bombay',
  'Nuova Delhi|New Delhi|Delhi', 'Kathmandu', 'Colombo', 'Manila', 'Giacarta|Jakarta', 'Kuala Lumpur', 'Taipei', 'Teheran|Tehran',
  'Beirut', 'Amman',
  // Africa e Oceania
  'Il Cairo|Cairo', 'Marrakech', 'Casablanca', 'Tunisi|Tunis', 'Città del Capo|Cape Town', 'Nairobi', 'Zanzibar', 'Sydney',
  'Melbourne', 'Auckland',
];

// ---------- the countries ----------
const COUNTRIES: string[] = [
  // Europa
  'Italia|Italy', 'Albania', 'Andorra', 'Austria', 'Belgio|Belgium', 'Bielorussia|Belarus', 'Bosnia-Erzegovina|Bosnia', 'Bulgaria',
  'Città del Vaticano|Vaticano|Vatican City|Vatican', 'Croazia|Croatia', 'Danimarca|Denmark', 'Estonia', 'Finlandia|Finland',
  'Francia|France', 'Germania|Germany', 'Grecia|Greece', 'Irlanda|Ireland', 'Islanda|Iceland', 'Kosovo', 'Lettonia|Latvia',
  'Liechtenstein', 'Lituania|Lithuania', 'Lussemburgo|Luxembourg', 'Macedonia del Nord|North Macedonia|Macedonia', '*Malta',
  'Moldavia|Moldova', '*Monaco|Principato di Monaco', 'Montenegro', 'Norvegia|Norway', 'Paesi Bassi|Olanda|Netherlands|Holland',
  'Polonia|Poland', 'Portogallo|Portugal', 'Regno Unito|UK|United Kingdom|Gran Bretagna|Great Britain|Britain',
  'Repubblica Ceca|Cechia|Czechia|Czech Republic', 'Romania', 'Russia', 'San Marino', 'Serbia', 'Slovacchia|Slovakia', 'Slovenia',
  'Spagna|Spain', 'Svezia|Sweden', 'Svizzera|Switzerland', 'Ucraina|Ukraine', 'Ungheria|Hungary', 'Cipro|Cyprus', 'Turchia', 'Georgia',
  'Armenia', 'Azerbaigian|Azerbaijan', 'Inghilterra|England', 'Scozia|Scotland', 'Galles|Wales', 'Irlanda del Nord|Northern Ireland',
  // Asia
  'Afghanistan', 'Arabia Saudita|Saudi Arabia', 'Bahrein|Bahrain', 'Bangladesh', 'Bhutan', 'Brunei', 'Cambogia|Cambodia', 'Cina|China',
  'Corea del Sud|South Korea|Corea', 'Corea del Nord|North Korea', 'Emirati Arabi Uniti|Emirati|EAU|UAE|United Arab Emirates',
  'Filippine|Philippines', 'Giappone|Japan', 'Giordania', 'India', 'Indonesia', 'Iran', 'Iraq', 'Israele|Israel',
  'Kazakistan|Kazakhstan', 'Kirghizistan|Kyrgyzstan', 'Kuwait', 'Laos', 'Libano|Lebanon', 'Malesia|Malaysia', 'Maldive|Maldives',
  'Mongolia', 'Myanmar|Birmania|Burma', 'Nepal', 'Oman', 'Pakistan', 'Palestina|Palestine', 'Qatar', 'Singapore', 'Siria|Syria',
  'Sri Lanka', 'Tagikistan|Tajikistan', 'Taiwan', 'Thailandia|Thailand|Tailandia', 'Timor Est|East Timor', 'Turkmenistan',
  'Uzbekistan', 'Vietnam', 'Yemen',
  // Africa
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Camerun|Cameroon', 'Capo Verde|Cape Verde|Cabo Verde', 'Ciad',
  'Comore|Comoros', "Costa d'Avorio|Ivory Coast|Côte d'Ivoire", 'Egitto|Egypt', 'Eritrea', 'Eswatini|Swaziland', 'Etiopia|Ethiopia',
  'Gabon', 'Gambia', 'Ghana', 'Gibuti|Djibouti', 'Guinea', 'Guinea-Bissau', 'Guinea Equatoriale|Equatorial Guinea', 'Kenya', 'Lesotho',
  'Liberia', 'Libia|Libya', 'Madagascar', 'Malawi', '*Mali', 'Marocco|Morocco', 'Mauritania', 'Mauritius', 'Mozambico|Mozambique',
  'Namibia', 'Niger', 'Nigeria', 'Repubblica Centrafricana|Central African Republic', 'Repubblica del Congo|Congo-Brazzaville',
  'Repubblica Democratica del Congo|RD Congo|Congo-Kinshasa|DR Congo', 'Ruanda|Rwanda', 'São Tomé e Príncipe', 'Senegal', 'Seychelles',
  'Sierra Leone', 'Somalia', 'Sudafrica|South Africa|Sud Africa', 'Sudan', 'Sud Sudan|South Sudan', 'Tanzania', 'Togo', 'Tunisia',
  'Uganda', 'Zambia', 'Zimbabwe',
  // Americhe
  'Antigua e Barbuda', 'Argentina', 'Bahamas', 'Barbados', 'Belize', 'Bolivia', 'Brasile|Brazil', 'Canada', 'Cile|Chile', 'Colombia',
  'Costa Rica', 'Cuba', 'Dominica', 'Ecuador', 'El Salvador', 'Giamaica|Jamaica', 'Grenada', 'Guatemala', 'Guyana', 'Haiti', 'Honduras',
  'Messico|Mexico', 'Nicaragua', 'Panama', 'Paraguay', 'Perù', 'Repubblica Dominicana|Dominican Republic', 'Saint Kitts e Nevis',
  'Saint Lucia', 'Saint Vincent e Grenadine', "Stati Uniti|USA|Stati Uniti d'America|United States|America", 'Suriname',
  'Trinidad e Tobago', 'Uruguay', 'Venezuela', 'Groenlandia|Greenland', 'Porto Rico|Puerto Rico',
  // Oceania
  'Australia', 'Figi|Fiji', 'Isole Marshall|Marshall Islands', 'Isole Salomone|Solomon Islands', 'Kiribati', 'Micronesia', 'Nauru',
  'Nuova Zelanda|New Zealand', 'Palau', 'Papua Nuova Guinea|Papua New Guinea', 'Samoa', 'Tonga', 'Tuvalu', 'Vanuatu',
];

export const PLACES: ReadonlyArray<Place> = [
  ...REGIONS.map((s) => place(s, 'region')),
  ...PROVINCIAL_CAPITALS.map((s) => place(s, 'city')),
  ...OTHER_ITALIAN_TOWNS.map((s) => place(s, 'city')),
  ...WORLD_CITIES.map((s) => place(s, 'city')),
  ...COUNTRIES.map((s) => place(s, 'country')),
];
