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

## Fatto (in attesa di deploy) — Mondrop Share, esito di ritorno, playlist, condividere con la famiglia, posta nell'app (richieste 2026-11-08)

**Fatto in SoundReel 2.10.0 + Mondrop 1.6.0, in attesa di deploy:** spec `docs/superpowers/specs/2026-11-08-mondrop-share-inbox-design.md`, ADR-0015 (**accettato**), contratto `docs/mondrop-inbox.md`. Resta da fare da parte di Michele: **la chiave APNs** (il push è costruito e spento fino ad allora; passi nella spec, §6) e dire se i default adottati per le domande 3–6 vanno bene (spec §7). Sotto, la richiesta com'era:
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

## Da costruire — Mondrop: cercare come su Spotify, senza playlist (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-search-spotify-style-design.md`, ADR-0018. Richiesta di Michele: «Perché non c'è modo di trovare le musiche di bassi maestro? Ci sono sul nas?» e «La ricerca la trovo molto confusa. Io posso cercare anche senza avere/fare playlist, alla spotify».
- **Misurato:** le musiche di Bassi Maestro ci sono (45 file sul NAS, 10 su geekom) ma nel diario sono 0, e la Libreria di Mondrop cerca **solo nel diario** (`/api/mondrop/library`); il servizio dei file parte dal diario (`findSong`), quindi un brano che esiste solo come file non si può nemmeno suonare. La schermata si apre sulle playlist e la ricerca filtra una «dimensione».
- **Proposto (2.13.0 + Mondrop 1.7.0):** `GET /api/mondrop/search` su diario + geekom + NAS (un risultato per canzone); i brani solo-file si suonano (senza voce nel diario, mai un download da YouTube); scheda **Cerca** come Spotify (Brani / Artisti / Album, un tocco suona, pagine autore e album), la Libreria si assorbe.
- **Regola P (Michele, stesso giorno):** «la logica di avere 3 liste o store [sia] server in sounreel e non in mondrop. Quello deve andare sempre e solo su soundreel» e «Idem il player web (locale o in internet)»: i client parlano **sempre e solo con SoundReel**. Oggi non è vero: Mondrop a casa scarica direttamente dal Fritz (`mediaUrl`, `/net`) e il player web sceglie la sorgente nel browser (interruttore «Sorgente») e da internet suona da YouTube. Da togliere (S10, S11).
- **Risposte di Michele (8 novembre):** Cerca sostituisce la Libreria; il tocco suona e accoda i seguenti; per il player web «se siamo su internet parte da youtube, sempre. se siamo in casa parte da youtube nel frattempo» (decide il server con un piano di riproduzione).
- **In produzione dall'8 novembre:** SoundReel 2.13.0 (`GET /api/mondrop/search`, brani solo-file serviti dal file esatto, `POST /api/mondrop/playlists/:id/songs`, niente `mediaUrl`, guardia del ritiro delle copie). **Prova reale:** la ricerca funzionava ma dava 21 righe per ~11 canzoni (la stessa registrazione con grafie diverse).
- **Costruita e provata, aspetta l'OK di deploy di Michele:** SoundReel **2.13.1** (una riga per canzone: raggruppamento per titolo e artista accreditato in comune, album dal tag, `&` non separa i nomi, niente più radici comuni nel testo cercato; sui dati veri 21 → 11 righe).
- **Mondrop 1.7.0 (build 8): costruita e provata** (scheda Cerca al posto della Libreria, tocco = questo e i seguenti, pressione prolungata, pagine artista e album, ricerche recenti, «Sfoglia»; l'app non ha più il percorso diretto al NAS né la scelta `home`, con `RulePTests`; 843 test, compila anche per macOS). **Aspetta l'OK di Michele per la build TestFlight.**
- **Il piano di riproduzione del player web** (S11): costruito, SoundReel **2.15.0**, in attesa dell'OK di deploy di Michele.

## Da costruire — la copertina nel player di Mondrop, cercata su Internet (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-player-cover-art-design.md`, ADR-0019. Richiesta di Michele: «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.»
- **Misurato:** un brano **solo-file** (NAS, geekom: quelli che «Cerca» fa suonare) non ha nessuna copertina vera; per gli altri l'app la scarica **direttamente dal sito del fornitore**, senza copia (offline sparisce) e senza passare da SoundReel.
- **Proposto (SoundReel 2.14.0 + Mondrop 1.7.0, build 8, la stessa di «Cerca»):** il **server** trova la copertina (quella già nota, poi quella **dentro il file** MP3, poi **Internet**: iTunes e Deezer con riscontro forte), la ridimensiona e la **tiene**; rotta `GET /api/mondrop/songs/:key/cover` e campo `coverPath` nelle tracce; l'app la chiede solo a SoundReel, la **tiene sul telefono** (offline) e la usa nel player e sulla schermata di blocco.
- **Risposte di Michele (8 novembre):** i **testi** («come le parole») **sì, cercali su Internet** quando mancano → release a parte (SoundReel 2.16.0, con la sua ADR); la copertina piccola nelle liste **no**, solo nel player.
- Il piano di riproduzione del player web (scelto da Michele come prossimo lavoro) è la **2.15.0** (costruito); i testi vengono dopo, nella 2.16.0.

## Fatto (in attesa di TestFlight) — l'icona di Mondrop rifatta a vettore, e la gemella dell'app TV (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-app-icon-design.md`. Richiesta di Michele: «volgio rifare l'icona di mondrop, mi sembra troppo poco professionale.» Risposta davanti alle prove: «la goccia con le onde ( sondo giallo e goccia nera ) per mondrop, mentre la casa gialla con le onde a sfondo azzurro per home-ass».
- **Fatto (Mondrop 1.7.0, build 8):** goccia nera con le onde su giallo (disegnata a vettore da `ios/scripts/make_app_icon.mjs`), in tre versioni per iOS 18 (normale, scura, tinta), l'icona del foglio di condivisione con la stessa goccia e una freccia, i dieci tagli macOS. Nove prove sul generatore e tre sull'app (nessun alpha, buchi puliti, sorgenti non toccate a mano).
- **Regola di Michele sulla TV:** «Non voglio due app diverse sulla tv - l'app è quella di prima e deve avere icona diversa e basta.» Una sola app (`dev.casamon.tv`), cambia solo l'icona: nient'altro.
- **Fatto, con il sì di Michele:** la gemella (casa gialla con le onde su azzurro) installata nell'app TV **Casamon** (`casamon-tv/apps/tv-webos/shell/icon.png` 80 px e `largeIcon.png` 130 px, più il sorgente in `docs/art/icon/`), **senza commit** in quel repo. Non toccati (regola sopra): `appinfo.json`, `splash.png` col dipinto e i documenti di quel repo.
- Domande aperte: le versioni scura e tinta e la freccia del foglio di condivisione vanno bene? (mie scelte di default, spec D3 e D4)

## In corso — Mondrop su TestFlight, il gruppo «Family» come tester (richiesta 2026-11-08)

Spec `docs/superpowers/specs/2026-11-08-mondrop-testflight-design.md`, ADR-0016. Richiesta di Michele: «Pubblica mondrop su testflight e metti il gruppo family come tester».
- **Pronto nel repository:** privacy manifest (app ed estensione), conformità export, orientamenti iPad, entitlements push solo per la Release, `ios/scripts/testflight.sh` (archivio Release + upload, firma gestita dal cloud con la chiave API).
- **Fatto da Michele (8 novembre):** la **chiave API** di App Store Connect (Key ID `7A4NS73W6Y`, `.p8` in `~/.config/soundreel/appstoreconnect/`) e il **record app** «Mondrop». Issuer ID dato e record verificato via API (bundle `it.mikesoft.mondrop`). **La chiave ha un ruolo troppo basso per scrivere** (firma cloud: «Cloud signing permission error»; gruppo: 403), quindi la build parte dall'**Apple ID di Xcode** (`testflight.sh` senza variabili `ASC_*`). Poi: gruppo esterno con i tester (le email dei familiari le ha date Michele), informazioni di test (serve il contatto per la revisione: nome, telefono, email), revisione beta di Apple (prima build di una versione per tester esterni) — via API con una chiave **Admin**, o nell'interfaccia web.
- Domande aperte: il nome «Mondrop» è libero? l'informativa privacy (URL) che Apple può chiedere; test interni al posto degli esterni?

## Da misurare — FTPS al posto di SMB per la replica sul Fritz e per l'import dal Mac (idea di Michele, 2026-11-08)

Spec `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` (sezione in fondo). Il Fritz ha già l'FTP acceso (porta 21) con **FTPS esplicito**, `MDTM` e `SIZE`, senza `MLSD` né `REST`. Quando la chiavetta è tornata e pulita: banco di prova su `Music/SoundReel/_bench/` (elenco dell'albero, invio di ~200 MB, passata senza cambiamenti) di `lftp` in FTPS contro `rsync` su SMB; se vince in modo netto, addendum ad ADR-0006 e `fritz-sync.sh` + prompt del Mac adattati. Mai FTP in chiaro.
