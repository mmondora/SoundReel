# Mondrop Share — foglio di condivisione, esito di ritorno, playlist, condividere con la famiglia, posta nell'app (roadmap)

- **Data:** 2026-11-08
- **Stato:** **Implementata** in SoundReel 2.10.0 (backend) + Mondrop 1.6.0 (app), in attesa di deploy. Il foglio e la posta sono regole d'interfaccia (spec); la posta sul server, il push e le condivisioni tra utenti toccano dati, API e infrastruttura (**ADR-0015, accettato**). Il push è costruito e **spento** finché Michele non crea la chiave APNs
- **Owner:** Michele
- **Correlati:** `docs/share.md` (contratto di `POST /api/share`), `adr/0015-mondrop-inbox-server-side-push-as-doorbell.md` (proposto), `2026-11-07-multi-user-authelia-design.md` (utenti e condivisioni), `ios/MondropShare/ShareViewController.swift`

## 1. Richieste di Michele (testuali, in ordine)

1. «La ux di Mondrop share non mi piace. Vorrei avere indietro anche una notifica, proprio come Telegram. Inoltre invia, il bottone, non è evidente. Vorrei anche poter scegliere la playlist ( default vuoto ) se sto linkando roba di media/musica.»
2. «Inoltre dalla share iOS posso voler anche fare uno share ( che deve essere server ) con archi o sarà o entrambi. Significa che in app devo avere anche la lista delle condivisioni ricevute ( e delle notifiche che però devono sparire in pochi giorni, salvo gli errori)»

**Come le leggo (da confermare):** «archi» e «sarà» sono gli utenti `archi` e `sara` della famiglia (insieme a `mike` sono i tre `FAMILY_USERS`). «Che deve essere server» = la condivisione deve avvenire **sul server** (come `entry_shares`, che già esiste), non come condivisione locale di iOS: chi la riceve la vede nel proprio SoundReel e nella propria app. «Condivisioni ricevute» = l'elenco delle voci che altri mi hanno condiviso. «Notifiche» = gli esiti e gli avvisi, che **spariscono dopo pochi giorni, tranne gli errori**.

## 2. Com'è oggi (letto dal codice il 2026-11-08)

- `MondropShare/ShareViewController.swift`: un `Form` SwiftUI in una `NavigationStack` con le sezioni «Link» (URL piccolo e grigio), «Utente» («Come mike · iPhone di Michele») e «Tag (opzionale)» (campo libero + chip dei tag recenti).
- **«Invia» è un bottone di solo testo nella barra in alto a destra** (il «conferma» di sistema, uguale a quello di ogni altro foglio), con «Annulla» a sinistra: piccolo, lontano dal pollice, non si nota.
- Dopo l'invio: «In coda ✓» per 0,45 secondi, poi il foglio si chiude. **Non torna nessun esito.** `POST /api/share` risponde subito `queued` e l'analisi prosegue in background con `notify: false`, quindi nemmeno un messaggio Telegram.
- Telegram, invece, a fine analisi risponde con un messaggio: riassunto dell'AI, conteggi (canzoni, film…) e link a SoundReel (`formatTelegramResponse`). È **quello** il comportamento che Michele vuole anche in Mondrop.
- Nessuna scelta di playlist: i brani trovati entrano in libreria, non in una playlist.
- Condividere una voce con `archi` o `sara` oggi si fa solo dal web (`POST /api/entries/:id/share`, `entry_shares`).

## 3. Decisioni prese con valori di default (da correggere se non vanno)

### Il foglio

