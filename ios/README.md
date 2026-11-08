# Mondrop — installazione e uso

App iPhone/Mac: **Condividi → Mondrop → (tag) → Invia** → journal SoundReel.

Ogni share manda: **link**, **utente Authelia** (`mike`/`archi`/`sara`), **data/ora locale del device**, **canale** (ios/macos), **device** (nome/modello/OS/timezone).

---

## Installazione (iPhone) — su vulcano o un altro Mac

### 1. Una tantum sul Mac

```bash
# Xcode già installato; poi:
brew install xcodegen   # se manca (/opt/homebrew/bin)

cd ~/works/Soundreel/ios   # su vulcano il tree è già syncato da geekom
# oppure clona/sync del repo Soundreel
xcodegen generate
open Mondrop.xcodeproj
```

### 2. Firma in Xcode (obbligatoria per iPhone fisico)

Su vulcano oggi **non** ci sono certificati Apple (`0 valid identities`):

1. Xcode → **Settings → Accounts** → aggiungi il tuo Apple ID (Team **5NZADC9YQ2** / mikesoft)
2. Seleziona target **Mondrop** → **Signing & Capabilities** → Team automatico
3. Stesso Team sul target **MondropShare**
4. Collega l’iPhone via cavo, confida il computer

### 3. Run sull’iPhone

1. Scheme **Mondrop** → destination = il tuo iPhone → ▶ Run  
2. Prima apertura: tocca **Ottieni API key** (home, o **Impostazioni → API key**)
   - si apre il foglio di login Authelia → **Genera API key** → torni nell’app già collegato
   - la key è personale (utente Authelia + nome del dispositivo); **Rinnova API key** la sostituisce (la vecchia smette di funzionare)
   - fallback: «Incolla a mano» (key da `cat ~/.config/soundreel/share-api-key` su geekom, oppure mint sotto)

> Nessuna key mintata a mano per gli utenti: ognuno la genera dal proprio device con il login Authelia
> (pagina `/mondrop/connect`, vedi `docs/share.md`). OIDC vero (Bearer) resta l’upgrade: `docs/mondrop-auth.md`.

### 4. Favorisci Mondrop nello share sheet

Instagram (o Safari) → Condividi → **Modifica azioni / Edit Actions** → pin **Mondrop**.

### 5. Prova

Condividi un Reel → Mondrop → eventuale `#tag` → **Invia** → controlla https://soundreel.casamon.dev

---

## Installazione Mac (Share da Safari)

Scheme **MondropMac** → Run. Stesse Impostazioni (utente + API key). Poi Safari → Condividi → Mondrop.

---

## Mint API key manuale (geekom, legacy)

```bash
docker exec soundreel node -e \
  "fetch('http://127.0.0.1:8080/api/share/mint-key',{method:'POST'}).then(r=>r.json()).then(console.log)"

# già mintata su questa macchina:
cat ~/.config/soundreel/share-api-key
```

---

## Sync / primo play

Contratto API: `docs/mondrop-sync.md`. Tab **Playlist** → una playlist.

