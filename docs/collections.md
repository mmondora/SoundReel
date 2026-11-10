# Le raccolte del sito — contratto API (`/api/collections`)

Spec: `docs/superpowers/specs/2026-11-09-library-collections-auto-topics-design.md` (C1–C18, §4, §5, §6, §8). Architettura: `adr/0022-the-server-discovers-the-collections-of-the-library.md`. Piano: `docs/superpowers/plans/2026-11-10-library-collections-phase-1.md` (Task 8, 9–12; l'«Update» in testa dice che cosa è cambiato dopo il telaio nuovo). Richiesta di Michele (9 e 10 novembre): «vorrei che crei una serie di aggregazioni […] Vorrei sia tutto automagico, ad esempio "vino" viene scoperto da solo e proposto.» e «Voglio anche che il luogo venga identificato dal testo […] e abbia un link a googlemap (oppure apri in gmap ).»
**Stato** (10 novembre, 2.24.0): il contratto è stato scritto prima del codice; **lo strato che risponde (vista e rotte, task 8) è costruito** (`services/collectionsView.ts` le regole, `collectionsViewData.ts` le fonti vere, `routes/collections.ts` le rotte) e dove il codice ha precisato il testo, il testo è stato corretto qui. Le raccolte **tema** le scrive il motore notturno (task 4 e 7): finché non gira l'elenco ha i tipi e i luoghi, e i temi compaiono dopo il primo giro.

## Che cosa è

Una **raccolta** è una vista sulle voci (non una copia). Tre strati (spec §4): **tipi** (`type:music`, `type:films`, `type:software`, `type:places`, `type:books`: predicati sull'estrazione, **calcolati**, mai in tabella), **temi** (scoperti dal server con i vettori, **le sole righe di `collections`**; id UUID) e **luoghi** (`place:<slug>`: «Milano» da sola a 8 voci, **calcolata**). Il **server decide tutto** (regola P): quali raccolte ci sono, il nome, l'ordine, le viste, le miniature, i chip di ogni voce, l'indirizzo di Google Maps. Il sito **disegna e basta**: un test (`frontend/src/collections/ruleP.test.ts`) vieta al sito di costruire un indirizzo di Maps o di raggruppare. **Solo il sito** mostra le raccolte (Michele, Q2: no su Mondrop).

## Chi è l'utente — e la sicurezza

Come le altre liste del sito: l'utente è **solo** `Remote-User` (Authelia), mai la query né il corpo (un `Remote-User` assente o sconosciuto è `anonymous`, che non ha raccolte). Le raccolte di una persona sono costruite sulle **sue** voci più quelle **condivise con lei** (lo stesso criterio di `GET /api/entries`, **senza** la clausola dell'amministratore): **sono strettamente per persona, anche per l'amministratore** (che vede le voci di `anonymous` nelle liste, ma non le raccolte di nessuno; ha in più solo `?state=watching` e l'anteprima del ricalcolo). Un id di un'altra persona è `404`, mai «vietato». Le correzioni (`POST`/`DELETE`) vogliono un utente della famiglia: senza `Remote-User` è `401 { "error": "authentication required" }` e non cambia niente. Le rotte **devono restare dietro `auth-family`**, con le altre del sito: mai sotto `/api/mondrop` né `/api/share` (quei router saltano Authelia: `Remote-User` lo scriverebbe il client e chiunque potrebbe leggere o correggere le raccolte di chiunque).

## Le forme

