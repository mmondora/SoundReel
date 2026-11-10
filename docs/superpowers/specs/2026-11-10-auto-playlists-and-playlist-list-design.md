# Playlist automatiche dai post che parlano di musica, e l'elenco delle playlist che si cerca, si ordina e si sfoglia (richiesta 2026-11-10)

Stato: **richiesta di Michele del 10 novembre, disegnata con i default scelti (§5: da correggere se non vanno), costruita, provata e **in produzione** (SoundReel **2.20.0** dal 10 novembre alle 01:06 con il suo OK; Mondrop 1.7.0 **build 12** su TestFlight alle 01:08): backend, sito e app con i test, le rotture provate, la prova su un Postgres vero e l'anteprima su dati veri (§2b). Le playlist per le voci già presenti **non sono state fatte**: solo con `--apply` e il suo OK.
ADR: ADR-0023 (**proposto**). Spec collegata: `2026-11-09-library-collections-auto-topics-design.md` (le raccolte; qui le playlist).
Codice previsto: backend `services/autoPlaylists.ts` (+ `autoPlaylistTitle.ts`), `scripts/buildAutoPlaylists.ts`, migrazione `021_auto_playlists.sql`, `routes/playlists.ts` e `routes/mondrop.ts` (parametri dell'elenco); sito `components/PlaylistPanel.tsx`, `pages/PlaylistManagerPage.tsx`; app `ios/Mondrop/PlaylistsView.swift`, `ios/MondropKit/PlaylistListModel.swift`.

## 1. Richiesta di Michele (testuale)

10 novembre, nello stesso messaggio che rispondeva alle quattro domande sulle raccolte (`1 si, - 2 no, - 3 5 voci - 4 ok.`):

> «voglio anche che se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato" e le 5 musiche dentro. se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve essere una sola. in tal caso le musiche sono ordinate per data di inserimento, le ultime per prime per facilitare gli ascolti. mondrop deve permettere di vedere queste play list. Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop.»

In due parti: **(A)** i post che parlano di musica **diventano playlist**, una per post se il titolo è preciso, **una sola per tema** se è generico, con i brani nuovi in cima; **(B)** quando le playlist sono molte l'elenco si **cerca, si seleziona, si sfoglia**, mostra la **data di creazione** accanto al nome e si **ordina per data**, sul sito e su Mondrop.

## 2. Cosa c'è oggi (misurato il 10 novembre 2026, sola lettura)

- **Playlist** (`playlists`: id, name, owner_user, created_at, updated_at, kind `static`|`dynamic`, rule; `playlist_songs`: playlist_id, song_key, position, added_at, letta per `position, added_at`). Si creano **a mano** dal sito e da Mondrop (statiche), o come regole (dinamiche, ADR-0008). Nessuna nasce da sola.
- **L'elenco** (`GET /api/playlists` sul sito, `GET /api/mondrop/playlists` per l'app) risponde **con tutte**, ordinate per ultima modifica, senza ricerca, senza pagine; l'app e il sito mostrano il nome e il numero di brani, **non la data di creazione**.
- **I post che parlano di musica:** delle 719 voci con canzoni solo **94** hanno canzoni che vengono dal **contenuto** del post (`ai_analysis` 71 voci con 241 brani, `both` 27; più un link Spotify e uno Shazam); le altre circa 626 hanno **solo l'impronta audio del sottofondo** (`audio_fingerprint`: una canzone che passa sotto un reel che parla d'altro). Solo **42** voci hanno almeno **due** canzoni dal contenuto (la soglia per una playlist); i 94 con una sola non fanno una playlist.
- **Ganci già pronti:** `onAnalysisFinished` nel lavoro di coda (`jobQueueWorker.ts`) e la Posta (`inbox_items`, messaggi `info` che scadono dopo 3 giorni, ADR-0015).

## 2b. Prova su dati veri (anteprima del 10 novembre: sola lettura, in memoria, regole vere e modello locale vero)

