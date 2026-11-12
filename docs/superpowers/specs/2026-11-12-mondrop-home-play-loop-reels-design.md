# Mondrop: play sulla card della Home, il loop sul play, la Home senza «Ascoltati di recente», download uno alla volta e il tab «Reel»

Stato: **richiesta registrata il 12 novembre 2026; costruita e rilasciata** (SoundReel 2.27.0 in produzione alle 17:40, Mondrop 1.8.0 build 20 su TestFlight nel gruppo interno Family alle 17:44, con l'OK di Michele per ciascuno). Le scelte marcate «mia scelta» sono di Claude finché Michele non le conferma. **Risposte di Michele, 12 novembre (sera): Q1 «lascia così» (niente finestra di N brani), Q3 «si apri sulla scheda» (un «Apri» sulla scheda del film: §4.6, SoundReel 2.28.0 + Mondrop build 21, costruiti e provati, in attesa dell'OK per rilasciarli).** Q2 resta come l'ho proposta (nessuna obiezione).
Riferimenti: ADR-0020 (la Home la decide il server), ADR-0029 e ADR-0030 (telefono prima, ordine dei download), ADR-0031 (ordinamenti, «Scarica tutta»), ADR-0033 (il tab Reel); spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` (U1–U20), `2026-11-10-mondrop-like-and-repeat-design.md` (il loop), `2026-11-08-mondrop-home-spotify-design.md` (la Home).

---

## 1. La richiesta (testuale)

Michele, 12 novembre:

> «in mondrop voglio avere il bottone play, in homepage, direttamente sulla play list, in un angolo - oppure ocn una gesture. sul play voglio anche il "loop" del singolo o della playlist - gli Ascoltati di recente non mi interessano in homepage. Il download deve essere non necessariamente parallelo e massivo. Voglio avere anche un tab con le altre categorie sul reel ( dove però per ora l'unica cosa che viene portata sulla device è la musica ) ma non il link al reel ma la sua scomposizione e spiegazione.»

E, a metà lavoro:

> «a cosa serve il bottone "Sync " in homepage vicino alle playlist ? se è il controllo di consistenza lo voglio in "impostazioni" - e Tutte che cosa farebbe ?»

Risposta data: in Home **non c'è nessun «Sync» dalla build 16** (era della build 15: sincronizzava **tutte** le playlist, con la domanda sopra il limite; Michele l'aveva tolto l'11 novembre con «Il sync deve girare solo per playlist che sto suonando. Non di tutti in assoluto»). Il controllo di consistenza è «Controlla le playlist sul telefono» in **Impostazioni → Sync** dalla build 17. «Tutte» apre l'elenco completo delle playlist (ricerca, «Mostra», «Ordina per», pagine) e non scarica niente. **Regola che ne esce: sulla Home nessun comando di sync né di controllo**; l'unico posto che li nomina sono le Impostazioni (già U12/U13). Chi vede ancora il «Sync» ha la build 15 sul telefono.

## 2. Come l'ho letta

| # | Parole di Michele | Lettura |
|---|---|---|
| M1 | «il bottone play, in homepage, direttamente sulla play list, in un angolo - oppure con una gesture» | Un play su ogni card di playlist della Home (angolo della copertina) e, in più, una gesture sulla card |
| M2 | «sul play voglio anche il "loop" del singolo o della playlist» | Il loop (che il Player ha già: nessuno / tutto / questo brano) raggiungibile **dal play**: dalla card, dal mini player e da «Riprendi» |
| M3 | «gli Ascoltati di recente non mi interessano in homepage» | La riga «Ascoltati di recente» sparisce dalla Home |
| M4 | «Il download deve essere non necessariamente parallelo e massivo» | I download vanno uno alla volta; niente scarichi di massa non chiesti |
| M5 | «un tab con le altre categorie sul reel … ma non il link al reel ma la sua scomposizione e spiegazione» | Un tab **Reel**: per ogni reel, di cosa parla (la spiegazione) e cosa contiene diviso per categoria (musica, film, software, luoghi, libri…); **nessun link al reel**; sul telefono resta **solo la musica** |

## 3. Decisioni

### M1 Play sulla card della Home
- Un pulsante **rotondo giallo con il play** nell'angolo in basso a destra della copertina di ogni card di playlist (come Spotify). Un tocco **suona la playlist da capo**, con i brani sul telefono per primi (`localFirst`, come «Suona» sulla pagina della playlist). Un tocco sul resto della card apre la pagina, come prima.
- **Gesture:** pressione prolungata sulla card = menu «Suona», «Mescola», «Suona in loop». *Mia scelta:* niente scorrimento laterale (la riga delle card scorre già in orizzontale e i due gesti si confonderebbero).
- La lista dei brani la dà la copia che il telefono tiene (`PlaylistManifestCache`) o, se manca, SoundReel (`GET …/offline`); sul pulsante gira una rotellina finché non è pronta. Senza copia e senza rete una riga dice «Non riesco a leggere la playlist». Una playlist senza niente da suonare dice «Niente da suonare in «X»».
- Il pulsante **non fa partire nessun sync**: il sync automatico della playlist che suona parte da solo, come da U2.

### M2 Il loop sul play
- Il loop del Player non cambia (`RepeatMode`: nessuno → tutto → questo brano, ricordato tra i lanci).
- **Dal play:** pressione prolungata sul tasto play/pausa del **mini player** e della card **«Riprendi»** = menu con tre voci, «Non ripetere», «Ripeti la playlist», «Ripeti questo brano» (la scelta in uso ha la spunta). Quando il loop è acceso il tasto play porta un **piccolo segno giallo** (`repeat` o `repeat.1`), così si vede. *Mia scelta:* un quinto tasto nel mini player lo stringerebbe fino a togliere il titolo.
- Dal menu della card della Home: **«Suona in loop»** = parte e ripete la playlist (`RepeatMode.all`). «Suona» e «Mescola» non toccano il loop già scelto.
- «Il singolo»: «Ripeti questo brano» (`RepeatMode.one`), dal mini player, da «Riprendi» e dal Player (il tasto di prima).

### M3 La Home senza «Ascoltati di recente»
- Lo decide il **server** (ADR-0020, la Home la compone SoundReel): dalla **2.27.0** `GET /api/mondrop/home` non manda più la sezione `recent`. Restano «Le tue playlist» e «Nuovi dai tuoi reel»; «Riprendi» (la coda del telefono) non cambia.
- Le app già installate la smettono di mostrarla appena il server è in produzione (leggono le sezioni che arrivano). Niente da cambiare nell'app oltre ai dati di prova.
- La lettura che dava quella riga (`getRecentSongKeys`) non ha più chiamanti ed è stata tolta con i suoi test; le playlist dinamiche con ordine `recent` hanno la loro lettura.

### M4 I download uno alla volta
- `SyncEngine.maxParallel` da **2 a 1**: la coda scarica un brano per volta, nell'ordine in cui i brani stanno per suonare (ADR-0030). Vale anche per «Scarica tutta».
- «Non massivo»: dalla build 16 non c'è più nessun sync di tutte le playlist; scarica solo la **playlist che suona**, con la domanda sopra «Avvisa sopra» (2 GB di partenza), e «Scarica tutta» è una richiesta della persona. Questo resta com'è.
- **Q1, risposta di Michele (12 novembre, sera): «lascia così».** Niente finestra di N brani: la playlist che suona si scarica **tutta, un brano alla volta** (come oggi). Era: «solo i prossimi N brani (N = 10)»; costava che in auto, senza rete, sul telefono ci sarebbero stati solo quelli.

### M5 Il tab «Reel»
- **Cos'è:** l'elenco dei reel (e dei post) che SoundReel ha già analizzato per l'utente, dal più recente; di ognuno **di cosa parla** (la spiegazione) e **cosa contiene, diviso per categoria**. Non ha il link al reel: «non il link al reel ma la sua scomposizione e spiegazione». L'unica cosa che si apre è la scheda di un film (§4.6, Q3).
- **Chi decide cosa si vede:** il server (regola P): compone le schede e le categorie, l'app le disegna. Nessun campo con un indirizzo di un reel, di un negozio o di una pagina esterna, **tranne** la scheda di un film su IMDb (`openUrl`, §4.6).
- **Sul telefono resta solo la musica:** i brani di un reel sono i brani di Mondrop (si suonano, si scaricano, si mettono in playlist, con i tre segni telefono/online/errore). Il resto (film, software, luoghi, libri…) è **testo letto da SoundReel, non salvato sul telefono**: senza rete il tab dice che serve la rete e la musica già scaricata si suona lo stesso.
- **Categorie** (nell'ordine in cui compaiono): Musica, Film, Software, Luoghi, Libri, Prodotti, Marchi, Persone, Eventi, Citazioni. Vengono dalle estrazioni del reel (canzoni, film, software e le note per categoria). *Mia scelta:* la categoria «altro» delle note e quelle che non sono categorie di cose (`tag`, `note`, vuote) **non si mostrano**: sono ciò che il modello non ha saputo classificare (751 note «altro» su 5 000 e righe come `/n`).
- **Scheda nell'elenco:** miniatura (se c'è), spiegazione in due-tre righe, data e piattaforma («Instagram · 12 nov»), una riga di **categorie con il conteggio e i primi nomi** («Software 3: Notion, Gmail +1»). In testa una riga di **filtri per categoria** (Tutti, Musica, Film, Software…) con quanti reel hanno ciascuna.
- **Pagina del reel:** la spiegazione per intero («Di cosa parla»); le sezioni per categoria (la Musica con le righe dei brani e «Suona tutta»; le altre come righe di testo con un dettaglio); **«Approfondimenti»** (le voci di approfondimento generate dal modello, con la dicitura «Generato dall'IA»: non sono sempre esatte); il **verdetto** se il reel ne ha uno (vero, falso, dubbio…); **«Slide per slide»** per i caroselli; le parole chiave.
- **Dove sta il tab:** *mia scelta:* **al posto del tab «Share»** (cinque tab restano in barra: con un sesto iOS ripiega il resto in «Altro» e il badge della Posta non si vedrebbe). Ordine: Home, Cerca, **Reel**, Posta, Impostazioni. Il modulo di condivisione manuale (`ContentView`) si apre con un **«+» in alto nel tab Reel**; la Share Extension e le Impostazioni (chiave API) non cambiano.
- **Niente copia sul telefono** dei dati dei reel: coerente con «l'unica cosa che viene portata sulla device è la musica». Fa eccezione una copia di miniature nella cache di sistema (`Caches`, la svuota iOS quando serve), solo per non riscaricarle a ogni scorrimento.

## 4. Contratto del server (SoundReel 2.27.0)

Tutte le rotte sono sotto `/api/mondrop`, con `X-SoundReel-Key` (`requireMondrop`): **solo i reel che l'utente della chiave può leggere** (suoi più quelli condivisi con lui: la stessa regola `visibilitySql` di tutte le liste, **mai** un parametro che la allarghi; l'id di un reel non visibile è `404`, mai `403`). Il documento per i client è `docs/mondrop-reels.md`.

### 4.1 `GET /api/mondrop/reels?limit&offset&kind&facets`
- `limit` 1–50 (default 20), `offset` ≥ 0, `kind` uno di `music|film|software|place|book|product|brand|person|event|quote`, `facets` `1`/`true`. Un valore sbagliato (non numero, fuori misura, categoria sconosciuta, stesso nome due volte) è un **`400`** `{ "error": … }`.
- Risponde `{ "total", "limit", "offset", "kinds"?, "reels": [ReelCard] }`.
  - Entrano solo i reel **completati** con almeno una spiegazione **o** una cosa in una categoria che si mostra (stessa condizione per l'elenco e per `total`). Dal più recente; a parità di data per `id`, così due pagine non mostrano mai lo stesso reel.
  - `kind` tiene i reel che hanno almeno una voce di quella categoria; `total` segue il filtro.
  - `kinds` (solo con `facets`): `[{ "kind", "label", "count" }]`, quanti reel hanno ciascuna categoria su **tutti** quelli leggibili (non seguono né la pagina né il filtro `kind`), nell'ordine delle categorie, **solo quelle con almeno un reel**.
- `ReelCard`: `{ "id", "createdAt" (ISO), "platform" (`instagram`, `tiktok`…), "summary": string|null, "imagePath": string|null (`/api/mondrop/reels/<id>/image`, solo se la miniatura è sul server), "counts": [{ "kind", "label", "count", "names": [max 3 stringhe] }] }` — `counts` solo per le categorie con almeno una voce, nell'ordine delle categorie.

### 4.2 `GET /api/mondrop/reels/:id`
`404` se il reel non esiste o l'utente non lo legge. Risponde `ReelDetail`:
`{ "id", "createdAt", "platform", "summary", "imagePath", "tags": [string], "sections": [Section], "insights": [{ "label", "text" }], "verdict": { "label", "explanation" } | null, "slides": [{ "index", "summary" }] }`
- `Section` = `{ "kind", "title", … }` con **`tracks`** (la Musica: gli stessi oggetti `OfflineTrack` della libreria e di Cerca, costruiti con `buildTracks`, così si suonano e si scaricano come ogni brano; un brano che il diario non risolve non compare) oppure **`items`** `[{ "title", "detail": string|null }]` per le altre categorie.
- `tags` senza `#`/`@`, senza segnaposto del modello (`tag`, `utente`, `hashtag`), senza doppioni, al massimo 12. `insights` al massimo 8, `text` al massimo 600 caratteri (con «…»). `slides` solo quelle con una spiegazione.
- Pulizia (stessa dei posti del sito): i segnaposto `#tag`, `@utente`, `#hashtag` non compaiono **in nessun campo**; un testo vuoto o fatto di soli segni non è una voce; la **stessa cosa non compare due volte nello stesso reel** (confronto senza maiuscole, accenti e punteggiatura; vale la prima categoria nell'ordine delle categorie: un software che il modello ha messo anche tra i prodotti resta solo nel Software); testi lunghi tagliati (titolo 140, dettaglio 200, citazione 280 caratteri, con «…»); al massimo 20 voci per sezione.
- Categorie dalle note: `place`→Luoghi, `book`→Libri, `product`→Prodotti, `brand`→Marchi, `person`→Persone, `event`→Eventi, `quote`→Citazioni; ogni altra categoria non si mostra. Film: `title`, `detail` = «anno · regia di …» se ci sono. Software: `title`, `detail` = tipo (repo, prodotto, articolo) e descrizione se c'è.

### 4.3 `GET /api/mondrop/reels/:id/image`
Il JPEG della miniatura (`MEDIA_ROOT/<id>/thumbnail.jpg`, 320 px), `Cache-Control: private, max-age=86400`. `404` se il reel non è leggibile, se la miniatura non c'è o se l'id non è un UUID (nessun percorso sfugge dalla cartella dei media). **Un handler async che manda uno stream deve restituire la reply.**

### 4.4 Regole da non rompere
- **Regola P:** nessun campo nomina un negozio, un indirizzo o un link; **nessun `sourceUrl`, `mediaUrl`, `imdbUrl`, `url`** in nessuna risposta, e l'indirizzo del reel non compare da nessuna parte nel testo della risposta (un test cerca l'indirizzo di prova in tutto il JSON). **Un'eccezione sola, dalla 2.28.0 (§4.6):** `openUrl` sull'item di un film, la scheda del film su IMDb costruita dal server; il resto del JSON resta senza indirizzi e un test lo conta (un solo indirizzo, e di quella forma).
- **Sola lettura:** nessuna rotta del tab scrive o accoda niente. Un guasto di una parte (i brani, le miniature) costa solo quella parte: l'elenco non si rompe.
- **SQL:** i valori (utente, categoria, limite, offset, id) sono sempre parametri, mai scritti nel testo della query; la visibilità è sempre nella `WHERE`.
- **Nessun modello, nessuna chiamata esterna:** si legge quello che l'analisi ha già salvato (`results` dell'entry).