| # | Decisione | Default scelto |
|---|-----------|----------------|
| SH1 | **Bottone «Invia»** | Grande, **pieno**, a tutta larghezza **in fondo al foglio** (sopra la tastiera, sempre visibile), colore d'accento, etichetta «Invia a SoundReel», spinner mentre invia. Non sta più nella barra: lì resta solo «Annulla». Disabilitato solo se manca l'URL, **con il motivo scritto** |
| SH2 | **Gerarchia** | Dall'alto: anteprima del link (sito + titolo se disponibile, altrimenti host e URL accorciato) → «Aggiungi a una playlist» (solo per link di musica/media) → «Condividi con» → tag → utente e dispositivo in piccolo in fondo. Meno `Form` grigio uniforme, più ordine |
| SH3 | **Esito subito** | Dopo l'invio il foglio non si chiude di scatto: stato di successo ben visibile (spunta grande + una riga che dice che cosa è successo: «Brano aggiunto a Road trip», «Link in analisi, ti avviso») per ~1,2 s, con feedback aptico. In caso di errore resta aperto con il motivo e «Riprova» |
| SH4 | **Scelta della playlist** | Compare **solo per link di musica/media** (Spotify, Apple Music, Shazam, YouTube e YouTube Music, SoundCloud, e anche Instagram e TikTok perché i reel contengono canzoni). **Default «Nessuna»**. Elenco delle playlist **statiche** dell'utente (le dinamiche sono in sola lettura). L'elenco sta nella cache condivisa dell'app (App Group), aggiornata a ogni apertura e a ogni sync, così il foglio non aspetta la rete |
| SH5 | **Cosa fa il server con la playlist** | `POST /api/share` accetta `playlistId` (opzionale). Un brano noto subito (Spotify, Shazam) lo aggiunge **subito**; le canzoni che emergono dopo l'analisi (reel, video) le aggiunge **a fine analisi**, tutte, senza doppioni. Se la playlist non è dell'utente, è dinamica o non esiste, il link entra comunque in libreria e l'esito lo dice |
| SH6 | **Condividere con la famiglia** | Fila di chip «archi», «sara» (selezionabili, anche **entrambi**), **default nessuno**. `POST /api/share` accetta `shareWith: ["archi","sara"]`: il server crea le righe di `entry_shares` (le stesse del web). Solo utenti di `FAMILY_USERS`, mai se stessi; idempotente. È una condivisione **sul server**: chi la riceve la vede nel proprio SoundReel e nella propria app |
| SH7 | **Mac** | Lo stesso `ShareComposeView` serve il Mac: stesso bottone, stessa playlist, stessi chip |

### La posta nell'app

