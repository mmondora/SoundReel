# CLAUDE.md — SoundReel Project

## Cos'è questo progetto

SoundReel è una web app personale (single user) che analizza contenuti social (Instagram Reels, TikTok, post) per estrarre canzoni e film menzionati. Le canzoni vengono aggiunte automaticamente a una playlist Spotify. Tutto viene loggato in un journal cronologico.

## Stack tecnologico

- **Frontend**: React + Vite + TypeScript, SPA statica servita da Fastify
- **Backend**: Node.js 20 + Fastify + TypeScript, in `backend/`
- **Database**: PostgreSQL 17 (container Docker `soundreel-db`)
- **AI**: Ollama self-hosted — `glm-4.7-flash:q4_K_M` (testo/analisi, via vulcano), `moondream:latest` (vision/frame video) via `ollamaClient.ts`
- **Music Recognition**: AudD API + Shazam (`shazamClient.ts` → instaloader) + Whisper (trascrizione)
- **Film DB**: TMDb API
- **Spotify**: Spotify Web API con OAuth 2.0 PKCE
- **Telegram**: Bot API con webhook su endpoint Fastify — link Spotify inviati a Spooty (`http://spooty:3000/api/playlist`)
- **Spooty**: servizio Docker (`raiper34/spooty`) per download MP3 da Spotify via yt-dlp, su rete `web`
- **Video extraction**: cobalt.tools API + Instaloader (container dedicato) con fallback su OG meta scraping
- **OCR**: servizio OCR dedicato (container `soundreel-ocr`)
- **Deploy**: Docker Compose su GEEKOM A8 Max, `soundreel.casamon.dev`
- **Architettura di riferimento**: `adr/0005-reference-architecture.md` (stack, dati, identità, mobile + decisioni aperte D1–D3). Nuove spec/ADR partono da lì

## Struttura progetto

```
soundreel/
├── CLAUDE.md
├── README.md
├── Dockerfile               # multi-stage: frontend-build + backend-build + runtime
├── docker-compose.yml       # soundreel, soundreel-db, instaloader, whisper, ocr (ollama via gpu-router su rete web esterna)
├── .env                     # secrets (non committare)
├── scripts/
│   ├── build.sh             # docker compose build con GIT_REVISION e BUILD_DATE
│   ├── bump-version.sh      # incrementa patch version in package.json
│   └── telegram-set-webhook.sh
├── backend/
│   ├── package.json
│   ├── tsconfig.json
│   └── src/
│       ├── server.ts        # entry point Fastify
│       ├── db/
│       │   └── init.sql
│       ├── routes/
│       ├── services/
│       └── types/
├── frontend/
│   ├── package.json
│   ├── vite.config.js
│   ├── tsconfig.json
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── components/
│       ├── pages/
│       ├── services/
│       │   ├── api.ts
│       │   └── spotify.ts
│       ├── hooks/
│       ├── types/
│       └── styles/
├── instaloader/             # servizio Python per Instagram
│   └── Dockerfile
├── ocr/                     # servizio OCR
│   └── Dockerfile
└── ios/                     # App nativa **Mondrop** (Share → SoundReel journal)
    ├── project.yml          # XcodeGen — iOS + macOS + Share Extension
    ├── README.md
    ├── Mondrop/             # app contenitore (display name Mondrop)
    ├── MondropShare/        # share extension
    └── MondropKit/          # Settings + BackendClient + URLExtractor
```

## Convenzioni di sviluppo

### Linguaggio e stile
- TypeScript strict mode ovunque (frontend e backend)
- Nessun `any` — definire sempre i tipi in `types/index.ts`
- Preferire `async/await` su `.then()` chains
- Gestire SEMPRE gli errori: ogni step della pipeline è indipendente, se uno fallisce gli altri continuano
- Loggare ogni azione nell'`actionLog` dell'entry in Postgres

