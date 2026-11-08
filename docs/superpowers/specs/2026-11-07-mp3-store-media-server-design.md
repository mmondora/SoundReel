# Archivio MP3 server-side + media server (Fritz) — design v2

- **Data:** 2026-11-07
- **Stato:** Fasi 0 (deployata), 1 e 2 (implementate, in attesa di deploy) — vedi §2.9. Nessun deploy senza OK di Michele
- **Owner:** Michele
- **Correlati:** `adr/0005-reference-architecture.md`, `docs/superpowers/specs/2026-11-07-mondrop-offline-spooty-sync-design.md`, `docs/mondrop-auth.md`, `ROADMAP.md` § Client iOS / Mondrop

## 0. Requisiti e decisioni

1. **Parità Mondrop = Telegram**: un link Spotify condiviso da Mondrop entra in libreria, va in coda su Spooty, viene scaricato ed è riproducibile/scaricabile da Mondrop via `soundreel.casamon.dev`. Un solo punto d'ingresso per i link (web, Telegram, share) con test di parità.
2. **Metadati e fine download senza Spotify configurato**: dalla API di Spooty.
3. **In rete locale** stream e download restano locali. Il ripiego YouTube non è mai locale.
4. **Il file vive sul media server**; SoundReel tiene un record per canzone (percorso/URL sul media server, sorgente, stato); il client lo prende da lì.
5. Download server-side (anche se avviato da mobile con Sync), **solo per playlist e Sync**; il telefono scarica da SoundReel e non riscarica ciò che ha già.

Risposte di Michele: store = **Fritz**, se non funziona **geekom**; media server = Fritz (per ora); canzone già solo sul Fritz = **SoundReel la copia dal Fritz**. In roadmap: Navidrome, chiavetta del Fritz su geekom come media server, **app player su TV LG (webOS) in LAN**.

## 1. Cosa è stato verificato (nel codice e sull'infrastruttura)

