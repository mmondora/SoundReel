# Changelog

Tutte le modifiche rilevanti a SoundReel sono documentate in questo file.

## [Unreleased]

### 2.9.0 — Scegliere cosa suonare, filtri per tipo/album/autore/anni, stati del download, play più rapido
- Added: **anno di uscita** di ogni canzone (ADR-0013, `song_meta.release_year`, migration 018), **solo da iTunes** con un match forte (artista e titolo coincidono): le date degli album di Deezer sono quelle delle ristampe e sbagliavano il decennio per metà dei classici provati (Queen 1975 → 2005, Nirvana 1991 → 2011; iTunes 8 su 8). Un brano che iTunes non conosce bene resta «Senza anno».
- Added: **riempimento una tantum** (`services/releaseYearBackfill.ts`) dell'anno per i brani già in libreria: parte 90 s dopo l'avvio, dura circa **50 minuti** (limite di iTunes) e scrive **solo l'anno** dei brani già arricchiti (copertine, generi e id Deezer restano come sono); si ferma da solo se iTunes non risponde e riprova dopo un'ora. `RELEASE_YEAR_BACKFILL_ENABLED=0` lo spegne.
- Added: **`GET /api/mondrop/library`** — tutti i brani dell'utente filtrabili per testo (ordine delle parole ininfluente), tipo, album, autore e decennio («Anni 80» = 1980–1989, più «Senza anno»), con le voci tra cui scegliere e i loro conteggi (ognuna conta senza il proprio filtro), paginata. `album`, `genres` (canonici) e `year` su ogni brano Mondrop. Contratto in `docs/mondrop-sync.md`.
- Added: **web — «Scegli cosa suonare»** nel player: filtri per tipo, album, autore, anni, fonte, tag, playlist, scaricata, FS/MS e ricerca libera; il risultato (o una playlist, un album, un autore, un brano) diventa la coda, con «Mescola e suona». Un solo motore di filtri per Playlist manager, player e pagina Canzoni (stesse regole del backend); il filtro **Anni** c'è anche nel manager. Su telefono il pannello è un foglio a tutta altezza (bersagli ≥ 44 px, testo ≥ 12 px, campi a 16 px, safe-area).
- Added: **web — play più rapido**: la IFrame API di YouTube e il `preconnect` si caricano una volta quando la pagina è ferma, l'id del video del brano successivo si anticipa mentre suona quello corrente, «Sto caricando…» dura finché il brano parte davvero. Un brano che suona dal media server o dal disco non tocca mai l'IFrame.
- Added: **Mondrop 1.5.0 (iOS)** — scheda **Libreria** al posto della «coda generica»: si sceglie una playlist, un album, un autore, un tipo, un decennio o un singolo brano (anche solo tra quelli scaricati sul telefono, offline); la scelta diventa la coda, visibile come «In coda». **Stati del download** su ogni brano (spinner con percentuale mentre il server prepara o il telefono scarica, spunta verde, in coda, «da cercare», errore con il motivo) e una riga di stato in cima («Preparo 3 brani sul server · 1 in download dal telefono…»). **Notifica locale a sync finito** con l'app non in primo piano (interruttore in Impostazioni, acceso di default; il permesso si chiede alla prima sincronizzazione). Spazio, skip-list, statistiche e playlist dinamiche invariati.
- Fixed: iOS `SyncEngine` — un download finito consegnato prima di `attachExisting` poteva sovrascrivere `sync-queue.json` con una coda vuota, perdendo i brani in coda e falsando il riepilogo.
- Fixed: web — un id di video già in cache poteva far ripartire il video sotto un brano che suonava dal file; un caricamento fallito della IFrame API non viene più ricordato per sempre, così non rompe il primo play.
- Changed: la ricerca nella pagina Canzoni e nello scaffale del player ignora l'ordine delle parole e gli accenti; un chip scelto senza più brani resta visibile con lo 0, così si può annullare.
- Docs: ADR-0013 (anno, con le misure), ADR-0014 e ADR-0015 **proposti**, spec nuove per il sync delle foto di Mondrop, il sito web da telefono e la Share con la posta nell'app (tutte in roadmap, non implementate).
- Ops: nota scoperta l'8 novembre — la ricerca Deezer con `artist:"…" track:"…"` non risponde più dall'8 settembre, quindi ogni arricchimento passa da iTunes (vedi ROADMAP).

