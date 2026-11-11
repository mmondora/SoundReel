# Mondrop — sync MP3 (contratto API v2)

Spec di riferimento: `docs/superpowers/specs/2026-11-07-mp3-store-media-server-design.md` (§2.4–2.7, Fasi 1–2). Dalla 2.13.0 anche la **ricerca unica** e la **regola P** (l'app parla solo con SoundReel): `docs/superpowers/specs/2026-11-08-mondrop-search-spotify-style-design.md`, ADR-0018.
Auth invariata: `X-SoundReel-Key` (+ `X-SoundReel-User` per le key legacy; con una key legata a un utente vince l'utente della key).
Tutte le rotte sono sotto `/api/mondrop/*` (Traefik senza Authelia, come `/api/share`).

## Idea in quattro righe

- Il **server** prepara i file (riuso → copia dal Fritz → download yt-dlp) e li tiene su geekom; il **Fritz** ne tiene una replica che serve alla LAN (TV, auto).
- Il telefono fa **Sync = `prepare` + download in background**: scarica solo i brani `ready`, salta quelli già presenti con la stessa `version`, sempre da `downloadPath`.
- Il manifest è **solo MP3**: niente più `audio.wav` / `video.mp4` delle entry.
- **Regola P (ADR-0018):** l'app parla **sempre e solo con SoundReel**. Quanti elenchi o «negozi» ci siano (diario, libreria di geekom, NAS), dove stia un file e da dove si legga sono **del server**: nessuna risposta dice in quale negozio sta un brano e l'app non ha un percorso diretto verso il media server.

## `GET /api/mondrop/playlists` — l'elenco, che si cerca, si ordina e si sfoglia (2.20.0, ADR-0023)

Richiesta di Michele (10 novembre): «Se le play list diventano molte devo poterle selezionare/paginare/cercare, e di fianco al nome la data di creazione e un ordine di data. questo anche su mondrop.» **Regola P:** cercare, filtrare, ordinare e tagliare in pagine lo fa il **server**; l'app chiede una pagina e disegna.

`GET /api/mondrop/playlists?q&filter&sort&order&limit&offset` (stessi parametri di `GET /api/playlists` del sito):

| Parametro | Valori | Se manca |
|---|---|---|
| `q` | parole nel **nome**, in qualunque ordine, senza maiuscole né accenti (massimo 100 caratteri) | nessuna ricerca |
| `filter` | `all`, `auto` (fatte dal server), `mine`, `shared` (condivise con l'utente della key), `dynamic` | `all` |
| `sort` | `created` (data di creazione), `updated` (ultima modifica), `name`, `size` (numero di brani) | `updated` |
| `order` | `asc`, `desc` | per `name` `asc`, per gli altri `desc` |
| `limit` | intero ≥ 1, **massimo 100** (di più si taglia a 100) | **nessuna pagina**: tutte |
| `offset` | intero ≥ 0 | 0 |

```json
{ "playlists": [ { "id": "…", "name": "Jazz da ascoltare", "songCount": 12, "createdAt": "2026-11-09T10:00:00.000Z", "updatedAt": "…",
                   "kind": "static", "canEdit": true, "origin": "auto", "autoKind": "theme" } ],
  "user": "mike", "total": 41, "limit": 30, "offset": 0 }
```

- `total` = quante playlist rispondono a `q` e `filter`, **prima** di tagliare la pagina; `limit` è `null` quando non si è chiesta una pagina.
- `origin` è `auto` per le playlist fatte dal server da un post che parla di musica (nessun campo per quelle a mano) e `autoKind` dice come: `one_off` (una per post) o `theme` (una sola per tema generico, con i brani nuovi in cima). **Sono playlist statiche normali**: si scaricano, si ascoltano, si cambiano come le altre.
- Un valore che non è tra quelli noti (`sort=banana`, `limit=0`, `offset=-1`…) è un **`400 { "error": "…" }`** che nomina il parametro, mai un elenco sbagliato. Con una key mancante resta `401` prima di tutto.
- Ordine di pari merito: la più nuova per prima, poi per nome. Le playlist dinamiche portano il conteggio **di adesso** (si risolvono prima di tagliare, così `sort=size` le vede).
- **Compatibile:** senza nessuno dei sei parametri la risposta è quella di prima (tutte, per ultima modifica) con in più `total`. Le app fino alla build 11 la chiamano così e non cambiano; la build 12 chiede le pagine.

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
| `lyrics` | Solo nei manifest delle playlist e in `GET /api/mondrop/songs/:key` (le liste portano `null`): la **trascrizione del post se è una vera** (almeno **100 caratteri**), altrimenti `null` — un frammento non è un testo (spec L12). L'app la mostra subito ma chiede comunque la rotta dei testi (sotto): è il server che decide quali sono le parole del brano |
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
| `addedAt` | **Dalla 2.26.0** (spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` §12 U19, ADR-0031): quando il brano è entrato **in questa playlist** (ISO, UTC, da `playlist_songs.added_at`). Solo nel manifest di una playlist statica o automatica e nella risposta di `prepare`; **assente** (mai `null`) per una playlist dinamica — la decide la regola —, per le liste della libreria, di Cerca e della Home e per `GET /api/mondrop/songs/:key`. Un guasto nel leggere le date costa solo le date. Mondrop ci ordina i brani di una playlist per «Data di aggiunta» e offre la voce solo se qualche brano ha la data; un'app che non lo conosce legge il brano come prima |

`missingCount` = tutto ciò che non è `ready` (compat); `preparingCount` e `failedCount` sono nuovi.
Solo i brani della playlist dell'utente; i `songKey` sconosciuti restano `missing` con `title = songKey`.

**Brani che esistono solo come file** (la musica del NAS o della libreria di geekom, mai salvata da un post: ADR-0018): stesso oggetto `track`, con `entryId` e `spotifyUrl` `null` e `canEnqueueSpooty` `false`. Il server li serve **solo se il file c'è** (`state: ready`, altrimenti `missing` con `error: "file non più presente"`) e **non li scarica mai da YouTube**: nessun `song_files`, nessuna voce nel diario. Una playlist li tiene come qualunque brano (tiene `songKey`).

## `POST /api/mondrop/playlists/:id/prepare`

Avvia sul server la preparazione di tutti i brani non `ready` della playlist (riuso della libreria Spooty, copia dal Fritz, altrimenti download yt-dlp in coda). **Idempotente, risponde subito** (non aspetta i download). Corpo opzionale `{"retryFailed": true}`: rimette in coda anche `failed` e `no_source`.
Risposta: lo stesso manifest di `GET …/offline` (così il client vede subito gli stati `preparing`).

## `GET /api/mondrop/songs/:songKey`

Un solo brano, **stesso oggetto** `track` del manifest (`state`, `downloadPath`, `mediaUrl`, `version`, `bytes`, `error`, …). Serve al primo play per ricontrollare lo stato. `404` se il brano non è dell'utente e nessun file della libreria o del NAS ha quella chiave.

## `GET /api/mondrop/home` — la Home

La prima schermata dell'app, **già decisa dal server** (ADR-0020, spec `2026-11-08-mondrop-home-spotify-design.md`, regola P): quali sezioni ci sono, in che ordine, con che titolo e con quali brani. L'app disegna ciò che riceve e non calcola niente (non monta «recenti» o «nuovi» da playlist e statistiche); una sezione di un tipo che non conosce la ignora. Sola lettura: non mette in coda niente e non registra niente. Tocca **solo** i dati dell'utente della key. Nessun parametro.

```json
{
  "user": "mike",
  "displayName": "Michele",
  "sections": [
    { "id": "playlists", "title": "Le tue playlist", "kind": "playlists",
      "playlists": [ { "id": "…", "name": "Road trip", "songCount": 7, "kind": "static", "ruleSummary": null, "canEdit": true,
                       "createdAt": "…", "updatedAt": "…", "coverKeys": ["artista::titolo", "…"] } ] },
    { "id": "recent", "title": "Ascoltati di recente", "kind": "tracks", "tracks": [ { "songKey": "…", "title": "…", "state": "ready", "coverPath": "/api/mondrop/songs/…/cover", "mediaUrl": null, "…": "…" } ] },
    { "id": "fresh",  "title": "Nuovi dai tuoi reel",  "kind": "tracks", "tracks": [ … ] }
  ]
}
```

- `displayName`: il nome con cui salutare (Michele, Archimede, Sara), o `null` per un utente che il server non conosce (l'app saluta senza nome). Il saluto («Buongiorno», «Buon pomeriggio», «Buonasera») lo sceglie l'app dall'ora del telefono.
- `kind`: `playlists` (una carta per playlist) o `tracks` (una fila di brani); un `kind` nuovo è ignorato dalle app vecchie. Una sezione senza niente **non viene mandata**.
- **Sezioni di oggi, in quest'ordine:** `playlists` (al massimo 12, la modificata per ultima per prima, anche dinamiche e condivise, **senza quelle vuote**; `coverKeys` = fino a 4 chiavi di brano per il mosaico della copertina, che l'app chiede come sempre con `GET …/songs/:key/cover`; `canEdit` come in `GET /playlists`) · `recent` (fino a 20 brani **diversi**, dal più recente, solo ascolti che contano — un salto non è ascoltare —; un brano che non esiste più né nel diario né come file è saltato, non lasciato come buco) · `fresh` (fino a 20 brani del diario, dal post più recente che li menziona, che questo utente **non ha mai ascoltato**).
- `tracks` = **lo stesso oggetto `track`** del manifest e di Cerca (stato, `downloadPath`, `coverPath`, `plays`…); **`mediaUrl` è sempre `null`** e nessun campo nomina un negozio (regola P: la Home non dice dov'è un file).
- Il guasto di **una** sezione costa solo quella sezione (il resto risponde; l'errore va nel log del server). Se non si riesce a costruire niente: `500 { "error": "home failed" }`; senza key valida `401`.
- **«Riprendi» non c'è nella risposta:** è la coda dell'app, che il telefono salva e al lancio ricarica **ferma** (il play non parte mai da solo).
- Un server più vecchio risponde `404`: l'app mostra «Non riesco a caricare la Home» con «Riprova», il campo di ricerca, «Riprendi» e il percorso per «Brani sul telefono».

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

## `DELETE /api/mondrop/playlists/:id/songs/:songKey` — togliere un brano da una playlist (2.25.0)

Il gemello del `POST` (il gesto «Togli dalla playlist» dell'app, spec `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md` U7): oggi l'app sapeva solo **aggiungere**. Senza corpo; `:songKey` è la chiave **percent-encoded** nel percorso e il server la riceve **già decodificata una volta sola** (un `%` dentro la chiave non si decodifica di nuovo: `100% pure::love` e `ac%41dc::back in black` arrivano come sono). **Solo le playlist statiche dell'utente della key**, come il `POST`: una playlist non sua o solo condivisa con lui è in sola lettura (`404 { "error": "playlist not found" }`), una dinamica è una regola (`409 { "error": "playlist_is_dynamic" }`). L'utente è **solo** quello della key (non la query, non le intestazioni). **Idempotente:** un brano che non c'è (o che non esiste più da nessuna parte: una playlist può tenere una chiave vecchia e la persona deve poterla togliere) non è un errore, la risposta è la stessa `200`.
Risposta: `{ "ok": true, "playlist": { "id": "…", "name": "…", "songs": 11 }, "user": "mike" }` (`songs` = quanti brani restano). Errori: `401` prima di tutto; `400 { "error": "songKey is required" }` se la chiave è vuota (dopo il `trim`) o più lunga di 500 caratteri (lo stesso limite del `POST`; il router del server accetta nel percorso una chiave di quella lunghezza, fino a 4500 caratteri una volta codificata); `404 { "error": "playlist not found" }`; `409 { "error": "playlist_is_dynamic" }`; `500 { "ok": false, "error": "playlist remove song failed" }` (la causa solo nel log). Nel registro delle attività scrive una riga `playlist / remove_song` («… ha tolto «Titolo – Artista» dalla playlist «…»») come fa il `POST` con `add_song`; il sito ha già lo stesso gesto dietro Authelia (`DELETE /api/playlists/:id/songs/:songKey`).

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

## `GET /api/mondrop/songs/:songKey/lyrics` — le parole

Le parole di un brano, date dal **server** (ADR-0021, spec `2026-11-08-lyrics-from-the-internet-design.md`, regola P): la **trascrizione del post** se c'è, altrimenti quelle **trovate su Internet** e tenute. L'app chiede solo qui: non parla mai con un archivio di testi. Sola lettura; vale per ogni brano che l'utente può suonare, anche solo-file.

```json
{ "songKey": "…", "lyrics": "testo…", "source": "transcript", "instrumental": false }
```

- `source`: `transcript` (il post) o `internet` (cercato dal server). `instrumental: true` = il brano è strumentale: `lyrics` è `""` e l'app dice «Brano strumentale».
- `404 { "error": "song not found" }` se nessuno conosce il brano; `404 { "error": "no lyrics" }` se non c'è niente; `500 { "error": "lyrics failed" }`; senza key valida `401`. `Cache-Control: private, max-age=86400`.
- **Internet solo quando il testo manca**: una trascrizione **vera** (almeno **100 caratteri**) non si sostituisce. Sotto i 100 caratteri è un **frammento** di ciò che Whisper ha sentito (spec L12, Michele: «Proposta accettata»): conta come «testo che manca», si cerca su Internet e, **se non si trova niente** (o la ricerca è spenta, o non risponde), **resta il frammento** (`source: "transcript"`); uno strumentale trovato su Internet batte il frammento; tra le prime tre voci del diario che citano il brano vale la prima trascrizione vera. Si accetta **solo un riscontro forte** (stesso titolo senza i segni tra parentesi o dopo un trattino, e un autore accreditato in comune; senza autore non si cerca): meglio nessun testo che quello di un'altra canzone. Un brano che è una **versione** (Speed, Slowed + Reverb, Remix…) senza testo suo ripiega sull'originale, tranne Instrumental e Karaoke.
- Il testo trovato **resta** (tabella `song_lyrics`); «non c'è» si ricorda **7 giorni**; un guasto dell'archivio non si ricorda. Le richieste all'archivio (LRCLIB; esce solo autore e titolo) sono distanziate di almeno un secondo. `LYRICS_ONLINE=0` spegne la ricerca su Internet.
- Le liste (`/library`, `/search`, `/home`) **non portano i testi**: l'app li chiede qui quando parte un brano che non ha un testo **scritto dall'utente** (mostra intanto la trascrizione che il sync le ha dato, se ce l'ha: offline resta quella). Sul telefono tiene **solo i testi trovati su Internet e gli strumentali** (anche offline); le risposte «trascrizione» le richiede ogni volta, perché possono essere un frammento e il server avrà un testo quando l'Internet ce l'ha. Ricorda «nessun testo» per un giorno. La soglia dei 100 caratteri sta **solo nel server** (regola P: l'app non conta caratteri).

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
