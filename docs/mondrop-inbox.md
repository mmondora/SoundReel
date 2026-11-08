# Mondrop — Share, posta e notifiche (contratto API, 2.10.0)

Spec: `docs/superpowers/specs/2026-11-08-mondrop-share-inbox-design.md` (SH1–SH7, IN1–IN7). Architettura: `adr/0015-mondrop-inbox-server-side-push-as-doorbell.md`.
Auth: `X-SoundReel-Key` come per tutte le rotte `/api/mondrop/*` (con una key legata a un utente vince l'utente della key). Utenti della famiglia: `mike`, `archi`, `sara`.
**Stato: contratto da implementare** (il backend e l'app lo seguono; ogni campo nuovo è opzionale per l'app già installata).

## `POST /api/share` — nuovi campi

Corpo (oltre a quelli di `docs/share.md`):

```json
{ "url": "https://open.spotify.com/track/…", "comment": "#tesla", "playlistId": "p1", "shareWith": ["archi", "sara"] }
```

| Campo | Significato |
|-------|-------------|
| `playlistId` | Opzionale, **default assente = nessuna playlist**. Una playlist **statica** dell'utente (le dinamiche e quelle condivise con lui sono in sola lettura). I brani del link vengono aggiunti: **subito** se sono noti al momento della condivisione (Spotify, Shazam), **a fine analisi** per gli altri (reel, video), tutti, senza doppioni |
| `shareWith` | Opzionale, **default assente = nessuno**. Sottoinsieme di `["mike","archi","sara"]`, mai se stessi: il server crea le righe di `entry_shares` (le stesse del web). Idempotente |

Risposta `200` (campi nuovi in fondo, sempre presenti):

```json
{
  "success": true, "entryId": "…", "tags": [], "status": "queued", "kind": "spotify", "title": "…", "artist": "…",
  "playlist": { "id": "p1", "name": "Road trip", "added": 1 },
  "sharedWith": ["archi"],
  "rejected": [ { "user": "mike", "reason": "self" } ]
}
```

- `playlist`: `null` se non richiesta; `{ id, name, added }` con `added` = numero di brani aggiunti adesso, oppure la stringa `"pending"` se verranno aggiunti a fine analisi; `{ id, error }` se non valida, con `error` = `not_found` · `dynamic` · `read_only` (il link entra comunque in libreria).
- `sharedWith`: i destinatari effettivi. `rejected`: gli altri, con `reason` = `self` · `unknown_user`.

## `GET /api/mondrop/playlists` — campo nuovo

Ogni playlist porta `canEdit: boolean` (vero solo per le **statiche proprie**): il foglio di condivisione offre solo quelle.

## La posta

```http
GET /api/mondrop/inbox?since=2026-11-08T07:00:00Z&limit=100
```

`limit`: default **100**, massimo **200**. Le notifiche arrivano dalla più recente; `received` ha lo stesso tetto.

```json
{
  "notifications": [
    {
      "id": "b6a1…", "kind": "share_result", "level": "info",
      "title": "Salvato su SoundReel", "body": "2 canzoni, 1 film · aggiunte a Road trip",
      "entryId": "75c141a1-…", "url": "https://soundreel.casamon.dev/?entry=75c141a1-…",
      "createdAt": "2026-11-08T07:10:00Z", "readAt": null, "expiresAt": "2026-11-11T07:10:00Z",
      "data": { "songs": 2, "films": 1, "notes": 0, "software": 0, "tags": 3, "playlist": { "id": "p1", "name": "Road trip", "added": 2 } }
    },
    {
      "id": "c0de…", "kind": "share_result", "level": "error",
      "title": "Analisi non riuscita", "body": "Non sono riuscito a leggere il reel. Puoi riprovare.",
      "entryId": "…", "url": "…", "createdAt": "…", "readAt": null, "expiresAt": null,
      "data": { "sourceUrl": "https://www.instagram.com/reel/…", "reason": "ai_output_unusable", "options": { "playlistId": "p1", "shareWith": ["archi"], "comment": "#tesla" } }
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
| `level` | `info` oppure `error`. **Gli `info` scadono dopo 3 giorni** (`expiresAt`), letti o no; **gli `error` non scadono** (`expiresAt: null`): restano finché l'utente non li toglie o finché lo stesso link non va a buon fine (allora il server li chiude da solo) |
| `title`, `body` | Testo già pronto da mostrare, in italiano, con gli stessi dati del messaggio Telegram (riassunto, conteggi, playlist) |
| `data.sourceUrl`, `data.options` | Per gli errori: il link da rimandare con «Riprova» e **le opzioni con cui era partito** (`playlistId`, `shareWith`, `comment`, quelle che c'erano): il server le tiene in `share_intents`, così «Riprova» le riproduce da **qualunque dispositivo**, anche se la condivisione non è partita da quel telefono |
| `received` | Le voci che altri mi hanno condiviso (`entry_shares`): **non scadono** finché la condivisione esiste |
| `unread` | Il numero sul badge: **ogni condivisione ricevuta conta una volta sola**. Una condivisione ricevuta ha una notifica `share_received` e una riga in `received`, collegate dallo stesso `entryId`: **«vista» e «letta» sono la stessa cosa** (`POST …/received/:entryId/seen` segna letta anche la notifica, `POST …/inbox/:id/read` di una `share_received` segna vista la condivisione), e `unread` = notifiche non lette + condivisioni non viste **senza** una notifica non letta |
| `since` | Opzionale: solo notifiche create o cambiate dopo quell'istante (il client tiene l'ultimo `serverTime`) |
| `removedIds` | Con `since`: gli id delle notifiche **tolte** dopo quell'istante (cancellate da un altro dispositivo, o errori che il server ha chiuso perché lo stesso link è poi riuscito, o scadute): il client le toglie dalla lista senza rileggere tutto. Il server tiene un promemoria delle rimozioni per 7 giorni; un client che manca da più di 7 giorni fa una lettura completa (senza `since`) |

```http
POST   /api/mondrop/inbox/:id/read          → { "ok": true }
POST   /api/mondrop/inbox/read-all          → { "ok": true, "marked": 3 }
DELETE /api/mondrop/inbox/:id               → { "ok": true }      (toglie la notifica; un errore si toglie solo così)
POST   /api/mondrop/received/:entryId/seen  → { "ok": true }      (non è più «nuova»)
```

**Fuori da questo contratto:** un tocco su una condivisione ricevuta apre `url` (la pagina web, dietro Authelia, in Safari). «Aggiungi a playlist» da Mondrop richiederebbe una rotta che oggi non esiste (`POST /api/mondrop/playlists/:id/songs`): resta per dopo.

Ogni rotta tocca **solo la posta dell'utente della key**: l'id di un altro utente risponde `404`. Errori: `401` key assente o sbagliata, `400` parametro non valido.

## Push (opzionale, APNs)

Il push è solo il campanello: il contenuto sta nella posta e l'app lo legge da lì. **Spento finché non c'è la chiave APNs** (ADR-0015).

```http
POST   /api/mondrop/push/devices   { "token": "<hex del dispositivo>", "environment": "development" | "production" }  → { "ok": true }
DELETE /api/mondrop/push/devices   { "token": "…" }                                                                  → { "ok": true }
```

Payload inviato ad APNs: `{ "aps": { "alert": { "title": "…", "body": "…" }, "sound": "default", "badge": 3, "thread-id": "inbox" }, "inboxId": "…", "entryId": "…" }`. Un build installato da Xcode registra un token **development**. Se APNs risponde che il token non è più valido, il server lo toglie.

## Contatori d'uso (solo server)

Per capire come si usa il sito (spec `2026-11-08-web-mobile-ux-design.md`, M8) il backend tiene contatori **aggregati** per giorno: utente, tipo di dispositivo ricavato dallo user-agent (`mobile-web`, `desktop-web`, `app`, `automation`, `other`), rete (`internal` o `external`), gruppo di rotta e numero di chiamate. **Mai** un indirizzo IP né uno user-agent in chiaro. Lo legge solo l'admin: `GET /api/admin/usage?days=14`.