### 2.8.0 — Statistiche e playlist dinamiche, log di attività, media server senza copie, ricerca nella libreria
- Added: **statistiche di ascolto** (ADR-0007, `docs/mondrop-stats.md`): Mondrop e il player web mandano sessioni grezze (`POST /api/mondrop/plays`, `POST /api/plays`, tabella `play_events`, idempotenti per id); il server decide cosa conta (≥ min(30 s, 50 %)) e l'ora locale dell'ascolto. Dashboard `GET /api/stats/listening` (+ `/recent`): ogni utente vede i suoi numeri, l'admin tutti.
- Added: **playlist dinamiche** (ADR-0008): regola parametrica (fascia oraria anche a cavallo della mezzanotte, giorni, periodo, genere, ordine, limite, scope io/famiglia) valutata a ogni lettura, quindi a ogni Sync; preset (notte, mattina 7–8, pranzo, sera, weekend…); sulle dinamiche add/remove/reorder rispondono `409 playlist_is_dynamic`. Il manifest Mondrop ha `dynamic`/`generatedAt` e per brano `plays`/`lastPlayedAt`.
- Added: **log di attività** (ADR-0009): playlist (chi/quando, brani aggiunti e tolti, rinomine, condivisioni), sync, richieste di download (telefono **e web**), esito dei download del worker, cancellazioni dal telefono (anche in `device_events`, durevole), copie ritirate. `GET /api/logs?category=a,b&since=` filtra sul server.
- Added: **Mondrop 1.4.0** (iOS): statistiche di ascolto con coda e invio a lotti, schermata «Spazio» (elimina i meno ascoltati con **doppia conferma** per i blocchi e log dettagliato sul server), skip-list «Riscarica», playlist dinamiche in sola lettura.
- Added: **Playlist manager**: «Tipo» è il genere (sinonimi fusi: Alternativa/Alternative…), la **posizione** di ogni brano (percorso su disco, URL sul media server, link YouTube), pallino verde = **esattamente** «su disco o sul media server»; `GET /api/songs` porta `fs`, `mediaServer`, `fsPath`, `mediaUrl`, `GET /api/songs/:key/state` porta `location`.
- Changed: **un brano può essere il file del media server** (ADR-0010): nessuna copia su geekom (la 2.7.0 copiava al primo play), `source: mediaserver`, `rel_path` nullo. Il web lo suona **dal media server** tramite proxy HTTPS con `Range` (funziona da internet); un brano che non c'è lo scarica il backend e un **invio su richiesta** (`SoundReel/.publish-request` → `fritz-sync-request.path` → `fritz-sync.service`) lo porta sul Fritz in minuti. Le copie della 2.7.0 si ritirano da sole quando l'originale risponde con gli stessi byte. Mondrop su iOS resta «scarica in locale e suona in locale».
- Added: **player web — sorgente**: switch `Auto`/`Internet`/`Media server` (Auto: rete interna → media server, da internet → Internet/YouTube), `GET /api/net`; badge `FS`/`MS`; lista a finestra di 20; video al posto della foto quando suona da Internet, copertina quando suona il file di casa.
- Added: **ricerca nella libreria** (ADR-0011): `GET /api/library/search` su journal, media server e file locali (Spooty + cartelle extra configurabili in «Cartelle musica», solo admin, solo dentro `MUSIC_EXTRA_ROOTS`); ordine delle parole ininfluente («Maestro Bassi» trova «Bassi Maestro»), mostra dove sta ogni file.
- Added: **import della musica del Mac** (ADR-0012): `docs/mac-music-import-prompt.md` per il Claude Code sul Mac (conversione a MP3 senza perdita di qualità, niente duplicati, tutti i tag che il media server usa); `scripts/fritz-sync.sh` protegge `/_MacMusic/` dal `--delete` notturno.
- Added: le canzoni che arrivano da link **Shazam/Spotify** vengono arricchite (copertina, generi) come le altre (`SONG_ENRICHMENT_ENABLED=0` lo spegne).
- Fixed: **chiavetta del Fritz scollegata** (è anche il drive dell'auto: osservato l'8 novembre, catalogo DLNA da ~6 450 voci a 1, `404` per ogni file): l'indice del media server non viene più sostituito da un catalogo crollato, i file non si danno per spariti senza un file di controllo, i brani che stanno sul Fritz aspettano invece di scaricarsi in doppione (ADR-0010 §9).
- Fixed: **il play era lento a partire** rispetto alla preview: `GET /api/songs/:key/youtube` e `/file-info` ricostruivano tutto il journal a ogni chiamata (~0,45 s); ora usano la cache per utente dei brani (spec `2026-11-08-player-selection-and-filters-design.md` §2).
- Fixed: l'ora locale di un ascolto si leggeva con il fuso del processo (`local_started_at` ora è testo); `GET /api/stats/listening` con un giorno non valido dava 500 invece di 400.

