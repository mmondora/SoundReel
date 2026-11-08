# Mondrop — statistiche di ascolto, spazio, playlist dinamiche (contratto v1)

Estende `docs/mondrop-sync.md`. Spec e decisioni: `docs/superpowers/specs/2026-11-07-listening-stats-dynamic-playlists-design.md`.
Auth come il resto di `/api/mondrop/*` (`X-SoundReel-Key`, utente e dispositivo vengono dalla key). Il web usa le rotte `/api/*` con `Remote-User`.

## 1. Eventi di ascolto

Il client registra **fatti grezzi** e li spedisce a lotti; è il server a decidere cosa conta come «ascolto», così le soglie si cambiano senza aggiornare l'app.

```json
POST /api/mondrop/plays
{ "events": [
  { "id": "6F1C2D6E-…", "songKey": "bishop briggs::white flag",
    "startedAt": "2026-11-08T06:12:03Z", "tzOffsetMin": 60,
    "listenedMs": 183000, "durationMs": 231000, "completed": true,
    "origin": "local", "playlistId": "p1" } ] }
→ { "accepted": 1, "duplicates": 0, "rejected": [] }
```

| Campo | Regola |
|-------|--------|
| `id` | UUID generato dal client: rispedire lo stesso evento è sicuro (idempotente) |
| `startedAt` | ISO 8601 UTC, istante in cui è partito il brano (tra −400 giorni e +1 giorno da ora) |
| `tzOffsetMin` | minuti a est di UTC **al momento dell'ascolto** (es. `60` inverno in Italia, `120` estate): serve alle fasce orarie («7–8 di mattina») |
| `listenedMs` | millisecondi **effettivamente ascoltati** (non la posizione finale: seek e pause non contano), 0…86 400 000 |
| `durationMs` | durata del brano se nota, altrimenti `null` |
| `completed` | arrivato alla fine |
| `origin` | `local` (file sul telefono) · `stream` (dal server) · `web` |
| `playlistId` | playlist da cui è partito, o `null` |

