# Mondrop — sync MP3 (contratto API v2)

Spec di riferimento: `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` (§2.4–2.7, Fasi 1–2). Dalla 2.13.0 anche la **ricerca unica** e la **regola P** (l'app parla solo con SoundReel): `docs/superpowers/specs/2026-11-08-mondrop-search-spotify-style-design.md`, ADR-0018.
Auth invariata: `X-SoundReel-Key` (+ `X-SoundReel-User` per le key legacy; con una key legata a un utente vince l'utente della key).
Tutte le rotte sono sotto `/api/mondrop/*` (Traefik senza Authelia, come `/api/share`).

## Idea in quattro righe

- Il **server** prepara i file (riuso → copia dal Fritz → download yt-dlp) e li tiene su geekom; il **Fritz** ne tiene una replica che serve alla LAN (TV, auto).
- Il telefono fa **Sync = `prepare` + download in background**: scarica solo i brani `ready`, salta quelli già presenti con la stessa `version`, sempre da `downloadPath`.
- Il manifest è **solo MP3**: niente più `audio.wav` / `video.mp4` delle entry.
- **Regola P (ADR-0018):** l'app parla **sempre e solo con SoundReel**. Quanti elenchi o «negozi» ci siano (diario, libreria di geekom, NAS), dove stia un file e da dove si legga sono **del server**: nessuna risposta dice in quale negozio sta un brano e l'app non ha un percorso diretto verso il media server.

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
      "mediaUrl": null,
      "version": "6291456-1794085004000",
      "bytes": 6291456,
      "durationS": 230,
      "error": null,
      "spotifyUrl": null,
      "entryId": "…",
      "canEnqueueSpooty": false,
      "coverUrl": "https://…/800x800cc.jpg",
      "coverPath": "/api/mondrop/songs/bishop%20briggs%3A%3Awhite%20flag/cover",
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
| `mediaUrl` | **Sempre `null` dalla 2.13.0** (regola P, ADR-0018): l'app non parla col media server, solo con SoundReel. Il campo resta nel contratto per le app già installate (1.6.0 e precedenti), che con `null` scaricano da `downloadPath`: per un brano `ready` è sempre valido. **Mai** mandare qui l'API key |
| `coverPath` | **Dalla 2.14.0** (ADR-0019): percorso relativo, come `downloadPath`, per chiedere la copertina del brano (`GET`, con la key): vedi sotto. È presente su ogni traccia e **non dice se una copertina esiste** (la risposta può essere `404`). `coverUrl`, l'indirizzo del fornitore quando il diario lo conosce, resta per le app già installate; una app nuova usa `coverPath` e non parla con iTunes o Deezer |
| `version` | Cambia quando cambia il file (`<bytes>-<mtimeMs>`). Il client non riscarica se ha già quella `version` per quel `songKey` |
| `error` | Motivo breve per `failed` / `no_source` |

`missingCount` = tutto ciò che non è `ready` (compat); `preparingCount` e `failedCount` sono nuovi.
Solo i brani della playlist dell'utente; i `songKey` sconosciuti restano `missing` con `title = songKey`.

**Brani che esistono solo come file** (la musica del NAS o della libreria di geekom, mai salvata da un post: ADR-0018): stesso oggetto `track`, con `entryId` e `spotifyUrl` `null` e `canEnqueueSpooty` `false`. Il server li serve **solo se il file c'è** (`state: ready`, altrimenti `missing` con `error: "file non più presente"`) e **non li scarica mai da YouTube**: nessun `song_files`, nessuna voce nel diario. Una playlist li tiene come qualunque brano (tiene `songKey`).

## `POST /api/mondrop/playlists/:id/prepare`

Avvia sul server la preparazione di tutti i brani non `ready` della playlist (riuso della libreria Spooty, copia dal Fritz, altrimenti download yt-dlp in coda). **Idempotente, risponde subito** (non aspetta i download). Corpo opzionale `{"retryFailed": true}`: rimette in coda anche `failed` e `no_source`.
Risposta: lo stesso manifest di `GET …/offline` (così il client vede subito gli stati `preparing`).

## `GET /api/mondrop/songs/:songKey`

Un solo brano, **stesso oggetto** `track` del manifest (`state`, `downloadPath`, `mediaUrl`, `version`, `bytes`, `error`, …). Serve al primo play per ricontrollare lo stato. `404` se il brano non è dell'utente e nessun file della libreria o del NAS ha quella chiave.

## `GET /api/mondrop/search` — Cerca, come su Spotify

Una sola ricerca su **tutto ciò che si può suonare**, con la risposta data dal **server** (ADR-0018, spec `2026-11-08-mondrop-search-spotify-style-design.md`, regola P): il **diario** dell'utente (ciò che viene dai post e dai link), i **file della libreria di geekom** e il **catalogo del NAS**. **Non serve una playlist e non serve che il brano sia nel diario**: «Bassi Maestro» si trova anche se nessuno ha mai salvato un suo post. Solo lettura: non accoda e non scarica nulla.

| Parametro | Significato |
|-----------|-------------|
| `q` | Testo libero su autore, titolo, album (e, per i brani del diario, i tag); **l'ordine delle parole non conta**, niente maiuscole/accenti («Maestro Bassi» trova «Bassi Maestro») |
| `artist`, `album` | Restringono ai brani di quell'autore (conta **ogni** nome accreditato: «Hell Raton, Ensi & Bassi Maestro» è anche di Bassi Maestro) o di quell'album: sono le pagine autore e album. Uguaglianza senza maiuscole/accenti/punteggiatura |
| `limit`, `offset` | Pagina dei **brani**: `limit` 1–200 (default 30), `offset` ≥ 0 |
| `sections` | `1` (default): manda anche `artists` e `albums`; `0`: solo i brani (per sfogliare le pagine successive) |

Senza `q`, `artist` né `album`: `400 { "error": "invalid_query", "field": "q" }` (la ricerca vuota non elenca tutta la musica). Un numero o un valore malformato: `400` con `field` = `limit`, `offset` o `sections`.

```json
{
  "q": "bassi maestro",
  "tracks": [ { "songKey": "bassi maestro::foto di gruppo", "title": "Foto di gruppo", "artist": "Bassi Maestro", "album": "Foto di gruppo", "genres": [], "year": null, "state": "ready", "downloadPath": "/api/mondrop/songs/…/file", "mediaUrl": null, "version": "…", "plays": 0, "…": "…" } ],
  "artists": [ { "name": "Bassi Maestro", "tracks": 45 } ],
  "albums":  [ { "title": "Mia maestà", "artist": "Bassi Maestro", "tracks": 14 } ],
  "total": 45,
  "offset": 0,
  "limit": 30,
  "user": "mike"
}
```

- `tracks` = **lo stesso oggetto `track`** del manifest, ma solo per la pagina; `total` conta **tutti** i brani trovati. Ordine: prima i brani con le parole nell'autore o nel titolo, poi quelli che le hanno solo nell'album (o nei tag, o nelle cartelle); a parità, autore e titolo A–Z.
- **Una canzone = una riga**, non un file. La stessa registrazione è spesso più volte con grafie diverse (l'originale del NAS ha il tag dell'album e «Bassi Maestro», l'import dal Mac dice «Bassi Maestro feat. Ape & Zampa», la copia fatta dal nome del file «Bassi Maestro, Ape, Zampa»; «S.I.C» e «S.I.C.»; «King's» e «King’s»). Le voci si **raggruppano** se hanno lo stesso titolo (senza maiuscole, accenti, punteggiatura né un «(feat. X)» finale) e **almeno un artista accreditato in comune** (i nomi si separano su virgola, `;`, `feat.` / `ft.` / `featuring`, « x » e « vs »; **non** su `&`: «Simon & Garfunkel» è un nome; «Various Artists» e simili non contano). Una **versione** («(Instrumental)», «(2019 Remastered)») ha un altro titolo e resta una canzone a sé. L'identità resta la `songKey` (playlist, file, ascolti): il raggruppamento è solo come la ricerca le mostra.
- **Il gruppo è mostrato sempre con la stessa voce**, qualunque parola si scriva (così «già sul telefono» non cambia): quella del diario se c'è (sa di più), altrimenti quella con un file sul disco di geekom, altrimenti la più completa; nella pagina di un album, la voce che è su quell'album. L'album mostrato è il **tag** del file del NAS quando c'è; il nome di una cartella di geekom (una playlist di Spooty, non un album) solo in mancanza di meglio. `artists` e `albums` contano **canzoni**, non file. Si cerca anche nelle cartelle del file, non nelle radici comuni («Music», «SoundReel», «_MacMusic») né nell'estensione.
- `artists`: i nomi accreditati che corrispondono a ciò che si è scritto, con quanti brani trovati (al massimo 6; assenti con `artist=`). `albums`: da dove vengono **tutti** i brani trovati, sotto il primo autore accreditato (al massimo 6; 60 nella pagina di un autore; assenti con `album=`).
- **Nessun campo dice in quale «negozio» sta il file** (diario, geekom, NAS): è del server. L'app mostra solo «sul telefono» o «su SoundReel».
- Un brano che esiste **solo come file** si suona e si scarica come gli altri (vedi sopra): il server **non lo scarica mai da YouTube** e non crea nessuna voce nel diario.
- Il catalogo del NAS si riempie dopo l'avvio e si rinnova ogni ora: finché è vuoto (o la chiavetta è scollegata) la ricerca risponde con ciò che c'è, senza errore.

## `POST /api/mondrop/playlists/:id/songs` — aggiungere un brano a una playlist

Corpo `{ "songKey": "…" }`: mette il brano in coda alla playlist. **Solo le playlist statiche dell'utente della key** (`canEdit: true` in `GET /playlists`): una playlist condivisa con lui è in sola lettura (`404`, come ogni playlist non sua), una dinamica è una regola (`409 { "error": "playlist_is_dynamic" }`). Il brano può essere anche solo un file (ADR-0018): la playlist tiene `songKey`, non voci del diario. Idempotente: un brano già presente resta dov'è.
Risposta: `{ "ok": true, "playlist": { "id": "…", "name": "…", "songs": 12 }, "user": "mike" }`. Errori: `400` se manca `songKey` (testo, al massimo 500 caratteri); `404 { "error": "song not found" }` se nessuno conosce quel brano (né il diario né un file); `404 { "error": "playlist not found" }`.

## `GET /api/mondrop/library` — scegliere cosa suonare

Tutti i brani **che questo utente può vedere** (non solo quelli delle sue playlist), filtrabili, con le voci tra cui scegliere. Serve alla schermata «Libreria» dell'app: suonare **un album, un autore, un tipo, un decennio, un brano** senza passare da una playlist (ADR-0013, spec `2026-11-08-player-selection-and-filters-design.md` X1–X2). Non accoda nulla: solo lettura. **Dalla 2.13.0 l'app usa `GET /search`** (che cerca anche nei file di geekom e del NAS, e non solo nel diario); questa rotta resta per le app già installate.

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

Come `prepare` ma per un solo brano. Corpo opzionale `{ "priority": "play" | "sync" }` (default `sync`): `play` **passa davanti a tutta la coda** di Sync (è un brano che l'utente sta aspettando). Idempotente. Risposta `{ "ok": true, "state": "preparing" | "ready" | "failed" | "no_source", "track": { … } }`; `404` se il brano non è dell'utente. Per un brano che esiste **solo come file** risponde `ready` (o `missing` se il file non c'è) e **non mette in coda nulla**.

## `PUT /api/mondrop/songs/:songKey/source`

Corpo `{ "youtubeUrl": "https://www.youtube.com/watch?v=…" }`: forza la sorgente di un brano (versione sbagliata o `no_source`) e lo rimette in coda. Risposta `{ "ok": true }`; `400 { "ok": false, "error": "bad_url" }` se l'URL non è YouTube; `400 { "ok": false, "error": "library_only" }` per un brano che esiste solo come file (non ha una sorgente YouTube da cambiare); `404` se il brano non esiste.

## `GET /api/mondrop/net`

`{ "viaCloudflare": false, "home": true }` — `viaCloudflare` è vero se la richiesta è arrivata dal tunnel Cloudflare (header `CF-Ray` / `CF-Connecting-IP`). In casa il DNS split-horizon porta a Traefik direttamente: `home: true`. **Solo informativa dalla 2.13.0**: serve alle Impostazioni («Rete: casa / internet»). L'app **non** sceglie più la sorgente in base alla rete (regola P): scarica e suona sempre da `downloadPath`.

## `GET /api/mondrop/songs/:songKey/file`

MP3 con `Range` (`206`), `Accept-Ranges`, `Content-Length`, `ETag: "<version>"`. `404` JSON se il file non c'è (mai un redirect HTML). **Da dove** il server legga il file (disco di geekom, media server) lo decide il server (`songStream.ts`): il client non lo sa e non lo sceglie.

## `GET /api/mondrop/songs/:songKey/cover` — la copertina

L'immagine della copertina (JPEG quadrata, al massimo 800×800) di un brano che l'utente può suonare. La **trova il server** (ADR-0019, spec `2026-11-08-player-cover-art-design.md`) e l'app chiede solo qui (regola P): non va mai da iTunes o Deezer. In ordine: la copertina che il diario già conosce, quella **dentro il file** MP3 (se è quasi quadrata **e di almeno 300 px**: i programmi di download scrivono in ogni file una foto dell'artista da 160 px, che non è una copertina), **Internet** (iTunes, poi Deezer, solo con un riscontro forte di artista e titolo: meglio nessuna copertina di una sbagliata), quella del file comunque (piccola, o ritagliata), la miniatura del video da cui il brano è stato scaricato. Il server la **tiene** su disco e ricorda «non c'è» per 3 giorni: la prima richiesta di un brano nuovo può metterci qualche secondo (la ricerca su Internet), le successive no.

- `200`, `Content-Type: image/jpeg`, `ETag` e `Cache-Control: private, max-age=86400`; con `If-None-Match` uguale all'`ETag` → `304` senza corpo.
- `404 { "error": "no cover" }` se nessuna fonte ne ha una (l'app disegna la sua copertina); `404 { "error": "song not found" }` se il brano non esiste per l'utente, né nel diario né come file.
- Funziona anche per un brano che esiste **solo come file** (NAS, geekom): la copertina dentro il file si legge dal disco di geekom, o dal media server con due letture `Range` all'inizio del file (mai tutto il brano).
- L'app **tiene sul telefono** le copertine viste: un brano scaricato mostra la sua anche offline.

## Primo play: riproduci subito e scarica in parallelo

Regola unica per tutti i client. Se il brano è **già scaricato** (sul device, o sul server per il web) si riproduce **il file locale**. Se no: si riproduce subito in streaming e **in parallelo** lo si scarica, così le volte successive è locale.

- Server pronto (`state == ready`): stream da `downloadPath` (con `Range`) + download in background sul device.
- Server non pronto: `POST …/songs/:songKey/download` con `{"priority":"play"}`, poi `GET …/songs/:songKey` ogni ~2 s fino a `ready` (di solito 10–30 s: ricerca YouTube + conversione) e solo allora stream + download. Su iOS si mostra «Preparo il brano…» (non esiste un ripiego YouTube nell'app); il **web** ha il ripiego YouTube immediato e intanto manda lo stesso `POST`.
- Web (auth `Remote-User` come le altre rotte `/api/songs`): `POST /api/songs/:songKey/download` (corpo `{ "priority": "play" }`) e `GET /api/songs/:songKey/state` → `{ "state": "ready" | "preparing" | "failed" | "no_source" | "missing", "source": …, "version": …, "bytes": …, "error": …, "inLibrary": bool }`. `GET /api/songs/:songKey/file` serve il file dallo store quando `state == ready`.

## Algoritmo del client (Fase 2)

1. (Facoltativo, solo da mostrare) `GET /net` → `home`: non influisce su nessun percorso (regola P).
2. `POST …/prepare` → manifest. Per ogni `ready` con `version` diversa da quella locale: scarica in background (Wi-Fi, max 2 in parallelo, ripresa). URL = `base + downloadPath`, con i due header di auth; **nessun altro indirizzo** (`mediaUrl` è `null` e un client non lo usa). Se fallisce → ritenta con attesa crescente.
3. Se ci sono `preparing`: rilegge il manifest ogni ~5 s in foreground (max ~10 min) e scarica i nuovi `ready`; il pulsante Sync è ripetibile (idempotente).
4. Stato per brano nell'interfaccia: `preparing` · `in coda` · `scarico NN %` · `scaricato` · `errore` (con il motivo) · `no_source`.
5. File in `Application Support` (escluso da iCloud), indice in JSON; brani non più in nessuna playlist sincronizzata = orfani, rimossi solo su richiesta esplicita.

## Compatibilità

Le app già installate decodificano il manifest con i soli campi vecchi: `status` resta `ready`/`missing`, `source` non vale più `entry_*`, tutti i campi nuovi (`album`, `genres`, `year` compresi) sono opzionali lato client. Dalla 2.13.0 `mediaUrl` è `null`: le app 1.6.0 e precedenti, che in casa preferivano `mediaUrl`, ripiegano da sole su `downloadPath` (nessuna modifica lato app). `POST /api/mondrop/songs/:songKey/spooty` resta com'è.