```ts
type CollectionKind = 'type' | 'theme' | 'place';
type CollectionView = 'grid' | 'list' | 'play';

interface CollectionListItem {
  id: string;                      // 'type:music' · '<uuid>' (tema) · 'place:milano'
  name: string;                    // già pulito: «Vino», «Milano»
  kind: CollectionKind;
  group: string | null;            // l'intestazione fissa del seme («Cibo e bevande»); null = «Altre»; i tipi hanno 'Tipi' e i luoghi 'Luoghi' (testi del server: il sito scrive le intestazioni come arrivano, nell'ordine della prima comparsa, «Altre» per ultima)
  parentId: string | null;         // il padre di un figlio (due livelli), **solo se il padre è a sua volta nell'elenco** (attivo): un padre nascosto, in osservazione o fuso non è un padre per il sito
  count: number;                   // quante voci (di chi chiede)
  isNew: boolean;                  // un TEMA nato da meno di 7 giorni (a 7 giorni esatti non lo è più); un tipo e un luogo non nascono mai
  thumbs: string[];                // fino a 4 miniature (url) delle voci più recenti che ne hanno una, ognuna una volta; può essere vuoto
  views: CollectionView[];         // le sole viste che i dati sanno riempire: la musica ['play','list']; le altre ['grid','list'] se almeno il 25 % delle voci ha la miniatura, altrimenti ['list']
  defaultView: CollectionView;     // 'play' per type:music; 'grid' se ≥ 60 % delle voci ha la miniatura, altrimenti 'list'
}

interface CollectionChip { id: string; name: string }          // un chip su una voce: ≤ 2 di tema + il luogo (id 'place:<slug>')

interface CollectionVenue {
  key: string;                     // venueKey: nome pulito + '|' + città pulita (una cosa = una voce, ADR-0017)
  name: string;
  kind: string;                    // la CHIAVE: restaurant · pizzeria · bar · cafe · hotel · refuge · winery · shop (dal 2.24.0 è quella della PAROLA di locale che sta nel nome, mai quella che dice il modello; `other` non si produce più, ma il sito lo tollera e non lo scrive; il sito la scrive nella lingua della pagina: «cantina», «winery»; una chiave che non conosce la scrive com'è)
  place: string | null;            // la città, se c'è
  mapsUrl: string;                 // costruito dal SERVER: https://www.google.com/maps/search/?api=1&query=<nome, città>
  posts: Array<{ entryId: string; sourceUrl: string; sourcePlatform: string; createdAt: string }>;   // i post che lo citano: UNA riga con più link
}

type CollectionEntry = EntrySummaryRow & { collections: CollectionChip[] };   // la riga di GET /api/entries?view=summary, più i chip
```

## Le rotte

Tutte rispondono `Cache-Control: no-store`.