### 2.7.0 — Archivio MP3 server-side, primo play, sync iOS (Fasi 1–2 della spec MP3)

- Added: **archivio MP3** (ADR-0006, `docs/mondrop-sync.md`). Tabella `song_files` (migration 016): una riga per canzone, record del file e coda di download. Worker `songDownloader` (2 in parallelo, retry con backoff, priorità `play` sopra `sync`): prima **riusa** un file che c'è già (libreria `/music`, catalogo del Fritz), poi scarica da YouTube con il nuovo `POST /yt/audio` dell'instaloader (ricerca `ytsearch5` + punteggio del candidato con soglia, MP3 192k, tag e copertina nostri). I file finiscono in `~/Music/SoundReel/` (mount rw `/music/SoundReel`): scan libreria, player web e flag `downloaded` li vedono come quelli di Spooty.
- Added: **Fritz = media server e replica**. Catalogo DLNA (`media_index`, ~3450 brani utili su 6449 voci, 30 s), URL diretti verificati con HEAD prima di darli ai client (`mediaUrl`). Nessuno share SMB montato nel container. Stato in `GET /api/admin/store`. *(2.7.0 copiava su geekom ciò che c'era solo sul Fritz: dalla 2.8.0 il brano **è** il file del Fritz, vedi ADR-0010.)*
- Added: **API di sync** per Mondrop: manifest solo MP3 con `state`/`version`/`mediaUrl`, `POST …/prepare`, `GET/POST /api/mondrop/songs/:key{,/download}`, `PUT …/source` (link YouTube scelto a mano), `GET /api/mondrop/net` (casa / internet), `ETag` + `304` + `Range` sul file. Compatibile con le app già installate (`status` legacy resta `ready`/`missing`).
- Added: **primo play** — se il brano non è ancora scaricato parte subito (stream / ripiego YouTube sul web) e **in parallelo** si scarica con priorità, così la volta dopo è locale; se è già scaricato suona il file locale (`POST /api/songs/:key/download` + `GET /api/songs/:key/state` per il web).
- Fixed: **ogni download di Mondrop produceva un file vuoto** — la rotta del file rispondeva `200` con `content-length: 0` (handler async che non restituiva la reply mentre partiva lo stream). Trovato dal test end-to-end, verificato in produzione.
- Fixed: il sync notturno verso il Fritz falliva ogni notte da agosto (`cp watchlist.html: Stale file handle`): ora scrive accanto e rinomina, non è più fatale, i conteggi finali sono best-effort, `rsync` ha `--timeout` ed esclude `*.part` e i `._*` di macOS (che raddoppiavano l'indice del Fritz).
- Changed: la ricerca nella libreria trova anche i file col nome exFAT-safe che scriviamo noi (`AC/DC` → `AC DC`); `inLibrary` conta anche le canzoni con un file in `song_files`.
- Changed: cache unica della scansione libreria (`libraryCache`), invalidata a ogni file nuovo.
- Added: **pagina «Playlist» stile Norton Commander** (`/playlist-manager`): due pannelli (Libreria o qualsiasi playlist tua o condivisa con te), filtri per **tipo (genere musicale: rock, jazz, trap…)**, autore, fonte (piattaforma), «riconosciuta da» (audio, AI, lista, link Spotify, link Shazam), album, stato (scaricata / da scaricare / in preparazione), tag, preferiti; tastiera completa (Tab, Spazio/Ins, `+` `-` `*`, F3 dettagli, F4 rinomina, F5 copia, F6 sposta, F7 nuova, F8 rimuovi, F9 condividi, Ctrl+↑/↓ riordina, Ctrl+Z annulla) e bottoni per ogni comando; esito per brano, mai un fallimento parziale silenzioso. Le playlist condivise con te sono in sola lettura (regola del backend), le tue si condividono dal dialogo F9. `GET /api/songs` ora porta `sources`, `platforms`, `tags` per canzone.
- Added: **Mondrop 1.3 (iOS)** — Sync = `prepare` + download in background (solo Wi-Fi di default, 2 in parallelo, ripresa), salta i brani già presenti (esistenza + dimensione > 0 + uguale a `bytes`), in casa scarica dal Fritz (`mediaUrl`, senza mai mandare la key) con ripiego sul proxy; stato per brano con Riprova e «Link» (YouTube a mano); primo play (locale se c'è, altrimenti stream + download in parallelo, «Preparo il brano…» se il server deve ancora prepararlo); store in Application Support escluso da iCloud con migrazione (i file da 0 byte vengono scartati) e «Libera spazio» solo su richiesta; Info.plist `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription`; «Rete: casa / internet» nelle Impostazioni. Anche la build macOS torna a compilare. 157 test XCTest.
- Fixed: la rimozione di un brano da una playlist decodificava due volte la chiave (`50% off::song` → 500).
- Ops: l'instaloader va ricostruito a parte (`docker compose build soundreel-instaloader && docker compose up -d --no-deps soundreel-instaloader`): il deploy-watcher ricostruisce solo `soundreel`. Senza, `/yt/audio` non esiste e i download restano in attesa con retry.

- Added: **punto d'ingresso unico per i link** (`services/linkIngest.ts`): Telegram, `/api/share` e web usano la stessa logica. Un link Spotify (traccia/album/playlist, anche `intl-xx`, `spotify:` URI, `spotify.link`) entra in libreria come entry (artista/titolo/copertina da Spooty) ed è accodato su Spooty da **qualsiasi canale** — prima lo faceva solo Telegram, e senza creare nessuna entry.
- Added: **link Shazam** (`services/shazamLink.ts`, via `linkIngest`): `shazam.com/track/<chiave>` e `/song/<id>/<slug>` (anche con prefisso lingua, `?referrer=share`) diventano un'entry di libreria con artista, titolo, album e copertina letti dalla pagina (JSON-LD `MusicRecording`), uguale da Telegram, `/api/share` e web; piattaforma `shazam` (badge SZ), canzone `source: shazam_link`. Lo stesso link rimandato è idempotente; una lettura fallita salva l'entry in errore e rimandarla la riprova (adotta anche le due entry Shazam in errore del journal).
- Security: lettura Shazam solo su `shazam.com` via https, redirect rivalidati a ogni hop, timeout 12 s, download interrotto a metà pagina (~135 KB su ~1 MB). Shazam serve ai browser-like una pagina generica di un ALTRO brano (HTTP 200, nessun redirect): l'identità della pagina viene verificata contro l'URL raggiunto, altrimenti errore — mai un brano sbagliato.
- Changed: `/api/share` con un link Shazam illeggibile risponde `200 {success:false, error}` (il foglio iOS mostra il motivo e resta aperto) invece di «In coda ✓».
- Fixed: test `Home` che fallivano per il mock `fetchMe` mancante (Header/Inspector).
- Added: watcher Spooty (`spootyWatcher`, tabella `spooty_requests`, migration 015): segue lo stato (0–5) fino a Completato/Errore, scrive l'esito nell'action log, imposta `downloaded` solo a download finito, avvisa il chat Telegram; Spooty irraggiungibile → il link resta salvato e viene riprovato (max 6 h).
- Added: test di parità Telegram = share = web (`routes/linkParity.test.ts`) e test di `spotifyLink`, `spootyClient`, `linkIngest`, `spootyWatcher`.
- Fixed: Telegram classificava `netflix.com` come X (`includes('x.com')`): ora match esatto dell'host, una sola mappa per Telegram e share.
- Fixed: test Telegram che fallivano per il servizio identità non mockato; due guard di sorgente di `analyze.reanalyze` aggiornate a `findEntryByUrl(url, owner)`.
- Fixed: `DELETE /api/entries/:id` (e «cancella tutto») rispondeva 500 per ogni entry passata dalla coda (Telegram, share): `job_queue.entry_id` non ha `ON DELETE CASCADE`. Ora le righe di coda vengono tolte nello stesso statement.
- Ops: Spooty (upstream scomparso) aggiornato nel suo `yt-dlp` (2026.03.17 → 2026.10.26) per l'errore HTTP 403 di YouTube — vedi `CLAUDE.md`.

- Added: `GET/POST /mondrop/connect` — la app Mondrop ottiene/rinnova da sola la propria API key dopo il login Authelia (foglio web-auth → `mondrop://auth?key=…`). Key legata a utente + dispositivo (`config.apiKeys.meta`), «Rinnova» revoca la precedente dello stesso dispositivo, max 8 per utente.
- Changed: `/api/share` e `/api/mondrop/*` — con una key legata a un utente il server usa quell’utente e ignora `user` / `X-SoundReel-User` del client (le key legacy restano invariate).
- Changed: playlist nuove sempre **vuote** (rimosso il seeding con la coda/catalogo e il bottone 💾 «Salva coda come playlist»). Aggiungere una canzone a una playlist nuova dal modale «Aggiungi a playlist» la inserisce ancora.
- Changed: icona Mondrop → «casa-lanterna» (iOS full-bleed 1024 + tagli macOS).
- Added: Mondrop Impostazioni → «Ottieni / Rinnova API key» (+ bottone nella home se manca); deep link `mondrop://auth`.

## [2.6.14] - 2026-11-07

- Added: `POST /api/share` — ingest pubblico per Share Extension iOS/macOS (auth `X-SoundReel-Key`, stub+queue, tag da comment come Telegram).
- Added: `POST /api/share/mint-key` (loopback o Remote-User) per generare key in `config.apiKeys`.
- Added: Traefik router `soundreel-share` (Path `/api/share`, bypass Authelia).
- Added: app nativa iOS + macOS in `ios/` (XcodeGen): Share Extension con tag/chip recenti, Settings API key via App Group `group.it.mikesoft.soundreel`.
- Docs: `docs/share.md`, `ios/README.md`.

---

## [1.5.0] - 2026-05-14

- Added: page-extraction pipeline for non-Instagram URLs (Readability + link harvesting + representative image, no media download).
- Added: `pageExtractionEnabled` feature flag (default on).
- Added: `domain`, `faviconUrl`, `title`, `category` fields on `ExtractedLink` (optional, retro-compatible).
- Changed: Telegram bot now sends a single message per submitted link (AI summary + counts + SoundReel link). The "Ricevuto!" ack message has been removed.
- Changed: URL normalization (lowercase host, strip tracking params) before idempotency lookup.
- Security: SSRF guard on outbound page fetches (rejects loopback/private/link-local hosts and non-http(s) schemes).
- Added: `pageExtractionEnabled` toggle in Settings.
- Added: iOS Share Extension scaffold (sources for Xcode wiring on macOS).
- Added: Git SHA in Header version badge tooltip.
- Changed: bumped frontend version to 1.5.0.
- Removed: "Use Vertex AI" toggle from Settings UI and `useVertexAi` from `FeaturesConfig` (no code consumer).
- Removed: Instagram Cookies UI from Settings (backend endpoint and DB schema preserved).
- Removed: unused i18n keys for the deleted sections.

---

## [1.3.0] - 2026-01-31

### Novità
- **Internazionalizzazione (i18n)**: Supporto completo per Italiano e Inglese
  - Selettore lingua nelle Impostazioni
  - Default automatico basato sulla lingua del browser
  - Persistenza della preferenza in localStorage

### Miglioramenti
- Tutte le label UI ora localizzate
- Date e orari formattati secondo la lingua selezionata
- Messaggi di errore e successo localizzati
- Tooltip e placeholder tradotti

### Modifiche Tecniche
- Nuovo sistema i18n basato su React Context
- File `translations.ts` con tutte le stringhe
- Hook `useLanguage()` per accedere alle traduzioni
- Funzione `interpolate()` per stringhe parametriche

---

## [1.2.0] - 2026-01-31

### Novità
- **Supporto multi-piattaforma**: L'app ora funziona con qualsiasi social network
  - Instagram, TikTok, YouTube, Facebook, Twitter/X
  - Threads, Snapchat, Pinterest, LinkedIn, Reddit
  - Vimeo, Twitch, Spotify, SoundCloud
  - Qualsiasi altro URL con meta tag OG

### Miglioramenti
- Estrazione oEmbed generica per tutte le piattaforme che lo supportano
- Badge piattaforma dinamico con label specifiche (YT, FB, X, etc.)
- Fallback automatico su OG scraping per piattaforme senza oEmbed

### Modifiche Tecniche
- Nuovo sistema di configurazione piattaforme con pattern matching
- Tipo `SocialPlatform` condiviso tra frontend e backend
- Funzione `getPlatformConfig()` per accesso dinamico alla configurazione

---

## [1.1.0] - 2026-01-31

### Novità
- **Feature Toggles**: Nuova sezione in Impostazioni per gestire funzionalità avanzate
  - Toggle per abilitare/disabilitare Cobalt.tools (estrazione audio)
  - Toggle per ammettere URL duplicati (disabilita idempotenza per testing)

### Miglioramenti
- **Tema Light Apple-style**: Interfaccia completamente ridisegnata con tema chiaro
- **Date corrette**: Fix parsing date Firestore Timestamp nelle card
- **Card compatte**: Le entry senza risultati ora mostrano un layout compatto
- **Link cliccabili**: Il badge piattaforma (IG/TT) ora apre il post originale
- **Navigazione Console**: Aggiunto link "Home" nella pagina Debug Console

### Bug Fix
- Fix "Invalid date" nelle entry card
- Fix errore 500 causato da valori `undefined` nei log Firestore
- Fix Logger condiviso tra richieste (ora istanziato per-request)
- Fix HTML entities nelle caption (`&quot;`, `&#x1f3a7;` etc.)

### Modifiche Tecniche
- Cobalt.tools disabilitato di default (richiede autenticazione JWT)
- Migliorato logging con context per debugging
- Aggiunta gestione errori più robusta in contentExtractor

---

## [1.0.0] - 2026-01-31

### Release Iniziale
- Analisi URL da Instagram e TikTok
- Estrazione metadata via oEmbed e OG scraping
- Riconoscimento musicale con AudD API
- Analisi AI con Gemini Flash
- Integrazione Spotify (aggiunta automatica a playlist)
- Ricerca film su TMDb
- Bot Telegram
- Journal real-time con Firestore
- Debug Console con log filtrabili
- Editor Prompt personalizzabili