| # | Domanda | Esito |
|---|---------|-------|
| 1 | Telegram + link Spotify | `isSpotifyUrl` (track/playlist/album) → **solo** `sendToSpooty` + risposta «✅ Ho aggiunto il tuo link a Spooty!». **Nessuna entry nel journal**, nessun owner, nessun metadato. Ramo con `return` prima della creazione dello stub (`telegram.ts:369`). La regex non copre `open.spotify.com/intl-it/track/…` né `spotify.link/…` |
| 2 | `/api/share` e web con link Spotify | Nessun caso Spotify: `share.ts` lo tratta come `other` (stub + job di analisi pagina), il web passa da `POST /api/analyze`. **Nessun Spooty**. Esistono due `platformFromUrl` diversi (share/telegram) e la sequenza *findEntryByUrl → merge/createEntry → enqueueJob* è duplicata |
| 3 | API Spooty | `GET/POST /api/playlist`, `PUT/DELETE /api/playlist/:id`, `GET /api/playlist/retry/:id`, `GET /api/track/playlist/:id`, `GET /api/track/download/:id`, `DELETE /api/track/:id`, `GET /api/track/retry/:id`. Stato traccia (letto dal codice compilato): **0 New, 1 Searching, 2 Queued, 3 Downloading, 4 Completed, 5 Error**; confermato sui dati (Moon Safari: 10 tracce a 4 → 10 file; Mezzanine: 9 a 4 + 2 a 5 → 9 file). Link a traccia singola: `createSingleTrack` → playlist `isTrack:true` con `name` = titolo e `coverUrl`, più 1 traccia con `artist`, `name`, `coverUrl`, `status`, `error`. **Verificato nel codice, non ancora live** (oggi in Spooty ci sono solo 5 album + 1 playlist). Errori reali: 10 tracce su 81 (≈12%) in `Error` — «HTTP 403», «Sign in to confirm you're not a bot», «youtubeUrl is null» |
| 4 | Come risolve `soundreel.casamon.dev` da casa | Il **MikroTik ha il DNS split-horizon**: `@192.168.178.1` → `192.168.178.113` (geekom), `@1.1.1.1` → Cloudflare. Traefik risponde in LAN con certificato valido (`ssl_verify_result=0`), quindi **HTTPS locale senza ATS exception**. geekom stesso usa DNS pubblici (non rilevante). App iOS: nessuna chiave `NSAllowsLocalNetworking` / `NSLocalNetworkUsageDescription` oggi |
| 5 | La chiavetta è sempre nel Fritz? | Sì: il log del sync notturno (02/08 → 07/11) ha **99 notti su 99** con share montata e volume `TESLA_MEDIA` presente, 0 errori di volume |
| 6 | Il Fritz indicizza un file appena scritto? | Servibile **subito** via URL DLNA derivato dal path (`206`, `Accept-Ranges`). Comparsa nell'indice DLNA: **no, né dopo 8 né dopo 12 minuti** (due test; il secondo con nome file = titolo = tag, ID3v2.3, ricerca per titolo/nome/artista): il Fritz indicizza in modo periodico, non a evento. I file del sync notturno compaiono nell'indice (523 voci sotto `SoundReel/`, `._*` inclusi), con latenza non misurata (da minuti a ore). **Il design non dipende dall'indicizzazione** per la consegna: il record `song_files` conosce il path e l'URL derivato funziona subito; l'indice serve solo ai client DLNA (TV/auto) e al riuso |
| 7 | SMB regge le scansioni? | **No, non va usato per scansionare**: un giro con `find` ha impiegato 198 s per 29 file (mentre il Fritz serviva anche DLNA). Per leggere/scrivere singoli file va bene: scrittura 2,7 MB in 0,4 s (6,8 MiB/s) + rename 0,19 s |
| 8 | Indice pronto già sul Fritz | **DLNA `Search`**: 6449 voci lette in **31 s** (200 per ~1 s), con titolo, artista (3457), album (2957), durata, dimensione e URL. ~46% delle voci è spazzatura (`._*` di macOS, < 200 KB): validi 3464. URL stabili `http://192.168.178.10:49200/AUDIO/DLNA-1-0/<path relativo al volume>`; lettura 7,9 MiB/s |
| 9 | Quanto riuso c'è davvero | Su 783 canzoni: **16** già nella tua libreria sul Fritz, 3 solo nella copia Spooty, **764 da scaricare**. Il matcher dà anche falsi positivi (versioni live/bootleg), va tarato |
| 10 | Sync notturno verso il Fritz | `rsync --delete` su `Music/SoundReel/` entrerebbe in conflitto con i file scritti direttamente lì. Inoltre il log mostra `FAILED (exit 1)` dopo lo step watchlist: un solo `OK` dal 02/08 |

## 2. Architettura

### 2.1 Punto d'ingresso unico: `linkIngest`
`backend/src/services/linkIngest.ts`, usato da Telegram, `/api/share` e web. Il web passa da `/api/analyze`, che per i link Spotify delega a `ingestLink` (risposta compatibile, frontend invariato); per gli altri link `/api/analyze` resta il motore di analisi usato anche dal worker.

- `classifyLink(url)`: `spotify_track|album|playlist` (anche `intl-xx/`, `spotify:track:…`, `spotify.link/…` risolto con redirect) | social | pagina. Sostituisce i due `platformFromUrl`.
- `ingestLink({url, comment, tags, ownerUser, channel, device, sharedAt})`:
  - **Spotify**: normalizza → idempotenza (URL + owner) → **crea entry** (`sourcePlatform: 'spotify'`, journal) → `postToSpooty` (unica implementazione, sparisce il `sendToSpooty` duplicato) → salva `spooty_playlist_id` → risponde `queued`.
  - **altro**: la sequenza stub/merge tag/`enqueueJob` oggi duplicata in `share.ts` e `telegram.ts`.
- Gli adattatori formattano soltanto la risposta (Telegram messaggio, share/web JSON).
- **Test di parità** (`linkIngest.parity.test.ts`): tabella di URL (Spotify track/album/playlist/`intl-it`/con `?si=`, Instagram, TikTok, YouTube, pagina generica) × adattatori (webhook Telegram, `POST /api/share`, `POST /api/links`); stessa chiamata a `ingestLink` e stessi effetti osservabili (createEntry, postToSpooty, enqueueJob), seconda sottomissione idempotente.

