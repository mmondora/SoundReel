# SoundReel — Roadmap Ideas

Idee future non ancora in sviluppo. Non ordinate per priorità.

---

## Instagram Saves → Contenuti Tematici (+ Mneme)

**Cosa**: importare i salvataggi Instagram dell'utente, raggrupparli per tema, e archiviarli come **contenuto semantico** — non come video/post raw.

**Esempi**:
- "tavolo moderno per esterni" → tema: casa / stile francese
- "risotto" → tema: ristorante (Milano?)

**Concetto chiave**: non archiviare il media, ma il *significato* del salvataggio — cosa si vuole ricordare, non cosa è stato salvato.

**Pipeline immaginata**:
1. Fetch dei saved posts Instagram (API o scraping via instaloader)
2. AI (Ollama) estrae il "contenuto": oggetto, luogo, stile, intenzione
3. Clustering automatico per tema
4. Entry nel journal Soundreel con tag semantici
5. Sync verso Mneme come knowledge nodes

**Output**: non un post, ma una scheda tipo "Ristorante consigliato: X (Milano) — risotto" o "Arredo: tavolo ferro battuto esterno — stile provenzale".

---

## Link musicali → estrazione Spotify URL → download Spooty

**Cosa**: quando un link salvato fa riferimento a musica in forma editoriale (es. "I migliori dischi del 2026", "Top 10 album da ascoltare", "Le canzoni dell'estate"), estrarre i link Spotify citati nel contenuto e metterli automaticamente in coda download su Spooty.

**Trigger**: entry con tag musicale o summary che contiene riferimenti a classifiche/liste di album/canzoni.

**Pipeline immaginata**:
1. AI (Ollama) analizza il contenuto dell'entry e identifica se è una lista/classifica musicale
2. Se sì, scraping della pagina sorgente per estrarre link Spotify (`open.spotify.com/album/*`, `open.spotify.com/track/*`)
3. Ogni link trovato → POST a `http://spooty:3000/api/playlist`
4. Logga nel journal "X link Spotify trovati e inviati a Spooty"

**Note**:
- Spooty già integrato nel webhook Telegram — riutilizzare logica esistente e `SPOOTY_URL`
- Playwright (già presente per JS rendering) utile per pagine che caricano i link via JS
- Evitare duplicati: verificare se link Spotify già inviato prima di ri-accodare

---

## X (Twitter) — analizzare link post come IG / TikTok

**Cosa**: aprire e analizzare URL `x.com/…` / `twitter.com/…` (status, video, immagini) con la stessa qualità di Instagram/TikTok — caption, media, canzoni/film/note nel journal — da web, Telegram e Share Extension.

**Oggi**: la piattaforma è già riconosciuta (`twitter` / badge «X»); l’ingest passa soprattutto da page/OG meta. Manca un percorso media robusto (video/audio per Shazam/Whisper/vision) paragonabile a cobalt/instaloader/yt-dlp sugli altri social.

**Esito desiderato**: share di un post X → stub+coda → testo + media utili all’analisi AI/musica, senza passaggi manuali extra.

---

## Client iOS / Mondrop — sync playlist locale + play offline

**Cosa**: sull’app client (iOS / Mondrop, e in prospettiva macOS) scaricare o sincronizzare una playlist SoundReel sul device e riprodurla **in locale** — play / skip / browse — **senza passare da Apple Music**.

**Bottone**: «Download» o «Sync locale della playlist» (per playlist scelta o attiva).

**File**: MP3 e/o MP4 già disponibili dalla pipeline SoundReel / Spooty / libreria, alla **massima qualità disponibile** sul server (niente transcodifica al ribasso lato client se il file è già hi‑fi).

**Esito desiderato**:
1. Utente apre una playlist in app → tap sync/download
2. I brani finiscono nello storage locale del device (cache/libreria offline)
3. Player locale: coda della playlist, play/pause, next/prev, browse tracce offline
4. Funziona offline / in auto senza stream YouTube né Apple Music obbligatorio

**Gap oggi**:
- Mondrop è Share Extension (+ eventuale shell); non c’è ancora player o sync file
- Web `/player` suona via YouTube IFrame; Spooty/MP3 locali e Fritz/Tesla USB sono fuori dal player web
- Playlist Postgres esistono (`/api/playlists`) ma non c’è endpoint «bundle offline» né client che scarica i file

**Decisioni (2026-11-07)**:
- Sync **playlist** → MP3 offline + play in Mondrop
- Fonte: libreria SoundReel **prima**; se manca → **accoda Spooty** e riprova
- Auth: **OIDC Authelia** (attesa Geeko) — niente sync file su cellulare con sola API key
- Spec: `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md`
- **Aggiornamento 2026-11-07 (sera)** — archivio MP3 server-side: store sul **Fritz** (ripiego geekom), link Spotify da Mondrop = parità con Telegram (un solo punto d'ingresso), download solo per playlist/Sync, iOS in background solo Wi-Fi che salta i brani già presenti. Auth interim: key per dispositivo via `/mondrop/connect` (OIDC resta l'upgrade). Spec e fasi 0–3: `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md`

**Dipendenze**:
- OIDC IdP + client `mondrop` (Geeko)
- API: `GET /api/playlists/:id/offline`, `POST /api/songs/:songKey/spooty`, stream `GET /api/songs/:songKey/file` con Bearer
- Qualità: master già su disco, no transcodifica al ribasso

**Fuori scope (v1)**: Apple Music SDK; iCloud Music; film/MP4; background download raffinato.

---

## Link Shazam e Apple Music come riferimenti a canzoni

**Cosa**: un link Shazam (`shazam.com/track/<chiave>`, `/song/<id>/<slug>`) condiviso da Telegram, Mondrop o web diventa una canzone in libreria (artista, titolo, album, copertina) e, entrando in una playlist, si scarica in MP3 al Sync.

**Fatto** (v2.6.22, in attesa di deploy): ingest unico via `linkIngest` → `shazamLink.ts` (entry `shazam`, canzone `shazam_link`, test di parità Telegram = share = web, identità della pagina verificata). `shz.am` non esiste (DNS) e `/song/<id>` senza slug dà 204: non supportati.