- **Sync** = `POST …/prepare` (il server prepara i brani non pronti) + download in background: sessione `URLSession` *background*
  (continua anche con l'app sospesa), **solo Wi-Fi** salvo l'interruttore *Impostazioni → Sync → Scarica anche con rete cellulare*,
  **max 2 in parallelo**, ripresa dei download interrotti. Finché il server ha brani `preparing` l'app rilegge il manifest ogni ~5 s
  (max ~10 min) e scarica ogni brano appena è `ready`. Il pulsante è ripetibile: nulla viene scaricato due volte.
- **Salta ciò che c'è già**: un brano è «presente» solo se il file esiste, **non è vuoto** e — quando il manifest conosce `bytes` — ha
  la stessa dimensione (la sola `version` non basta: il backend precedente serviva `200` con `Content-Length: 0` e la vecchia app
  indicizzava MP3 da 0 byte). Un file basta per tutte le playlist.
- **Solo rete cellulare** con l'interruttore spento: i download non falliscono, restano **in attesa del Wi-Fi** (la schermata lo dice).
- **Indirizzo**: in casa (`GET /api/mondrop/net` → `home`) e con `mediaUrl` si scarica dal media server (HTTP in LAN, **senza** API key);
  altrimenti da `downloadPath` (HTTPS, con key). Se `mediaUrl` fallisce (permesso «Rete locale» negato, timeout, non 2xx, dimensione
  diversa dal manifest) c'è un secondo tentativo da `downloadPath`.
- **Primo play**: tocca un brano. Se è sul telefono si riproduce il file; altrimenti parte **subito in streaming** e si scarica **in parallelo**
  (la prossima volta è locale). Se il server non l'ha ancora preparato: «Preparo il brano…» (richiesta con priorità + controllo ogni ~2 s).
- **Stato per brano**: preparo sul server · in coda · scarico NN % · scaricato · errore (+motivo, «Riprova») · nessuna sorgente
  (+ «Link» per incollare un link YouTube).
- **File**: `Application Support/Mondrop/Offline` (escluso dal backup iCloud), indice in `offline-index.json`. Al primo avvio i file di
  `Documents/Offline` e l'indice in UserDefaults vengono migrati (i file vuoti scartati).
- **Libera spazio** (Impostazioni → Sync): rilegge **tutte** le playlist, poi propone di eliminare solo i brani che non sono più in
  nessuna playlist, con conteggio e MB, e solo dopo conferma. Se una playlist non si legge non cancella niente.
- **Permessi**: `NSAllowsLocalNetworking` (HTTP solo verso la rete locale; `NSAllowsArbitraryLoads` resta spento) e
  `NSLocalNetworkUsageDescription` (iOS chiede il permesso «Rete locale» al primo accesso al media server; se lo neghi tutto passa dal server SoundReel).
- **Test**: `xcodebuild test -scheme Mondrop -destination 'platform=iOS Simulator,name=iPhone 17e' -skip-testing:MondropTests/ShareClientTests`
  (`ShareClientTests` è lo smoke test contro la produzione: crea una entry nel journal, quindi non lo si lancia di default).

---

## Statistiche e spazio (Mondrop 1.4)

Contratto: `docs/mondrop-stats.md` §1–§4 · decisioni D1–D9: `docs/superpowers/specs/2026-11-07-listening-stats-dynamic-playlists-design.md`.

- **Ascolti**: `PlayTracker` osserva il player (file locali **e** primi play in streaming, anche in background e con lo schermo bloccato) e somma
  i millisecondi **realmente ascoltati**: pause, buffering e seek non contano. Una sessione ≥ 3 s diventa un evento (`id` UUID, `startedAt` UTC,
  `tzOffsetMin` dell'istante di partenza, `listenedMs`, `durationMs`, `completed`, `origin` local|stream, `playlistId` della playlist da cui è partita la coda).
  Un nuovo brano / lo stop / l'uscita dall'app chiude la sessione; se l'app viene uccisa, la sessione aperta è in un piccolo journal
  (checkpoint ogni ~10 s e a ogni pausa) e al lancio dopo diventa il suo evento **una volta sola** (stesso id: né persa né duplicata).
- **Coda eventi** (`event-queue.jsonl` in Application Support, esclusa dal backup): una sola coda durevole per ascolti ed eventi del dispositivo.
  Un evento esce solo dopo la risposta `200` (il server è idempotente per id: rispedire è sicuro). Tetto 5000: si scartano i **più vecchi**
  (prima gli ascolti; le cancellazioni sono l'audit e restano) e in Impostazioni compare il contatore.
- **Quando parte** (D2): a 20 eventi, quando l'app va in background (dentro `beginBackgroundTask`), al lancio, ogni 15 minuti in foreground,
  con «Invia ora». Lotti da ≤ 200 (il server accetta 500); backoff esponenziale 30 s → 15 min; un `401/403` mette in pausa e mostra
  «API key non valida» **senza perdere eventi**; un lotto che il server rifiuta in blocco (400/413/422) viene dimezzato fino a isolare l'evento colpevole.
  Impostazioni → *Statistiche di ascolto* mostra quanti eventi aspettano e l'ora dell'ultimo invio riuscito.
- **Numeri per brano**: `plays` / `lastPlayedAt` del manifest e di `GET /songs/:key` finiscono nell'indice locale; ogni ascolto contato
  (stessa regola del server: `listenedMs ≥ min(30 s, 50 % della durata)`) li aggiorna subito, anche offline. I numeri del server sono su
  **tutti** i dispositivi; gli ascolti di questo telefono non ancora confermati restano in più, così la classifica non torna mai indietro.
- **Spazio** (Impostazioni → Sync → *Spazio e brani scaricati*, o «Spazio» dalla tab Coda): spazio occupato, brani scaricati con peso / ascolti /
  ultimo ascolto; ordinamento *Meno ascoltate* (default: meno ascolti contati, poi ultimo ascolto più vecchio, mai ascoltati per primi),
  *Più pesanti*, *Più vecchie*, *Nome*; selezione multipla; scorciatoie **«Elimina le N meno ascoltate»** (N da 1, default 20),
  **«Libera spazio»** (100 / 250 / 500 MB, 1 GB: toglie i meno ascoltati finché non si libera tanto) e «Elimina i brani non più in nessuna playlist».
  Prima di decidere rilegge le playlist per avere ascolti e appartenenze aggiornati (offline usa quelli che ha e lo dice).
- **Cancellare** (D7): un brano = **una** conferma; **qualsiasi blocco** (più di un brano, comunque scelto) = **doppia** conferma — prima finestra con
  numero, MB e i primi titoli, seconda «Sei sicuro? Non si può annullare» con il pulsante distruttivo; «Annulla» in uno qualsiasi dei due passi non cancella nulla.
  Dopo la conferma l'evento `delete_songs` (motivo `manual|least_played|free_space`, criteri, conferme 1 o 2, numero, byte, e **una voce per brano**
  con `songKey/title/artist/bytes/plays/lastPlayedAt`) viene scritto nella coda **prima** di togliere i file, così sopravvive a un crash; se non si
  riesce a scriverlo non si cancella niente.
- **Skip-list** (D8): i brani cancellati dal telefono non vengono riscaricati dal Sync («rimossa dal telefono» + **Riscarica**); ascoltarli li fa
  partire in streaming **senza** il download in parallelo. «Riscarica» toglie la voce e scarica.
- **Playlist dinamiche** (§4): arrivano come playlist normali con badge **DINAMICA** e il riepilogo della regola; il Sync scarica i brani
  «veri adesso»; i brani usciti dalla regola diventano orfani e si tolgono solo con un'azione esplicita. Nell'app sono in sola lettura.
- **Compatibilità**: ogni campo nuovo è opzionale; con un backend senza `plays`/`device-events`/`kind` l'app funziona come prima e gli eventi
  restano in coda (se l'endpoint risponde 404 riprova con backoff).
- **Test**: stessi comandi di sopra; i test non toccano la rete (`URLProtocol` stub, orologi e trasporti finti).

---

## Cosa viene inviato con il link

| Campo | Esempio | Dove finisce |
|--------|---------|----------------|
| `url` | `https://instagram.com/reel/…` | entry |
| `user` | `mike` | `inputUser` + action log |
| `sharedAt` | `2026-11-07T14:02:11+01:00` | action log `url_received` |
| `channel` | `ios` / `macos` | action log `shareChannel` |
| `device` | nome, modello, OS, timezone | action log |
| `comment` / tag | `#tesla vacanze` | `results.tags` |

---

## Login OIDC Authelia (a regime)

Ogni utente genera da solo la sessione sul device: **Accedi con Authelia** → token → share con `Authorization: Bearer`. Niente key di famiglia mintate da Michele.

Stato: IdP OIDC **non ancora attivo** su `auth.casamon.dev` (404). Abilitazione = responsabilità **Geeko** (inbox hub); quando comunica «fatto», si collegano Mondrop + `/api/share` Bearer.

Dettaglio: `docs/mondrop-auth.md`.

---

## Icone

- **App**: `Mondrop/Assets.xcassets/AppIcon.appiconset` — «casa-lanterna» (iOS 1024 full-bleed senza alpha + tagli macOS).
- **Share** (foglio di condivisione): `MondropShare/Assets.xcassets/AppIcon.appiconset` — casa + velo giallo + freccia di share, diversa da quella dell’app.
  Si rigenera con `python3 ios/scripts/make_share_icon.py [--veil 0.55] [--blur 5]` (serve Pillow; 0.42 = più casa, 0.68 = più giallo).
- XcodeGen: i cataloghi `Assets.xcassets` stanno nei `sources` dei target. La chiave `resources:` di un target **non esiste** e viene ignorata in silenzio
  (così l’icona non finiva nell’app: nel `.pbxproj` c’erano 0 riferimenti). Verifica dopo `xcodegen generate`: `grep -c Assets.xcassets Mondrop.xcodeproj/project.pbxproj` > 0.

---

## Bundle

| Target | Bundle ID |
|--------|-----------|
| iOS | `it.mikesoft.mondrop` |
| Share iOS | `it.mikesoft.mondrop.share` |
| Mac | `it.mikesoft.mondrop.mac` |
| App Group | `group.it.mikesoft.mondrop` |
