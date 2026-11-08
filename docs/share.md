# Share ingest (`POST /api/share`)

Endpoint pubblico per la Share Extension iOS/macOS. Authelia è bypassata su Traefik solo per questo path; l’auth è l’header `X-SoundReel-Key`.

## Contratto

```http
POST /api/share
Content-Type: application/json
X-SoundReel-Key: sr_…

{
  "url": "https://www.instagram.com/reel/…",
  "comment": "#tesla vacanze",
  "tags": ["#opzionale"],
  "channel": "ios",
  "user": "mike",
  "sharedAt": "2026-11-07T14:02:11+01:00",
  "device": {
    "name": "iPhone di Michele",
    "model": "iPhone",
    "system": "iOS 18.0",
    "timeZone": "Europe/Rome"
  },
  "playlistId": "p1",
  "shareWith": ["archi", "sara"]
}
```

`playlistId` e `shareWith` sono **opzionali** (default: nessuna playlist, nessuno) e valgono dalla 2.10.0: una playlist **statica** dell'utente in cui mettere le canzoni del link, e i familiari (`mike`, `archi`, `sara`, mai se stessi) con cui condividere l'entry **sul server**. Contratto completo, risposta e posta in `docs/mondrop-inbox.md`.

Risposta `200`:

```json
{ "success": true, "entryId": "…", "tags": ["#tesla", "vacanze"], "status": "queued", "kind": "generic",
  "playlist": null, "sharedWith": [], "rejected": [] }
```