| # | Decisione | Default scelto |
|---|-----------|----------------|
| IN1 | **Una scheda «Posta»** in Mondrop | Due elenchi: **Notifiche** e **Condivisioni ricevute**. Il numero di quelle da leggere sta sulla scheda e sull'icona dell'app |
| IN2 | **Condivisioni ricevute** | Le voci che altri mi hanno condiviso (`entry_shares`): chi, che cosa (titolo o riassunto, conteggi), quando; «nuova» finché non la apro. **Non scadono** finché la condivisione esiste (chi l'ha fatta può ritirarla). Un tocco apre la voce; per le canzoni c'è «Aggiungi a playlist» |
| IN3 | **Notifiche** | Gli esiti delle **mie** condivisioni («2 canzoni, 1 film · aggiunte a Road trip») e gli avvisi di chi mi ha condiviso qualcosa. **Spariscono da sole dopo 3 giorni**, lette o no |
| IN4 | **Gli errori restano** | Un errore (analisi fallita, brano non trovato, playlist non valida) **non scade**: resta, in rosso, con «Riprova» (rimanda lo stesso link), «Apri» e «Elimina», finché non lo tolgo io **o finché lo stesso link non va a buon fine** (allora si chiude da solo). Tetto di sicurezza: 100 errori per utente, i più vecchi escono per primi |
| IN5 | **Contenuto come Telegram** | Stessi dati del messaggio Telegram: riassunto, conteggi, link; più la playlist se scelta. Un tocco apre la voce |
| IN6 | **Come arriva** | La posta sta **sul server** ed è la fonte di verità: l'app la legge all'apertura, in primo piano e a ogni sync, quindi funziona **senza push**. Il **push** (APNs) è solo il campanello che avvisa subito, anche con l'app chiusa: richiede l'account sviluppatore Apple a pagamento (domanda 1). Senza push, l'app mostra una notifica locale quando il sistema la risveglia. Dettagli e alternative in ADR-0015 |
| IN7 | **Interruttori** | Impostazioni → «Notifiche delle condivisioni» (default acceso; il permesso si chiede la prima volta che serve) e «Condividi di default con…» (default nessuno) |

## 4. Contratto API (scritto in `docs/mondrop-inbox.md` e `docs/share.md`)

- `POST /api/share`: nuovi campi opzionali `playlistId` e `shareWith`. La risposta aggiunge `playlist: { id, name, added: n | "pending" } | null` e `sharedWith: string[]`, più `rejected: [{ user, reason }]` per i destinatari non validi. Resta compatibile con l'app già installata.
- `GET /api/mondrop/inbox?since=` → `{ notifications: [...], received: [...], unread: n }`.
- `POST /api/mondrop/inbox/:id/read`, `POST /api/mondrop/inbox/read-all`, `DELETE /api/mondrop/inbox/:id` (toglie la notifica).
- `POST /api/mondrop/received/:entryId/seen` (non è più «nuova»).
- Solo con il push: `POST` e `DELETE /api/mondrop/push/devices` (token del dispositivo e ambiente). Vedi ADR-0015.

## 5. Test

- **Foglio:** il bottone è sempre visibile con la tastiera aperta (320, 375 e 430 pt, anche con testo grande); stati: pronto, invio, ok, errore con «Riprova», URL assente; la playlist è nascosta per i link non musicali, «Nessuna» di default, l'elenco viene dalla cache; il corpo inviato contiene `playlistId` e `shareWith` solo se scelti.
- **Backend:** playlist subito per Spotify e Shazam; a fine analisi per un job; mai su una playlist dinamica o altrui; nessun doppione; un link già noto con playlist aggiunge comunque; `shareWith` accetta solo la famiglia e mai se stessi, idempotente; nessuna chiamata a servizi esterni nei test.
- **Posta:** la scadenza a 3 giorni cancella le notifiche ma **mai gli errori**; un errore si chiude se lo stesso link riesce; tetto degli errori; `read` e `DELETE` solo sulla posta del proprio utente (mai quella di un altro); le condivisioni ricevute non scadono; un invio di push che fallisce non fa perdere né la voce né il job.
- **Notifica:** stessi conteggi del messaggio Telegram; non parte con l'interruttore spento.

## 6. Domande aperte per Michele

1. ~~L'account sviluppatore Apple (Team `5NZADC9YQ2`, «mikesoft») è a pagamento?~~ **Risposta di Michele (2026-11-08): «si account apple è a pagamento».** Quindi il **push APNs è possibile** (opzione A di ADR-0015). Resta un passo che solo Michele può fare, perché la chiave non si può creare da qui: nel portale Apple Developer → Certificates, Identifiers & Profiles → **Keys** → «+» → abilitare **Apple Push Notifications service (APNs)** → scaricare il file `AuthKey_<KeyID>.p8` (si scarica **una sola volta**) e annotare il **Key ID**; il Team ID è `5NZADC9YQ2`. Il file va messo in `~/.config/soundreel/apns/` (0600, come le credenziali del Fritz) e a me serve **solo il Key ID**: il contenuto della chiave non deve mai passare dalla chat né dal repository. Finché la chiave non c'è, il push resta spento e tutto il resto funziona
2. Che altro del foglio non ti piace oltre al bottone (ordine, colori, troppa roba)?
3. La playlist serve solo per la musica, o ti serve qualcosa anche per i link di film (che oggi non hanno playlist)?
4. Chi riceve una condivisione deve poter **rispondere** o aggiungere note, o basta che la veda?
5. Tre giorni per far sparire le notifiche vanno bene?
6. Una notifica anche quando rimando un link già noto?

## 7. Valori di default adottati per le domande ancora senza risposta (2.10.0)

Michele non ha ancora risposto alle domande 2–6: si è costruito con questi default, **da correggere se non vanno**.
- **D3 — playlist per i film:** nessuna; la scelta compare solo per link di musica e media, e si riempie con le **canzoni** del link.
- **D4 — rispondere a una condivisione:** no; chi riceve la vede e la apre (una condivisione è un'entry, non una conversazione).
- **D5 — tre giorni:** sì, 3 giorni per le informazioni; gli errori non scadono; le condivisioni ricevute non scadono.
- **D6 — link già noto rimandato:** **sì, si avvisa di nuovo** il mittente (per i link che passano dal job l'analisi gira comunque e l'esito torna); i destinatari che hanno già ricevuto un avviso per quell'entry **non** vengono riavvisati (chi aveva l'entry ma mai l'avviso, per una condivisione fallita la prima volta, lo riceve alla seconda).
- **Esiti già visti nel foglio** (Spotify, Shazam, playlist non valida): salvati **già letti** e senza push; il campanello suona solo per ciò che arriva dopo che il foglio si è chiuso.
- **Un errore per link:** uno nuovo sostituisce il vecchio; un esito riuscito dello stesso link chiude gli errori in attesa.
- Dettagli di implementazione in ADR-0015 §7.

## 8. Cosa non cambia

`POST /api/share` e il foglio attuale restano validi per l'app già installata: i campi nuovi sono opzionali. Telegram continua a funzionare come oggi.
