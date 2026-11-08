# Mondrop — installazione e uso

App iPhone/Mac: **Condividi → Mondrop → (tag) → Invia** → journal SoundReel.

Ogni share manda: **link**, **utente Authelia** (`mike`/`archi`/`sara`), **data/ora locale del device**, **canale** (ios/macos), **device** (nome/modello/OS/timezone).

---

## Installazione (iPhone) — su vulcano o un altro Mac

### 1. Una tantum sul Mac

```bash
# Xcode già installato; poi:
brew install xcodegen   # se manca (/opt/homebrew/bin)

cd ~/works/Soundreel/ios   # su vulcano il tree è già syncato da geekom
# oppure clona/sync del repo Soundreel
xcodegen generate
open Mondrop.xcodeproj
```

### 2. Firma in Xcode (obbligatoria per iPhone fisico)

Su vulcano oggi **non** ci sono certificati Apple (`0 valid identities`):

1. Xcode → **Settings → Accounts** → aggiungi il tuo Apple ID (Team **5NZADC9YQ2** / mikesoft)
2. Seleziona target **Mondrop** → **Signing & Capabilities** → Team automatico
3. Stesso Team sul target **MondropShare**
4. Collega l’iPhone via cavo, confida il computer

### 3. Run sull’iPhone

1. Scheme **Mondrop** → destination = il tuo iPhone → ▶ Run  
2. Prima apertura: tocca **Ottieni API key** (home, o **Impostazioni → API key**)
   - si apre il foglio di login Authelia → **Genera API key** → torni nell’app già collegato
   - la key è personale (utente Authelia + nome del dispositivo); **Rinnova API key** la sostituisce (la vecchia smette di funzionare)
   - fallback: «Incolla a mano» (key da `cat ~/.config/soundreel/share-api-key` su geekom, oppure mint sotto)

> Nessuna key mintata a mano per gli utenti: ognuno la genera dal proprio device con il login Authelia
> (pagina `/mondrop/connect`, vedi `docs/share.md`). OIDC vero (Bearer) resta l’upgrade: `docs/mondrop-auth.md`.

### 4. Favorisci Mondrop nello share sheet

Instagram (o Safari) → Condividi → **Modifica azioni / Edit Actions** → pin **Mondrop**.

### 5. Prova

Condividi un Reel → Mondrop → eventuale `#tag` → **Invia** → controlla https://soundreel.casamon.dev

---

## Installazione Mac (Share da Safari)

Scheme **MondropMac** → Run. Stesse Impostazioni (utente + API key). Poi Safari → Condividi → Mondrop.

---

## Mint API key manuale (geekom, legacy)

```bash
docker exec soundreel node -e \
  "fetch('http://127.0.0.1:8080/api/share/mint-key',{method:'POST'}).then(r=>r.json()).then(console.log)"

# già mintata su questa macchina:
cat ~/.config/soundreel/share-api-key
```

---

## Sync / primo play

Contratto API: `docs/mondrop-sync.md`. Tab **Playlist** → una playlist.