Le **42** voci con almeno due canzoni dal contenuto, dalla più vecchia, ~1 secondo a voce: **36 playlist nuove, 5 voci entrate in una playlist di un tema, 1 voce saltata perché non parla di musica** (il post dei film), **211 brani**. Cosa ha mostrato (e cosa ho corretto):
- La prima corsa faceva **37 playlist e un post di film** come playlist («Film da vedere su RaiPlay», 7 «brani»): da lì `aboutMusic`.
- Il modello scriveva titoli in TUTTO MAIUSCOLO copiati dalla didascalia («GARA DURÁN») e temi con numeri e superlativi («Album più belli»): da lì le regole sul titolo di un tema e il minuscolo.
- Con le regole nuove i temi si fondono di più («Album da ascoltare» raccoglie 5 post, 21 brani; «Capolavori anni 80 italiani» 2 post, 12 brani) ma **restano difetti di un modello piccolo**: qualche refuso nel titolo («Canzioni per guidare la notte», «Royksoop da Ascoltare»), temi a nome di un artista («Pet shop boys da ascoltare»), qualche tema quasi doppio («Canzoni per guidare la notte» e «Canzone da ascoltare»). Si correggono rinominando; **non si fondono per somiglianza di parole o di significato** (provato con i vettori sui titoli: «Jazz da ascoltare» e «Album da ascoltare» a 0,91, «Rock anni 80» e «Musica anni 80» a 0,90, quindi fonderebbero cose diverse): meglio una playlist in più che brani nella playlist sbagliata.
- **Da decidere con l'anteprima davanti** (lo script `--apply`, solo con l'OK di Michele): applicarla a tutte le 42 voci, a quelle da una certa data, o per niente (valgono solo i post nuovi).

## 3. Cosa si costruisce

### A. Playlist automatiche