### 2.2 Spooty: metadati e fine download (senza Spotify in SoundReel)
Watcher (ogni 10–15 s finché ci sono richieste aperte, poi backoff): `GET /api/playlist` per trovare la playlist per `spotifyUrl`, `GET /api/track/playlist/:id` per le tracce.
- Arricchisce entry e `song_meta` con artista, titolo, copertina.
- `4 Completed` → individua il file in `/music` → registra in `song_files` → pubblica sul Fritz → entry completata.
- `5 Error` → log nel journal con il testo di Spooty; ritentabile con `GET /api/track/retry/:id`; timeout → `failed`.

### 2.3 Store: Fritz primario, geekom ripiego (SUPERATO da §2.9 / ADR-0006)
`MusicStore` con due radici configurabili (`MUSIC_STORE_PRIMARY`, `MUSIC_STORE_FALLBACK`). Cambiare media server (chiavetta su geekom) = cambiare un path, non il codice.
- Scrittura: file in staging locale → verifica → **`.part` + rename** sul Fritz (`TESLA_MEDIA/Music/SoundReel/Artista - Titolo.mp3`, nomi sanificati per exFAT/NTFS). Fritz non raggiungibile (mount assente, volume non `TESLA_MEDIA`, timeout) → il file resta su geekom come **outbox** (`store=local`) e un publisher lo sposta quando il Fritz torna.
- **Unico scrittore sul Fritz = container `soundreel`**. `soundreel-instaloader` (yt-dlp) scrive solo in staging sul volume condiviso `/data/media/_staging`.
- Mount persistente (oggi `noauto,user`, solo notturno): automount `systemd` con `soft`, `x-systemd.idle-timeout`, bind nel container con propagazione `rslave`. **Il passo `/etc/fstab` richiede sudo: lo fai tu.**
- Sync notturno: via `--delete`, correzione dell'uscita `FAILED`, resta come mirror non distruttivo della libreria Spooty.

### 2.4 Record per canzone e indice
- `song_files(song_key, store, rel_path, media_url, bytes, mtime, duration_s, source, match, status, error, attempts, spooty_*, video_id, timestamps)` — `source`: `spooty|ytdlp|existing`; `status`: `queued|downloading|publishing|ready|failed|no_source`. Sostituisce il match per nome file calcolato a ogni richiesta.
- `media_index(store, rel_path, artist, title, album, duration_s, bytes)`: copia in DB dell'indice DLNA (rilettura oraria + on-demand, ~31 s). Niente scansioni SMB né chiamate al Fritz per ogni richiesta. Filtri: esclude `._*`, file < 200 KB, durata 0.

### 2.5 Consegna ai client (dentro/fuori rete)
- Il manifest dà due indirizzi: `url` (proxy SoundReel, HTTPS, sempre valido) e `mediaUrl` (URL diretto del media server, derivato dal path: `http://192.168.178.10:49200/AUDIO/DLNA-1-0/<path>`; verificato `206` + Range).
- **App iOS**: in LAN preferisce `mediaUrl`, altrimenti `url`; mai YouTube per i download. Richiede `NSAllowsLocalNetworking` + `NSLocalNetworkUsageDescription`.
- **Player web**: solo `url` (HTTPS): un `<audio>` HTTP su pagina HTTPS è mixed content bloccato.
- DNS: **niente secondo URL**, basta lo split-horizon già attivo (HTTPS valido in LAN). Rischi lato telefono: iCloud Private Relay / DNS cifrato che aggira il DNS del router; permesso «Rete locale» negato (con split DNS il server di casa è un indirizzo locale: va gestito con messaggio chiaro).
- Diagnostica: `GET /api/mondrop/net` → `{viaCloudflare: bool}` (header `CF-Connecting-IP`/`CF-Ray`), mostrato nelle Impostazioni («Rete: casa / internet»).
- Il ripiego YouTube esiste solo nel player web in streaming e non è mai locale.

### 2.6 Canzoni senza Spotify (779 su 783): yt-dlp
- `POST /yt/audio` nell'instaloader: `ytsearch5`, scelta con regole (durata attesa se nota, canale «Topic»/ufficiale, no live/cover se non nel titolo), MP3 192 kbps con tag e copertina, in staging.
- Coda `song_downloads` nel worker: 2 in parallelo, retry con backoff, un solo job per canzone, solo per le canzoni delle playlist su Sync (+ tasto «scarica» sul brano).
- Override: «link YouTube corretto» per forzare un brano.