**Da fare**: il download MP3 (downloader yt-dlp «artista + titolo», Fase 1 della spec) e lo stesso percorso per Apple Music (`music.apple.com/…?i=<id>`, lookup iTunes). Dettagli: spec `2026-11-07-mp3-store-media-server-design.md` § 2.8.

---

## Archivio MP3 server-side e sync Mondrop (v2.7.0, 2026-11-07)

**Fatto** (Fasi 1–2 della spec `2026-11-07-mp3-store-media-server-design.md`, ADR-0006): `song_files` + worker di download con riuso prima di YouTube, `/yt/audio` nell'instaloader, catalogo e URL diretti del Fritz (`mediaUrl`), API di sync (`docs/mondrop-sync.md`), primo play che scarica in parallelo, sync iOS in background (Wi-Fi, ripresa, salta i già presenti, `mediaUrl` in casa), sync notturno del Fritz riparato.

**Da fare / migliorie**
- Cadenza della replica sul Fritz: oggi notturna (una canzone nuova ha `mediaUrl` il giorno dopo; prima i client usano il proxy). Un timer utente ogni 10–15 min che lancia solo la parte musica è un cambio di configurazione, non di design.
- Durata attesa dal link Shazam (`PT3M50S` nel JSON-LD) → `expectedDurationS`, per scegliere la versione giusta del brano.
- Cookie YouTube opzionali (`YTDLP_COOKIES`) per i brani con restrizione d'età / «not a bot» (oggi `no_source` + link a mano).
- Telegram: avviso a fine download dei brani preparati dal sync.

---

## Media server e altri device (roadmap, 2026-11-07)

**Player su TV LG (webOS) in LAN** — tra i device dove Michele vuole l'app di play c'è la TV LG in rete.
- Opzioni da valutare: (a) la TV legge già via DLNA dal Fritz (nessuna app: da provare per primo); (b) web app del player nel browser webOS; (c) app webOS dedicata (HTML/JS, Enact/React) sulle stesse API Mondrop (`/api/mondrop`), con UX da telecomando (D-pad / Magic Remote).
- Dipendenze: split-horizon DNS già attivo (HTTPS valido in LAN), `mediaUrl` diretto del file sul media server, auth per dispositivo (key `/mondrop/connect` o OIDC), account/dev mode LG per installare l'app.

**Navidrome** su geekom (API Subsonic, solo musica) sulla cartella Musica — oltre al Fritz.

**Chiavetta del Fritz su geekom** come media server al posto del Fritz: l'origine è già locale (`~/Music/SoundReel`, ADR-0006), cambiano solo la radice della replica e `MEDIA_SERVER_*`; l'indice DLNA viene sostituito da filesystem + Navidrome.

