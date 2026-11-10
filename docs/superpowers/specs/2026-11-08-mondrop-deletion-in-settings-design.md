# Mondrop: la cancellazione è un'opzione speciale e sta nelle Impostazioni (richiesta 2026-11-08)

Stato: **costruita** (Mondrop 1.7.0). Solo interfaccia: nessuna ADR (regole d'interfaccia stanno nella spec).

**Aggiornamento 10 novembre (Michele): «La canzone viene cancellata solo con uno swipe della canzone in ricerca, non nel browser di una playlist.»** D1 e D2 qui sotto sono **sostituite in parte** da U8 di `2026-11-10-mondrop-simplify-playlists-and-song-states-design.md`: un brano si cancella dal telefono **solo dalle Impostazioni («Spazio e brani scaricati») e con lo scorrimento della riga in Cerca**, mai da una playlist, dalla Home o dal Player. Il resto (D3 e le conferme) resta. Vale dalla build che porta quella spec (1.8.0).

## 1. Richiesta di Michele (testuale)

> «su mondrop la cancellazione è una opzione speciale e deve stare in impostazione.»

## 2. Com'è oggi (misurato nel codice dell'app, 8 novembre)

Dove l'app 1.6.0 e la 1.7.0 in costruzione permettono di cancellare:

| Dove | Cosa cancella | Raggiungibile da |
|------|---------------|------------------|
| **«Spazio e brani scaricati»** (`SpaceView`) | i brani scaricati sul telefono: uno per volta (scorrimento), una selezione, «Elimina le N meno ascoltate», «Libera spazio…», «Elimina i brani non più in nessuna playlist» (sempre con conferma, doppia per più brani) | **Impostazioni → Sync**, ma anche dal pulsante **«Spazio»** (l'unità disco) nella barra in alto di **Libreria** e di **Cerca** |
| **Posta** (`InboxView`) | le notifiche e le condivisioni ricevute (scorrimento «Elimina» e pulsante nel dettaglio) | la scheda Posta |
| **Cerca** (1.7.0) | le ricerche recenti (scorrimento «Togli», «Cancella») | la scheda Cerca |

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| D1 | **Cancellare brani dal telefono si fa solo nelle Impostazioni** | La schermata «Spazio e brani scaricati» ha **un solo ingresso**: Impostazioni, in una sezione a parte **«Cancellazione»** (non più dentro «Sync»), con una nota che dice che è l'unico posto e che ogni cancellazione chiede conferma. **Sparisce il pulsante «Spazio»** dalla barra di Cerca e di Libreria |
| D2 | **Nessuna cancellazione sulle righe dei brani** | Dal Player, da Cerca, dalle pagine di artista e album, dalle playlist e dalla coda **non si cancella niente** (oggi è già così: la pressione prolungata offre solo «Aggiungi in coda», «Aggiungi a playlist…» e «Scarica sul telefono») |
| D3 | **La Posta e le ricerche recenti restano dove sono** | Togliere una notifica dalla Posta e una ricerca recente dall'elenco non cancellano né brani né dati di SoundReel: sono gesti di ordine, come in ogni app di posta. **Da confermare con Michele** (domanda in §5) |
| D4 | **Come si garantisce** | Un test fa fallire la build se `SpaceView` si raggiunge da un posto che non sia `SettingsView`, o se una riga di brano offre un'azione di cancellazione |
| D5 | **Una nota sbagliata** | Nella nota sotto «Sync» c'era ancora «a casa i brani arrivano direttamente dal media server»: non è più vero dalla regola P (l'app scarica solo da SoundReel). Corretta |

## 4. Test

`MondropTests/DeletionInSettingsTests.swift`: la schermata `SpaceView` è costruita solo in `SettingsView.swift`; nessuna vista di brani (Cerca, pagine di artista e album, Libreria, playlist, coda, player) ha un'azione distruttiva; nelle viste non c'è più la frase «direttamente dal media server».

## 5. Domanda per Michele

Intendevi **solo i brani scaricati** (quelli di «Spazio»)? Se vuoi che anche **«Elimina» della Posta** e le **ricerche recenti** stiano nelle Impostazioni, si sposta (D3).