### 2.7 «Già presente»
Ordine: `song_files` pronto → `/music` (file Spooty) → `media_index` del Fritz (artista+titolo normalizzati, tag o cartella artista, esclusi live/bootleg salvo richiesta) → solo allora download. Trovato sul Fritz = `source: existing`, **si copia/serve da lì**, nessun download. Sul telefono: stesso brano (id + dimensione/etag) non riscaricato, un file unico per più playlist.

### 2.0 Stato Fase 0 (2026-11-07): **deployata** (v2.6.21, Shazam in v2.6.22) e verificata dal vivo
- Implementati: `spotifyLink` (tutte le varianti di link), `spootyClient` (unico client, stati 0–5), `spootyRequests` + migration 015, `linkIngest` (`classifyLink`/`ingestLink`), `spootyWatcher`, adattatori Telegram / `/api/share` / `/api/analyze`, avvio del watcher in `server.ts`.
- Test: suite backend verde (85 file, 1108 test), typecheck backend e frontend ok. Parità: 3 URL Spotify × 3 canali → stessi effetti; stesso link da due canali → una sola entry e un solo invio a Spooty; link non Spotify identici fra Telegram e share.
- Smoke test live con il link a traccia singola: Spooty crea subito playlist `isTrack` (titolo, copertina) e traccia (artista); stati osservati 1→2→3. Il primo download è finito in **errore 403** perché Spooty portava `yt-dlp` 2026.03.17; con `yt-dlp` 2026.10.26 il retry è arrivato a **4 Completato** e il file è in `/home/mike/Music`.
- Scoperte: l'upstream di Spooty non esiste più (repo e immagine 404: la copia locale è l'unica); dopo un retry riuscito Spooty **non azzera il campo `error`** (conta solo `status`).
- Deploy fatto con l'OK di Michele; la tabella `spooty_requests` è in produzione e il watcher gira. Smoke test live OK (entry, tracking, `downloaded`, idempotenza con la variante `intl-it`).