| Rotta | Che cosa fa | Risposta |
|-------|-------------|----------|
| `GET /api/collections` (o `?state=active`) | Le raccolte **visibili** dell'utente, già in ordine: prima i **tipi** (musica, film e serie, software e app, luoghi, libri; solo quelli con voci: `type:places` = le voci con una nota di categoria `place`, `type:books` = le voci con una nota `book`), poi i temi e i luoghi: **le nuove (✦), poi quelle con una voce degli ultimi 14 giorni** (meno di 14 giorni esatti), **poi le altre; dentro ognuno per grandezza (decrescente), poi per nome** come lo legge una persona (senza maiuscole né accenti), poi per id. Un tema `watching` **non c'è** (con 5 voci il motore lo fa `active`); un tema **senza nessuna voce viva** (tutte cancellate o non più condivise) non c'è; `place:*` da 8 voci (le voci che nominano il luogo, in tutte le grafie, ognuna una volta) | `200 { collections: CollectionListItem[] }` (un utente senza voci: `[]`) |
| `GET /api/collections?state=hidden` | Le raccolte che l'utente ha **nascosto** (per recuperarle con `unhide`), solo temi, nello stesso ordine | `200 { collections: CollectionListItem[] }` |
| `GET /api/collections?state=watching` | In osservazione (3–4 voci, non pubblicate): **solo amministratore**, e sono le **sue** | `200 { collections: […] }`; chi non è admin (e un visitatore senza `Remote-User`, anche con il gruppo `admins`): `403 { "error": "admin_only" }` |
| `GET /api/collections/:id?dove&fonte&quando&q&offset&limit` | Una raccolta: `dove` = un luogo della faccetta (senza maiuscole né accenti), `fonte` = una piattaforma, `quando` = `AAAA-MM` (mese UTC della data della voce), `q` = parole libere (**tutte** devono stare nel riassunto, nella didascalia o nei tag, in qualunque ordine, senza maiuscole né accenti); `limit` 1–100 (predefinito 40), `offset` ≥ 0 (interi). `dove` e `fonte` fino a 100 caratteri, `q` fino a 200; un valore vuoto è un valore assente. `id` va codificato nell'URL (`type%3Amusic`); anche i due punti scritti così come sono funzionano. Un tema **nascosto** si apre (l'ha nascosto dall'elenco, non da sé); **in osservazione** solo l'amministratore | `200 { collection, why, facets, entries, venues, songKeys?, total }` (sotto) |
| `POST /api/collections/:id/rename` | Corpo `{ "name": "…" }` (1–60 caratteri dopo aver sistemato gli spazi, niente `#@"*`, **niente caratteri di controllo** nemmeno un a-capo: si rifiutano come arrivano): da quel momento **il nome non si tocca più** | `200 { collection }` (com'è adesso) |
| `POST /api/collections/:id/merge` | Corpo `{ "targetId": "<id>" }`: i membri passano al bersaglio, che **tiene il suo nome**; la raccolta resta fusa a ogni ricalcolo. Il bersaglio è **un altro tema attivo dell'utente**: né sé stesso, né un tipo o un luogo, né un tema nascosto o in osservazione (`400 invalid_target`); non suo o già fuso: `404` | `200 { collection }` (il bersaglio, com'è adesso) |
| `POST /api/collections/:id/hide` · `…/unhide` | Nasconde / rimette; una nascosta **resta nascosta** a ogni ricalcolo | `200 { "ok": true }` |
| `POST /api/collections/:id/entries/:entryId` | «Aggiungi a…»: la voce entra e **non esce più** (`user_add`); la voce deve essere una che l'utente legge (sua o condivisa con lui) | `200 { "ok": true }` |
| `DELETE /api/collections/:id/entries/:entryId` | «Non è questo»: la voce esce e **non rientra più** (`user_remove`) | `200 { "ok": true }` |
| `POST /api/admin/collections/rebuild?dry=1` | Solo amministratore: l'anteprima del ricalcolo **delle sue raccolte** (la query non sceglie l'utente; nessuna scrittura; senza `dry=1` è `400 invalid_query:dry`: si scrive con lo script e l'OK di Michele). Controlla **prima** che sia amministratore (`403`), poi `dry` (`400`). **`503 { "error": "rebuild_unavailable" }` finché il motore (task 7) non è collegato** | `200 { collections: Array<{ id: string \| null; name: string; size: number; state: string; memberIds: string[] }> }` |
| `GET /api/entries?view=summary` | **Invariata**, più `collections: CollectionChip[]` in ogni riga (una sola domanda per tutta la pagina). I chip sono quelli **dell'utente che legge** (un amministratore che legge le voci di `anonymous` ha i propri chip). Un guasto delle raccolte **non rompe mai la lista**: le righe tornano con `collections: []` (e il guasto va nel log) | come oggi |
| `GET /api/entries/:id` | **Invariata**, più `places: Array<{ name: string; kind: 'city' \| 'region' \| 'country' }>` e `venues: CollectionVenue[]` (con `mapsUrl`; `posts` = quella voce soltanto). Un guasto: i due campi **non ci sono** e la voce risponde come sempre | come oggi |
| `GET /api/home` | **Invariata**, più la sezione `collections` (vedi `docs/web-home.md`): i temi e i luoghi (**mai i tipi**) come tessere, fino a 12, `{ id, name, count, isNew, thumbs }`, nell'ordine della lista; tra `playlists` e `films`; le righe di `resume` portano anche i chip | come oggi |

**`GET /api/collections/:id`** risponde:

```ts
{
  collection: CollectionListItem;
  why: { words: string[]; entryIds: string[] };      // «Perché è qui?» (solo per i temi; vuoto per i tipi e i luoghi): fino a 4 parole (prima i tag che almeno 2 voci hanno, senza `#`, una volta per voce, senza rumore come `#tag`, `@utente`, `#fyp`; poi le parole dei riassunti: 4 lettere o più, non di grammatica, in almeno un quarto delle voci con riassunto e in almeno 2; «vino» e «vini» sono una parola) e le 2 voci più centrali (le più sicure del raggruppamento; quelle messe a mano per ultime, il loro punteggio è una formalità). Calcolato su TUTTE le voci della raccolta, qualunque filtro
  facets: {
    places:  Array<{ name: string; count: number }>;     // i luoghi nominati da almeno 2 voci della raccolta, i più nominati per primi (in una raccolta di luogo non c'è il luogo stesso: filtrerebbe niente)
    sources: Array<{ platform: string; count: number }>; // la fonte (instagram, tiktok…), tutte, le più usate per prime
    months:  Array<{ month: string; count: number }>;    // 'AAAA-MM' (UTC), dal più recente
  };                                                 // le faccette sono contate su TUTTE le voci della raccolta, non su quelle che un filtro lascia: così si può scegliere un'altra
  entries: CollectionEntry[];                        // ordinate dalla più recente; filtrate da dove/fonte/quando/q; i chip hanno sempre la raccolta aperta (se è un tema), prima, così il «non è questo» la raggiunge
  venues: CollectionVenue[];                         // i locali citati da TUTTE le voci della raccolta (non solo la pagina né i filtri), una riga per locale con i post che lo citano (il più recente per primo); i più citati per primi, poi per nome; [] se non ce ne sono
  songKeys?: string[];                               // SOLO se `views` contiene 'play' (type:music): le chiavi delle canzoni del diario dell'utente (le stesse della pagina Canzoni), la più recente per prima (a pari data per chiave), al massimo 500; se non si leggono: []
  total: number;                                     // le voci che passano i filtri (per «carica altre»)
}
```

## Le regole (dal piano e dalla spec: non si piegano)

- **Numeri:** un tema nasce a **5** voci, è «in osservazione» a 3–4, muore sotto 3; un gruppo nuovo eredita id e nome della raccolta vecchia con cui condivide **almeno la metà dei membri di quella vecchia**; **al massimo 2 temi** per voce più il padre; luogo: faccetta a ≥ 2, combinazione a ≥ 5, `place:*` a ≥ 8; ≤ 20 locali per voce; «Nuova» per 7 giorni; «viva» per 14; il binario del sito mostra al massimo 12 (`COLLECTION_VIEW` in `services/collectionsView.ts` è l'unico posto dei numeri del server).
- **I chip di una voce** (`pickChips`): al massimo **2 temi attivi** (il più sicuro per primo; un tema di cui la voce è anche in un figlio **non c'è**: il figlio dice di più; mai un tema nascosto, in osservazione o fuso, mai uno da cui la voce è stata tolta a mano) e, in coda, **il luogo, solo se `place:<slug>` esiste** (≥ 8 voci che l'utente legge: un chip porta a `/entries?raccolta=<id>`, e una raccolta che non c'è direbbe «non c'è più»); se più luoghi sono raccolte, il più preciso (città, poi regione; poi il più nominato; poi il nome). **Un paese non è mai una raccolta né un chip** (`placeMakesCollection`: «Italia» e «Cina» sono nominati di passaggio, e un luogo non si può nascondere); resta scritto sulla voce e come faccetta dentro una raccolta. Lo slug è minuscolo, senza accenti, ogni segno che non è lettera o cifra è un trattino.
- **Le viste:** la musica è `['play','list']` e parte da «Suona»; le altre offrono la griglia dal **25 %** di voci con miniatura e partono dalla griglia dal **60 %** (a 60 % esatto è griglia), altrimenti la lista; una raccolta senza voci ha la sola lista.
- **Il luogo e i locali compaiono nel testo della voce** (controllo letterale) e il luogo sta nell'elenco dei luoghi; **niente coordinate**; `mapsUrl` è `https://www.google.com/maps/search/?api=1&query=` + `encodeURIComponent("nome, città")` (solo il nome se non c'è la città; l'apostrofo e simili si codificano): nessuna chiave, nessuna chiamata a Google. Un locale che più post nominano è **una riga**: il nome è quello che usano più post (a pari merito, quello del post più recente), il tipo quello che dicono più post, la città idem. **Il controllo dei locali (dal 2.24.0, `PLACES_RULES_VERSION = 2`, `services/entryPlaces.ts`).** Il modello propone, **il codice decide**, e la precisione viene prima del recupero: sulla libreria vera il modello dava come «locali» prodotti, persone e marchi (`other|Claude Code`, `hotel|Pink Floyd`) vicino a «ristorante», «bakery» o «hotels». Un nome è un locale solo se (1) nel nome c'è una **parola forte** di locale (Trattoria, Osteria, Hotel, Bar, Cantina, Tenuta…), scritto con una maiuscola su un'altra parola o con un numero; (2) c'è una **parola debole** (club, store, shop, market, caffè, libreria…) **più un altro segno** entro 120 caratteri nel testo (una parola forte o un indizio: un pin, via e numero, «prenota … tavolo», «menu degustazione» o «alla carta»); (3) non c'è nessuna parola di locale nel nome ma entro 120 caratteri ci sono **una parola forte e un indizio**. **Il tipo è sempre quello della parola di locale**, mai quello che dice il modello (la chiave `other` non si produce più). Si scartano `@` e `#`, indirizzi web, simboli, più di sei parole, lettere sole da OCR, nomi di piattaforme e di AI, «un ristorante a…» e un indirizzo usato come nome. **Misurato il 10 novembre su 618 chiamate vere:** 0 falsi positivi su 350 voci scelte a caso o con una nota di luogo; **14 locali veri su 15** tra le 268 voci con una parola o un segno nel testo; **il recupero è circa il 40 %** (si perdono soprattutto bar, cantine e negozi negli elenchi senza parola forte né pin): meglio un locale in meno di uno sbagliato. Resta una classe di falsi positivi (un'opera con una parola di locale nel titolo) e il tipo, nei lunghi elenchi, può essere quello del vicino. Cambiare le regole = alzare `PLACES_RULES_VERSION`: ogni voce con il vecchio valore si rilegge una volta. **Una risposta troncata** del modello (900 token: un lungo elenco di locali, circa 40 secondi) conta come «niente trovato» e si registra, così non si richiede ogni notte.
- **Solo i temi si correggono** (rinomina, unisci, nascondi, aggiungi, togli): sui tipi e sui luoghi (calcolati) le rotte di correzione rispondono `400 { "error": "not_editable" }`.
- **Le correzioni durano:** nascosta resta nascosta, una voce tolta non rientra, una aggiunta non esce, un nome cambiato non si tocca, una fusione resta, a ogni ricalcolo.
- **Come si calcolano (il motore, `services/collectionsEngine.ts`):** una passata **notturna** (la prima circa 10 minuti dopo l'avvio, mai all'avvio; poi ogni 24 ore; `services/collectionsNightly.ts`) rifà i gruppi su **tutti** i vettori dell'utente, con gli id e i nomi ereditati, e applica **per ultime** le correzioni. Prima di ogni utente rimette in pari le voci i cui ingressi (vettore, luoghi, locali) erano rimasti indietro (al massimo 200 a notte). **Corsia veloce** (`assignOne`): dopo ogni analisi riuscita la voce entra, se il suo vettore è vicino, nei temi attivi che esistono già (al massimo 2, mai toglie, mai crea o rinomina, rispetta le voci tolte a mano); il resto lo fa la notte. **Un tema non è «quasi tutto musica o film»:** un gruppo il cui centro è vicino a quello della musica o dei film (coseno ≥ 0,80) o i cui membri sono almeno al **70 %** voci con canzoni dal contenuto o con film **non si pubblica come tema** (è già «Musica» o «Film e serie»); anche **dopo l'assegnazione** un tema non supera il 70 % (le voci con film o canzoni entrano, la migliore per prima, finché non si arriva alla soglia). Un gruppo che non si riesce a nominare **resta «in osservazione»** e si riprova la notte dopo (meglio nessun nome che uno sbagliato); **i figli** di un gruppo grande si pubblicano anche se il padre non ha nome; due gruppi con lo stesso nome si fondono se i centri sono vicini, altrimenti **il più grande tiene il nome** (l'altro aspetta). L'anteprima (`POST /api/admin/collections/rebuild?dry=1`, `node dist/scripts/rebuildCollections.js`) chiede al modello i nomi veri (circa un minuto sulla libreria vera), **non scrive niente** e fa i controlli dell'insieme d'oro di spec §9; **la prima pubblicazione** è `rebuildCollections --apply`, solo con l'OK di Michele. **La notte non pubblica mai la prima volta:** la passata rifà solo le raccolte di chi **ne ha già** (una riga della tabella `collections`, in qualunque stato: anche una nascosta o unita vuol dire che la prima pubblicazione c'è stata, `hasCollections` in `collectionsEngineData.ts`); chi non ne ha **aspetta** (il riepilogo della notte dice `waiting`, le sue voci rimaste indietro si rileggono lo stesso, così l'anteprima vede tutti i vettori) e un familiare vuole `--owner`. Se il database non dice se un utente ne ha, **per lui** quella notte non c'è passata (un avviso nel log, gli altri vanno avanti).
- **Tutto locale** (`nomic-embed-text` e `glm-4.7-flash` dietro il gpu-router): mai Claude; `COLLECTIONS_AUTO=0` ferma la scoperta e la passata notturna (le raccolte esistenti restano).

## Errori

| Risposta | Quando |
|----------|--------|
| `400 { "error": "invalid_query:<campo>" }` | `limit` fuori da 1–100 o non intero, `offset` negativo o non intero, `quando` che non è `AAAA-MM` (mese 01–12), `dove`/`fonte`/`q` troppo lunghi, un parametro dato due volte, `state` sconosciuto (anche vuoto), `dry` che non è `1` |
| `400 { "error": "invalid_name" }` · `"not_editable"` · `"invalid_target"` | rinomina con un nome non valido; correzione su un tipo o un luogo (anche con un nome non valido: prima `not_editable`); fusione con sé stessa, con un tipo o un luogo, con un tema nascosto o in osservazione, o senza `targetId` |
| `401 { "error": "authentication required" }` | una correzione senza `Remote-User` |
| `403 { "error": "admin_only" }` | `state=watching` o il ricalcolo senza essere amministratore |
| `404 { "error": "collection_not_found" }` · `"entry_not_found"` | un id che non esiste, che è di un'altra persona, di un tema fuso, di un luogo sotto le 8 voci, di una raccolta senza voci (o in osservazione, per chi non è amministratore); una voce che l'utente non legge |
| `500 { "error": "collections_failed" }` | un guasto che non è dell'utente (va nel log; il messaggio non arriva mai al client) |
| `503 { "error": "rebuild_unavailable" }` | l'anteprima del ricalcolo quando il motore non è collegato |

## Come si prova

Unitari con dipendenze iniettate: `services/collectionsView.test.ts` (le regole pure: ordine, `views` e `defaultView`, `isNew` a 7 giorni, «viva» a 14, luogo da 8, chip solo se il luogo è una raccolta, figlio al posto del padre, «perché è qui?», lo stesso locale in due post = una riga con due link, `mapsUrl` con accenti e `&`, filtri e faccette, soglie), `services/collectionsViewData.test.ts` (le fonti vere con il database finto: l'utente è sempre un parametro, mai nel testo; nessuna clausola dell'amministratore), `routes/collections.test.ts` (stato e validazioni, `404` e non `403`, `not_editable`, `401`, amministratore, `no-store`, `?user=` che non sceglie l'utente, registrazione dietro Authelia), `routes/entries.test.ts` e `services/webHome*.test.ts` (chip, luoghi e locali, la sezione). **D'integrazione su un Postgres vero** (`services/collectionsViewData.int.test.ts`, solo con `COLLECTIONS_INT=1` e un database usa-e-getta, mai la produzione; **`--no-file-parallelism`**; i dati hanno il prefisso `vtest_`): i predicati dei tipi, i luoghi, le voci vive dei temi (non quelle tolte a mano, non quelle non leggibili, sì quelle condivise), i chip di una pagina intera, il conteggio del luogo solo sulle voci che l'utente legge, le correzioni che si vedono subito. Rotture provate con il banco delle mutazioni.

```bash
COLLECTIONS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=collections_check DB_USER=postgres DB_PASSWORD=… \
  npx vitest run --no-file-parallelism src/services/collectionsViewData.int.test.ts
```