### Database (PostgreSQL)
- Schema definito in `backend/src/db/init.sql`
- MAI usare ORM — query SQL dirette con `pg`
- Secrets DB via env vars (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`)

### Backend (Fastify)
- Entry point: `backend/src/server.ts`
- Secrets letti da env vars, MAI hardcodati
- L'endpoint `analyzeUrl` è chiamato sia dal frontend che dal bot Telegram — unica implementazione
- **Punto d'ingresso unico per i link**: `services/linkIngest.ts` (`classifyLink` + `ingestLink`), usato da Telegram, `/api/share` e `/api/analyze` (solo per i link Spotify). Mai reimplementare stub/merge/enqueue negli adattatori; parità coperta da `routes/linkParity.test.ts`. I link Spotify → entry + Spooty, seguiti da `services/spootyWatcher.ts` (tabella `spooty_requests`). I link Shazam (`shazam.com/track|song`) → entry di libreria letta dalla pagina (`services/shazamLink.ts`, nessun job): attenzione, `/track/<chiave>` risponde col redirect giusto solo a uno User-Agent da bot — ai browser-like (e a `node`) dà HTTP 200 con una pagina generica di UN ALTRO brano; `/song/<id>` senza slug dà 204; `shz.am` non esiste (DNS). Per questo `fetchShazamTrack` verifica che la pagina sia quella dell'URL raggiunto e altrimenti salva l'entry in errore, mai un brano sbagliato
- **Archivio MP3** (ADR-0006, contratto client `docs/mondrop-sync.md`): una riga per canzone in `song_files` è insieme record del file e coda di download (`services/songFiles.ts`); il worker `songDownloader.ts` (2 in parallelo, priorità `play` prima di `sync`) per ogni job prima **riusa** (libreria `/music`; poi il catalogo del media server `media_index`: il brano **è** il file del Fritz, `source: mediaserver`, `rel_path` null, **mai copiato** su geekom — ADR-0010) e solo dopo scarica da YouTube con l'instaloader `POST /yt/audio` (MP3 192k taggato) in `/data/media/_staging`, poi `musicStore.placeIntoStore` sposta in `<libreria>/SoundReel/` (`.part` + rename, nomi exFAT-safe `Artista - Titolo.mp3`). Tutto sta sotto `MUSIC_LIBRARY_PATH`: scan libreria, player web e flag `downloaded` li vedono come i file di Spooty. Il Fritz è una **replica** scritta solo da `scripts/fritz-sync.sh` (rsync notturno, `*.part` e `._*` esclusi, `/_MacMusic/` protetta: la scrive il Mac, ADR-0012; dopo un download il backend tocca `SoundReel/.publish-request` e lo unit `fritz-sync-request.path` fa partire il sync subito, ADR-0010); il backend lo legge solo via HTTP (`mediaServer.ts`: DLNA Search → `media_index`, HEAD sull'URL diretto → `song_files.media_url`). **Mai** montare lo share SMB nel container (ADR-0006). Endpoint: `/api/mondrop/playlists/:id/{offline,prepare}`, `/api/mondrop/songs/:key{,/download,/source,/file}`, `/api/mondrop/net`; web `POST /api/songs/:key/download`, `GET /api/songs/:key/state` (con `location`), `GET /api/songs/:key/file` (media server **prima**, via proxy HTTPS con `Range`; poi il disco; `?from=media|fs`), `GET /api/net` (rete interna/esterna dagli header Cloudflare); admin `GET /api/admin/store`. Il file lo serve `services/songStream.ts` (`serveSong`/`openSongStream`: origini in ordine, la prima che risponde); `offlineManifest.resolveSongServing` sceglie l'ordine (web: media→disco, Mondrop: disco→media). Dove sta un brano: `services/songLocation.ts` (`fs`, `mediaServer`, `fsPath`, `mediaUrl`); il pallino verde `inLibrary` è **esattamente** `fs || mediaServer`. Le copie fatte dalla 2.7.0 le ritira `services/retireCopies.ts` (solo se l'originale risponde con gli stessi byte **e non è la replica sul Fritz della copia stessa**: `findBoxOriginal` esclude `Music/SoundReel/SoundReel/`, altrimenti un brano perderebbe il suo unico file) Un handler Fastify async che fa stream deve **restituire la reply** (`return reply.send(stream)`), altrimenti il corpo esce vuoto (bug che azzerava ogni download di Mondrop)
- **Ricerca nella libreria** (ADR-0011, spec `2026-11-07-library-search-music-folders-design.md`): `GET /api/library/search?q&scope=all|songs|media|local` cerca nel journal, nel catalogo del media server e nelle cartelle musica (Spooty `/music` + cartelle extra della configurazione web `GET/POST /api/config/music-folders`, solo admin, solo dentro `MUSIC_EXTRA_ROOTS`); ordine delle parole ininfluente, restituisce l'indice (dove sta il file), mai file. Indici in memoria (`musicSnapshot.ts`, `musicFolders.ts`)
- **Scegliere cosa suonare** (ADR-0013, spec `2026-11-08-player-selection-and-filters-design.md`, 2.9.0): `GET /api/mondrop/library?q&genre&album&artist&decade&limit&offset&facets` (filtri e faccette pure in `services/libraryFacets.ts`, ogni faccetta conta senza il proprio filtro; le tracce della pagina le costruisce `buildTracks` in `offlineManifest.ts`) e `album`/`genres`/`year` su ogni brano Mondrop. L'anno (`song_meta.release_year`) viene **solo da iTunes** con un match forte (artista e titolo coincidono): le date degli album di Deezer sono quelle delle ristampe e sbagliano il decennio (§5 dell'ADR). Il riempimento una tantum (`services/releaseYearBackfill.ts`, ~50 minuti, una volta) scrive **solo l'anno** dei brani già arricchiti: mai riscrivere cover e generi per aggiungerlo. Attenzione: la ricerca Deezer con `artist:"…" track:"…"` non risponde più dall'8 settembre 2026, ogni arricchimento passa da iTunes
- **Cerca e regola P** (ADR-0018, spec `2026-11-08-mondrop-search-spotify-style-design.md`, 2.13.0; richiesta di Michele dell'8 novembre: «posso cercare anche senza avere/fare playlist, alla Spotify» e «la logica di avere 3 liste o store [sia] server in SoundReel e non in Mondrop … sempre e solo su SoundReel», «Idem il player web (locale o in internet)»): **i client parlano sempre e solo con SoundReel**; quanti elenchi ci siano (diario, libreria di geekom, catalogo del NAS), dove stia un file e da dove si legga sono **logica del server**, e nessuna risposta ha un campo che nomini un negozio. `GET /api/mondrop/search?q&artist&album&limit&offset&sections` (`services/mondropSearch.ts`): **una canzone per riga, non un file** (dalla 2.13.1 le voci con lo stesso titolo — senza maiuscole, accenti, punteggiatura né «(feat. X)» — e un artista accreditato in comune si raggruppano; la voce mostrata è sempre la stessa: diario, poi file su geekom, poi la più completa; i nomi si separano su virgola/`feat.`/` x `, **non** su `&`), identità = `songKey` che non cambia (una versione è un brano a sé; **mai** `normalizeForMatch` come identità), sezioni brani/artisti/album che contano canzoni. I brani che esistono **solo come file** (`services/libraryOnlySongs.ts`, `AggregatedSong.libraryOnly`) si suonano, scaricano e mettono in playlist (`POST /api/mondrop/playlists/:id/songs`, solo statiche proprie) **dal file esatto che la loro chiave nomina** (`libraryFilesOf`), mai per somiglianza di nome, mai da YouTube, senza voce nel diario né riga in `song_files`. **`mediaUrl` è sempre `null`** dalla 2.13.0 (le app ≤1.6.0 ripiegano su `downloadPath`; `/api/mondrop/net` è solo informativo). **L'app (Mondrop 1.7.0, build 8)**: scheda **Cerca** al posto della Libreria (che si apre da «Sfoglia»), tocco = questo brano e i seguenti, pressione prolungata (in coda / a playlist / scarica); **nessun percorso diretto al Fritz e nessuna scelta `home`** (`NetStatus` è solo la riga «Rete» delle Impostazioni), con `MondropTests/RulePTests.swift` che fa fallire la build se tornano. **Player web (2.15.0)**: segue un *piano di riproduzione* deciso dal server, `GET /api/songs/:key/play?prefer=auto|internet|media` (`services/playPlan.ts`: da internet YouTube **sempre**, in casa il file se c'è e altrimenti YouTube nel frattempo con `download: true`; la rete è quella **della richiesta**, il guasto del localizzatore dà YouTube senza download); il browser manda solo la preferenza dell'interruttore «Sorgente» e segue la risposta, e `frontend/src/player/ruleP.test.ts` fa fallire la build se il player torna a testare la rete (`/api/net`), a nominare indirizzi di negozi o a scegliere la sorgente da solo. Mai reintrodurre in un client indirizzi di negozi (porte e indirizzi del Fritz, DLNA, `192.168.`), `mediaUrl` per suonare o scaricare, o una scelta della sorgente in base alla rete. **Creare le playlist cerca in tutto** (2.16.0, spec `2026-11-08-playlist-search-everything-design.md`; richiesta di Michele: «anche la creazione delle playlist, la ricerca deve prendere da tutto e non solo dalla libreria»): il gestore del sito (`PlaylistManagerPage`, l'unico posto dove si creano e si riempiono le playlist) chiede `GET /api/songs?scope=everything` = i brani del diario **più** i solo-file (`songsOnlyAsFiles`, stessa identità e stesso raggruppamento di Cerca, `libraryOnly: true`); il pannello è «Tutti i brani», disegna le prime 300 righe e «Mostra altri». Senza `scope` la lista è il solo diario (pagina Canzoni, scaffali del player). **Il player web** (2.17.0, «Sì, anche il player»): «Scegli cosa suonare» e le playlist prendono da tutto (l'elenco grande si chiede una volta e solo quando serve), gli altri scaffali restano del diario, la lista disegna 300 righe; `hydrateQueue(catalogo, caricaTutto)` ricostruisce da tutto una coda salvata che contiene un solo-file. **Un brano che non è nel diario si localizza dal file che la sua chiave nomina** (`libraryFilesOf`), mai per nome (piano `/play` e `/state`, 2.16.1)
- **Copertine** (ADR-0019, spec `2026-11-08-player-cover-art-design.md`; richiesta di Michele dell'8 novembre: «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole»; 2.14.0 + Mondrop 1.7.0): **le trova il server, l'app chiede solo a SoundReel** (regola P: mai iTunes o Deezer dall'app). `GET /api/mondrop/songs/:key/cover` (immagine o `404`) e `coverPath` su ogni traccia (`coverUrl` resta per le app già installate). Ordine: la copertina che il server già conosce (`song_meta`) → quella **dentro il file** MP3 (ID3 `APIC`, `services/id3Cover.ts`) se è quasi quadrata **e di almeno 300 px** (i file di Spooty hanno una foto dell'artista da 160 px, uguale in ogni brano) → **Internet** (iTunes poi Deezer, **solo con riscontro forte**: meglio nessuna copertina di una sbagliata) → quella del file comunque → l'app disegna la sua. Tenuta su disco (`MEDIA_ROOT/_covers/`, 800×800) e «non c'è» ricordato 3 giorni; l'app la tiene sul telefono (offline). I **testi** («come le parole»): li trova il server su Internet quando mancano, vedi il punto «I testi delle canzoni» qui sotto (2.19.0, ADR-0021)
- **I testi delle canzoni** (ADR-0021, spec `2026-11-08-lyrics-from-the-internet-design.md`, 2.19.0 + Mondrop 1.7.0 build 10, regola dei frammenti 2.19.1 + build 11; richiesta di Michele dell'8 novembre: «…come le parole», poi «Sì, cercale su Internet», poi «Proposta accettata» sui frammenti): `GET /api/mondrop/songs/:key/lyrics` (`services/songLyrics.ts`, `services/lyricsFinder.ts`) dà **la trascrizione del post se c'è, altrimenti i testi trovati su LRCLIB** e tenuti nella tabella `song_lyrics`; l'app chiede **solo** a SoundReel (regola P: un test vieta di nominare un archivio di testi nei sorgenti), tiene sul telefono (`LyricsLoader`, in Caches) **solo i testi trovati su Internet e gli strumentali** (la trascrizione del sync si mostra subito, ma la rotta si chiede lo stesso) e il foglio «Parole» dice da dove viene. **Regole da non rompere:** Internet **solo quando il testo manca** (mai al posto di una trascrizione **vera, almeno 100 caratteri**, né di ciò che l'utente ha scritto: quello vince sempre; sotto i 100 caratteri la trascrizione è un **frammento** e conta come «testo che manca»: si cerca su Internet e, se non si trova niente, **resta il frammento**; sync e `GET /api/mondrop/songs/:key` portano solo trascrizioni vere; **la soglia sta solo nel server**, `MIN_TRANSCRIPT_CHARS` in `songLyrics.ts`, l'app non conta caratteri); **solo con un riscontro forte** di titolo (senza segni tra parentesi o dopo un trattino) e autore, e **mai senza autore**: meglio nessun testo che le parole di un'altra canzone; il testo trovato resta, «non c'è» 7 giorni, un guasto dell'archivio **non** si ricorda; una versione senza testo suo ripiega sull'originale **tranne Instrumental e Karaoke**; richieste all'archivio distanziate di un secondo; esce solo autore e titolo; `LYRICS_ONLINE=0` spegne tutto. I testi sono protetti da diritto d'autore: uso privato della famiglia, mai pubblicati. Attenzione: l'archivio manda anche un campo `lyricsfile` col testo intero (e `syncedLyrics`): se si guarda la risposta a mano, **non stampare i campi di testo**.
- **Le playlist automatiche e l'elenco delle playlist** (ADR-0023, spec `2026-11-10-auto-playlists-and-playlist-list-design.md`, 2.20.0 + Mondrop 1.7.0 build 12; richiesta di Michele del 10 novembre: «se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato"… se il titolo è generico ( ecco gli album jaaz da ascoltare ... ) la play list è "jazz da ascoltare" e deve essere una sola… le ultime per prime», e «Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop»): un post che elenca **almeno 2 canzoni dal contenuto** (`ai_analysis`, `both`, `music_list`; **mai** l'impronta audio `audio_fingerprint` del sottofondo, che è il caso di 626 voci su 719) diventa una playlist quando la sua analisi finisce (`services/autoPlaylists.ts` le regole, `autoPlaylistTitle.ts` titolo e tipo dal modello **locale**, `autoPlaylistStore.ts` il database, `autoPlaylistWiring.ts` il gancio: **non si attende mai** e non può far fallire un'analisi). **Regole da non rompere:** titolo **preciso** (`one_off`) = una playlist per post, titolo **generico** (`theme`) = **una sola per tema** con i brani nuovi **in cima** (posizioni più basse) e senza doppioni; il modello dice anche `aboutMusic` (i «brani» di un post sui film non fanno una playlist); **mai una playlist con un titolo brutto** (pulizia: niente `#@"`, «ecco i», emoji, tutto maiuscolo; senza titolo la voce resta `pending`); **una playlist cancellata non si ricrea** (`auto_playlist_themes.playlist_id` nullo) e una rinominata continua a ricevere il suo tema (la chiave è `themeKey`, non il nome); i temi **non si fondono per somiglianza di significato** (provato con i vettori: «Jazz da ascoltare» e «Album da ascoltare» a 0,91, meglio una playlist in più che brani in quella sbagliata); una volta per voce (`auto_playlist_runs`); le voci già presenti **solo** con `node dist/scripts/buildAutoPlaylists.js` (**anteprima per default**, `--apply` solo con l'OK di Michele; **applicato il 10 novembre, 07:27–07:43**: 56 playlist, 357 brani, annullabile con `--undo-since 2026-11-10T06:27:41Z`). `AUTO_PLAYLISTS=0` spegne. **Tutti i post con canzoni (2.20.1, Michele: «vorrei di tutti i post non solo di 42»):** una canzone sola (nominata o riconosciuta dall'audio) entra **solo in un tema scelto da un elenco chiuso di 36 titoli** (`SINGLE_THEMES` in `autoPlaylistTitle.ts`, schema `enum`: **il modello non scrive mai il titolo di una canzone sola**, con titoli liberi faceva «Synthwave de Ascolare») e solo se `aboutMusic`; `AUTO_PLAYLIST_MODEL` (compose, `qwen3.5:122b` su vulcano) fa i titoli delle **liste** con ripiego sul default (`gpt-oss:120b` scartato: ~35 s a voce); annullare un'applicazione: `buildAutoPlaylists --undo-since <ISO>` (anteprima per default). **Due correzioni di Michele dopo l'applicazione (2.20.2, ADR-0024, spec §1.2):** «le playlist non possono essere di una sola canzone - vanno smontate, si chiamano "play list"» → **una playlist automatica ha almeno due brani** (`MIN_PLAYLIST_SONGS`): un tema con un brano **aspetta** (la voce è `waiting`, con `theme_key`, e si rilegge) e la playlist nasce con tutti i brani che aspettavano quando arriva il secondo brano **diverso**; le fatte a mano non si toccano. «"Soul da ascoltare" mi aspetto che sia una dinamica deve avere il tag soul la canzone» → i **23 temi che nominano un genere dei metadati** (`services/genreThemes.ts`, nomi canonici di `utils/genres.ts`) sono playlist **dinamiche** (`kind = 'dynamic'`, ordine nuovo `newest` = ogni brano col genere, i più recenti del diario per primi, fino a 200, **senza guardare gli ascolti**), **una per insieme di generi** (`theme_key = genre:…`: «Rap»/«Hip hop», «R&B»/«Soul»), nate quando la libreria ha due brani col tag e **senza brani propri** (un post dopo non aggiunge né avvisa); i temi senza tag nei metadati (Synthwave, Darkwave, Italo disco, Disco, Lo-fi, Musica italiana, i decenni), le occasioni e i titoli liberi restano liste dei post. **Mai** copiare i brani di un post in una playlist di genere; **mai** togliere un tema dal registro senza togliere anche la playlist (un tema senza playlist vuol dire «cancellata dall'utente» e non si rifà). Le playlist già fatte: `node dist/scripts/repairAutoPlaylists.js` (**anteprima per default**, `--apply` solo con l'OK di Michele). Test d'integrazione su Postgres vero: `AUTOPL_INT=1 … vitest run --no-file-parallelism` (i due file usano lo stesso database). Pagina Canzoni del sito: l'elenco delle playlist è una riga chiusa «Playlist (N)», aperta scorre in una scatola. **L'elenco** (`GET /api/playlists`, `GET /api/mondrop/playlists`): `q`, `filter` (all, auto, mine, shared, dynamic), `sort` (created, updated, name, size), `order`, `limit` (massimo 100), `offset`, risposta con `total`; **senza parametri come prima** (le app fino alla build 11), il server decide tutto (regola P), un valore sbagliato è un `400`; la lista **completa** serve a «Libera spazio» dell'app (`pruneMemberships`): mai dargli una pagina. L'app (build 12): `PlaylistList.swift` (modello, query, data «oggi»/«ieri»/«10 nov»), `PlaylistsView.swift`.
- **Icona di Mondrop** (spec `2026-11-08-mondrop-app-icon-design.md`; richiesta di Michele dell'8 novembre: «volgio rifare l'icona di mondrop, mi sembra troppo poco professionale.»; scelta: «la goccia con le onde ( sondo giallo e goccia nera ) per mondrop, mentre la casa gialla con le onde a sfondo azzurro per home-ass»): **è codice, non un'immagine**. `node ios/scripts/make_app_icon.mjs` disegna gli SVG (`ios/icon/`) e riscrive i cataloghi `Mondrop/` e `MondropShare/Assets.xcassets/AppIcon.appiconset` (iOS 1024 **RGB senza alpha** in tre versioni — normale, `-Dark`, `-Tinted` —, dieci tagli macOS); mai ritoccare un PNG a mano, si cambia lo script e si rigenera (prove: `node --test ios/scripts/make_app_icon.test.mjs`, `AppIconAssetsTests.swift`). Usa `sharp` del backend. Il foglio di condivisione è la stessa goccia con una freccia in giù. `--house <cartella>` produce la **gemella dell'app TV Casamon** («home-ass»: casa gialla con le onde su azzurro, 80/130/1024 px) che sta nel repo `casamon-tv`, non qui (regola di Michele: «Non voglio due app diverse sulla tv - l'app è quella di prima e deve avere icona diversa e basta.»: una sola app, `dev.casamon.tv`, cambiano solo `icon.png` e `largeIcon.png`). **La cancellazione dei brani sta solo nelle Impostazioni** (spec `2026-11-08-mondrop-deletion-in-settings-design.md`, `DeletionInSettingsTests`): nessuna riga di brano offre di cancellare.
- **La Home di Mondrop** (ADR-0020, spec `2026-11-08-mondrop-home-spotify-design.md`, 2.18.0 + Mondrop 1.7.0 build 9; richiesta di Michele dell'8 novembre: «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify», poi «A, si giallo»): la prima scheda è la **Home** (saluto, campo «Cosa vuoi ascoltare?» che apre Cerca con la tastiera, «Riprendi», le sezioni del server); **«Cerca musica» non deve tornare** (un test lo cerca in tutti i sorgenti). `GET /api/mondrop/home` (`services/mondropHome.ts`) risponde con le **sezioni già pronte** (`playlists`, `recent`, `fresh`: quali ci sono, in che ordine, con che titolo e che brani): l'app disegna e non calcola niente, ignora un `kind` che non conosce, e un guasto di una sezione costa solo quella (regola P: nessun campo nomina un negozio, `mediaUrl` `null`). **Il Player non è una scheda**: è il **mini player** (`MiniPlayer.swift`), uno solo per l'app, applicato con `.miniPlayer(open:)` alla `NavigationStack` di **ogni** scheda (mai a mano in una pagina: `HomeStructureTests` fallisce), che apre il Player a schermo intero (`fullScreenCover`, freccia in giù). **La coda si salva** (`QueueSnapshot.swift`: file compatto + posizione nel brano a parte) e al lancio ricompare **ferma**: il play non parte mai da solo; un brano ripristinato non ha la vista del server, la chiede al primo play (`LocalAudioPlayer.serverView`). **Giallo ovunque = app tutta scura** (`UIUserInterfaceStyle` Dark + `.preferredColorScheme(.dark)` + `AccentColor` giallo; il giallo su bianco ha contrasto 1,4): i colori sono `MondropPalette` (numeri con contrasto provato), un pulsante giallo è `MondropPillStyle` (testo **nero**: il `.borderedProminent` di sistema lo fa bianco, e un test lo vieta), mai i colori dinamici di sistema nelle schermate scure. Attenzione: `RulePTests` vieta la parola «home» nei file che scelgono una sorgente (`LocalAudioPlayer.swift` compreso): lì si dice «la scheda di Riprendi», non «Home». Per **guardare le schermate** senza server: build DEBUG sul simulatore con `-MondropDemo` (+ `-MondropDemoTab search|playlists|inbox|share|settings`, `-MondropDemoPlayer`, `-MondropDemoSearch`, `-MondropDemoPush playlist|library`; `DemoData.swift`, solo `#if DEBUG`, mai in TestFlight); script di prova nel lavoro di Michele: `scratchpad/home_shot.sh`.
- **Import musica del Mac**: lo fa il Claude Code sul Mac con `docs/mac-music-import-prompt.md`, scrive **solo** in `TESLA_MEDIA/Music/SoundReel/_MacMusic/` (ADR-0012; la chiavetta è anche il drive della Tesla). La password dell'utente SMB `geekom` sta solo in `~/.config/soundreel/fritz-credentials` (0600) e non va mai in chat, file o prompt
- Share Extension: `POST /api/share` (auth `X-SoundReel-Key`, stub+queue, tag da comment) — doc `docs/share.md`, client in `ios/`
- Timeout pipeline: 120s

### Frontend React
- Componenti funzionali con hooks
- Stato globale minimo: usare hooks custom
- Polling o WebSocket per aggiornamenti real-time (no Firestore)
- React Router per navigazione
- CSS semplice — no component library
- Dark mode come default e unico tema

### API esterne
- **Whisper**: HTTP verso `gpu-router:9000/whisper` (env `WHISPER_URL`) — il router sceglie: archi-pc (`192.168.178.23:9000`, nativo CPU) quando risponde, altrimenti accende da sé il container locale `soundreel-whisper` scegliendo `tiny` o `small` secondo la RAM disponibile, e lo spegne dopo 15 minuti di inattività. Spec: `geekom-hub/gpu-router/specs/2026-08-30-whisper-routing-and-on-demand-design.md`
- **Instaloader**: HTTP verso `soundreel-instaloader:5000` (include endpoint `/shazam/recognize`, `/shazam/scan-full`, `/yt/url`, `/download-media` per YouTube/TikTok via yt-dlp, `/yt/audio` per scaricare una canzone come MP3 taggato: `instaloader/yt_audio.py`, scelta del video per punteggio con soglia — meglio nessuna sorgente che il brano sbagliato)
- **OCR**: HTTP verso `soundreel-ocr:5001`
- **Ollama**: HTTP verso `gpu-router:9000` (env `OLLAMA_URL`) — gpu-router preferisce vulcano (tier 0), poi archi-PC, poi GEEKOM. Modelli: `OLLAMA_TEXT_MODEL` (default `glm-4.7-flash:q4_K_M`; il client manda `think: false` sui call di testo), `OLLAMA_VISION_MODEL` (default `moondream:latest`) **L'analisi dei contenuti impone uno JSON Schema a Ollama** (`ANALYSIS_SCHEMA` in `aiAnalysis.ts`, `format: <schema>`): con il solo `format: json` il modello poteva scrivere qualunque chiave (l'8 novembre copiava una riga di istruzioni del prompt e poi si scusava in chiaro) o andare in loop fino ai 4096 token; il prompt non gli chiede di ricopiare trascrizione, OCR e contesto visivo. **Una risposta troncata (`truncated`) o senza JSON leggibile NON è «niente da trovare»**: un nuovo tentativo, poi un fallimento `unusable_output` ritentabile (il job lo riaccoda), mai un'entry «completata» a zero. Per riprendere le entry già vuote: `node dist/scripts/requeueEmptyAnalysis.js --dry-run` (mai Claude: il lavoro è locale). **I software citati li trova una seconda chiamata dedicata** (`services/softwareExtraction.ts`, dalla 2.10.0): lo schema grande non ne dava nessuno (0 su 135 entry, 48 che citano strumenti). Parte solo se il testo parla di software, scarta ogni titolo o URL che non compare nel testo, non fa mai fallire l'analisi; per riempire quelle già nel journal senza rifare l'analisi: `node dist/scripts/backfillSoftware.js --dry-run`.
- **Spooty**: HTTP verso `spooty:3000/api/playlist` per aggiungere link Spotify (env `SPOOTY_URL`, default `http://spooty:3000`; env `SPOOTY_FRONTEND_URL`, default `https://spooty.casamon.dev`). Unico client: `services/spootyClient.ts` (stato traccia: 0 New, 1 Searching, 2 Queued, 3 Downloading, 4 Completed, 5 Error; dopo un retry riuscito Spooty NON azzera `error`: conta solo `status`). L'immagine upstream `raiper34/spooty` non esiste più (repo e Docker Hub 404): la copia locale è l'unica (tag `raiper34/spooty:pre-update-20261107`, non cancellarla). Il suo `yt-dlp` è montato da `~/works/Spooty/yt-dlp/` (generato da `sync-ytdlp.sh` dal yt-dlp di instaloader); l'originale (2026.03.17) dava HTTP 403
- **Spotify**: OAuth PKCE, token refresh automatico prima di ogni operazione
- **TMDb**: GET a `https://api.themoviedb.org/3/search/movie`
- **Telegram**: webhook, risposta inline nel messaggio. Il testo libero nello stesso messaggio del URL diventa tag di filtro sull'entry (oltre ai tag AI/post); su URL già noto i tag si uniscono via `mergeEntryResults`
- **Share (iOS/macOS)**: app nativa **Mondrop** (`ios/`, bundle `it.mikesoft.mondrop`, Team `5NZADC9YQ2`) → `POST /api/share` (Traefik `soundreel-share`, auth `X-SoundReel-Key`). App Group `group.it.mikesoft.mondrop`. Doc `docs/share.md` + `ios/README.md`. Key personale self-service: `GET/POST /mondrop/connect` (Authelia `Remote-User` → key legata a utente+dispositivo; app: Impostazioni → Ottieni/Rinnova API key). **Vincolo**: quella rotta DEVE restare dietro `auth-family` — mai sotto `/api/mondrop` né su `/api/share` (router Traefik senza Authelia: `Remote-User` lo scriverebbe il client). XcodeGen: `Assets.xcassets` va nei `sources` (la chiave `resources:` del target viene ignorata e l'icona non arriva nell'app)
- **Posta di Mondrop** (ADR-0015, spec `2026-11-08-mondrop-share-inbox-design.md`, contratto `docs/mondrop-inbox.md`, 2.10.0): `POST /api/share` accetta `playlistId` (statica propria) e `shareWith` (famiglia, mai se stessi, `entry_shares` subito) e risponde sempre `playlist`/`sharedWith`/`rejected`. Il server tiene la **posta** (`inbox_items`, fonte di verità: l'app la legge, il push APNs è solo il campanello) e un'**intenzione** per condivisione (`share_intents`, `services/shareFlow.ts`: si chiude quando l'entry è pronta — subito per Spotify/Shazam, a fine analisi per gli altri, via `onAnalysisFinished` nel worker e `onEntrySongsAvailable` nel watcher Spooty — e chi la chiude annuncia, una volta sola). Regole di Michele: **gli `info` scadono dopo 3 giorni, gli errori mai** (restano finché non li tolgo io o lo stesso link riesce: un solo errore per link, `closeErrorsForLink`), le condivisioni ricevute non scadono, un badge unico (`seen` = `read`). Rotte `GET /api/mondrop/inbox?since&limit` (+ `removedIds`), `POST …/inbox/:id/read`, `…/read-all`, `DELETE …/inbox/:id`, `POST …/received/:entryId/seen`, `POST|DELETE …/push/devices`: ognuna tocca **solo la posta dell'utente della key** (`requireMondrop`), l'id di un altro è `404`. Mai posta per Telegram, web e riparazioni (`notify: false`): l'intenzione esiste solo per `POST /api/share`. **APNs spento** finché non c'è la chiave (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_KEY_FILE`; `.p8` in `~/.config/soundreel/apns/` 0600, montata sola lettura in `/run/secrets/apns`): mai nel repository, in `.env` o in un log. **Contatori d'uso** aggregati (`services/usageCounters.ts`, `GET /api/admin/usage?days=14`): giorno, utente, tipo di dispositivo, rete, gruppo di rotta; mai IP, user-agent, percorso o query
- **Una cosa = una sola voce, e ogni card rimanda al post** (ADR-0017, spec `2026-11-08-no-duplicates-and-post-links-design.md`, regola di Michele dell'8 novembre): entry, canzoni, software, film e note non si duplicano (al massimo un link all'originale); le card dei media trovati (canzoni, film, software, note) mostrano il **link al post** da cui sono state estratte (`sourceUrl` di ogni menzione). Identità per nome normalizzato, applicata **alla lettura** (le voci originali restano nelle entry): software in `services/softwareCollapse.ts` (un link principale, gli altri «Altri link», URL segnaposto scartati), film in `services/filmCollapse.ts`; **le canzoni restano su `songKey`**, che è anche la chiave di playlist, `song_files` e `song_meta` (le versioni, D5, aspettano Michele). Ogni menzione è `{entryId, createdAt, sourceUrl, sourcePlatform}` (`utils/mentions.ts`, una per entry) e le card mostrano `PostLinks`. **Le versioni delle canzoni** (Instrumental, Slowed + Reverb, Live, Remix…) restano card a sé con `versionOf` (`services/songVersions.ts`, calcolato in `aggregateSongs`, riconoscimento prudente: «(Interlude)» o «(Nature Sounds)» sono titolo; la `songKey` non cambia); la card mostra «Versione di «Titolo»» e l'originale apre `/songs?q=<titolo>`. Per correggere l'identità di una canzone sbagliata dall'analisi: `fixSongIdentity` (file JSON `from`/`to`, anteprima di default, **rifiuta** una chiave con playlist, file o ascolti). Creazione delle entry **atomica**: `withEntryKeyLock(owner, url, …)` + `postKey()` attorno a «cerca, poi crea» in `ingestLink` e nel percorso web di `/api/analyze`: un nuovo punto che crea entry deve passare da lì. La fusione delle entry doppie: `node dist/scripts/mergeDuplicateEntries.js` (**anteprima per default**; `--apply` solo con l'OK di Michele; tiene la più vecchia con dati, sposta condivisioni, job, avvisi, intenzioni, richiesta Spooty e log, una transazione per gruppo, salta un gruppo con un job in corso); la copia di sicurezza va in `/tmp` del container, **mai sotto `/data/media`** (servita via HTTP su `/media` e ripulita dopo 7 giorni) e si copia fuori con `docker cp`; mai si toccano MP3, playlist o libreria
- **Distribuzione di Mondrop** (ADR-0016, spec `2026-11-08-mondrop-testflight-design.md`): alla famiglia arriva da **TestFlight** (gruppo esterno «Family»); build e upload con `ios/scripts/testflight.sh` (archivio Release, firma di distribuzione gestita dal cloud con la **chiave API di App Store Connect**), da lanciare nella **sessione grafica** di vulcano (`open -a Terminal`: il portachiavi non si sblocca via ssh). Il `.p8` sta solo in `~/.config/soundreel/appstoreconnect/` (0600) su geekom e vulcano, mai nel repository, in `.env`, in chat o nei log. **La chiave in uso è la Admin `KXRWH399D2`** (8 novembre; `config.env` punta a lei): la prima, `7A4NS73W6Y`, era «Sviluppatore» (403 sulla firma cloud e sui gruppi; si può revocare). **Il login Apple ID di Xcode su vulcano non regge** (scade in ore, «Failed to Use Accounts»): non è una strada; `testflight.sh` si lancia con le variabili `ASC_*` (`run-testflight.command`) nel Terminale grafico. `ios/scripts/asc.mjs` ha anche `assign-build` e `submit-review`: un gruppo esterno vuole **prima la build, poi i tester**, e la revisione beta è **una alla volta** per versione. Il numero di build deve crescere a ogni upload della stessa versione (`BUILD=`). `install-iphone.sh` resta per le build di sviluppo. Le build TestFlight usano l'ambiente APNs di produzione
- **TTS**: `TTS_URL=http://gpu-router:9000/tts` — `POST /api/tts/render` (cache in `MEDIA_ROOT/tts/`), `localOnly` → header `X-TTS-Local-Only: 1`
- **MCP**: stdio in `backend/src/mcp/server.ts` (`npm run mcp`), usato dal SecondBrain (`~/works/personal/.mcp.json`); doc `docs/mcp.md`
- **cobalt.tools**: POST a `https://api.cobalt.tools/` per estrazione video — implementare SEMPRE fallback su OG scraping se cobalt fallisce
- **FRITZ!Box**: `192.168.178.10` (share SMB3 `FRITZ.NAS`) — sync notturna della libreria via `scripts/fritz-sync.sh`, scrive SOLO in `TESLA_MEDIA/Music/SoundReel` e `TESLA_MEDIA/Movies/SoundReel` (la chiavetta è il drive media Tesla dell'auto, non toccare il resto). Gira senza root: mount delegato a una riga `/etc/fstab` con opzione `user` (`scripts/fritz-sync.fstab.example`, unico passo con sudo, una tantum), config in `~/.config/soundreel/`, password solo nel file credenziali 0600 letto da mount.cifs **Leggere i file della chiavetta: `smbclient`, non il mount** (8 novembre, dopo che la chiavetta era stata tolta e rimessa): il mount cifs di `~/.local/share/soundreel/fritz` risponde «Stale file handle» a ogni lettura di un file esistente, anche dopo `umount`/`mount` (il kernel scrive «bogus file nlink value 0»), mentre le scritture di rsync e `stat` funzionano e `smbclient //192.168.178.10/FRITZ.NAS -A ~/.config/soundreel/fritz-credentials -c 'get …'` legge a 10 MB/s: per verificare cosa c'è davvero sulla chiavetta (tag, byte) si scarica con `smbclient`; la data di modifica di un file sostituito resta quella vecchia sulla chiavetta, quindi rsync lo riproporrà ancora (stesso contenuto, solo l'ora).

### Resilienza della pipeline
La pipeline è progettata per essere resiliente:
1. Se cobalt fallisce → usa OG meta scraping (solo caption + thumbnail)
2. Se AudD/Shazam/Whisper non trovano nulla → si usa solo il risultato AI (Ollama)
3. Se Ollama fallisce → si usa solo il risultato AudD/Shazam/Whisper
4. Se Spotify non trova la canzone → logga nel journal, non bloccare
5. Se TMDb non trova il film → logga titolo/regista senza link IMDb
6. OGNI fallimento va loggato nell'actionLog con dettagli dell'errore

### YouTube links
NON usare YouTube Data API. Generare link di ricerca:
`https://youtube.com/results?search_query=${encodeURIComponent(artist + " " + title)}`

### Idempotenza
Prima di processare un URL, cercare `sourceUrl` in Postgres. Se esiste, restituire i risultati esistenti senza riprocessare.

## Regole di lavoro (date da Michele)

- **Regola nuova = spec + ADR.** Quando Michele dà una regola, un requisito o un vincolo nuovo (in chat, anche a metà lavoro), non resta solo nel codice:
  1. si salva **testualmente** in una spec in `docs/superpowers/specs/` (si aggiorna quella del tema o se ne crea una: richieste testuali, decisioni con i default scelti, dati, test);
  2. se tocca l'architettura (dati, API, sicurezza, infrastruttura, chi è responsabile di cosa) si scrive anche un **ADR** in `adr/` (numero successivo, stesso formato di ADR-0006…0009) e si aggiorna `adr/README.md`. Le regole d'interfaccia (come si presenta una schermata) vanno nella spec, non in un ADR;
  3. si aggiornano `CHANGELOG.md`, `ROADMAP.md` e questo file se serve;
  4. nella risposta si dice a Michele quali file sono stati scritti.
- **Nessun deploy senza OK esplicito di Michele**, uno per ogni deploy.
- Specifiche in vigore sul player web: `docs/superpowers/specs/2026-11-07-web-player-ux-design.md`; su statistiche, spazio su iPhone, playlist dinamiche e log: `2026-11-07-listening-stats-dynamic-playlists-design.md`; sull'archivio MP3: `2026-11-07-mp3-store-media-server-design.md`; sulla ricerca nella libreria e le cartelle musica: `2026-11-07-library-search-music-folders-design.md`; sull'import della musica del Mac: `2026-11-07-mac-music-import-design.md` (+ `docs/mac-music-import-prompt.md`); su scegliere cosa suonare (iOS e web), filtri per tipo/album/autore/anni, stati del download e velocità del play: `2026-11-08-player-selection-and-filters-design.md` (ADR-0013, per la 2.9.0); sulla **ricerca unica «Cerca»** (diario + geekom + NAS, brani solo-file) e la **regola P** (i client parlano solo con SoundReel; piano di riproduzione del player web): `2026-11-08-mondrop-search-spotify-style-design.md` (ADR-0018, per la 2.13.0, Mondrop 1.7.0 e la 2.14.0); su Mondrop Share con esito di ritorno, playlist, condivisione con la famiglia e posta nell'app: `2026-11-08-mondrop-share-inbox-design.md` (ADR-0015, per la 2.10.0). sulla **Home di Mondrop** (rotta del server, mini player, coda salvata, giallo ovunque): `2026-11-08-mondrop-home-spotify-design.md` (ADR-0020, per la 2.18.0 e Mondrop 1.7.0 build 9). **In roadmap, non ancora in vigore:** sync delle foto di Mondrop al posto di Flickr (`2026-11-08-mondrop-photo-sync-design.md`, ADR-0014 proposto: le foto vanno in una cartella che MemoryLoom legge, SoundReel non fa galleria); sito web usabile da telefono (`2026-11-08-web-mobile-ux-design.md`); **ripensare il look & feel del sito** (`2026-11-10-web-look-and-feel-rethink-design.md`: richiesta di Michele del 10 novembre, «non mi piace il l&f generico, con molto spazio libero ai fianchi della pagina principale. dovremmo ripensarlo. ma ora finisci le attività»: da fare dopo le attività in corso, con mockup da guardare, e che regga anche il telefono); **playlist automatiche dai post di musica** e **elenco delle playlist che si cerca, si ordina per data e si sfoglia**, sito e Mondrop (`2026-11-10-auto-playlists-and-playlist-list-design.md`, ADR-0023: **fatte**, in produzione con la 2.20.0 e su TestFlight con la build 12, vedi il punto sopra; richiesta di Michele del 10 novembre: «voglio anche che se il reeel/post parla di musiche ( ecco le 5 musiche di natale ) mi venga creata una "playlist con il titolo adeguato"…»: titolo preciso = una per post, titolo generico = **una sola per tema** con i brani nuovi in cima); **raccolte automatiche della libreria** (`2026-11-09-library-collections-auto-topics-design.md`, ADR-0022 accettato, scelte di Michele del 10 novembre «1 si, - 2 no, - 3 5 voci - 4 ok.»: le raccolte per argomento, luogo e tipo le **scopre il server** con vettori locali — nome da un elenco di ~30, nascita a 5 voci, correzioni che durano, mai Claude —, il luogo si legge dal testo e i **locali** citati hanno «Apri in Maps», **solo sul sito**, non su Mondrop).

## Deploy

Deploy su GEEKOM via file sentinel (sistema `deploy-watcher`):

```bash
# Trigger rebuild + redeploy
touch /home/mike/works/Soundreel/.rebuild

# Verifica risultato (dopo ~60s)
cat /home/mike/works/Soundreel/.rebuild-log

# Oppure via API
curl -X POST https://console.casamon.dev/rebuild/soundreel
curl https://console.casamon.dev/deploy-status/soundreel
```

**Build e cache:** il watcher dà alla build 300 s e la lancia con `BUILD_DATE` e `GIT_REVISION` nuovi a ogni volta: nel Dockerfile `ARG BUILD_DATE`/`ARG GIT_REVISION`, `ENV GIT_REVISION` e le `LABEL` devono restare **in fondo** allo stadio finale, dopo `apt-get` e gli `npm install` (messi in alto, come fino alla 2.10.0, rifanno chromium e la CLI di Claude Code a ogni deploy: l'8 novembre il deploy della 2.11.0 è scaduto per questo). Il Dockerfile prende i manifest da uno stadio che toglie il numero di versione (`docker/strip-version.cjs`), quindi un bump di versione **non rifà** i tre `npm install`; un cambio di dipendenze sì (circa cinque minuti: scaldare la cache a mano con `docker compose build soundreel` prima di toccare `.rebuild`, come per la 2.9.1). Se il watcher scrive `ERROR: timeout 300s` il vecchio container resta su: nessun danno.

## Comandi utili

```bash
# Build Docker locale
./scripts/build.sh

# Dev locale frontend
cd frontend && npm run dev

# Dev locale backend
cd backend && npm run dev

# Logs container in produzione
docker compose logs -f soundreel

# Restart container
docker compose restart soundreel

# Sync manuale della libreria verso la chiavetta del FRITZ!Box (nessun root:
# il mount è delegato a una riga in /etc/fstab con opzione `user`)
./scripts/fritz-sync.sh
cat ~/.local/share/soundreel/fritz-sync.log

# Timer utente (systemd --user, linger già attivo su questa macchina)
systemctl --user list-timers fritz-sync.timer
```

## Cose da NON fare

- NON usare Firebase, Firestore, o Firebase Cloud Functions
- NON usare Next.js o altri framework backend — solo Fastify
- NON usare YouTube Data API
- NON montare lo share SMB del Fritz nel container né farlo scrivere al backend (ADR-0006): la replica la scrive solo `scripts/fritz-sync.sh`
- NON hardcodare API keys o secrets nel codice; la chiave APNs (`AuthKey_<KeyID>.p8`) sta solo in `~/.config/soundreel/apns/` e quella di App Store Connect solo in `~/.config/soundreel/appstoreconnect/` (0600), e non passano mai da chat, repository, `.env` o log
- NON creare un sistema di autenticazione multi-utente — è un'app personale
- NON aggiungere dipendenze frontend pesanti (Material UI, Chakra, etc.)
- Test automatici: unit test e integration test con mock sono benvenuti. NON usare chiamate reali a sorgenti esterne nei test (Instagram, TikTok, YouTube, Spotify, Ollama, cobalt, instaloader) — usare sempre mock/stub per evitare ban/rate-limit degli account. Stack test consigliato: Vitest (frontend), Node test runner o Vitest (backend).

<!-- claude-skills:begin -->
## Installed Skills

The following Claude Code skills are installed in `.claude/skills/`. Claude will auto-load them based on context, or you can invoke them with `/<skill-name>`.

### Foundations
| Skill | Description |
|-------|-------------|
| `architecture-decision-records` | Architecture Decision Records governance and format. |
| `ask-questions-if-underspecified` | description: Clarify underspecified requirements before implementation. |
| `prompt-architect` | Analyzes and transforms prompts using 8 research-backed frameworks (CO-STAR, RISEN, RISE-IE, RISE-IX, TIDD-EC, RTF, Chain of Thought, Chain of Density). |
| `skill-clusters` | Skill cluster index and loader. |

### Cloud & Infrastructure
| Skill | Description |
|-------|-------------|
| `containerization` | Docker best practices for cloud-native applications. |
| `finops` | Cloud cost management as an architectural discipline. |
| `infrastructure-as-code` | Infrastructure as Code with Terraform and Pulumi. |
| `observability` | Logging, metrics, and tracing with OpenTelemetry. |
| `terraform-style-guide` | description: Generate Terraform HCL code following HashiCorp's official style conventions and best practices. |
| `terraform-test` | description: Comprehensive guide for writing and running Terraform tests. |

### Security & Compliance
| Skill | Description |
|-------|-------------|
| `authn-authz` | Authentication and authorization patterns for multi-tenant applications. |
| `compliance-privacy` | GDPR compliance and privacy as architectural constraints. |
| `differential-review` | description: > |
| `owasp-security` | description: Use when reviewing code for security vulnerabilities, implementing authentication/authorization, handling user input, or discussing web application security. |
| `security-by-design` | Security as a design property, not an added layer. |

### Testing & Quality
| Skill | Description |
|-------|-------------|
| `performance-testing` | Performance testing with k6 for SLO validation. |
| `property-based-testing` | description: Provides guidance for property-based testing across multiple languages and smart contracts. |
| `quality-gates` | Formal quality gates that block releases. |
| `security-testing` | Automated security testing in CI. |
| `testing-implementation` | Concrete test tooling and patterns for TypeScript and Swift. |
| `testing-strategy` | Testing strategy that produces real confidence. |
| `verification-before-completion` | description: No completion claims without fresh verification evidence. |

### Delivery & Release
| Skill | Description |
|-------|-------------|
| `chaos-engineer` | description: Use when designing chaos experiments, implementing failure injection frameworks, or conducting game day exercises. |
| `cicd-pipeline` | CI/CD pipeline design with GitHub Actions. |
| `executing-plans` | description: Execute implementation plans in batches with feedback checkpoints. |
| `feature-management` | Feature flags, progressive rollout, A/B testing, and kill switches. |
| `finishing-a-development-branch` | description: Complete feature branches safely with structured options. |
| `incident-management` | Incident response process from detection to postmortem. |
| `production-readiness-review` | Production readiness GO/NO-GO framework. |
| `release-management` | Release management with automated SemVer, changelog generation, release notes, rollback strategies, and hotfix workflow. |
| `using-git-worktrees` | description: Set up isolated git worktree workspaces for feature development. |
| `writing-plans` | description: Break requirements into TDD-based micro-task implementation plans. |

### Documentation & Diagrams
| Skill | Description |
|-------|-------------|
| `architecture-communication` | Communicating architectural decisions to stakeholders. |
| `diagrams` | Architectural diagrams as code using Mermaid and C4 model. |
| `technical-documentation` | Documentation as a living artifact. |

### Data Architecture
| Skill | Description |
|-------|-------------|
| `caching-search` | Distributed caching and full-text search patterns. |
| `data-modeling` | Schema design, multi-tenant data isolation, and migration management. |
| `database-optimizer` | description: Use when investigating slow queries, analyzing execution plans, or optimizing database performance. |
| `event-driven-architecture` | Event-driven systems with CloudEvents and GCP Pub/Sub. |

### Architecture & Patterns
| Skill | Description |
|-------|-------------|
| `api-design` | API design conventions for REST and GraphQL. |
| `error-handling-resilience` | Error handling and resilience patterns for distributed systems. |
| `legacy-modernizer` | description: Use when modernizing legacy systems, implementing incremental migration strategies, or reducing technical debt. |
| `microservices-architect` | description: Use when designing distributed systems, decomposing monoliths, or implementing microservices patterns. |
| `microservices-patterns` | Microservices patterns for service decomposition, inter-service communication, and operational concerns. |

### AI & Applications
| Skill | Description |
|-------|-------------|
| `rag-architect` | description: Use when building RAG systems, vector databases, or knowledge-grounded AI applications requiring semantic search, document retrieval, or context augmentation. |

### Green Software & Sustainability
| Skill | Description |
|-------|-------------|
| `carbon-aware-architecture` | Carbon-aware design patterns from the Green Software Foundation. |
| `green-software-principles` | Green Software Foundation principles as an architectural discipline. |
| `sci-measurement` | Software Carbon Intensity (SCI) measurement per ISO/IEC 21031:2024. |
| `sustainability-impact-assessment` | Sustainability governance council for software projects. |

### Other Skills
| Skill | Description |
|-------|-------------|
| `apple-compliance-audit` | Apple App Store compliance audit for iOS apps covering Info.plist, entitlements, privacy manifests, App Store Review Guidelines, HIG, security, and submission readiness. |
| `graphql-architect` | GraphQL schema design, Apollo Federation, DataLoader patterns, and query optimization. |
| `insecure-defaults` | Detects fail-open insecure defaults — hardcoded secrets, weak auth, permissive security — that allow apps to run insecurely in production. |
| `ios-app-audit` | Comprehensive production audit for iOS apps covering security, App Store compliance, privacy, reliability, performance, accessibility, and code quality. |
| `ios-gui-assessment` | Audit iOS SwiftUI/UIKit projects for GUI consistency, native Apple control usage, HIG conformance, deprecated API detection, OS version compatibility, and accessibility. |
| `kubernetes-specialist` | Kubernetes workloads, networking, security hardening, Helm, and GitOps. |
| `pypict-claude-skill` | Pairwise and combinatorial test case design using PICT models. |
| `sharp-edges` | Identifies error-prone APIs, dangerous configurations, and footgun designs that enable security mistakes through poor developer ergonomics. |
| `systematic-debugging` | Root-cause-first debugging methodology with four-phase investigation process. |
| `websocket-engineer` | Real-time communication with WebSocket and Socket.IO, scaling, and presence patterns. |
<!-- claude-skills:end -->

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