### 2.8 Link Shazam (e Apple Music)
- **Stato**: ingest **implementato** (v2.6.22, in attesa di deploy): `shazamLink.ts` + `ingestShazam` in `linkIngest`. Il download MP3 resta della Fase 1.
- **Prima** i 2 link Shazam condivisi (uno da Telegram, uno da Mondrop, `https://www.shazam.com/track/404798580?referrer=share`) erano entry `other` in errore con 0 canzoni. Quel link è **Bishop Briggs – White Flag** (album Church of Scars).
- **Formati supportati**: `shazam.com/track/<chiave>` (anche con slug e prefisso lingua `/it-it/…`), `/song/<adamId>/<slug>`; spesso con `?referrer=share`. **Non** supportati: `shz.am` (non risolve in DNS) e `/song/<adamId>` senza slug (HTTP 204, slug sbagliato → 404).
- **Cosa espone la pagina** (verificato 2026-11-07): JSON-LD `MusicRecording` di primo livello con titolo, artista, album; `og:image` (800×800) per la copertina; **nessun link Spotify né YouTube** → non si passa da Spooty, serve il percorso «canzone da artista + titolo» (ricerca YouTube + yt-dlp, Fase 1). Gli oggetti dentro `citation[]` sono altri brani: il parser legge solo il primo livello.
- **Trappola scoperta in verifica**: `/track/<chiave>` risponde col redirect `301 → /song/<adamId>/<slug>` solo a uno User-Agent da bot (`SoundReel/2.6 (+https://soundreel.casamon.dev)`); ai browser-like e a `node` risponde `200` con una pagina generica di un ALTRO brano (quel giorno «DtMF – Bad Bunny»). Per questo la prima fixture catturata era sbagliata. Il fetcher verifica che l'URL del JSON-LD coincida con l'URL raggiunto (e, per `/song`, con l'id richiesto), altrimenti errore `mismatch`: entry salvata in errore, mai un brano sbagliato. Fixture reali ridotte in `backend/src/services/__fixtures__/` (pagina giusta + pagina generica da rifiutare).
- **Sicurezza**: solo `shazam.com` / `www.shazam.com` via https, redirect rivalidati a ogni hop (max 4), timeout 12 s, lettura interrotta a fine JSON-LD (~135 KB su ~1 MB).
- **Entry**: `sourcePlatform: 'shazam'` (badge SZ), URL canonico (`/track/<chiave>` o `/song/<id>/<slug>`), canzone `source: 'shazam_link'`, `youtubeUrl` = ricerca, stato `completed` subito; lettura fallita → `error` + action log `shazam_failed`, rimandare il link riprova; le vecchie entry in errore col link grezzo vengono adottate.
- **Estensione naturale**: link Apple Music (`music.apple.com/…?i=<id>`) risolti con la lookup pubblica di iTunes.
- **Test**: parità Telegram = share = web con tre forme del link, lettura fallita, stesso link da due canali (`routes/linkParity.test.ts`); parser/fetcher con fixture reali e mutation check (`shazamLink.test.ts`); ingest (`linkIngest.test.ts`).

### 2.9 Come è stato realizzato (2026-11-07) — scostamenti dal progetto
- **Origine su geekom, replica sul Fritz** (ADR-0006, sostituisce §2.3): i file stanno in `~/Music/SoundReel/` (mount rw `/music/SoundReel`), il Fritz li riceve dal mirror notturno e il backend lo legge **solo via HTTP**. Motivo: il mount persistente richiede un passo `sudo` e un `hard` mount può bloccare il processo se il Fritz dorme. Il passo `/etc/fstab` **non serve più**; `--delete` resta (ora il mirror è l'unico scrittore).
- **Nuovi requisiti di Michele (in corso d'opera):** (1) **primo play**: suona subito (locale se già scaricato, altrimenti stream/YouTube) e scarica in parallelo con priorità `play`; (2) **gestione playlist stile Norton Commander** sul web (due pannelli, filtri per tipo/autore/fonte, aggiungi/rimuovi, playlist condivisibili — la condivisione c'era già nel backend).
- Contratto client: `docs/mondrop-sync.md`. Admin: `GET /api/admin/store`.
- **Niente copie dal Fritz** (caso Kavinsky – Nightcall, 2026-11-07; **supera** la prima versione, che copiava su geekom): un brano che c'è già sul media server **è** il file del Fritz (`source: mediaserver`, nessun file su disco, `media_rel_path` + `media_url` pubblicati subito). Il web lo suona **dal media server** tramite proxy HTTPS con `Range` (anche da internet), Mondrop lo scarica dal telefono in locale; la scelta della sorgente nel player è `Auto`/`Internet`/`Media server` secondo la rete. Un brano che non c'è lo scarica il backend su geekom e un invio su richiesta del `fritz-sync` lo porta sul Fritz. Le copie fatte dalla 2.7.0 vengono ritirate se l'originale risponde con la stessa dimensione. Richieste testuali, decisioni e regole: `2026-11-07-web-player-ux-design.md` (§1, S1–S8, W1–W8); ADR-0010. Nell'interfaccia: badge `FS` / `MS` / `FS+MS` e percorso/URL visibili nel Playlist manager.
- Trovato per strada: la rotta file di Mondrop rispondeva sempre con corpo vuoto (async handler senza `return reply`): ogni download dell'app era un file da 0 byte.

## 3. Fasi, stime e rischi

| Fase | Contenuto | Stima |
|------|-----------|-------|
| **0 — Parità d'ingresso** | `classifyLink` + `ingestLink`, adattatori Telegram/share/web, entry per link Spotify, watcher Spooty (metadati + stato), test di parità; smoke test live con **un** link a traccia scelto da te | 1–1,5 g |
| **1 — Store e link sul media server** (✅ implementata, in attesa di deploy) | `MusicStore`, `song_files`, `media_index` (DLNA), resolver «riuso prima», yt-dlp `/yt/audio`, coda, publisher/outbox, manifest MP3-only con `url` + `mediaUrl`, `prepare`, `/api/mondrop/net`, stato store in admin, sync notturno corretto | 2–3 g (+ il tuo passo fstab) |
| **2 — iOS** (in corso / vedi report) | Sync = `prepare` + download in background (ripresa, solo Wi-Fi, 2 in parallelo), salta già presenti, `mediaUrl` in LAN, avanzamento ed errori per brano, «in preparazione» ricontrollato, Application Support fuori da iCloud, pulizia orfani, ATS + permesso rete locale; compile e test su vulcano | 1,5–2 g |
| **3 — Roadmap** | Navidrome; chiavetta su geekom come media server; **app player su TV LG (webOS)**; Spooty che scrive direttamente nello store; pulizia `._*` | — |

Totale fasi 0–2: **circa 5–7 giorni** di lavoro. Ogni fase chiude con test; **nessun deploy senza il tuo OK**.

**Rischi**
- **YouTube**: Spooty fallisce già sul 12% (403, verifica bot); stesso motore → `yt-dlp` da aggiornare, cookie opzionali, stato `no_source` visibile e override manuale.
- **Versione sbagliata** del brano (live/cover/remix): euristiche + override; falsi positivi del riuso.
- **Fritz/SMB**: scritture singole ok, scansioni no (si usa DLNA + DB); mount che sparisce → outbox su geekom + controllo di salute; handle stantii nei container (`rslave`).
- **Indice DLNA in ritardo**: il Fritz non indicizza subito (>12 min in due test). Conseguenze: TV LG / auto vedono i brani nuovi con ritardo (da misurare; valutare un rescan via TR-064 o impostazioni del Fritz); il riuso vede i file recenti di altri solo dopo la rilettura. Per i file scritti da SoundReel vale `song_files`, non l'indice.
- **exFAT/NTFS**: sanificazione nomi (`\ / : * ? " < > |`).
- **iOS**: permesso «Rete locale» e DNS cifrato possono tagliare il server di casa; HTTP verso il Fritz solo in LAN.
- **Cloudflare** fuori casa: banda in upload di casa; il traffico locale non ci passa.
- **Disco**: ~4 GB per 783 brani, 216 GB liberi: non è un rischio.

## 4. Cosa serve da te
1. Passo `sudo` su `/etc/fstab` per il mount persistente del Fritz (preparo la riga esatta).
2. OK a togliere `--delete` dal sync notturno e a correggere il suo `FAILED`.
3. OK (facoltativo) a ripulire i file `._*` dalla chiavetta: oggi sporcano l'indice del Fritz (≈ metà delle voci).
4. Un link Spotify a traccia singola per lo smoke test live della Fase 0.
5. OK fase per fase; nessun deploy senza il tuo via.

## Idea (2026-11-08): FTP(S) al posto di SMB per la replica e per l'import dal Mac — da misurare

Messaggio di Michele: «l'integrazione al nas si può fare anche via ftp quando la chiavetta è montata che forse è più efficiente di smb.»

**Fatti verificati il 2026-11-08** (senza login, dal geekom):
- Il Fritz ha già un **server FTP acceso sulla porta 21** («220 FTP server ready»). La porta 990 (FTPS implicito) e la 22 (SFTP) sono chiuse.
- `FEAT` dichiara `UTF8`, `MDTM`, `SIZE`, `AUTH TLS`, `PBSZ`, `PROT`: **FTPS esplicito** disponibile (`AUTH TLS` accettato), data e dimensione di ogni file. **Non** dichiara `MLSD` né `REST`: gli elenchi vanno letti con `LIST` e un trasferimento interrotto non si riprende garantito.
- Oggi la replica la scrive `scripts/fritz-sync.sh` con `mount.cifs` + `rsync`; sullo SMB la scansione di migliaia di file è lenta (il controllo dei `._*` ha richiesto molti minuti).

**Dubbi da sciogliere con una misura**, non a intuito: l'FTP può battere lo SMB nei trasferimenti grossi, ma senza `MLSD` l'elenco di 6.000 file e il confronto per data e dimensione (`MDTM`, `SIZE`) potrebbero costare di più. Il Mac import (ADR-0012) oggi usa lo SMB e ne gioverebbe allo stesso modo.

**Piano (quando la chiavetta è montata e pulita):** su una copia di prova sotto `Music/SoundReel/_bench/`, con `lftp` in FTPS contro `rsync` su SMB: (1) elenco dell'albero intero; (2) invio di circa 200 MB in file da 5 MB; (3) una passata senza cambiamenti (il caso della notte). Se l'FTP vince in modo netto si scrive un addendum ad ADR-0006 e si adatta `fritz-sync.sh` (la password dell'utente resta solo nel file credenziali 0600; **FTPS, mai FTP in chiaro**) e il prompt del Mac. Il backend continua a **non** scrivere sul Fritz (ADR-0006): cambia solo il trasporto dello script.