I tre campi in fondo sono **sempre presenti** (dalla 2.10.0): `playlist` (`null` se non richiesta; `{ id, name, added: n | "pending" }`; `{ id, error }` con `error` = `not_found` · `dynamic` · `read_only`), `sharedWith` (i destinatari validi, che hanno già l'entry) e `rejected` (`[{ user, reason }]` con `reason` = `self` · `unknown_user` · `sender_unknown`). Un'app che non li conosce li ignora.

Per un link Spotify la risposta aggiunge titolo e artista letti da Spooty:

```json
{ "success": true, "entryId": "…", "tags": [], "status": "queued", "kind": "spotify", "title": "Say it Ain't So", "artist": "PENNY" }
```

Per un link Shazam (`shazam.com/track/<chiave>` o `/song/<id>/<slug>`) il brano è letto subito dalla pagina e la risposta è già `completed`:

```json
{ "success": true, "entryId": "…", "tags": [], "status": "completed", "kind": "shazam", "title": "White Flag", "artist": "Bishop Briggs" }
```

Se la pagina Shazam non è leggibile il link resta salvato (entry in errore) e la risposta è `200` con `success: false` + `error` — il foglio di condivisione mostra il motivo e resta aperto; rimandare lo stesso link riprova:

```json
{ "success": false, "entryId": "…", "tags": [], "status": "error", "kind": "shazam", "error": "Shazam: Shazam ha risposto HTTP 503" }
```

Errori: `401` key assente/sbagliata, `400` URL mancante, `500` errore interno.

## Comportamento

1. Valida la key contro `config.apiKeys.keys` (timing-safe via SHA-256 compare).
2. Estrae tag da `comment` (stesse regole Telegram) + `tags` espliciti.
3. **Un solo punto d’ingresso per i link** (`services/linkIngest.ts`, `ingestLink`), identico per Telegram, share e web:
   - **Link Spotify** (traccia/album/playlist, anche `intl-xx/`, `spotify:` URI, `spotify.link`): URL canonico senza `?si=`/`utm_*` → **entry nel journal** (la canzone entra in libreria con artista, titolo, copertina letti da Spooty) + **accodata su Spooty**. Il watcher segue Spooty (`spooty_requests`) fino a «Completato» o «Errore» e lo scrive nell’action log; su Telegram avvisa a fine download. Spooty giù = il link resta salvato e viene riprovato.
   - **Link Shazam** (`/track/<chiave>`, `/song/<id>/<slug>`, anche con prefisso lingua e `?referrer=share`): URL canonico → **entry di libreria** con artista, titolo, album e copertina letti dalla pagina Shazam (JSON-LD `MusicRecording`); canzone con `source: shazam_link`, nessun job e nessun Spooty (la pagina non ha link Spotify). L'MP3 arriva con la Sync, dal downloader yt-dlp (Fase 1). Lo stesso link rimandato è idempotente; se l'ultima lettura era fallita, rimandarlo la riprova (e adotta le vecchie entry in errore salvate col link grezzo).
   - **Tutto il resto**: normalizza URL, se esiste già merge tag + action log, altrimenti stub `processing`, poi `enqueueJob` con `notify: false` (niente Telegram).
4. Ritorna subito — analisi/download in background come il webhook Telegram.
5. Lo stesso link rimandato è idempotente; se l’ultimo download era fallito, rimandarlo equivale a «riprova».
6. **Esito di ritorno (2.10.0)**: ogni condivisione da Mondrop lascia nella **posta** dell'utente (`GET /api/mondrop/inbox`) l'esito — lo stesso contenuto del messaggio Telegram: titolo, riassunto, conteggi, playlist — appena il link è pronto (subito per Spotify e Shazam, a fine analisi per gli altri); un'analisi fallita lascia un **errore che resta** finché l'utente lo toglie o lo stesso link non riesce. Le canzoni vanno nella playlist scelta **subito** se il link le porta già (Spotify, Shazam) e **a fine analisi** per un reel; chi riceve l'entry (`shareWith`) la vede subito nel proprio SoundReel e riceve un avviso quando l'entry è pronta. Il push (APNs) è solo il campanello. Dettagli, scadenze e regole in `docs/mondrop-inbox.md` e ADR-0015.

La parità fra i canali è coperta da `routes/linkParity.test.ts` (stessi URL → stessi effetti da Telegram, `/api/share` e web).

## API key

### Dal telefono (consigliato): `/mondrop/connect`

In Mondrop → **Impostazioni → Ottieni / Rinnova API key** (o il bottone nella home quando manca):
si apre la pagina `https://soundreel.casamon.dev/mondrop/connect` in un foglio di sistema, login Authelia,
tap **Genera API key**, la pagina rimanda all’app con `mondrop://auth?key=…&user=…&device=…`.

- La key è **legata all’utente Authelia** (`Remote-User`) e al **nome del dispositivo**: su `/api/share` e
  `/api/mondrop/*` il server usa l’utente della key e ignora `user` del client.
- **Rinnova** = stesso utente + stesso nome dispositivo → la key precedente viene revocata. Gli altri dispositivi non cambiano.
- Max 8 key per utente (oltre, la più vecchia viene revocata).
- Senza app (Safari): apri la stessa URL, la pagina mostra la key e un link «Apri Mondrop».
- Dati in `config.apiKeys`: `keys[]` (key in chiaro, come prima) + `meta{}` (sha256 della key → utente/dispositivo/data).

> **Vincolo Traefik:** `/mondrop/connect` DEVE restare dietro `auth-family`. Non spostarlo sotto `/api/mondrop`
> né su `/api/share`: quei router bypassano Authelia e `Remote-User` diventerebbe falsificabile dal client.

### Mint manuale (legacy)

```bash
# Solo loopback o richiesta con Remote-User (sessione Authelia)
curl -sS -X POST http://127.0.0.1:8081/api/share/mint-key
```

Scrive la nuova key in Postgres `config.apiKeys`. Key **non legata** a un utente: l’utente arriva dal client
(`user` / `X-SoundReel-User`), come prima.

## Traefik

Router `soundreel-share` in `geekom-hub/traefik/dynamic/routers.yml`:

- Host `soundreel.casamon.dev` + Path `/api/share`
- Priorità 100, senza middleware Authelia
- Service `soundreel`

Card hub nascosta in `hub/apps.yml` (`soundreel-share`).

## Client nativo

App **Mondrop** (`ios/`): XcodeGen, App Group `group.it.mikesoft.mondrop`, Settings API key. Vedi `ios/README.md`.