1. **Quando.** Una voce **parla di musiche** se l'estrazione ha **almeno 2 brani con fonte nel contenuto** (`ai_analysis`, `both`, `music_list`). Un brano solo, o brani che sono solo l'**impronta audio** del sottofondo, **non fanno una playlist**. Un link Spotify (playlist) ha già il suo percorso (Spooty): non si tocca. **E il modello locale, nella stessa chiamata del titolo, conferma che il post parla davvero di musica** (`aboutMusic`): le «canzoni» di un post sui film, la colonna sonora o una citazione **non fanno una playlist** (visto sulle voci vere: un post «film da vedere su RaiPlay» aveva 7 «brani»); la voce si segna come vista e non si chiede più.
2. **Il titolo e il tipo** (una chiamata dedicata, in coda dopo l'analisi, **mai dentro l'analisi**, locale, mai Claude; risposta vincolata da uno JSON Schema): dal testo del post e dai titoli dei brani il modello dà `{ title, kind, existingTheme }`.
   - **`one_off`** (titolo **preciso**: un numero, un'occasione, un anno, un artista: «Le 5 musiche di Natale», «Canzoni del 2026»): **una playlist per post**, con quel titolo, e i brani **nell'ordine del post**.
   - **`theme`** (titolo **generico**: un genere, un umore, un'abitudine: «ecco gli album jazz da ascoltare» → **«Jazz da ascoltare»**): **una sola playlist per tema**. Un post nuovo dello stesso tema **entra nella stessa playlist**; il modello vede l'elenco dei temi che già esistono e, se il post è uno di quelli, scrive `existingTheme` **identico**; altrimenti si cerca per chiave (titolo senza maiuscole, accenti, segni), e come ultimo ripiego per somiglianza di parole. Ogni post nuovo mette i suoi brani **in cima** (la serie è in ordine di **data di inserimento, gli ultimi per primi**, come chiede Michele); un brano già nella playlist **non si aggiunge due volte**.
   - **Il titolo di un tema** è un'etichetta breve e durevole (2–4 parole: il genere, l'umore o l'occasione, e «da ascoltare» o «per…» se serve), **senza numeri, anni o superlativi** («10 dischi per una cena con gli amici» → «Musica per la cena»).
   - **Pulizia del titolo** (come per i nomi delle raccolte): niente `#`, `@`, virgolette, emoji, «ecco»/«ecco i»/«ecco gli», **mai tutto in maiuscolo** («GARA DURÁN» → «Gara durán»; una sola parola in maiuscolo, «ABBA», resta); italiano (o la lingua dell'interfaccia), massimo 60 caratteri, iniziale maiuscola. Se il modello non risponde o il titolo è vuoto dopo la pulizia, **nessuna playlist** e la voce resta «da fare» (si riprova); mai una playlist con un titolo brutto.
3. **Una volta sola per voce:** `auto_playlist_runs` ricorda ogni voce già vista (fatta, saltata, in attesa), quindi una rianalisi non duplica niente. **Una playlist cancellata dall'utente non si ricrea** (per un tema, il registro `auto_playlist_themes` tiene la chiave anche dopo la cancellazione, senza playlist). Una playlist **rinominata** o **ritoccata a mano** resta com'è e continua a ricevere i post del suo tema (la chiave non è il nome).
4. **Sono playlist come le altre:** statiche, dell'utente, con `origin = 'auto'` (e `auto_kind`), quindi **Mondrop le vede già** (scheda Playlist e Home), si scaricano e si ascoltano come ogni playlist, si possono rinominare, riordinare, condividere e cancellare. Un'etichetta «automatica» le distingue.
5. **Posta (l'avviso):** una playlist nuova manda un messaggio `info` («Nuova playlist: Le 5 musiche di Natale · 5 brani»); i brani aggiunti a un tema, un solo messaggio per post («Jazz da ascoltare · +3 brani»). Scade dopo 3 giorni come gli altri `info` (regola di Michele).
6. **Le voci già nella libreria:** uno script, `node dist/scripts/buildAutoPlaylists.js`, **anteprima per default** (`--dry-run`: quali playlist nascerebbero, con titolo, tipo e brani), `--apply` **solo con l'OK di Michele**; le voci si prendono **dalla più vecchia**, con `added_at` = data del post, così i temi finiscono con i brani più nuovi in cima. Non gira al deploy.
7. **Interruttore:** `AUTO_PLAYLISTS=0` ferma tutto (le playlist create restano).

### B. L'elenco delle playlist (sito e Mondrop)

1. **Cercare:** un campo di ricerca sul **nome** (parole in qualunque ordine, senza maiuscole né accenti, come la ricerca della libreria).
2. **Selezionare:** filtri **Tutte · Automatiche · Mie · Condivise · Dinamiche**.
3. **Ordinare per data:** per **data di creazione** (predefinito: **le più nuove per prime**, con il verso che si inverte), e anche per ultima modifica, nome, numero di brani.
4. **Sfogliare:** a pagine di 30 (`limit`, `offset`, massimo 100), con il totale («30 di 112»). Sul sito «Mostra altre» in fondo al pannello; sull'app l'elenco si allunga scorrendo (stessa rotta, stessi parametri).
5. **La data di creazione accanto al nome** («10 nov 2026»; «oggi» e «ieri» quando lo sono), su ogni riga, sul sito e sull'app.
6. **Il server decide tutto** (regola P: cercare, filtrare, ordinare e tagliare in pagine lo fa la rotta; il client mostra e basta). **Compatibile:** senza parametri la rotta risponde **come oggi** (tutte, per ultima modifica) con in più `total`, quindi le app già installate non cambiano; i parametri li usano solo la build 12 e il sito nuovo.
7. **Rotte:** `GET /api/mondrop/playlists?q&filter&sort=created|updated|name|size&order=asc|desc&limit&offset` e lo stesso su `GET /api/playlists`; risposta `{ playlists: [...], user, total, limit, offset }`, ogni playlist con `createdAt`, `origin` (`user`|`auto`), `autoKind` (`one_off`|`theme`|null).

## 4. Come si vede (bozza a parole; il disegno si fa se Michele lo vuole)

- **Sito** (pannello playlist del gestore): in cima il campo «Cerca nelle playlist», sotto una riga di filtri (Tutte · Automatiche · Mie · Condivise · Dinamiche) e il selettore dell'ordine («Data di creazione ↓», che si inverte con un tocco); ogni riga: **nome**, etichetta «automatica» se lo è, **data di creazione** a destra, numero di brani; in fondo «Mostra altre (30 di 112)».
- **Mondrop** (scheda Playlist): barra di ricerca nativa (`.searchable`), un menu **Ordina** (data di creazione, ultima modifica, nome, brani; il verso) e un menu **Mostra** (Tutte, Automatiche, Mie, Condivise, Dinamiche); righe con nome, etichetta, **data** e numero di brani; l'elenco si allunga scorrendo, con «30 di 112» in fondo. La Home continua a mostrare le 12 più recenti.

## 5. Decisioni (con i default scelti: da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| P1 | **Quando nasce una playlist** | Almeno **2 brani con fonte nel contenuto** del post **e** il modello conferma che parla di musica (`aboutMusic`); mai per l'impronta audio del sottofondo, per un brano solo, né per i «brani» di un post sui film |
| P2 | **Titolo preciso o generico** | Lo decide il modello locale con esempi (`one_off`: numero, occasione, anno, artista; `theme`: genere, umore, abitudine); **una playlist per post** o **una sola per tema** |
| P3 | **Una sola per tema** | Chiave = titolo pulito; il modello sceglie fra i temi esistenti; ripiego per somiglianza di parole; i post nuovi **entrano nella stessa** |
| P4 | **Ordine dei brani** | `one_off`: ordine del post; `theme`: **gli ultimi inseriti per primi** (ogni post in cima, nell'ordine che ha al suo interno); nessun doppione |
| P5 | **Sono playlist normali** | Statiche, dell'utente, `origin = 'auto'`; visibili su Mondrop e sul sito; modificabili; l'etichetta «automatica» |
| P6 | **Cancellazione e rinomina** | Cancellata = non si ricrea (registro dei temi); rinominata = resta e continua a ricevere (la chiave non è il nome) |
| P7 | **Avviso** | Messaggio `info` in Posta, 3 giorni: una volta per playlist nuova, una per post che aggiunge a un tema |
| P8 | **Le voci già presenti** | Script con anteprima per default, `--apply` solo con l'OK di Michele; dalla voce più vecchia, `added_at` = data del post |
| P9 | **L'elenco** | Cerca (nome), filtri, ordine per data (predefinito: più nuove), pagine da 30, data di creazione accanto al nome, **tutto deciso dal server**; compatibile con le app vecchie |
| P10 | **Numeri** | SoundReel **2.20.0** (server e sito) + Mondrop 1.7.0 **build 12**; nessun deploy né TestFlight senza OK |
| P11 | **Tutto locale** | Titolo e tipo dal modello locale via gpu-router, mai Claude; niente esce |

## 6. Dati e contratto (bozza; ADR-0023)

- **`playlists`** (colonne nuove, migrazione additiva): `origin TEXT NOT NULL DEFAULT 'user'` (`'user'|'auto'`), `auto_kind TEXT` (`'one_off'|'theme'`), `theme_key TEXT`, `source_entry_id TEXT`; indici unici parziali `(owner_user, theme_key) WHERE theme_key IS NOT NULL` e `(owner_user, source_entry_id) WHERE auto_kind = 'one_off'` (idempotenza e «una sola per tema» garantite dal database).
- **`auto_playlist_runs(entry_id, owner_user, status ('done'|'skipped'|'pending'), playlist_id → playlists ON DELETE SET NULL, reason, processed_at, PK(entry_id, owner_user))`.**
- **`auto_playlist_themes(owner_user, theme_key, title, playlist_id → playlists ON DELETE SET NULL, created_at, PK(owner_user, theme_key))`**: un tema con `playlist_id` nullo è un tema **cancellato dall'utente**.
- **Ordine «ultimi per primi»:** i brani di un post nuovo prendono posizioni **più basse** di tutte quelle presenti (`MIN(position) - n …`), nell'ordine che hanno nel post; la lettura è sempre `ORDER BY position, added_at` (nessun cambio per le playlist a mano). Un riordino manuale rinumera come oggi.
- **Rotte dell'elenco:** vedi §3.B.7. Parametri ignoti o non validi → errore `400` leggibile, mai un elenco sbagliato; `limit` oltre 100 → 100.
- **Gancio:** `onAnalysisFinished` (con le canzoni già estratte) mette la voce in coda; nessun errore può far fallire un'analisi (stesso schema di `softwareExtraction`).

## 7. Test

- **Pianificatore puro** (nessun database, nessun modello): meno di 2 brani con fonte nel contenuto → niente; impronta audio sola → niente; `aboutMusic` falso → niente, visto una volta sola; `one_off` → una playlist per voce nell'ordine del post; `theme` → la playlist del tema (esistente o nuova); un tema cancellato → saltata; titolo vuoto dopo la pulizia → niente e «pending».
- **Titolo:** pulizia (`#@"*`, «ecco i», emoji, 60 caratteri), `existingTheme` accettato solo se identico a uno esistente, ripiego per somiglianza.
- **Scrittura** (database di prova, come i test delle playlist): idempotenza (due corse = una playlist), «una sola per tema» anche con due corse insieme (indice unico), **i brani nuovi in cima** con l'ordine interno del post, nessun doppione, `added_at` della voce nel backfill, tema cancellato non ricreato, rinomina che non rompe il tema, playlist cancellata → `playlist_id` nullo.
- **Elenco:** ricerca senza maiuscole e accenti e con le parole in disordine, ogni filtro, ogni ordine e verso, `limit`/`offset`/`total`, **nessun parametro = come oggi**, parametri invalidi → 400.
- **Sito:** il pannello cerca, filtra, ordina, mostra la data accanto al nome, «Mostra altre».
- **App (XCTest):** decodifica con `total`/`origin`/`autoKind` (e senza, per un server vecchio), costruzione dei parametri, paginazione (allunga, si ferma al totale, ricomincia a ogni ricerca), ordine e filtro, formato della data.
- **Rotture provate** con il banco delle mutazioni (soglia dei 2 brani, in cima/in fondo, idempotenza, il tema cancellato, il verso dell'ordine, il tetto a 100).
- **Prova su dati veri, in lettura:** l'anteprima dello script sulle 94 voci (quante playlist, quanti temi, titoli) prima di qualunque scrittura.

## 8. Fasi

1. **L'elenco** (B): rotte con i parametri, sito, app; non dipende da niente e serve subito.
2. **Le playlist automatiche** (A): pianificatore, titolo, scrittura, gancio, avvisi.
3. **Lo script** con l'anteprima sulle voci già presenti; `--apply` a parte, con l'OK.
4. SoundReel 2.20.0 e Mondrop build 12: ognuno col suo OK.

## 9. Limiti noti e fuori ambito

- Il confine fra titolo **preciso** e **generico** lo fa un modello locale: sbaglierà qualche volta; basta rinominare, unire a mano (si spostano i brani) o cancellare.
- Un post che nomina i brani **solo nelle immagini** dipende dall'OCR e dall'analisi (se l'estrazione non li trova, la playlist non nasce).
- La ricerca cerca nel **nome** della playlist, non nei brani (si può aggiungere).
- Le playlist **dinamiche** (regole) restano a mano; le automatiche sono statiche.
- Fuori ambito: condividere in automatico, playlist automatiche dai film, e ogni cosa che riguardi le **raccolte** (altra spec).