**Altro**: Spooty che scrive direttamente nello store; pulizia dei file `._*` dalla chiavetta (sporcano l'indice DLNA del Fritz).

---

## Versione 2.8.0 — statistiche, dinamiche, media server senza copie, ricerca (2026-11-07/08)

Fatto (in attesa di deploy): vedi `CHANGELOG.md` 2.8.0 e ADR-0007…0012.

Da decidere / prossimi passi:
- **Importa nella libreria** dai risultati della ricerca (file locali / media server → canzoni normali con play, playlist, sync): oggi la ricerca dice solo *dove sono* (spec ricerca L6).
- Pulizia dei file ombra macOS `._*` sulla chiavetta (5 562 trovati, tutti da 4 096 byte): **autorizzata da Michele** («i file fantasma vanno cancellati, salvo servano al media server»); da rifare quando la chiavetta è di nuovo collegata (strumento: verifica della firma AppleDouble + rimozione per file).
- Import della musica del Mac: eseguirlo dal Mac con `docs/mac-music-import-prompt.md`; poi ricontrollare il catalogo (`media_index`) e la ricerca «Media server».
- Opzionali: durata Shazam → `expectedDurationS`, cookie YouTube per i brani con restrizione d'età, cadenza del mirror più corta, endpoint batch per aggiungere brani alle playlist.

## Versione 2.9.0 — scegliere cosa suonare, filtri, stati del download (richieste 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-player-selection-and-filters-design.md`, ADR-0013. Backend e web **deployati con l'OK di Michele (8 novembre)**; l'app Mondrop 1.5.0 la installa lui da vulcano con `install-iphone.sh`.
- iOS: scegliere playlist / album / brano (e artista, tipo, anni) invece della coda generica; spinner sul singolo brano in download, riga di stato, notifica locale a sync finito.
- Web: pannello «Scegli cosa suonare» con filtri per tipo, album, autore, anni (decenni), fonte, tag…; precarico della IFrame API e dell'id del brano successivo.
- Backend (fatto, provato su Postgres vero): `song_meta.release_year` **solo da iTunes** (le date degli album di Deezer sono quelle delle ristampe: decennio sbagliato per metà dei classici, ADR-0013 §5), riempimento una tantum che scrive **solo l'anno** (circa 50 minuti, si ferma da solo se iTunes non risponde), `GET /api/mondrop/library` con faccette, `album`/`genres`/`year` nei brani Mondrop.
- Da fare dopo (scoperto l'8 novembre): la ricerca Deezer con `artist:"…" track:"…"` non restituisce più nulla dal ~8 settembre, quindi ogni arricchimento è passato da iTunes in silenzio (copertine da 100 px invece di 250). Rimedio possibile: ricerca semplice `artista titolo` su Deezer (la verifica di artista e titolo c'è già), tenendo l'anno da iTunes. Non toccato nella 2.9.0.

## Da fare — sync delle foto di Mondrop, al posto di Flickr (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-photo-sync-design.md`, ADR-0014 (**proposto**, niente deciso). Richiesta di Michele: «un sync di Mondrop anche delle foto, come fa Flickr che devo dismettere il prossimo anno». **Scadenza di fatto: Flickr va spento nel 2027.** **Aggiornamento 8 novembre: «Flickr lo vedremo a Natale, ora resta»: rimandato a dicembre 2026, per ora non si fa nulla.**
- **Prima di tutto lo spazio:** geekom ha 199 GB liberi su 937; l'archivio Flickr indicizzato da MemoryLoom (83.895 foto, 1.065 album a settembre) ha gli originali **ancora su Flickr** e pesa verosimilmente centinaia di GB. Misurare e scegliere il disco (P1).
- **Poi mettere in salvo Flickr** (in MemoryLoom, non qui): scaricare gli originali e gli album con verifica dell'hash, senza cancellare nulla su Flickr. Ha i tempi lunghi e la scadenza, quindi parte per primo.
- **Poi il sync dal telefono:** upload a pezzi riprendibile e idempotente per SHA-256 (`POST /api/mondrop/photos/uploads`…), solo dal Wi-Fi di casa di default, destinazione = cartella che MemoryLoom legge come sorgente locale (il suo rilevamento dei duplicati toglie i doppioni con Flickr); Mondrop iOS legge il rullino, mostra lo stato per foto e libera spazio sul telefono solo dopo conferma e con doppia conferma. SoundReel **non** costruisce una galleria.
- Domande aperte per Michele: mese esatto di chiusura di Flickr, video sì/no, dove mettere lo spazio, chi altro in famiglia carica foto. Alternativa da rivalutare in F1: Immich.

## Da fare — il sito web usabile da telefono (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-web-mobile-ux-design.md` (solo interfaccia, nessun ADR). Richiesta di Michele: «la gui/ux del sito web. Su mobile e telefono è inusabile.»
- **Prima un audit sul telefono vero** (Safari su iPhone di Michele + 390×844 e 360×800 simulati): un difetto per riga, con la gravità, per ognuna delle 15 pagine.
- **Base misurata sul codice:** `manager.css` 999 righe con 1 solo `@media` (il Playlist manager è a due pannelli con F-tasti, pensato per il desktop); oltre 100 regole con testo tra 9,6 e 11,2 px; `min-width` di 300–520 px che a 390 px forzano lo scroll orizzontale (`stats.css`, `index.css`).
- **Poi, in ordine d'uso:** Player + «Scegli cosa suonare», Home, Canzoni e Playlist manager (un pannello alla volta, azioni in un foglio al posto dei F-tasti), Impostazioni, il resto; barra di navigazione in basso; bersagli ≥ 44 pt, campi a 16 px, mai scroll orizzontale, solo tema scuro. La tastiera completa resta su desktop.
- **Statistiche d'accesso raccolte l'8 novembre** (nella spec): dal sito si legge il journal ogni giorno (21 giorni su 30), si salva quasi solo da Telegram; playlist, ricerca e player hanno un giorno di storia. Il log di Traefik non ha lo user-agent: **contatori d'uso aggregati nel backend** (utente, tipo di dispositivo, rete, rotta) in 2.10.0 (**fatti**: `GET /api/admin/usage?days=14`), da rivedere dopo ~2 settimane dal deploy.
- Domande aperte per Michele: quali pagine possono restare «solo desktop», barra in basso o menu in alto; l'ordine d'uso proposto va bene?

## Da fare — Ripensare il look & feel del sito, con meno spazio vuoto ai lati (richiesta 2026-11-10; dopo le attività in corso)

Spec `docs/superpowers/specs/2026-11-10-web-look-and-feel-rethink-design.md` (solo interfaccia, nessun ADR). Richiesta di Michele: «non mi piace il l&f generico, con molto spazio libero ai fianchi della pagina principale. dovremmo ripensarlo. ma ora finisci le attività». Oggi il contenuto sta in una colonna di 800–900 px mentre la testata arriva a 1200 px: a 1280 px restano più di 250 px vuoti per lato. Si comincia con una sessione di brainstorming **con mockup da guardare** (non parole), che regga anche il telefono (spec `2026-11-08-web-mobile-ux-design.md`).

**Stato (10 novembre):** tre tornate di mockup (una tela privata) e le risposte di Michele («mi piace la A con le sezioni di C - possiamo metterle tute e tre configurabili», «Giallo e nero - Mondrop like ( e devon andare insieme gli stili )», «si, ma spostabile», «configurazione per utente - di default vista A»). Piano in quattro fasi (`docs/superpowers/plans/2026-11-10-web-look-and-feel.md`, ADR-0025 e ADR-0026): **P1 valori di stile uguali a quelli di Mondrop + telaio (barra, menu a sinistra, Player in basso) e P2 configurazione per utente sul server: in produzione dal 10 novembre alle 10:50 (2.21.0)**; **P3 le viste (Studio di partenza, Bacheca, Home a sezioni con `GET /api/home`) e l'interruttore: costruita, provata e in produzione dal 10 novembre alle 15:26 (2.22.0, spec §3.4); Link ha ora anch'essa elenco e dettaglio**; **P4 «Personalizza» e il Player spostabile (in basso, fluttuante e trascinabile, a destra con la coda, nascosto con una riga nel menu): costruita, provata e in produzione dal 10 novembre alle 15:55 (2.23.0, spec §3.5).** Con la stessa uscita il **controllo giornaliero delle playlist di genere** (ADR-0024 decisione 9): le quattro che mancavano (Latina, Techno, Blues, Metal) sono nate al primo giro. Le raccolte (ADR-0022) slittano dopo la P3: la loro parte di interfaccia dipende dal telaio.

## Fatto (2.20.2 in produzione dal 10 novembre; Mondrop build 12 su TestFlight) — Playlist automatiche dai post di musica, e l'elenco delle playlist che si cerca, si ordina e si sfoglia (richiesta 2026-11-10)

Spec `docs/superpowers/specs/2026-11-10-auto-playlists-and-playlist-list-design.md`, ADR-0023 (**accettato**, **in produzione**; **costruito e provato**, 36 rotture scoperte sul backend, prova su Postgres vero, anteprima su dati veri: 42 voci → 36 playlist nuove, 5 voci in un tema, 1 saltata, 211 brani). Richiesta di Michele: «voglio anche che se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato" e le 5 musiche dentro. se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve essere una sola. in tal caso le musiche sono ordinate per data di inserimento, le ultime per prime per facilitare gli ascolti. mondrop deve permettere di vedere queste play list. Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop.»
- **A, le playlist:** un post con almeno 2 brani **dal contenuto** (oggi 94 voci su 719: le altre hanno solo il sottofondo) diventa una playlist; titolo **preciso** = una per post, titolo **generico** = una sola per tema, con i brani nuovi **in cima**; sono playlist normali (Mondrop le vede già), una volta per voce, cancellate non si ricreano, avviso in Posta; le voci già presenti con uno script **in anteprima** e `--apply` solo con l'OK di Michele.
- **B, l'elenco:** cerca (nome), filtri (Tutte · Automatiche · Mie · Condivise · Dinamiche), **ordine per data di creazione** (le più nuove per prime), pagine da 30, **data accanto al nome**, tutto deciso dal server e compatibile con le app vecchie; sito e Mondrop.
- **2.20.1 (in produzione dal 10 novembre, 07:26; applicata alle 720 voci alle 07:43):** le playlist anche da **tutti i post con una canzone sola** (tema da un elenco chiuso di 36, solo se il post parla di musica), `AUTO_PLAYLIST_MODEL` (`qwen3.5:122b` per i titoli delle liste, ripiego sul default), `--undo-since`. Esito reale: **56 playlist nuove** (26 precise, 30 di tema), 147 voci in un tema, 517 saltate, 357 brani, un messaggio in Posta; per annullare `--undo-since 2026-11-10T06:27:41Z`.
- **2.20.2 (in produzione dal 10 novembre, 08:24; riparazione applicata alle 08:27):** le tre correzioni di Michele dopo l'applicazione (ADR-0024): **una playlist ha almeno due brani** (un tema con un brano aspetta), i **temi che nominano un genere sono playlist dinamiche** sul tag (ordine `newest`, tetto 200: «Soul da ascoltare» 2 → 39 brani, Pop 3 → 131), la **pagina Canzoni** si legge (elenco chiuso, scatola con scorrimento). Riparate le 56 già fatte: **15 dinamiche, 3 smontate, 38 restano**; ora 53 automatiche, nessuna con meno di due brani. Mondrop non è cambiato.
- **Fatto per primo** (SoundReel **2.20.0** in produzione il 10 novembre alle 01:06, 177 controlli su 177; Mondrop 1.7.0 **build 12** su TestFlight alle 01:08, con il suo OK per entrambi), poi le raccolte. Le playlist per le voci già presenti **sono state fatte il 10 novembre** (2.20.1, vedi sopra); per rifarle: `--undo-since`, poi di nuovo `--apply`, solo con l'OK.

## Da costruire — Raccolte: la libreria si ordina da sola per argomento, luogo e tipo (richiesta 2026-11-09; scelte approvate il 10 novembre)

Spec `docs/superpowers/specs/2026-11-09-library-collections-auto-topics-design.md`, ADR-0022 (**accettato**, niente costruito). Richiesta di Michele: «vorrei che crei una serie di aggregazioni, proponendo alcune di base, sulle viste che possono uscire dalle voci in libreria, ad esempio "ristoranti", "ristoranti a milano", "musica", "wallpaper", "casa", "montagna", "ricette" ecc. fammi delle proposte, sia di aggregazioni, che di ux di come si possno vedere/scegliere. Vorrei sia tutto automagico, ad esempio "vino" viene scoperto da solo e proposto.» **Risposte del 10 novembre:** «1 si, - 2 no, - 3 5 voci - 4 ok.» (A e B poi C; niente raccolte su Mondrop; nascita a 5 voci; l'elenco dei nomi di base va bene) e, in più: «Voglio anche che il luogo venga identificato dal testo ( es: voce che dice "ecco i ristoranti nuovi da provare su milano" e in tal caso voglio anche una sezione con i nomi dei ristoranti ) e abbia un link a googlemap (oppure apri in gmap ).»
- **Prova sui dati veri (9 novembre, sola lettura, locale):** 1643 voci → vettori con `nomic-embed-text` in 12 s; escono **da sole** Vino (15 voci), Ristoranti (7, 5 dicono Milano), Casa e design (10), Energia e domotica, Viaggi, Finanza, Auto, Anime… I nomi liberi del modello sono sporchi (`#`, refusi, JSON rotto): servono un elenco di ~30 nomi e una pulizia (spec §3).
- **Gli esempi di Michele oggi:** wallpaper 1 voce, ricette 2–3, montagna 4–6, casa 10: le prime tre **compaiono da sole a 5 voci**.
- **Disegno:** tre strati (tipi calcolati, temi scoperti in tabella, luoghi e combinazioni come «Ristoranti · Milano» calcolati), nascita a 5 voci, **mai una domanda** (nuova = segno per 7 giorni sul sito), correzioni che durano, tutto locale (mai Claude), regola P. **Luogo dal testo** (deve comparire nel testo della voce) e **sezione «Locali»** con i nomi citati e **«Apri in Maps»** (link costruito dal server). UX **solo sito**: **A** binario di chip su «Link», **B** pagina «Raccolte» con mosaici, poi **C** scaffali nella Home.
- **Fasi:** 0 calibrazione sui dati veri → 2.21.0 server + sito (binario, pagina, chip, locali) → scaffali, ricerca, esito «Salvato in…». Nessuna fase per Mondrop.

## Fatto (SoundReel 2.10.0 in produzione dall'8 novembre; Mondrop su TestFlight) — Mondrop Share, esito di ritorno, playlist, condividere con la famiglia, posta nell'app (richieste 2026-11-08)

**Fatto in SoundReel 2.10.0 (in produzione, 8 novembre 10:09) + Mondrop 1.6.0 (su TestFlight, poi la 1.7.0):** spec `docs/superpowers/specs/2026-11-08-mondrop-share-inbox-design.md`, ADR-0015 (**accettato**), contratto `docs/mondrop-inbox.md`. Resta da fare da parte di Michele: **la chiave APNs** (il push è costruito e spento fino ad allora; passi nella spec, §6) e dire se i default adottati per le domande 3–6 vanno bene (spec §7). Sotto, la richiesta com'era:
- **Foglio di condivisione:** oggi «Invia» è un bottone di solo testo in alto a destra e dopo l'invio non torna niente. Bottone grande e pieno in fondo al foglio, gerarchia più chiara, esito visibile con «Riprova» in caso di errore.
- **Esito di ritorno «come Telegram»:** riassunto, conteggi e link a fine analisi. La posta sta **sul server** (fonte di verità), l'app la legge quando si apre; il **push è solo il campanello** e richiede l'account sviluppatore Apple a pagamento: **confermato da Michele l'8 novembre**. Serve ancora che Michele crei la chiave APNs nel portale Apple (passi nella spec, §6) e mi dia il Key ID.
- **Playlist** (default nessuna) per i link di musica/media: `playlistId` in `POST /api/share`; i brani noti subito vanno dentro subito, gli altri a fine analisi.
- **Condividere con `archi` / `sara` / entrambi** dal foglio: `shareWith` in `POST /api/share`, sul server (`entry_shares`, già esistente).
- **Scheda «Posta»** in Mondrop: condivisioni ricevute (non scadono) e notifiche (**spariscono dopo 3 giorni, tranne gli errori**, che restano finché non li tolgo io o il link non riesce).
- Domande aperte per Michele: che altro del foglio non piace? Le notifiche a 3 giorni vanno bene? (L'account Apple è a pagamento: chiusa.) I default adottati sono nella spec, §7.

## Fatto e in corso — Niente duplicati, il link al post su ogni card, «Versione di» (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-no-duplicates-and-post-links-design.md`, ADR-0017. Richiesta di Michele: entry, canzoni, software, film «non devono essere duplicate (al massimo si mette un link all'originale)» e «nelle card dei media trovati, compreso il software, voglio anche il link al post. Es 5 canzoni sono state estratte dallo stesso link».
- **2.11.0, distribuita l'8 novembre:** un software = una card e un film = una card (alla lettura, senza migrazione); ogni menzione porta `sourceUrl` e le card di canzoni, film, software e note mostrano «Dal post»; creazione delle entry atomica (un blocco per utente e post); **fusione delle 9 entry doppie eseguita** (1700 → 1691, copia di sicurezza fuori dal container); il Dockerfile non rifà più chromium a ogni deploy.
- **2.12.0, distribuita l'8 novembre:** «Versione di «Titolo»» sulle card delle canzoni (risposta di Michele: «3 si ( Versione di )»; 95 canzoni su 796, 9 collegate a un originale), l'indirizzo di post con un carattere di troppo ora si apre (e la riga è stata corretta), `scripts/fixSongIdentity.ts` (applicato: 3 correzioni su 2 entry, chieste dall'agente Mac) e `scripts/retag_mp3.py` (applicato: tag ID3 dei 39 file «Edmea»).
- **Eseguito con l'OK di Michele:** il riempimento dei software citati (701 entry su 934, 1.370 voci).
- **Aspetta Michele:** la qualità del riempimento dei software (circa una voce su sei è rumore: tenerlo, restringere il filtro alla lettura o annullarlo, che è preciso perché ogni entry toccata è segnata); il gruppo esterno per Sara e Archi su TestFlight (serve una chiave API con ruolo Admin, oppure il sito).
- Poi: rivedere le 10 canzoni con un handle Instagram che sono in realtà album registrati come canzoni («Moon Safari», «Dummy», «Endtroducing»…); rivedere la pagina Software dopo il riempimento.

## Fatto (2.13.0 e 2.13.1 in produzione; Mondrop 1.7.0 su TestFlight) — Mondrop: cercare come su Spotify, senza playlist (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-search-spotify-style-design.md`, ADR-0018. Richiesta di Michele: «Perché non c'è modo di trovare le musiche di bassi maestro? Ci sono sul nas?» e «La ricerca la trovo molto confusa. Io posso cercare anche senza avere/fare playlist, alla spotify».
- **Misurato:** le musiche di Bassi Maestro ci sono (45 file sul NAS, 10 su geekom) ma nel diario sono 0, e la Libreria di Mondrop cerca **solo nel diario** (`/api/mondrop/library`); il servizio dei file parte dal diario (`findSong`), quindi un brano che esiste solo come file non si può nemmeno suonare. La schermata si apre sulle playlist e la ricerca filtra una «dimensione».
- **Proposto (2.13.0 + Mondrop 1.7.0):** `GET /api/mondrop/search` su diario + geekom + NAS (un risultato per canzone); i brani solo-file si suonano (senza voce nel diario, mai un download da YouTube); scheda **Cerca** come Spotify (Brani / Artisti / Album, un tocco suona, pagine autore e album), la Libreria si assorbe.
- **Regola P (Michele, stesso giorno):** «la logica di avere 3 liste o store [sia] server in sounreel e non in mondrop. Quello deve andare sempre e solo su soundreel» e «Idem il player web (locale o in internet)»: i client parlano **sempre e solo con SoundReel**. Oggi non è vero: Mondrop a casa scarica direttamente dal Fritz (`mediaUrl`, `/net`) e il player web sceglie la sorgente nel browser (interruttore «Sorgente») e da internet suona da YouTube. Da togliere (S10, S11).
- **Risposte di Michele (8 novembre):** Cerca sostituisce la Libreria; il tocco suona e accoda i seguenti; per il player web «se siamo su internet parte da youtube, sempre. se siamo in casa parte da youtube nel frattempo» (decide il server con un piano di riproduzione).
- **In produzione dall'8 novembre:** SoundReel 2.13.0 (`GET /api/mondrop/search`, brani solo-file serviti dal file esatto, `POST /api/mondrop/playlists/:id/songs`, niente `mediaUrl`, guardia del ritiro delle copie). **Prova reale:** la ricerca funzionava ma dava 21 righe per ~11 canzoni (la stessa registrazione con grafie diverse).
- **Costruita e provata, aspetta l'OK di deploy di Michele:** SoundReel **2.13.1** (una riga per canzone: raggruppamento per titolo e artista accreditato in comune, album dal tag, `&` non separa i nomi, niente più radici comuni nel testo cercato; sui dati veri 21 → 11 righe).
- **Mondrop 1.7.0 (build 8): costruita e provata** (scheda Cerca al posto della Libreria, tocco = questo e i seguenti, pressione prolungata, pagine artista e album, ricerche recenti, «Sfoglia»; l'app non ha più il percorso diretto al NAS né la scelta `home`, con `RulePTests`; 843 test, compila anche per macOS). **Aspetta l'OK di Michele per la build TestFlight.**
- **Il piano di riproduzione del player web** (S11): costruito, SoundReel **2.15.0**, in attesa dell'OK di deploy di Michele.

## Fatto (2.14.0 in produzione; Mondrop 1.7.0 su TestFlight) — la copertina nel player di Mondrop, cercata su Internet (richiesta 2026-11-08); i testi vengono dopo, nella sezione qui sotto

Spec `docs/superpowers/specs/2026-11-08-player-cover-art-design.md`, ADR-0019. Richiesta di Michele: «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.»
- **Misurato:** un brano **solo-file** (NAS, geekom: quelli che «Cerca» fa suonare) non ha nessuna copertina vera; per gli altri l'app la scarica **direttamente dal sito del fornitore**, senza copia (offline sparisce) e senza passare da SoundReel.
- **Proposto (SoundReel 2.14.0 + Mondrop 1.7.0, build 8, la stessa di «Cerca»):** il **server** trova la copertina (quella già nota, poi quella **dentro il file** MP3, poi **Internet**: iTunes e Deezer con riscontro forte), la ridimensiona e la **tiene**; rotta `GET /api/mondrop/songs/:key/cover` e campo `coverPath` nelle tracce; l'app la chiede solo a SoundReel, la **tiene sul telefono** (offline) e la usa nel player e sulla schermata di blocco.
- **Risposte di Michele (8 novembre):** i **testi** («come le parole») **sì, cercali su Internet** quando mancano → release a parte (SoundReel 2.19.0, con la sua ADR-0021); la copertina piccola nelle liste **no**, solo nel player.
- Il piano di riproduzione del player web (scelto da Michele come prossimo lavoro) è la **2.15.0** (costruito); i testi vengono dopo, nella 2.19.0 (la 2.18.0 è la Home).


## Fatto (2.19.1 in produzione; Mondrop build 11 su TestFlight) — i testi delle canzoni, cercati su Internet quando mancano (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-lyrics-from-the-internet-design.md`, ADR-0021. Richiesta di Michele (con la copertina): «…come le parole»; alla domanda se cercarli: **«Sì, cercale su Internet»**.
- **Server (2.19.0, in produzione dall'8 novembre, 20:13; 162 controlli post-deploy passati):** `GET /api/mondrop/songs/:key/lyrics` dà la trascrizione del post se c'è, altrimenti i testi trovati su **LRCLIB** (riscontro forte di titolo e autore, tenuti in `song_lyrics`, «non c'è» ricordato 7 giorni, un guasto no, un brano che è una versione ripiega sull'originale tranne Instrumental/Karaoke, strumentali dichiarati). Backend 2650 test; 22 rotture provate di proposito: 21 scoperte, la ventiduesima non cambiava il comportamento. Interruttore `LYRICS_ONLINE=0`.
- **App (Mondrop 1.7.0 build 10, su TestFlight dall'8 novembre, 20:17, con l'OK di Michele: «Sì, carica la build 10»):** il brano che parte senza testo lo chiede a SoundReel, lo tiene sul telefono (anche offline), il foglio «Parole» dice da dove viene («Testo trovato su Internet», «Trascrizione del post», «Scritto da te»), «Brano strumentale», «Cerco il testo…». Quello che scrive l'utente vince sempre. 997 test.
- **Default da correggere se non vanno:** i testi di Internet **non** sostituiscono le trascrizioni dei post; «non c'è» 7 giorni; il ripiego sull'originale per le versioni.
- **Risposta di Michele alla domanda del §6.3: «Proposta accettata»** → regola **L12** (SoundReel **2.19.1** in produzione dall'8 novembre, 20:56, con l'OK di Michele: «Sì, deploy ora»; Mondrop **build 11** su TestFlight dalle 20:57: «Sì, carica la build 11»; in produzione, su 6 brani con il solo frammento, 3 ora mostrano il testo di Internet): una trascrizione sotto i **100 caratteri** è un frammento (67 entry, «Clocks» 33) e conta come «testo che manca»: il server cerca su Internet e, se non trova niente, resta il frammento; le tracce portano solo trascrizioni vere; l'app chiede la rotta anche quando il sync le ha dato una trascrizione (la mostra intanto) e tiene solo i testi di Internet e gli strumentali. Backend 2668 test (14 rotture provate, tutte scoperte), iOS 1004 (11 rotture, 10 scoperte, una con una seconda difesa).
## Fatto (su TestFlight con le build 8 e 9) — l'icona di Mondrop rifatta a vettore, e la gemella dell'app TV (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-app-icon-design.md`. Richiesta di Michele: «volgio rifare l'icona di mondrop, mi sembra troppo poco professionale.» Risposta davanti alle prove: «la goccia con le onde ( sondo giallo e goccia nera ) per mondrop, mentre la casa gialla con le onde a sfondo azzurro per home-ass».
- **Fatto (Mondrop 1.7.0, build 8):** goccia nera con le onde su giallo (disegnata a vettore da `ios/scripts/make_app_icon.mjs`), in tre versioni per iOS 18 (normale, scura, tinta), l'icona del foglio di condivisione con la stessa goccia e una freccia, i dieci tagli macOS. Nove prove sul generatore e tre sull'app (nessun alpha, buchi puliti, sorgenti non toccate a mano).
- **Regola di Michele sulla TV:** «Non voglio due app diverse sulla tv - l'app è quella di prima e deve avere icona diversa e basta.» Una sola app (`dev.casamon.tv`), cambia solo l'icona: nient'altro.
- **Fatto, con il sì di Michele:** la gemella (casa gialla con le onde su azzurro) installata nell'app TV **Casamon** (`casamon-tv/apps/tv-webos/shell/icon.png` 80 px e `largeIcon.png` 130 px, più il sorgente in `docs/art/icon/`), **senza commit** in quel repo. Non toccati (regola sopra): `appinfo.json`, `splash.png` col dipinto e i documenti di quel repo.
- Domande aperte: le versioni scura e tinta e la freccia del foglio di condivisione vanno bene? (mie scelte di default, spec D3 e D4)

## Fatto — creare le playlist: la ricerca prende da tutto, non solo dalla libreria (richiesta 2026-11-08; 2.16.0, 2.16.1 e 2.17.0 in produzione)

Spec `docs/superpowers/specs/2026-11-08-playlist-search-everything-design.md` (ADR-0018, nota in coda). Richiesta di Michele: «anche la creazione delle playlist, la ricerca deve prendere da tutto e non solo dalla libreria».
- **Misurato:** il gestore delle playlist del sito (l'unico posto dove si creano e si riempiono; l'app non ha una schermata di creazione) caricava solo i **796 brani del diario**: «Bassi Maestro» dava 0 righe contro 11 di Cerca, e i brani solo-file messi in una playlist da Cerca comparivano come «non nel tuo journal» e la copia li saltava. La ricerca di Mondrop vede **4.439 brani** (796 del diario + 3.643 solo-file).
- **SoundReel 2.16.0 + 2.16.1:** (la 2.16.1 corregge il piano di riproduzione per i brani solo-file, trovato dai controlli dopo il deploy) `GET /api/songs?scope=everything` (diario + solo-file, una riga per canzone come in Cerca); il pannello del gestore si chiama «Tutti i brani», badge «Solo file», prime 300 righe e «Mostra altri». Prove sui dati veri in sola lettura.
- **Risposte di Michele:** «Scegli cosa suonare» del player web vuole tutto anche lui: **«Sì, anche il player»** → SoundReel **2.17.0** (pannello e playlist su tutto, 300 righe, la coda salvata ritrova i solo-file; costruita, in attesa del suo OK di deploy). Il nome «Tutti i brani» va bene.

## Fatto (build 9, su TestFlight) — il Player su iPad, «Scarica tutti», il play che non parte da solo (richieste 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-ipad-player-design.md` e `2026-11-08-mondrop-bulk-download-design.md`. Richieste di Michele: «Questa la home su ipad - colori sbagliati e spazi da rivedere»; «In mondrop voglio anche poter scaricare tutto dopo una ricerca. E il play non deve essere automatico».
- **Player:** una tavolozza sola, scura come l'icona, accento **giallo**; cover quadrata, colonna centrata, pulsanti affiancati; contrasti e geometria provati. **Scarica tutti:** nei risultati, negli artisti, negli album (fino a 200, con la domanda prima). **Play:** «Aggiungi in coda» non suona più da solo.
- Risposte di Michele: l'accento giallo anche nel resto dell'app? **sì** («A, si giallo», vedi la Home qui sotto); «il play non deve essere automatico» era proprio l'aggiunta in coda? **«Sì, è questo»**. Ancora aperta: «Scarica tutti» anche in «Sfoglia»?
- **La build 9 è su TestFlight dall'8 novembre, 18:49** (dopo «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify» porta anche la **Home**, sezione sotto). Confermato da Michele: «il play non deve essere automatico» = aggiungere in coda non suona («Sì, è questo»).

## Fatto (2.18.0 in produzione; build 9 su TestFlight) — la Home di Mondrop e il mini player (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-home-spotify-design.md`, ADR-0020 (**accettato**). Richiesta di Michele: «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify»; davanti al disegno: **«A, si giallo»**.
- **SoundReel 2.18.0 (in produzione dall'8 novembre, 18:34, con l'OK di Michele):** `GET /api/mondrop/home`, le sezioni già pronte decise dal server (playlist con mosaico, ascoltati di recente, nuovi dai reel). Backend 2595 test, rotture provate, 154 controlli post-deploy passati.
- **Mondrop 1.7.0 build 9 (su TestFlight dall'8 novembre, 18:49, con l'OK di Michele: «Sì, carica la build 9»; la sezione TestFlight qui sotto dice come):** la Home come prima scheda, il mini player su tutte le schede e pagine (il Player a schermo intero), «Riprendi» con la coda salvata sul telefono, il giallo come accento di tutta l'app e l'app scura. 966 test; verificata a occhio sul simulatore, anche con il telefono in modo chiaro.
- **Risposta di Michele:** l'app tutta scura va bene («Sì, tutta scura»). Se un giorno non va, si torna indietro con una riga (`UIUserInterfaceStyle`) e un accento più scuro per il chiaro. La sidebar di iPadOS 26 e «Mostra tutti» per le due file di brani non sono costruiti (spec §6).

## In corso — Mondrop su TestFlight, il gruppo «Family» come tester (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-testflight-design.md`, ADR-0016. Richiesta di Michele: «Pubblica mondrop su testflight e metti il gruppo family come tester».
- **Pronto nel repository:** privacy manifest (app ed estensione), conformità export, orientamenti iPad, entitlements push solo per la Release, `ios/scripts/testflight.sh` (archivio Release + upload, firma gestita dal cloud con la chiave API).
- **Fatto da Michele (8 novembre):** la **chiave API** di App Store Connect (Key ID `7A4NS73W6Y`, `.p8` in `~/.config/soundreel/appstoreconnect/`) e il **record app** «Mondrop». Issuer ID dato e record verificato via API (bundle `it.mikesoft.mondrop`). **La chiave ha un ruolo troppo basso per scrivere** (firma cloud: «Cloud signing permission error»; gruppo: 403), quindi la build parte dall'**Apple ID di Xcode** (`testflight.sh` senza variabili `ASC_*`). Poi: gruppo esterno con i tester (le email dei familiari le ha date Michele), informazioni di test (serve il contatto per la revisione: nome, telefono, email), revisione beta di Apple (prima build di una versione per tester esterni) — via API con una chiave **Admin**, o nell'interfaccia web.
- **Mondrop 1.7.0 (build 8) è su TestFlight** (8 novembre, 16:34): Michele ha rifatto il login in Xcode su vulcano e il caricamento è andato; Apple l'ha elaborata (VALID) e il gruppo interno «Family» (distribuzione automatica) la riceve. Dentro: Cerca, la regola P, le copertine, la cancellazione solo nelle Impostazioni e la nuova icona. **Distribuzione a Sara e Archimede (8 novembre, richiesta di Michele: «Fai la distribuzione di mondrop»): ferma su un passo di Michele.** Il gruppo «Family» di Mondrop è **interno** e ha accesso a tutte le build (Michele le riceve da solo). Per Sara e Archimede la chiave attuale dà **HTTP 403** sulla creazione di gruppi (riprovato: nessuna modifica fatta). Tre vie: **(C, consigliata)** tester **interni**: Michele li invita come utenti in App Store Connect (Utenti e accessi → «+», ruolo **Marketing**, il più basso che Apple accetta per i tester interni insieme a Developer, App Manager, Admin) e poi li aggiunge al gruppo Family (TestFlight → Test interni → Family → «+»): nessuna revisione Apple, la build 8 arriva subito; **(B)** gruppo **esterno** dalla pagina web (nome diverso da «Family»: è preso; servono contatto per la revisione, email di feedback, «cosa provare»; la **revisione beta** di Apple vorrà un account demo e il server è privato: rischio di rifiuto); **(A)** una **nuova chiave API con ruolo Admin** (solo Key ID a me, il `.p8` in `~/.config/soundreel/appstoreconnect/` 0600): allora creo io gruppo, tester e invii via `asc.mjs`. Fonte dei ruoli: https://developer.apple.com/help/app-store-connect/test-a-beta-version/add-internal-testers/
- **Mondrop 1.7.0 (build 9) è su TestFlight** (8 novembre, 18:49), caricata con la **chiave API Admin `KXRWH399D2`** (nuova, di Michele): il login Apple ID di Xcode su vulcano era scaduto di nuovo («Failed to Use Accounts») e la chiave «Sviluppatore» `7A4NS73W6Y` non poteva firmare in cloud. Elaborata (VALID); il gruppo interno «Family» (Michele) la ha. **Sara e Archimede:** nel gruppo esterno «FamilyPlus» con la build 9 dentro; aspettano la **revisione beta di Apple** della 1.7.0 (la build 8, mandata da Michele alle 17:21, è in coda: ne va una alla volta, la 9 si manda dopo). Appena approvata, gli inviti partono; se Apple rifiuta (l'app senza il server non fa niente) la strada senza revisione è invitarli come utenti di App Store Connect (ruolo Marketing). La chiave vecchia si può revocare. Spec `2026-11-08-mondrop-testflight-design.md` §7.
- **Mondrop 1.7.0 (build 10) è su TestFlight** (8 novembre, 20:17; Michele: «Sì, carica la build 10»): i testi nel Player. Elaborata in due minuti; «Family» (Michele) la ha, assegnata anche a «FamilyPlus»; la revisione beta resta quella della build 8 (ancora in attesa: ne va una alla volta, la 9 e la 10 si mandano dopo).
- **Mondrop 1.7.0 (build 11) è su TestFlight** (8 novembre, 20:57; Michele: «Sì, carica la build 11»): il server ha l'ultima parola sui testi (regola L12). Elaborata in due minuti; «Family» (Michele) la ha, assegnata anche a «FamilyPlus»; la revisione beta resta quella della build 8 (ancora in attesa: ne va una alla volta, la 10 e la 11 si mandano dopo).
- **Mondrop 1.7.0 (build 12) è su TestFlight** (10 novembre, 01:08; Michele: «Sì, carica la build 12»): l'elenco delle playlist con ricerca, ordine per data, data accanto al nome, etichetta AUTOMATICA e «Carica altre» (ADR-0023). Elaborata in due minuti (VALID alle 01:09); «Family» (Michele) la ha, assegnata anche a «FamilyPlus». **La revisione beta della build 8 è ora in corso (IN_REVIEW, 10 novembre ~01:10)**: appena è decisa si manda la 12 (la 10 e la 11 non servono più).
- **La revisione beta della build 8 è stata RIFIUTATA** (`REJECTED`, 10 novembre); Michele riporta cosa chiede Apple: «il motivo lo devi aggiungere tu, mettendo l'elenco delle macro funzionalità, i due o tre macro punti da attenzionare». **Fatto il 10 novembre (con il suo «vai»):** testi nuovi in `ios/testflight/` (cosa provare, descrizione beta, note per chi rivede), comando `asc.mjs set-test-info`, **build 12 sottomessa** (`WAITING_FOR_REVIEW`). Se Apple la rifiuta ancora o chiede una chiave per vedere l'app: chiave temporanea da «Ottieni chiave», oppure i tester interni. Spec `2026-11-08-mondrop-testflight-design.md` §8.
- Domande aperte: l'informativa privacy (URL) che Apple può chiedere; se la revisione beta rifiuta, passare ai test interni.

## Da misurare — FTPS al posto di SMB per la replica sul Fritz e per l'import dal Mac (idea di Michele, 2026-11-08)

Spec `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` (sezione in fondo). Il Fritz ha già l'FTP acceso (porta 21) con **FTPS esplicito**, `MDTM` e `SIZE`, senza `MLSD` né `REST`. Quando la chiavetta è tornata e pulita: banco di prova su `Music/SoundReel/_bench/` (elenco dell'albero, invio di ~200 MB, passata senza cambiamenti) di `lftp` in FTPS contro `rsync` su SMB; se vince in modo netto, addendum ad ADR-0006 e `fritz-sync.sh` + prompt del Mac adattati. Mai FTP in chiaro.