### 4.5 Dove il codice ha precisato il contratto (12 novembre, costruendolo e provandolo sui 1 665 reel veri)
Il documento per i client è `docs/mondrop-reels.md` e vale più di questo testo. In breve, rispetto a §4.1–4.3:
- **Id:** `entries.id` è testo; 87 post su 1 743 (quelli arrivati da Firestore) hanno 20 tra lettere e cifre invece di un UUID. Un id è **un UUID o quei 20 caratteri**; altro è `404` senza interrogare né il database né il disco.
- **Una cosa una volta sola:** software, luoghi, prodotti, marchi, persone ed eventi sono **una famiglia** (vale la prima categoria nell'ordine); un **film**, un **libro**, una **citazione** e una **canzone** non si fondono con niente («Dune» film e «Dune» libro sono due cose).
- **Brani:** fino a **50** (non 20: «Suona tutta» non si taglia), solo quelli che il diario conosce; i `names` della Musica sono titoli; la scheda dell'elenco dice **quello che la pagina mostra**. Dai brani sparisce `mediaUrl` (sempre `null` dalla 2.13.0): nessun indirizzo in nessuna risposta.
- **Il dettaglio** di un reel che l'elenco non mostra (non completato, senza niente da dire) è `404`: una scheda dell'elenco si apre sempre, il resto no.
- **Parametri:** un valore vuoto vale «non dato»; il primo sbagliato dà il nome all'errore (`400 { "error": "invalid_limit" | "invalid_offset" | "invalid_kind" | "invalid_facets" }`), `facets` accetta anche `0` e `false`, lo scarto arriva a 1 000 000; gli altri errori sono `not_found` (`404`) e `reels_failed` (`500`).
- **Pulizia in più** (dai dati veri): i segni di un JSON rotto ai bordi dei nomi (58 nomi di software su 1 368), le note che sono solo il nome della loro categoria, le **note-frase** spezzate in titolo e dettaglio (650 su 5 000), gli indirizzi scritti dentro le parole tolti (le parole restano), il riassunto al massimo 1 500 caratteri.
- **Misurato:** 1 665 schede, 16 senza spiegazione, 57 con la sola spiegazione, 1 del tutto vuota dopo la pulizia; 1 594 con la miniatura; l'elenco di tutti i reel costa 0,9 s al database. **Limiti noti, non correggibili qui:** il modello confonde le categorie («Claude» come persona, film e software) e a volte scrive un testo del riconoscimento ottico come nome.

### 4.6 «Apri» sulla scheda del film (Q3, risposta di Michele; SoundReel 2.28.0 + Mondrop 1.8.0 build 21)

**Richiesta (12 novembre, sera):** alla mia domanda «se vuoi un «Apri» sul sito del software o sulla scheda del film (non sul reel), dillo», Michele ha risposto **«Q3 si apri sulla scheda»**. La leggo come **la scheda del film** (la parola della domanda): un «Apri» su ogni film del reel che ha la sua pagina su IMDb. Per il software **non lo costruisco** (mia scelta, motivo qui sotto): se lo vuole, lo dica.

- **Dati veri (12 novembre, 1 665 reel):** 741 film mostrati, **498 con la scheda IMDb** (67 %; l'indirizzo arriva dall'arricchimento con TMDb, sempre nella forma `https://www.imdb.com/title/tt…/`); 1 358 software mostrati, **nessuno con un indirizzo utilizzabile** (nell'analisi 1 software su 1 370 ha `url`: il modello lo scrive solo se compare nel testo del post). Un «Apri» sul sito del software comparirebbe una volta ogni mille schede.
- **Contratto:** un item della categoria `film` di `GET /api/mondrop/reels/:id` può avere **`openUrl`**: `https://www.imdb.com/title/<id>/`, **costruito dal server** dall'id (`tt` e 7–10 cifre) di un indirizzo che è una pagina titolo di IMDb (`imdb.com`, con al più `www.` o `m.`, niente fra l'host e `/title/`: né credenziali, né porta, né un host più lungo). Qualunque altro valore (un altro sito, la pagina di una persona, una ricerca, l'indirizzo del post, un testo che non è un indirizzo) **non dà `openUrl`** (la chiave non c'è). Mai sul software, mai su una scheda dell'elenco, mai l'indirizzo come l'ha scritto il modello o il post. Lo stesso film nominato due volte è una sola voce e tiene la scheda della menzione che ce l'ha.
- **App:** sotto il titolo e i dettagli del film, un pulsante **«Apri su imdb.com»** (dice dove va) che apre la pagina **solo con un tocco**; l'app apre solo una pagina web su **https**, con un host e **senza credenziali**; un indirizzo diverso lascia il film senza «Apri» (e non rovina la voce). Un server 2.27.0 non manda il campo: nessun «Apri», il resto funziona; la build 20 ignora il campo.
- **Limite noto:** l'abbinamento dei film con TMDb a volte sbaglia (una parola generica come «movies» è stata abbinata a un film del 2026): «Apri» apre ciò che l'analisi ha abbinato, come fa il sito.
- **Test:** server (`reelBreakdown.test.ts`: la forma dell'indirizzo, 16 indirizzi che non passano, valori che non sono testo, solo sui film, un film nominato due volte, il limite, la scheda dell'elenco senza indirizzi, un solo indirizzo in tutta la pagina; rotta e servizio); i 1 665 reel veri letti in sola lettura (498 «Apri», 0 sul software, 0 indirizzi fuori posto, 0 schede dell'elenco con un indirizzo); app (decodifica, https e host, struttura).

## 5. L'app (Mondrop 1.8.0 build 20)

- **`PlaylistQuickPlay`** (MondropKit): dalla playlist della card al `PlayQueue` (cache o rete, `LibraryQueueBuilder`, telefono prima, loop opzionale); pura nelle decisioni, il lettore e le sorgenti sono iniettati.
- **`RepeatChoice`** (MondropKit): le tre voci del menu del loop, con titolo, icona e spunta; `RepeatIndicator` (il segno sul play).
- **Tab «Reel»:** `ReelModels` (lettura tollerante: una categoria o un campo che l'app non conosce si tiene e non si disegna), `ReelsTransport` (`MondropAPI`), `ReelsModel` (pagine da 20, filtro per categoria, sola rete), `ReelsView`, `ReelDetailView`, `ReelImageLoader` (miniature in `Caches`). `RootTab`: `home, search, reels, inbox, settings`.
- **Regola P nell'app:** `ReelTabStructureTests` fa fallire la build se i modelli dei reel hanno un campo di indirizzo diverso da `openUrl` (la scheda di un film: build 21) o se una vista dei reel apre un indirizzo (`Link(`: uno solo, nella pagina del reel, sull'`openUrl` dell'item).
- **Dati di prova** (`DemoData`, solo DEBUG): il tab Reel e una Home senza «Ascoltati di recente», per guardare le schermate sul simulatore.

## 6. Test

- **Server:** il costruttore delle schede e del dettaglio (puro): categorie e ordine, pulizia dei segnaposto, doppioni fra categorie, tagli, «altro» escluso, brani risolti/non risolti, niente `sourceUrl` in nessun punto, spiegazione assente; le query (parametri, visibilità nella `WHERE`, filtro `kind`, `total`, faccette); le rotte (401, 400 per ogni parametro sbagliato, 404, immagine, uno stream che non resta vuoto); la Home senza `recent` (e con `fresh` e `playlists` che restano). Rotture volontarie del codice nuovo, tutte da scoprire.
- **App:** decodifica tollerante dei reel; `ReelsModel` (prima pagina, altre pagine, filtro, guasto che lascia ciò che c'era, offline); `PlaylistQuickPlay` (cache prima della rete, coda con il telefono per primo, loop solo se chiesto, nessuna playlist suonabile, errore di rete); `RepeatChoice`; `maxParallel` è 1 e la coda scarica uno alla volta; `RootTab` e la struttura dei tab; regola P. Rotture volontarie, tutte da scoprire; build Release di iOS e macOS.

## 7. Rilascio

1. **SoundReel 2.27.0** (server: Home senza `recent`, le rotte dei reel): **solo con l'OK di Michele**, uno per ogni deploy. Nessuna migrazione.
2. **Mondrop 1.8.0 build 20** su TestFlight, gruppo interno «Family» (solo Michele): **con il suo OK**. Il tab Reel serve il server 2.27.0: su un server più vecchio il tab dice «Serve un SoundReel più recente» e il resto dell'app funziona come prima.
3. Non si manda niente a FamilyPlus finché Apple non dice perché ha rifiutato le build 16 e 17 (vedi CLAUDE.md).
4. **SoundReel 2.28.0 + Mondrop 1.8.0 build 21** (l'«Apri» sulla scheda del film, §4.6): costruiti e provati il 12 novembre sera; **solo con l'OK di Michele**, uno per ogni rilascio (server, poi TestFlight gruppo interno).

## 8. Domande aperte

- **Q1** (M4): finestra di N brani per il sync della playlist che suona, sì o no. **Risposta (12 novembre, sera): «lascia così»** → no.
- **Q2** (M5): il tab si chiama «Reel»; i familiari vedono solo i **propri** reel e quelli condivisi con loro (come tutto il resto). Va bene?
- **Q3** (M5): senza link, un software o un film trovato nel reel non si può aprire da nessuna parte. Se vuoi un «Apri» sul sito del software o sulla scheda del film (non sul reel), dillo: è un campo in più. **Risposta (12 novembre, sera): «si apri sulla scheda»** → fatto per il film (§4.6); per il software no (non c'è il dato).