- **Sync** = `POST …/prepare` (il server prepara i brani non pronti) + download in background: sessione `URLSession` *background*
  (continua anche con l'app sospesa), **solo Wi-Fi** salvo l'interruttore *Impostazioni → Sync → Scarica anche con rete cellulare*,
  **max 2 in parallelo**, ripresa dei download interrotti. Finché il server ha brani `preparing` l'app rilegge il manifest ogni ~5 s
  (max ~10 min) e scarica ogni brano appena è `ready`. Il pulsante è ripetibile: nulla viene scaricato due volte.
- **Salta ciò che c'è già**: un brano è «presente» solo se il file esiste, **non è vuoto** e — quando il manifest conosce `bytes` — ha
  la stessa dimensione (la sola `version` non basta: il backend precedente serviva `200` con `Content-Length: 0` e la vecchia app
  indicizzava MP3 da 0 byte). Un file basta per tutte le playlist.
- **Solo rete cellulare** con l'interruttore spento: i download non falliscono, restano **in attesa del Wi-Fi** (la schermata lo dice).
- **Indirizzo**: sempre e solo SoundReel (regola P, ADR-0018): si scarica e si suona da `downloadPath` (HTTPS, con key), in casa e fuori. L'app
  **non ha** un percorso verso il media server e **non sceglie** la sorgente in base alla rete: dove sta il file lo sa il server. Il manifest
  non porta più nessun indirizzo di negozio (un server più vecchio lo manda ancora: l'app lo ignora). `GET /api/mondrop/net` serve solo alla riga
  «Rete: casa / internet» delle Impostazioni. Un download che fallisce è un errore visibile (con «Riprova»), non c'è un secondo indirizzo.
  `MondropTests/RulePTests` fa fallire la build se nei sorgenti compaiono indirizzi di negozi o una scelta in base alla rete.
- **Primo play**: tocca un brano. Se è sul telefono si riproduce il file; altrimenti parte **subito in streaming** e si scarica **in parallelo**
  (la prossima volta è locale). Se il server non l'ha ancora preparato: «Preparo il brano…» (richiesta con priorità + controllo ogni ~2 s).
- **Stato per brano**: preparo sul server · in coda · scarico NN % · scaricato · errore (+motivo, «Riprova») · nessuna sorgente
  (+ «Link» per incollare un link YouTube).
- **File**: `Application Support/Mondrop/Offline` (escluso dal backup iCloud), indice in `offline-index.json`. Al primo avvio i file di
  `Documents/Offline` e l'indice in UserDefaults vengono migrati (i file vuoti scartati).
- **Libera spazio** (Impostazioni → Sync): rilegge **tutte** le playlist, poi propone di eliminare solo i brani che non sono più in
  nessuna playlist, con conteggio e MB, e solo dopo conferma. Se una playlist non si legge non cancella niente.
- **Permessi**: nessuna eccezione ATS (`NSAllowsArbitraryLoads` spento, tutto HTTPS verso SoundReel) e `NSLocalNetworkUsageDescription`
  (a casa il nome di SoundReel risolve a un indirizzo della rete locale e iOS può chiedere il permesso «Rete locale»).
- **Test**: `xcodebuild test -scheme Mondrop -destination 'platform=iOS Simulator,name=iPhone 17e' -skip-testing:MondropTests/ShareClientTests`
  (`ShareClientTests` è lo smoke test contro la produzione: crea una entry nel journal, quindi non lo si lancia di default).

---

## Statistiche e spazio (Mondrop 1.4)

Contratto: `docs/mondrop-stats.md` §1–§4 · decisioni D1–D9: `docs/superpowers/specs/2026-11-07-listening-stats-dynamic-playlists-design.md`.

- **Ascolti**: `PlayTracker` osserva il player (file locali **e** primi play in streaming, anche in background e con lo schermo bloccato) e somma
  i millisecondi **realmente ascoltati**: pause, buffering e seek non contano. Una sessione ≥ 3 s diventa un evento (`id` UUID, `startedAt` UTC,
  `tzOffsetMin` dell'istante di partenza, `listenedMs`, `durationMs`, `completed`, `origin` local|stream, `playlistId` della playlist da cui è partita la coda).
  Un nuovo brano / lo stop / l'uscita dall'app chiude la sessione; se l'app viene uccisa, la sessione aperta è in un piccolo journal
  (checkpoint ogni ~10 s e a ogni pausa) e al lancio dopo diventa il suo evento **una volta sola** (stesso id: né persa né duplicata).
- **Coda eventi** (`event-queue.jsonl` in Application Support, esclusa dal backup): una sola coda durevole per ascolti ed eventi del dispositivo.
  Un evento esce solo dopo la risposta `200` (il server è idempotente per id: rispedire è sicuro). Tetto 5000: si scartano i **più vecchi**
  (prima gli ascolti; le cancellazioni sono l'audit e restano) e in Impostazioni compare il contatore.
- **Quando parte** (D2): a 20 eventi, quando l'app va in background (dentro `beginBackgroundTask`), al lancio, ogni 15 minuti in foreground,
  con «Invia ora». Lotti da ≤ 200 (il server accetta 500); backoff esponenziale 30 s → 15 min; un `401/403` mette in pausa e mostra
  «API key non valida» **senza perdere eventi**; un lotto che il server rifiuta in blocco (400/413/422) viene dimezzato fino a isolare l'evento colpevole.
  Impostazioni → *Statistiche di ascolto* mostra quanti eventi aspettano e l'ora dell'ultimo invio riuscito.
- **Numeri per brano**: `plays` / `lastPlayedAt` del manifest e di `GET /songs/:key` finiscono nell'indice locale; ogni ascolto contato
  (stessa regola del server: `listenedMs ≥ min(30 s, 50 % della durata)`) li aggiorna subito, anche offline. I numeri del server sono su
  **tutti** i dispositivi; gli ascolti di questo telefono non ancora confermati restano in più, così la classifica non torna mai indietro.
- **Spazio** (Impostazioni → Sync → *Spazio e brani scaricati*, **solo** da lì: sezione «Cancellazione», regola di Michele dell'8 novembre): spazio occupato, brani scaricati con peso / ascolti /
  ultimo ascolto; ordinamento *Meno ascoltate* (default: meno ascolti contati, poi ultimo ascolto più vecchio, mai ascoltati per primi),
  *Più pesanti*, *Più vecchie*, *Nome*; selezione multipla; scorciatoie **«Elimina le N meno ascoltate»** (N da 1, default 20),
  **«Libera spazio»** (100 / 250 / 500 MB, 1 GB: toglie i meno ascoltati finché non si libera tanto) e «Elimina i brani non più in nessuna playlist».
  Prima di decidere rilegge le playlist per avere ascolti e appartenenze aggiornati (offline usa quelli che ha e lo dice).
- **Cancellare** (D7): un brano = **una** conferma; **qualsiasi blocco** (più di un brano, comunque scelto) = **doppia** conferma — prima finestra con
  numero, MB e i primi titoli, seconda «Sei sicuro? Non si può annullare» con il pulsante distruttivo; «Annulla» in uno qualsiasi dei due passi non cancella nulla.
  Dopo la conferma l'evento `delete_songs` (motivo `manual|least_played|free_space`, criteri, conferme 1 o 2, numero, byte, e **una voce per brano**
  con `songKey/title/artist/bytes/plays/lastPlayedAt`) viene scritto nella coda **prima** di togliere i file, così sopravvive a un crash; se non si
  riesce a scriverlo non si cancella niente.
- **Skip-list** (D8): i brani cancellati dal telefono non vengono riscaricati dal Sync («rimossa dal telefono» + **Riscarica**); ascoltarli li fa
  partire in streaming **senza** il download in parallelo. «Riscarica» toglie la voce e scarica.
- **Playlist dinamiche** (§4): arrivano come playlist normali con badge **DINAMICA** e il riepilogo della regola; il Sync scarica i brani
  «veri adesso»; i brani usciti dalla regola diventano orfani e si tolgono solo con un'azione esplicita. Nell'app sono in sola lettura.
- **Compatibilità**: ogni campo nuovo è opzionale; con un backend senza `plays`/`device-events`/`kind` l'app funziona come prima e gli eventi
  restano in coda (se l'endpoint risponde 404 riprova con backoff).
- **Test**: stessi comandi di sopra; i test non toccano la rete (`URLProtocol` stub, orologi e trasporti finti).

---

## Cerca (1.7.0)

Contratto: `docs/mondrop-sync.md` («GET /api/mondrop/search», «POST /api/mondrop/playlists/:id/songs») · ADR-0018 · spec
`docs/superpowers/specs/2026-11-08-mondrop-search-spotify-style-design.md` (S1–S11, sezione 8).

- **Cerca** prende il posto della scheda Libreria (richiesta di Michele, 8 novembre: «posso cercare anche senza avere/fare playlist, alla Spotify»).
  Un campo **sempre visibile** sotto il titolo; scrivendo (dopo una pausa di 300 ms) compaiono **Brani**, **Artisti**, **Album** e le **Playlist**
  il cui nome ha le parole (l'ordine non conta: «Maestro Bassi» trova «Bassi Maestro»). Si cerca in **tutto** quello che si può suonare — il
  diario, i file di geekom, il NAS — **senza** playlist e anche per un brano che nessuno ha mai salvato da un post: la ricerca la fa il **server**
  (regola P) e **non dice dove sta** il file. Una canzone è **una riga**, anche se il NAS la tiene in due o tre copie con grafie diverse.
- *Tocca un brano*: parte quello e **vanno in coda i brani che lo seguono** nella stessa lista (quelli prima no). *Tieni premuto*:
  **Aggiungi in coda** (dopo quelli già in coda; uno già in coda resta dov'è), **Aggiungi a playlist…** (le tue playlist statiche; vale anche per un
  brano che esiste solo come file), **Scarica sul telefono**.
- *Artista* e *Album*: la loro pagina, con **Riproduci** e **Casuale** (tutta la lista, anche oltre la prima pagina) e i brani; la pagina di un artista
  ha anche i suoi album. «Mostra tutti i brani (N)» apre l'elenco completo di una ricerca, con le pagine che si caricano scorrendo.
- *Prima di scrivere*: le **ricerche recenti** (solo su questo telefono; si tolgono con uno scorrimento o con «Cancella») e **Sfoglia**, la vecchia
  Libreria: Playlist, Album, Autori, Anni, Tipi e **Sul telefono**. «Solo sul telefono» sta nel menu di Cerca. **«Spazio» non c'è più nelle schermate della musica**: la cancellazione dei brani scaricati è un'opzione speciale e sta **solo nelle Impostazioni**, in una sezione «Cancellazione».
- *Offline*, o con «Solo sul telefono»: la ricerca vale **solo per i brani scaricati** (le stesse regole, sul telefono) e lo dice una riga in cima. Se il
  server non risponde (rete, backend senza la rotta) la lista passa ai brani sul telefono con l'avviso: mai una schermata vuota.
- **Schede**: Player, **Cerca**, Playlist, Posta, Share, Impostazioni. La Libreria non è più una scheda (si apre da «Sfoglia»); il Player senza coda
  propone «Cerca musica».
- **Test** nuovi (`SearchModelsTests`, `SearchModelTests`, `SearchPlaybackTests`): la richiesta sul filo (parole, `+`, `&`, accenti, limiti), la
  risposta documentata e quelle storte, la ricerca online / sul telefono / con server che non risponde, risposta tardiva scartata, pagine, polling dei
  brani in preparazione, le playlist trovate per nome, «tocca = questo e i seguenti», «Aggiungi in coda», le ricerche recenti, il selettore delle playlist
  con i rifiuti del server in parole semplici.

## Libreria, stati e notifiche (2.9.0)

Contratto: `docs/mondrop-sync.md` («GET /api/mondrop/library» e i campi `album` / `genres` / `year`) · ADR-0013 · spec
`docs/superpowers/specs/2026-11-08-player-selection-and-filters-design.md` (X1–X3).

- **Libreria** (la tab «Coda» è stata sostituita): si sceglie **una playlist, un album, un autore, un tipo** (genere), **un decennio**
  («Anni 80» = 1980–1989, più «Senza anno») **o un brano**, con la ricerca (le parole in qualsiasi ordine: «Maestro Bassi» trova «Bassi Maestro»).
  La scelta diventa la coda e resta visibile come **«In coda: Album · Thriller · 3 / 9»**: nel Player, nel mini player in fondo alle schermate e nella
  schermata «In coda» (ogni brano con il suo stato; tocca per saltarci). Il Player senza coda propone «Cerca musica» (dalla 1.7.0 la Libreria si apre da «Sfoglia», dentro Cerca).
  - *Tocca un brano*: parte quello e la lista che stai guardando è la coda; *tieni premuto* → «Suona solo questo brano» (coda di uno).
    «Suona» / «Mescola» (con il brano toccato per primo) usano **tutta** la scelta: le pagine successive del server si caricano prima.
  - *Online* si sfoglia `GET /api/mondrop/library` (filtri `q genre album artist decade`, voci con conteggio, pagine da 100). *Offline* — o con
    «Solo sul telefono» dal menu — le **stesse regole** girano sui brani scaricati: album / tipo / anno si salvano accanto al file al download e si
    completano per i file vecchi appena l'app rilegge una playlist o la Libreria. Un file vecchio senza dati sta sotto «Senza anno».
    Se il server non risponde (rete, backend senza l'endpoint) compare l'avviso e la lista passa ai brani sul telefono: mai una schermata vuota.
  - Le playlist si aprono come prima (Sync, stati, «Riscarica»…) e ora hanno «Suona» / «Mescola». «Spazio» (dove si cancellano i brani) è solo nelle Impostazioni.
- **Stati del download** (sulla riga del singolo brano, ovunque: playlist, Libreria, «In coda»): **spinner** mentre il server prepara il brano o
  il telefono lo scarica (con **NN %** del trasferimento e la barra), **segno verde** quando è sul telefono; poi *in coda*, *da cercare ·
  nessuna sorgente trovata* (`no_source`), *errore* con il motivo (del telefono o del server). In cima a ogni schermata una **riga di stato**:
  «Preparo 3 brani sul server · 1 in download dal telefono · 2 in coda · 1 errore» (anche «In attesa del Wi-Fi»); sparisce quando non succede niente.
  Il telefono non vede la coda del server: sa che un brano è `preparing` solo quando legge una playlist / la Libreria / aspetta un primo play, e
  se ne dimentica dopo 2 minuti senza nuove letture (`SyncActivity`). Mentre una lista ha brani in preparazione la schermata la rilegge ogni 5 s (max 10 min).
- **Notifica a sync finito**: quando un Sync (Sync, Riprova, Riscarica) finisce e l'app **non è in primo piano**, una notifica locale
  «Sync finito — 12 brani scaricati, 2 errori» (+ «N ancora in preparazione sul server» se il server non ha finito). Interruttore in
  *Impostazioni → Sync → «Avvisami a sync finito»*, **acceso di default**. Il permesso a iOS si chiede **solo quando serve**: al primo Sync o
  accendendo l'interruttore (mai a fine sync: da background iOS non mostrerebbe la richiesta). Se è negato o l'app è in primo piano non si
  notifica niente e **il Sync non si ferma mai**. Il download che parte da solo al primo play **non** è un Sync e non notifica. Il Sync in corso
  sta in `sync-batch.json`: se iOS risveglia l'app in background per consegnare l'ultimo file, il riepilogo sa ancora quali brani aveva avviato
  (un file lasciato da un crash di oltre 6 ore fa si scarta). Con una notifica già in lista, quella nuova la sostituisce.
- **Compatibilità**: `album` / `genres` / `year` sono opzionali ovunque (un backend vecchio non li manda: nessun tipo / «Senza anno»);
  l'indice, la coda su disco e la descrizione dei task di download delle versioni precedenti si leggono ancora. Spazio con doppia conferma,
  skip-list, coda eventi di ascolto, playlist dinamiche e logica del primo play non sono cambiati.
- **Non verificabile senza un dispositivo**: l'arrivo vero della notifica (e il suo permesso), l'ascolto, e il risveglio in background con download
  finiti mentre l'app era chiusa. I test coprono le decisioni (quando / cosa), la contabilità del Sync e la persistenza con trasporti e centri
  di notifica finti.
- **Test** nuovi: costruzione e codifica della query (`+`, `&`, accenti, emoji), lettura delle risposte vecchie e nuove, stati → riga, testo della
  riga di stato, decisione e testo della notifica, coda da album / autore / decennio / brano / playlist, regole offline = regole del server.

---

## Foglio di condivisione, Posta e notifiche (Mondrop 1.6 · SoundReel 2.10.0)

Contratto: `docs/mondrop-inbox.md` · spec `docs/superpowers/specs/2026-11-08-mondrop-share-inbox-design.md` (SH1–SH7, IN1–IN7) · ADR-0015.

- **Il foglio** (`MondropKit/ShareComposeView.swift`, lo stesso per iOS e Mac): in alto l'anteprima del link (sito + URL accorciato), poi **«Aggiungi a
  una playlist»** (solo link di musica/media), **«Condividi con»**, i tag, e in piccolo utente e dispositivo. **«Invia a SoundReel»** è un bottone grande,
  pieno, a tutta larghezza, fisso in fondo e sempre sopra la tastiera (spinner mentre invia; disabilitato solo se manca il link, e il motivo è scritto sopra);
  nella barra resta solo «Annulla» (dopo l'invio diventa «Chiudi»). **Dopo l'invio il foglio non si chiude di scatto**: una spunta grande e una riga dicono che cosa è successo
  («Brano aggiunto a Road trip», «Link in analisi, ti avviso», «Condiviso con archi e sara»), con feedback aptico, per ~1,2 s (3 s se c'è qualcosa da leggere:
  playlist non usata, destinatario rifiutato); un tocco chiude subito. **In caso di errore resta aperto** con il motivo e **«Riprova»** (rimanda la stessa cosa:
  il server è idempotente per link).
- **Playlist** (SH4): compare solo per `open.spotify.com` / `spotify.link` / `spotify:`, `music.apple.com`, `shazam.com`, `youtube.com` / `youtu.be` /
  `music.youtube.com`, `soundcloud.com`, `instagram.com`, `tiktok.com` (e i loro sottodomini; mai i look-alike come `youtube.com.evil.example`). **Default «Nessuna»**:
  senza scelta `playlistId` non è nel corpo. Si offrono solo le playlist con `canEdit == true` (statiche e proprie). L'elenco sta in `playlists-cache.json`
  nell'App Group: l'app lo riscrive a ogni apertura e a ogni sync (`GET /api/mondrop/playlists`), il foglio **non aspetta mai la rete**. Mai la cache di un altro
  utente (se la key passa a un altro utente il foglio non offre nulla finché l'app non la riscrive); con un backend vecchio, senza `canEdit`, non offre nessuna playlist.
- **Condividi con** (SH6): chip dei familiari — la famiglia **senza l'utente di questo telefono** (per mike: archi e sara), selezionabili, anche entrambi, default nessuno;
  vanno in `shareWith` solo se scelti. Impostazioni → «Condividi di default con…» li pre-seleziona, il foglio li lascia modificare. È una condivisione **sul server**:
  chi la riceve la vede nel proprio SoundReel e nella propria app (scheda Posta → «Ricevute»). L'esito del server (`playlist`, `sharedWith`, `rejected`) finisce nella riga di
  successo: un destinatario rifiutato («sei tu», «utente sconosciuto», «la tua chiave non è legata a un utente» se la key non ha un utente) o una playlist non valida (inesistente, dinamica, in sola lettura) compaiono come avvisi, il link è salvato comunque.
- **Posta** (scheda «Posta», quarta, con il numero da leggere come badge; sull'icona dell'app se iOS lo permette): due elenchi. **Notifiche**: gli esiti delle tue condivisioni e gli avvisi;
  le `info` scadono dopo 3 giorni (non si mostrano più quando `expiresAt` è passato, senza aspettare la pulizia del server), **gli errori no**: restano in rosso con **Riprova**, **Apri** ed **Elimina**.
  **Riprova** rimanda `data.sourceUrl` con la stessa chiamata di condivisione e **con le stesse opzioni** con cui era partito: quelle di questo telefono se le ha (playlist, destinatari, commento: ogni
  invio lascia una riga in `share-log.json`, 60 righe / 30 giorni, ritrovata anche se il server ha tolto `?si=` o `utm_*`), **altrimenti quelle che il server ha tenuto** (`data.options`: `playlistId`,
  `shareWith`, `comment`), così funziona anche per una condivisione partita da un altro dispositivo. Se il problema era la playlist (`playlist_not_found`, `playlist_dynamic`, `playlist_read_only`) il
  bottone dice **«Riprova senza playlist»** e rimanda il link **senza** `playlistId` (destinatari e commento restano). Se il server **riprova da solo** (`data.retrying`, per esempio Instagram che chiede una
  nuova autorizzazione) la riga mostra il testo del server e «Riprova comunque» passa in secondo piano, più discreto. Un «Riprova» riuscito lascia a sua volta una riga nel registro, con quello che è
  stato davvero mandato (senza la playlist, se è stata tolta). L'errore si chiude da solo quando il link poi riesce (lo fa il server). **Ricevute**: le voci che altri hanno condiviso con te, **non scadono**; un tocco apre la voce e la segna vista. Una notifica `info` si segna letta quando resta
  a schermo ~1,5 s (`POST …/read`) e un tocco apre la voce; scorrimento a sinistra = elimina, a destra = letta. Si legge all'apertura della scheda, quando l'app torna in primo piano, dopo un sync
  e col pull-to-refresh. **Letture leggere** (primo piano, dopo un sync) mandano `since` = l'ultimo `serverTime` e **fondono** (aggiungono/aggiornano) e **tolgono** gli id di `removedIds` (cancellate
  da un altro dispositivo, errori che il server ha chiuso perché lo stesso link è poi riuscito, notifiche scadute). Le **Ricevute** invece si **sostituiscono** a ogni lettura, anche leggera (il server manda sempre l'elenco intero, con `seen`): una condivisione ritirata sparisce subito. La scheda aperta, il pull-to-refresh e l'avvio rileggono **tutto**, e così fa una
  lettura leggera dopo 10 minuti dall'ultima completa: è la rete di sicurezza per un server che non manda `removedIds`.
- **Un solo numero** (badge della scheda e dell'icona): una condivisione ricevuta conta **una volta**. La sua notifica («<Nome> ha condiviso con te») e la voce in «Ricevute» sono la stessa cosa,
  legate da `entryId`: **vista = letta**. Segnare letta la notifica segna vista la voce, aprire la voce segna letta la notifica, eliminare la notifica segna vista la voce, «Segna tutto come letto» le
  segna tutte. Il numero che arriva dal server (`unread`) è sempre quello giusto; tra una lettura e l'altra l'app lo corregge con la **differenza** calcolata con la stessa regola (mai sotto zero, e
  un annullamento restituisce esattamente quello che aveva tolto), così non salta alla lettura successiva.
- **Notifiche**: Impostazioni → «Notifiche delle condivisioni» (acceso di default; il permesso a iOS si chiede la prima volta che serve — aprendo la Posta, accendendo l'interruttore, o tornando
  nell'app dopo aver condiviso — mai a freddo). Senza push l'app mostra **una notifica locale** quando legge notifiche non lette che non aveva ancora annunciato (dedupe per id, memoria di 300 id;
  si sta zitti se la Posta è a schermo, se l'interruttore è spento, se iOS non lo permette, o se la notizia ha più di 24 h — un primo avvio non annuncia un arretrato). Un tocco apre la Posta.
- **Push (client costruito, dormiente)**: dopo il permesso l'app chiama `registerForRemoteNotifications()` e manda l'hex del token a `POST /api/mondrop/push/devices` con `environment`
  `development` nelle build Debug (quelle di `install-iphone.sh`) e `production` nelle altre; con l'interruttore spento fa `DELETE` (se il server non risponde riprova al lancio dopo). Se iOS rifiuta
  (`didFailToRegisterForRemoteNotificationsWithError`: oggi manca l'entitlement) il push resta spento, Impostazioni lo dice in una riga e la Posta funziona uguale. Quando il token è registrato, l'app
  **non** annuncia in locale le stesse notifiche (le suona il server). **Per accenderlo — solo DOPO che il server ha la chiave APNs** (`~/.config/soundreel/apns/`, Key ID in configurazione):
  in `ios/project.yml`, nel target `Mondrop`, sotto `entitlements.properties` (accanto a `com.apple.security.application-groups`) aggiungere **una riga**: `aps-environment: development`
  (`production` per TestFlight / App Store); poi `xcodegen generate` e `ios/scripts/install-iphone.sh` (con `-allowProvisioningUpdates` Xcode aggiunge la capability Push Notifications al profilo
  dell'account a pagamento). Non è stata aggiunta ora perché cambierebbe la firma prima che la chiave esista.
- **Badge sull'icona**: serve il permesso `.badge`. La 1.5 chiedeva solo avviso e suono e iOS non cambia le opzioni di un permesso già dato: su un'installazione che aveva già risposto il badge dell'icona
  non compare finché non si reinstalla l'app (o si attiva «Badge» in Impostazioni iOS → Notifiche → Mondrop, se la voce c'è). Il numero sulla scheda funziona sempre.
- **Non fatto**: l'aggiornamento in background (`BGAppRefreshTask`) — iOS decide se e quando eseguirlo, richiede modifiche a Info.plist e non è verificabile senza un dispositivo; il risveglio per i download
  in background legge comunque la Posta dopo un sync. «Aggiungi a playlist» da una condivisione ricevuta — non esiste una rotta Mondrop per aggiungere una voce già nota a una playlist (dalla 2.13.0 c'è `POST /api/mondrop/playlists/:id/songs` per i singoli brani: la usa Cerca).
- **Schede** (1.6.0; dalla 1.7.0 «Libreria» è diventata «Cerca»): sono 6 (Player, Libreria, Playlist, **Posta**, Share, Impostazioni); su iPhone la barra ne mostra 4 più «Altro», perciò la Posta è la quarta (il suo badge resta visibile) e Share e Impostazioni stanno in «Altro».
- **Compatibilità**: ogni campo nuovo è opzionale (un backend senza Posta risponde 404 alla lettura: la scheda lo dice quietamente); la risposta di `POST /api/share` si legge anche nella forma vecchia.
- **Test** nuovi: corpo della richiesta (`playlistId` / `shareWith` solo se scelti), risposte vecchie e nuove, classificazione dei link, cache delle playlist, testi di successo e di errore, decodifica della Posta,
  conteggio dei non letti (una condivisione ricevuta una volta sola), errori visibili a prescindere dalla scadenza, letto / elimina / visto (con annullamento, anche della voce collegata, se il server non conferma),
  `removedIds`, `data.options` / `retrying` / `reason`, «Riprova» con lo stesso corpo (dal registro del telefono o da quello che ha tenuto il server, senza playlist se era lei il problema), impostazioni di default,
  dedupe delle notifiche locali, registrazione del push (successo, rifiuto di iOS, server giù, interruttore spento).

---

## Cosa viene inviato con il link

| Campo | Esempio | Dove finisce |
|--------|---------|----------------|
| `url` | `https://instagram.com/reel/…` | entry |
| `user` | `mike` | `inputUser` + action log |
| `sharedAt` | `2026-11-07T14:02:11+01:00` | action log `url_received` |
| `channel` | `ios` / `macos` | action log `shareChannel` |
| `device` | nome, modello, OS, timezone | action log |
| `comment` / tag | `#tesla vacanze` | `results.tags` |

---

## Login OIDC Authelia (a regime)

Ogni utente genera da solo la sessione sul device: **Accedi con Authelia** → token → share con `Authorization: Bearer`. Niente key di famiglia mintate da Michele.

Stato: IdP OIDC **non ancora attivo** su `auth.casamon.dev` (404). Abilitazione = responsabilità **Geeko** (inbox hub); quando comunica «fatto», si collegano Mondrop + `/api/share` Bearer.

Dettaglio: `docs/mondrop-auth.md`.

---

## Icone

- **App**: `Mondrop/Assets.xcassets/AppIcon.appiconset` — una goccia nera con le onde (un equalizzatore) su fondo giallo. Dalla 1.7.0 è **disegnata a vettore**
  (spec `docs/superpowers/specs/2026-11-08-mondrop-app-icon-design.md`: Michele trovava il dipinto della «casa-lanterna» «troppo poco professionale»).
  iOS 1024 opaco (senza alpha, iOS applica la sua maschera) in **tre versioni** per iOS 18 (`AppIcon.png` normale, `AppIcon-Dark.png` goccia gialla su blu notte,
  `AppIcon-Tinted.png` grigia, la colora il sistema) e i dieci tagli macOS (tessera arrotondata con ombra).
- **Share** (foglio di condivisione): `MondropShare/Assets.xcassets/AppIcon.appiconset` — la stessa goccia con una freccia in giù al posto delle onde («lascia qui»).
- **Si rigenerano tutte** con `node ios/scripts/make_app_icon.mjs` (disegna gli SVG in `ios/icon/` e scrive i due cataloghi; usa `sharp` del backend:
  `cd backend && npm ci` una volta). Prove: `node --test ios/scripts/make_app_icon.test.mjs` (file opachi 1024, buchi puliti, sorgenti SVG non toccati a mano);
  sull'app `MondropTests/AppIconAssetsTests.swift` legge i PNG committati. **Mai** modificare un PNG a mano: si cambia lo script e si rigenera.
- **La gemella** (l'icona dell'app TV **Casamon**, «home-ass»): `node ios/scripts/make_app_icon.mjs --house <cartella>` scrive `house.svg` e `house-1024/130/80.png`
  (casa gialla con le onde su azzurro). Non fa parte dell'app: i file vanno nel repo `casamon-tv` (`apps/tv-webos/shell/icon.png` 80 px e `largeIcon.png` 130 px).
- XcodeGen: i cataloghi `Assets.xcassets` stanno nei `sources` dei target. La chiave `resources:` di un target **non esiste** e viene ignorata in silenzio
  (così l’icona non finiva nell’app: nel `.pbxproj` c’erano 0 riferimenti). Verifica dopo `xcodegen generate`: `grep -c Assets.xcassets Mondrop.xcodeproj/project.pbxproj` > 0.

---

## Bundle

| Target | Bundle ID |
|--------|-----------|
| iOS | `it.mikesoft.mondrop` |
| Share iOS | `it.mikesoft.mondrop.share` |
| Mac | `it.mikesoft.mondrop.mac` |
| App Group | `group.it.mikesoft.mondrop` |
