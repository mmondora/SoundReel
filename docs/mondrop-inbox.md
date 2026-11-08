# Mondrop — Share, posta e notifiche (contratto API, 2.10.0)

Spec: `docs/superpowers/specs/2026-11-08-mondrop-share-inbox-design.md` (SH1–SH7, IN1–IN7). Architettura: `adr/0015-mondrop-inbox-server-side-push-as-doorbell.md`.
Auth: `X-SoundReel-Key` come per tutte le rotte `/api/mondrop/*` (con una key legata a un utente vince l'utente della key). Utenti della famiglia: `mike`, `archi`, `sara`.
**Stato: implementato nel backend 2.10.0** (`routes/share.ts`, `routes/mondropInbox.ts`, `services/inbox.ts`, `shareFlow.ts`, `shareIntents.ts`, `shareNotifications.ts`); ogni campo nuovo è opzionale per l'app già installata.

## `POST /api/share` — nuovi campi

Corpo (oltre a quelli di `docs/share.md`):

```json
{ "url": "https://open.spotify.com/track/…", "comment": "#tesla", "playlistId": "p1", "shareWith": ["archi", "sara"] }
```

| Campo | Significato |
|-------|-------------|
| `playlistId` | Opzionale, **default assente = nessuna playlist**. Una playlist **statica** dell'utente (le dinamiche e quelle condivise con lui sono in sola lettura). I brani del link vengono aggiunti: **subito** se sono noti al momento della condivisione (Spotify, Shazam), **a fine analisi** per gli altri (reel, video), tutti, senza doppioni |
| `shareWith` | Opzionale, **default assente = nessuno**. Sottoinsieme di `["mike","archi","sara"]`, mai se stessi: il server crea le righe di `entry_shares` (le stesse del web) **subito**, così i destinatari vedono l'entry nel proprio SoundReel e nella propria app. Idempotente |

Risposta `200` (campi nuovi in fondo, **sempre presenti**):

```json
{
  "success": true, "entryId": "…", "tags": [], "status": "queued", "kind": "spotify", "title": "…", "artist": "…",
  "playlist": { "id": "p1", "name": "Road trip", "added": 1 },
  "sharedWith": ["archi"],
  "rejected": [ { "user": "mike", "reason": "self" } ]
}
```

- `playlist`: `null` se non richiesta; `{ id, name, added }` con `added` = numero di brani **aggiunti adesso** (`0` = erano già tutti nella playlist, o il link non porta canzoni), oppure la stringa `"pending"` se verranno aggiunti a fine analisi; `{ id, error }` se non valida, con `error` = `not_found` · `dynamic` · `read_only` (il link entra comunque in libreria).
- `sharedWith`: i destinatari validi (hanno già l'entry). `rejected`: gli altri, con `reason` = `self` (sei tu) · `unknown_user` (non è della famiglia) · `sender_unknown` (la key non è legata a un utente: non si può condividere con nessuno).
- Anche la risposta `success: false` di una pagina Shazam illeggibile porta i tre campi (`playlist: null`, `sharedWith: []`, `rejected`).
- Rimandare lo stesso link è sicuro: l'entry, la condivisione e le righe sono idempotenti; una playlist aggiunge solo i brani che mancano.

## `GET /api/mondrop/playlists` — campo nuovo

Ogni playlist porta `canEdit: boolean` (vero solo per le **statiche proprie**): il foglio di condivisione offre solo quelle.

## Cosa succede dopo la condivisione

Il server tiene un'**intenzione** per ogni condivisione (`share_intents`: entry, mittente, playlist, destinatari) e la porta a termine quando l'entry è pronta; chi la chiude per primo annuncia, una seconda passata resta muta (nessun doppio avviso, anche dopo un riavvio).

| Link | Quando è pronto | Esito del mittente |
|------|-----------------|--------------------|
| Spotify con brani già noti, Shazam | subito | playlist riempita subito; l'esito è salvato **già letto** e **senza push** (l'ha appena visto nel foglio) |
| Reel, video, pagine | a fine analisi | playlist riempita a fine analisi; l'esito è **non letto** e suona il campanello (push) |
| Spotify i cui brani non sono ancora noti | quando Spooty li scrive nell'entry | come sopra, a quel punto |

- **Chi riceve** (`shareWith`) ha l'entry subito; l'avviso `share_received` (non letto, con push) parte quando l'entry è pronta, **solo per chi non ha ancora ricevuto un avviso per quell'entry** (che l'avviso sia letto, cancellato o scaduto): condividere di nuovo non riavvisa, ma una condivisione fallita la prima volta e riuscita la seconda avvisa alla seconda (i destinatari avevano già l'entry, non l'avviso).
- **Errori**: un'analisi che non riesce più (nessun tentativo rimasto) lascia un errore che **resta**; la prima volta che Instagram chiede una nuova autorizzazione il mittente è avvisato subito con un errore `retrying` (il server riprova da solo) e quell'errore si chiude quando il link riesce. Una playlist non valida lascia un errore `playlist_*` (già letto, senza push: il foglio l'ha detto) accanto all'esito di libreria.
- **Un solo errore per link**: un errore nuovo sostituisce il vecchio, e **un esito riuscito dello stesso link chiude gli errori che aspettavano**.
- **Mai posta** per ciò che non nasce da `POST /api/share`: Telegram, il web e le riparazioni (`requeueEmptyAnalysis`) restano come prima.

## La posta

```http
GET /api/mondrop/inbox?since=2026-11-08T07:00:00Z&limit=100
```

`limit`: default **100**, massimo **200** (di più viene portato a 200; un valore non numerico o < 1 è `400`). Le notifiche arrivano dalla più recente; `received` ha lo stesso tetto.

```json
{
  "notifications": [
    {
      "id": "b6a1…", "kind": "share_result", "level": "info",
      "title": "Cloudflare ha rilasciato una skill", "body": "Una skill open source che trasforma un agente in un team di sicurezza.\n2 canzoni, 1 film · aggiunte a «Road trip»",
      "entryId": "75c141a1-…", "url": "https://soundreel.casamon.dev/?entry=75c141a1-…",
      "createdAt": "2026-11-08T07:10:00Z", "readAt": null, "expiresAt": "2026-11-11T07:10:00Z",
      "data": { "songs": 2, "films": 1, "notes": 0, "software": 0, "tags": 3, "playlist": { "id": "p1", "name": "Road trip", "added": 2 } }
    },
    {
      "id": "c0de…", "kind": "share_result", "level": "error",
      "title": "Analisi non riuscita", "body": "Non sono riuscito a leggere il contenuto (instagram.com). Puoi riprovare.",
      "entryId": "…", "url": "…", "createdAt": "…", "readAt": null, "expiresAt": null,
      "data": { "reason": "ai_output_unusable", "sourceUrl": "https://www.instagram.com/reel/…", "options": { "playlistId": "p1", "shareWith": ["archi"], "comment": "#tesla" } }
    }
  ],
  "received": [
    { "entryId": "…", "from": "sara", "sharedAt": "2026-11-08T06:00:00Z", "title": "Say it Ain't So", "kind": "spotify",
      "counts": { "songs": 1, "films": 0, "notes": 0, "software": 0 }, "seen": false, "url": "https://soundreel.casamon.dev/?entry=…" }
  ],
  "removedIds": [],
  "unread": 2,
  "serverTime": "2026-11-08T07:12:00Z"
}
```

| Campo | Significato |
|-------|-------------|
| `kind` | `share_result` (esito di una **mia** condivisione) · `share_received` (qualcuno mi ha condiviso una voce; arriva anche in `received`) |
| `level` | `info` oppure `error`. **Gli `info` scadono dopo 3 giorni** (`expiresAt`), letti o no; **gli `error` non scadono** (`expiresAt: null`): restano finché l'utente non li toglie o finché lo stesso link non va a buon fine (allora il server li chiude da solo). Tetto di sicurezza: 100 errori per utente, i più vecchi escono per primi |
| `title`, `body` | Testo già pronto, in italiano, con gli stessi dati del messaggio Telegram (vedi sotto). `body` può avere più righe |
| `data` | Per un esito: i conteggi (`songs`, `films`, `notes`, `software`, `tags`) e, se scelta, `playlist: { id, name, added }`. Per un errore: `reason`, `sourceUrl` (il link da rimandare), `options` (con cosa era partita: `playlistId`, `shareWith`, `comment`, solo quelle che c'erano) e `retrying: true` quando il server riprova da solo |
| `received` | Le voci che altri mi hanno condiviso (`entry_shares`): **non scadono** finché la condivisione esiste. **È sempre l'elenco completo, anche con `since`** (la lista è piccola e porta lo stato `seen`): il client la **sostituisce**, così una condivisione ritirata sparisce subito. `kind` = `spotify` · `shazam` · `generic`; `from` = l'id utente di chi l'ha condivisa |
| `unread` | Il numero sul badge: **ogni condivisione ricevuta conta una volta sola**. Una condivisione ricevuta ha una notifica `share_received` e una riga in `received`, collegate dallo stesso `entryId`: **«vista» e «letta» sono la stessa cosa** (`POST …/received/:entryId/seen` segna letta anche la notifica, `POST …/inbox/:id/read` di una `share_received` segna vista la condivisione, cancellarla non letta la segna vista), e `unread` = notifiche non lette + condivisioni non viste **senza** una notifica non letta |
| `since` | Opzionale: solo notifiche create o cambiate dopo quell'istante (il client tiene l'ultimo `serverTime`). Il server legge 2 secondi prima: una riga scritta un attimo dopo l'ultima risposta non si perde mai, il client unisce per `id` |
| `removedIds` | Con `since`: gli id delle notifiche **tolte** dopo quell'istante (cancellate da un altro dispositivo, errori che il server ha chiuso perché lo stesso link è poi riuscito, scadute, uscite dal tetto): il client le toglie dalla lista senza rileggere tutto. Il server ricorda le rimozioni per 7 giorni; un client che manca da più di 7 giorni fa una lettura completa (senza `since`). Senza `since` è sempre `[]` |
| `serverTime` | L'istante di questa risposta, preso **prima** di leggere: il prossimo `since` non salta mai una riga scritta mentre la risposta veniva costruita |

### Il testo delle notifiche (come Telegram)

- **Esito** (`share_result`, `info`): `title` = il titolo dell'entry come nel messaggio Telegram (prima riga della didascalia, altrimenti l'inizio del riassunto, altrimenti il sito); `body` = il riassunto (una riga, ~160 caratteri) e poi «2 canzoni, 1 film, 3 note · aggiunte a «Road trip»» (oppure «già in «Road trip»», «1 aggiunta a …», «nessuna canzone per …»); senza niente da dire: «Salvato in libreria.».
- **Ricevuta** (`share_received`): `title` = «Sara ha condiviso con te» (nome della famiglia: Michele, Archimede, Sara); `body` = il titolo dell'entry e i conteggi.
- **Errore** (`share_result`, `error`), `data.reason`:

| `reason` | Titolo | Cosa dice |
|----------|--------|-----------|
| `analysis_failed` | Analisi non riuscita | Non sono riuscito a leggere il link (sito). Puoi riprovare. |
| `ai_output_unusable` | Analisi non riuscita | Non sono riuscito a leggere il contenuto (sito). Puoi riprovare. (l'AI non ha dato una risposta leggibile dopo tutti i tentativi) |
| `instagram_session` | Instagram non risponde | Instagram richiede una nuova autorizzazione; riprovo da solo (`retrying: true`) |
| `shazam_unreadable` | Shazam non leggibile | Rimanda il link per riprovare |
| `playlist_not_found` · `playlist_dynamic` · `playlist_read_only` | Playlist non valida | La playlist non esiste più / è dinamica / non è tua. Il link è comunque in libreria |

### Cambiare la posta

```http
POST   /api/mondrop/inbox/:id/read          → { "ok": true }
POST   /api/mondrop/inbox/read-all          → { "ok": true, "marked": 3 }   (notifiche lette e condivisioni viste; `marked` = quanto aspettava)
DELETE /api/mondrop/inbox/:id               → { "ok": true }      (toglie la notifica; un errore si toglie solo così)
POST   /api/mondrop/received/:entryId/seen  → { "ok": true }      (non è più «nuova»)
```

«Riprova» = rimandare `data.sourceUrl` a `POST /api/share` con `data.options` (il server le tiene, così funziona da qualunque dispositivo). Per un errore `playlist_*` l'app rimanda **senza** `playlistId`.
**Fuori da questo contratto:** un tocco su una condivisione ricevuta apre `url` (la pagina web, dietro Authelia, in Safari). «Aggiungi a playlist» da Mondrop richiederebbe una rotta che oggi non esiste (`POST /api/mondrop/playlists/:id/songs`): resta per dopo.

Ogni rotta tocca **solo la posta dell'utente della key**: l'id di un altro utente risponde `404` `{ "error": "not_found" }`. Errori: `401` key assente o sbagliata, `400` parametro non valido (`{ "error": "invalid_query", "field": "since" | "limit" }`), `500` errore interno senza dettagli.

### Manutenzione

Ogni ora il server toglie gli `info` scaduti (in modo morbido, per poter dire `removedIds`), dimentica le rimozioni vecchie di 7 giorni e butta le intenzioni concluse da più di 14 giorni (30 se mai concluse). Gli errori non si toccano. **Ogni 10 minuti** riprende anche le condivisioni aperte da più di 10 minuti il cui job non c'è più (l'analisi è finita prima che l'intenzione fosse scritta, o il server si è riavviato a metà): le completa dall'entry com'è adesso, o le fa fallire se l'entry è in errore; non tocca un'entry ancora in lavorazione.

## Push (opzionale, APNs)

Il push è solo il campanello: il contenuto sta nella posta e l'app lo legge da lì. **Spento finché non c'è la chiave APNs** (ADR-0015): senza `APNS_KEY_ID`, `APNS_TEAM_ID` e un `APNS_KEY_FILE` leggibile il sender è spento, non parte nulla e tutto il resto funziona.

```http
POST   /api/mondrop/push/devices   { "token": "<hex del dispositivo>", "environment": "development" | "production" }  → { "ok": true }
DELETE /api/mondrop/push/devices   { "token": "…" }                                                                  → { "ok": true }
```

Il token (esadecimale, 32–200 caratteri; altrimenti `400 invalid_body`) si salva sempre, anche a push spento; il `DELETE` toglie solo i token dell'utente della key (chiedere di togliere quello di un altro non è un errore). Se APNs risponde che il token non è più valido (`410`, `BadDeviceToken`…) il server lo toglie.

Payload inviato ad APNs: `{ "aps": { "alert": { "title": "…", "body": "…" }, "sound": "default", "badge": 3, "thread-id": "inbox" }, "inboxId": "…", "entryId": "…" }` (`badge` = il numero `unread` di quel momento). Un build installato da Xcode registra un token **development** (sandbox). Il testo dell'avviso transita dai server APNs di Apple, come per qualunque push.

Configurazione (`docker-compose.yml`, valori in `.env`; mai la chiave): `APNS_KEY_ID`, `APNS_TEAM_ID` (default `5NZADC9YQ2`), `APNS_KEY_FILE` (percorso **nel container**, es. `/run/secrets/apns/AuthKey_<KeyID>.p8`), `APNS_TOPIC` (default `it.mikesoft.mondrop`). La chiave la crea Michele nel portale Apple Developer (Keys → APNs), va in `~/.config/soundreel/apns/` (0600), montata in sola lettura.

## Contatori d'uso (solo server)

Per capire come si usa il sito (spec `2026-11-08-web-mobile-ux-design.md`, M8) il backend tiene contatori **aggregati** per giorno: utente, tipo di dispositivo ricavato dallo user-agent (`mobile-web`, `desktop-web`, `app`, `automation`, `other`), rete (`internal` o `external`, dagli header Cloudflare), gruppo di rotta (`entries`, `search`, `playlists`, `songs`, `share`, `analyze`, `inbox`, `stats`, `software`, `films`, `notes`, `settings`, `media`, `home` (dalla 2.18.0: la prima schermata dell'app, `GET /api/mondrop/home`), `other`) e numero di chiamate. **Mai** un indirizzo IP, uno user-agent, un percorso o una query. Non conta ciò che non è una chiamata API (pagine, file, health) né il server che chiama se stesso (il worker verso `/api/analyze`). Si scrive in memoria e si salva ogni minuto.

Lo legge solo l'admin (Authelia, gruppo `admins`; altrimenti `403`): `GET /api/admin/usage?days=14` (1–90) →

```json
{ "days": 14, "since": "2026-10-26", "total": 140,
  "byDevice": { "mobile-web": 110, "desktop-web": 25, "app": 5 },
  "byDeviceAndGroup": { "mobile-web": [ { "group": "search", "calls": 70 }, { "group": "entries", "calls": 40 } ] },
  "byUser": { "mike": 115, "sara": 25 }, "byNetwork": { "external": 115, "internal": 25 },
  "byDay": [ { "day": "2026-11-08", "calls": 135, "mobileWeb": 110, "desktopWeb": 25, "app": 0 } ] }
```
