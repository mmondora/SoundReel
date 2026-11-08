# Mondrop — sync MP3 (contratto API v2)

Spec di riferimento: `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` (§2.4–2.7, Fasi 1–2).
Auth invariata: `X-SoundReel-Key` (+ `X-SoundReel-User` per le key legacy; con una key legata a un utente vince l'utente della key).
Tutte le rotte sono sotto `/api/mondrop/*` (Traefik senza Authelia, come `/api/share`).

## Idea in tre righe

- Il **server** prepara i file (riuso → copia dal Fritz → download yt-dlp) e li tiene su geekom; il **Fritz** ne tiene una replica che serve alla LAN (TV, auto, app in casa).
- Il telefono fa **Sync = `prepare` + download in background**: scarica solo i brani `ready`, salta quelli già presenti con la stessa `version`, in LAN preferisce `mediaUrl`.
- Il manifest è **solo MP3**: niente più `audio.wav` / `video.mp4` delle entry.

## `GET /api/mondrop/playlists/:id/offline` — manifest

```json
{
  "playlistId": "…",
  "name": "Road trip",
  "user": "mike",
  "readyCount": 12,
  "missingCount": 5,
  "preparingCount": 3,
  "failedCount": 1,
  "tracks": [
    {
      "songKey": "bishop briggs::white flag",
      "title": "White Flag",
      "artist": "Bishop Briggs",
      "album": "Church of Scars",
      "genres": ["Alternative"],
      "year": 2018,
      "status": "ready",
      "state": "ready",
      "source": "ytdlp",
      "downloadPath": "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/file",
      "mediaUrl": "http://192.168.178.10:49200/AUDIO/DLNA-1-0/…/White%20Flag.mp3",
      "version": "6291456-1794085004000",
      "bytes": 6291456,
      "durationS": 230,
      "error": null,
      "spotifyUrl": null,
      "entryId": "…",
      "canEnqueueSpooty": false,
      "coverUrl": "https://…/800x800cc.jpg",
      "lyrics": null
    }
  ]
}
```

| Campo | Significato |
|-------|-------------|
| `album` | Album (il nome del provider se noto, altrimenti quello della menzione), o `null`. È il testo su cui si raggruppa e si filtra (ADR-0013) |
| `genres` | Generi **canonici** (il «tipo»: «Alternativa» e «Alternative» sono lo stesso), ordinati; `[]` se ignoti |
| `year` | Anno di uscita (Deezer, data dell'album; altrimenti iTunes), o `null` se ignoto. Il decennio è `year / 10 * 10` (1987 → 1980, «Anni 80») |
| `state` | `ready` (file scaricabile ora) · `preparing` (in coda o in download sul server) · `failed` (errore, ritentabile) · `no_source` (nessuna sorgente trovata, serve un link YouTube) · `missing` (mai richiesto: serve `prepare`) |
| `status` | **Legacy** per le app già installate: `ready` solo se `state == ready`, altrimenti `missing`. Le app nuove usano `state` |
| `source` | `library` (file Spooty) · `ytdlp` · `existing` (il file è del media server, **non copiato** — ADR-0010) · `none` |
| `downloadPath` | Path relativo da anteporre alla base URL del backend; **sempre valido** quando `ready`, con auth. Supporta `Range` |
| `mediaUrl` | URL **assoluto, HTTP, solo LAN**, sul media server (Fritz). Presente solo se il file è stato replicato e verificato. **Mai** mandare qui l'API key |
| `version` | Cambia quando cambia il file (`<bytes>-<mtimeMs>`). Il client non riscarica se ha già quella `version` per quel `songKey` |
| `error` | Motivo breve per `failed` / `no_source` |

`missingCount` = tutto ciò che non è `ready` (compat); `preparingCount` e `failedCount` sono nuovi.
Solo i brani della playlist dell'utente; i `songKey` sconosciuti restano `missing` con `title = songKey`.

## `POST /api/mondrop/playlists/:id/prepare`

Avvia sul server la preparazione di tutti i brani non `ready` della playlist (riuso della libreria Spooty, copia dal Fritz, altrimenti download yt-dlp in coda). **Idempotente, risponde subito** (non aspetta i download). Corpo opzionale `{"retryFailed": true}`: rimette in coda anche `failed` e `no_source`.
Risposta: lo stesso manifest di `GET …/offline` (così il client vede subito gli stati `preparing`).

## `GET /api/mondrop/songs/:songKey`

Un solo brano, **stesso oggetto** `track` del manifest (`state`, `downloadPath`, `mediaUrl`, `version`, `bytes`, `error`, …). Serve al primo play per ricontrollare lo stato. `404` se il brano non è dell'utente.

## `GET /api/mondrop/library` — scegliere cosa suonare

Tutti i brani **che questo utente può vedere** (non solo quelli delle sue playlist), filtrabili, con le voci tra cui scegliere. Serve alla schermata «Libreria» dell'app: suonare **un album, un autore, un tipo, un decennio, un brano** senza passare da una playlist (ADR-0013, spec `2026-11-08-player-selection-and-filters-design.md` X1–X2). Non accoda nulla: solo lettura.

Parametri (tutti opzionali):

| Parametro | Significato |
|-----------|-------------|
| `q` | Testo libero su autore, titolo, album; **l'ordine delle parole non conta**, niente maiuscole/accenti («Maestro Bassi» trova «Bassi Maestro») |
| `genre` | Un tipo; i sinonimi valgono («Alternativa» = «Alternative») |
| `album`, `artist` | Uguaglianza senza maiuscole/accenti/punteggiatura |
| `decade` | `1980` per gli anni 80 (multiplo di 10, 1900–2090), oppure `none` per i brani **senza anno** |
| `limit`, `offset` | Pagina: `limit` 1–500 (default 100), `offset` ≥ 0 |
| `facets` | `0` = non mandare le voci (utile solo per sfogliare le pagine successive) |

I filtri si sommano (AND). I brani sono ordinati per autore, poi titolo. Un parametro malformato dà `400 { "error": "invalid_query", "field": "decade" }`.

```json
{
  "songs": [ { "songKey": "…", "title": "…", "artist": "…", "album": "…", "genres": ["Pop"], "year": 1982, "state": "ready", "version": "…", "plays": 4, "…": "…" } ],
  "total": 214,
  "offset": 0,
  "limit": 100,
  "facets": {
    "genres":  [ { "value": "Pop", "label": "Pop", "count": 61 } ],
    "albums":  [ { "value": "Thriller", "label": "Thriller", "count": 9 } ],
    "artists": [ { "value": "Michael Jackson", "label": "Michael Jackson", "count": 14 } ],
    "decades": [ { "value": 1980, "label": "Anni 80", "count": 52 }, { "value": "none", "label": "Senza anno", "count": 7 } ]
  },
  "user": "mike"
}
```

- `songs` = **lo stesso oggetto `track`** del manifest (stato, `version`, `plays`…), ma **solo per la pagina**: `total` conta tutto ciò che corrisponde.
- Ogni voce delle `facets` conta i brani che corrispondono a **tutti i filtri tranne il proprio**: scegliere un tipo restringe gli album proposti, ma gli altri tipi restano lì per cambiare idea. `value` è ciò che si rimanda come filtro, `label` ciò che si mostra. `genres`/`albums`/`artists`: più brani prima, poi A–Z; `decades`: cronologico, con «Senza anno» (`none`) in fondo, solo se ce ne sono.
- Il risultato, o un singolo elemento scelto, diventa la **coda** del player.

## `POST /api/mondrop/songs/:songKey/download`

Come `prepare` ma per un solo brano. Corpo opzionale `{ "priority": "play" | "sync" }` (default `sync`): `play` **passa davanti a tutta la coda** di Sync (è un brano che l'utente sta aspettando). Idempotente. Risposta `{ "ok": true, "state": "preparing" | "ready" | "failed" | "no_source", "track": { … } }`; `404` se il brano non è dell'utente.

## `PUT /api/mondrop/songs/:songKey/source`

Corpo `{ "youtubeUrl": "https://www.youtube.com/watch?v=…" }`: forza la sorgente di un brano (versione sbagliata o `no_source`) e lo rimette in coda. Risposta `{ "ok": true }`; `400` se l'URL non è YouTube.

## `GET /api/mondrop/net`

`{ "viaCloudflare": false, "home": true }` — `viaCloudflare` è vero se la richiesta è arrivata dal tunnel Cloudflare (header `CF-Ray` / `CF-Connecting-IP`). In casa il DNS split-horizon porta a Traefik direttamente: `home: true`. Serve all'app per scegliere `mediaUrl` (solo `home`) e alle Impostazioni («Rete: casa / internet»).

## `GET /api/mondrop/songs/:songKey/file`

MP3 con `Range` (`206`), `Accept-Ranges`, `Content-Length`, `ETag: "<version>"`. `404` JSON se il file non c'è (mai un redirect HTML).

## Primo play: riproduci subito e scarica in parallelo

Regola unica per tutti i client. Se il brano è **già scaricato** (sul device, o sul server per il web) si riproduce **il file locale**. Se no: si riproduce subito in streaming e **in parallelo** lo si scarica, così le volte successive è locale.

- Server pronto (`state == ready`): stream da `mediaUrl` (solo LAN) o da `downloadPath` (con `Range`) + download in background sul device.
- Server non pronto: `POST …/songs/:songKey/download` con `{"priority":"play"}`, poi `GET …/songs/:songKey` ogni ~2 s fino a `ready` (di solito 10–30 s: ricerca YouTube + conversione) e solo allora stream + download. Su iOS si mostra «Preparo il brano…» (non esiste un ripiego YouTube nell'app); il **web** ha il ripiego YouTube immediato e intanto manda lo stesso `POST`.
- Web (auth `Remote-User` come le altre rotte `/api/songs`): `POST /api/songs/:songKey/download` (corpo `{ "priority": "play" }`) e `GET /api/songs/:songKey/state` → `{ "state": "ready" | "preparing" | "failed" | "no_source" | "missing", "source": …, "version": …, "bytes": …, "error": …, "inLibrary": bool }`. `GET /api/songs/:songKey/file` serve il file dallo store quando `state == ready`.

## Algoritmo del client (Fase 2)

1. `GET /net` → `home`.
2. `POST …/prepare` → manifest. Per ogni `ready` con `version` diversa da quella locale: scarica in background (Wi-Fi, max 2 in parallelo, ripresa). URL = `home && mediaUrl != nil ? mediaUrl : base + downloadPath`; con `downloadPath` si mandano i due header di auth, con `mediaUrl` **nessun** header. Se `mediaUrl` fallisce (rete locale negata, timeout, non 2xx) → un secondo tentativo con `downloadPath`.
3. Se ci sono `preparing`: rilegge il manifest ogni ~5 s in foreground (max ~10 min) e scarica i nuovi `ready`; il pulsante Sync è ripetibile (idempotente).
4. Stato per brano nell'interfaccia: `preparing` · `in coda` · `scarico NN %` · `scaricato` · `errore` (con il motivo) · `no_source`.
5. File in `Application Support` (escluso da iCloud), indice in JSON; brani non più in nessuna playlist sincronizzata = orfani, rimossi solo su richiesta esplicita.

## Compatibilità

Le app già installate decodificano il manifest con i soli campi vecchi: `status` resta `ready`/`missing`, `source` non vale più `entry_*`, tutti i campi nuovi (`album`, `genres`, `year` compresi) sono opzionali lato client. `POST /api/mondrop/songs/:songKey/spooty` resta com'è.