- Max **500 eventi** per richiesta; un evento non valido finisce in `rejected` (`{id, reason}`) senza bloccare gli altri.
- **Cosa conta** (lo decide il server): `counted = listenedMs ≥ min(30 s, 50 % di durationMs)`. Le sessioni più brevi sono salti. Il client registra ogni sessione **≥ 3 s**.
- **Quando spedire** («di tanto in tanto»): a lotti da 20, quando l'app va in background (con `beginBackgroundTask`), all'avvio, ogni 15 minuti in foreground; con backoff se fallisce. Gli eventi stanno in un file locale finché il server non risponde `200`: nessuna perdita offline.
- Web: `POST /api/plays` (stesso corpo; il dispositivo è `web`, l'utente è quello Authelia).

## 2. Cancellazione di brani dal telefono

Il telefono cancella da solo i file; il server vuole sapere **cosa, quando, perché**.

```json
POST /api/mondrop/device-events
{ "events": [
  { "id": "9A7B…", "type": "delete_songs", "at": "2026-11-08T09:40:00Z",
    "details": {
      "reason": "least_played",                // manual | least_played | free_space
      "criteria": { "count": 25, "olderThanDays": null },
      "confirmations": 2,                        // doppia conferma per i blocchi
      "count": 25, "bytes": 312000000,
      "songs": [ { "songKey": "…", "title": "…", "artist": "…", "bytes": 6291456, "plays": 0, "lastPlayedAt": null } ] } } ] }
→ { "accepted": 1, "duplicates": 0, "rejected": [] }
```

- Persistito in `device_events` (non si cancella dalla console) **e** scritto nel log di attività con l'elenco completo dei brani.
- Anche una cancellazione singola si registra (`count: 1`, `confirmations: 1`).
- Spedito con la stessa coda offline degli eventi di ascolto.
- Dopo una cancellazione il Sync **non** riscarica quel brano su quel telefono finché l'utente non lo chiede («Riscarica»).

## 3. Numeri per brano (per «meno ascoltate»)

Le tracce del manifest e di `GET /api/mondrop/songs/:key` portano due campi opzionali nuovi:

```json
{ "plays": 12, "lastPlayedAt": "2026-11-05T21:03:11Z" }
```

`plays` = ascolti **contati** dell'utente su **tutti** i dispositivi (non solo questo telefono), da sempre; `lastPlayedAt` = ultimo ascolto contato (`null` se mai).

## 4. Playlist dinamiche

Una playlist dinamica è definita da una **regola** e ricalcolata a ogni richiesta (quindi ogni Sync scarica ciò che è «vero adesso»). Non si aggiungono né si tolgono brani a mano.

`GET /api/mondrop/playlists` e `GET /api/playlists` portano per ogni playlist `kind: "static" | "dynamic"` e, per le dinamiche, `rule` e `ruleSummary` (testo leggibile, es. «Più ascoltate · 07:00–08:00 · ultimi 30 giorni»). Il manifest di una dinamica ha le stesse `tracks` di una statica, più `dynamic: true` e `generatedAt`.

```json
{ "v": 1,
  "scope": "me",                       // me | family (gli ascolti di tutti gli utenti)
  "period": { "days": 30 },            // { "days": N } oppure "all"
  "window": { "from": "07:00", "to": "08:00", "days": [1,2,3,4,5] },   // ora LOCALE dell'ascolto; opzionale
  "order": "most_played",              // most_played | least_played | recent | never_played
  "limit": 50,                         // 1–200, default 50
  "minPlays": 1,                       // ascolti minimi (ignorato da never_played)
  "genres": ["Rock", "Jazz"],          // opzionale: «tipo» di musica
  "downloadedOnly": false }
```

- `window.from > window.to` attraversa la mezzanotte (notte: `"22:00"` → `"06:00"`). `days` = giorni ISO (1 lunedì … 7 domenica), opzionale = tutti.
- Un ascolto rientra nella finestra in base alla **sua** ora locale (`startedAt` + `tzOffsetMin`), non a quella del server.
- `never_played` = brani dell'utente senza ascolti contati nel periodo (la finestra oraria non si applica).
- Sono visibili solo i brani che l'utente può già vedere (journal suo o condiviso). `genres` filtra sui generi di `song_meta` (nomi equivalenti come «Alternative»/«Alternativa» valgono uguale).
- Creazione/modifica (web): `POST /api/playlists` con `{ "name", "kind": "dynamic", "rule" }`, `PATCH /api/playlists/:id` con `{ "rule" }`; sulle dinamiche add/remove/reorder rispondono `409 { "error": "playlist_is_dynamic" }`. Preset suggeriti: `GET /api/playlists/dynamic/presets` → `[{ id, label, rule }]`.

## 5. Statistiche (web)

`GET /api/stats/listening?scope=me|all&from=YYYY-MM-DD&to=YYYY-MM-DD&user=&device=&tz=Europe/Rome`

- `scope=all` (tutti gli utenti) solo per l'admin; `user=` filtra un utente (admin); `device=` un dispositivo. Tutti gli altri vedono solo se stessi.
- Risposta: `totals` (ascolti contati, salti, tempo ascoltato in ms, brani e artisti distinti, dispositivi), `perDay` (`[{day, plays, listenedMs}]`), `heatmap` (7×24, lunedì=0, ora locale), `topSongs`, `topArtists`, `topGenres`, `perDevice`, `perOrigin`, `neverPlayed` (quanti brani della libreria non sono mai stati ascoltati), `period`.
- `GET /api/stats/listening/recent?limit=50` → ultimi ascolti (brano, utente, dispositivo, quando, quanto).

## 6. Dove sta il brano (player web e Playlist manager)

- `GET /api/songs` → ogni canzone ha anche `fs: boolean` (file sul disco di geekom: libreria di Spooty o `SoundReel/`), `mediaServer: boolean` (il file è sul media server: file suo, replica verificata o voce del catalogo), `fsPath: string | null` (percorso mostrato, es. `~/Music/Bassi Maestro/…`), `mediaUrl: string | null` (URL del file sul media server). **`inLibrary` (il pallino verde) è esattamente `fs || mediaServer`.**
- `GET /api/songs/:songKey/state` → aggiunge `location: { fs, mediaServer, fsPath, mediaUrl, streamUrl }` (`streamUrl` = link YouTube se noto).
- Badge: `FS`, `MS`, `FS+MS`; nessun badge = solo streaming (YouTube).
- `GET /api/songs/:songKey/file` → i byte del brano: **prima il media server** (proxy HTTPS con `Range`: si suona anche da internet, nessuna copia), poi il disco; `?from=media|fs` forza un'origine, `?download=1` scarica. Mondrop (`/api/mondrop/songs/:key/file`) fa l'inverso: prima il disco.

## 7. Lista del player web

Coda con più di **20** brani: se ne mostrano al massimo 20, il primo è sempre quello in play, sotto i successivi, i già ascoltati escono dall'alto; riga «20 di N · K già ascoltate nascoste». Con 20 brani o meno, lista intera. Precedente/successivo/shuffle/ripeti lavorano sulla coda intera.

## 8. Rete e sorgente del player web

`GET /api/net` → `{ "network": "internal" | "external" }`: «external» se la richiesta arriva via Cloudflare (`CF-Ray` / `CF-Connecting-IP`), «internal» se arriva diretta a Traefik (stessa regola di `/api/mondrop/net`). Serve allo switch «Sorgente» del player: `Auto` = rete interna → media server, da internet → Internet (YouTube); si può forzare a mano. Spec: `2026-11-07-web-player-ux-design.md` (S1–S8).

## 9. Ricerca nella libreria

`GET /api/library/search?q=<testo>&scope=all|songs|media|local&limit=100` → `{ q, scope, counts: { songs, media, local }, results: [{ scope, artist, title, album, folder, location, bytes, songKey, inJournal }] }`. Ordine delle parole ininfluente, senza maiuscole/accenti, su artista, titolo, album e percorso; max 100 risultati per ambito (`counts` conta tutti). `q` più corto di 2 caratteri → `400 query_too_short`. Cartelle extra: `GET/POST /api/config/music-folders` (admin), `GET …/browse?path=`, `POST …/rescan`. Spec: `2026-11-07-library-search-music-folders-design.md`.

