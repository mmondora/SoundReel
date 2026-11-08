# Mondrop: scaricare tutto dopo una ricerca, e il play che non parte da solo (richiesta 2026-11-08)

Stato: **costruita** (Mondrop 1.7.0, build 9). Solo app (il server ha già tutto: `POST /api/mondrop/songs/:key/download` e la ricerca). Nessuna ADR: regole d'interfaccia.
Codice: `ios/MondropKit/BulkDownload.swift`, `ios/Mondrop/SearchActions.swift` (`BulkDownloader`), `ios/MondropKit/LocalAudioPlayer.swift` (`append`), prove `ios/MondropTests/BulkDownloadTests.swift` e `SearchPlaybackTests.swift`.

## 1. Richiesta di Michele (testuale)

> «In mondrop voglio anche poter scaricare tutto dopo una ricerca. E il play non deve essere automatico»

## 2. Com'era (letto dal codice l'8 novembre)

- Un brano della ricerca si scarica **uno alla volta** («Scarica sul telefono», tenendo premuto), e solo se il server lo ha già pronto.
- **«Aggiungi in coda» con la coda vuota faceva partire la musica da sola** (`append` → `setQueue` → `play`): è l'unica azione che avvia l'ascolto senza un tocco sul brano. Il tocco su un brano suona (e accoda i seguenti) per **tua scelta** («Suona e accoda i seguenti»), e «Riproduci», «Casuale» e «Suona» sono espliciti: restano.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| B1 | **Dove sta** | **«Scarica tutti»** nell'intestazione di «Brani» dei risultati della ricerca; **«Scarica»** accanto a «Riproduci» e «Casuale» nella pagina di un artista, di un album e in «Mostra tutti i brani» |
| B2 | **Si decide e si mostra prima** | Si caricano tutti i risultati (fino a **200**, una pagina piena del server, circa un gigabyte) e, con lo stesso pianificatore del Sync, si dice che cosa succederebbe: «Scaricare 87 brani sul telefono?» con sotto *quanti sono pronti sul server (e circa quanto pesano), quanti il server deve prima preparare, quanti sono già sul telefono o già in arrivo, quanti avevi tolto dal telefono, quanti non hanno una sorgente*. Si parte solo dopo «Scarica». Se la ricerca ne ha trovati più di 200 lo dice («scarico i primi 200: restringi la ricerca») |
| B3 | **Come scarica** | I brani **pronti** vanno al motore dei download (due alla volta, in background, come ogni sync). Gli altri si **chiedono al server** (`POST …/download`, priorità «sync», sei richieste alla volta: è lavoro suo, due brani alla volta) e la schermata li **riprende da sola** quando diventano pronti (rilegge la lista ogni 5 secondi per 10 minuti, finché è aperta) e li scarica. Passati i 10 minuti, o se si esce, restano preparati sul server: **«Scarica tutti» di nuovo** prende quelli pronti (è idempotente) |
| B4 | **Cosa NON fa** | **Non riporta** sul telefono i brani che avevi **tolto** apposta: la cancellazione è un atto voluto (regola del 8 novembre), un download in blocco non la disfa; c'è «Riscarica» sul singolo brano. **Non tocca il Player** (un test lo garantisce): scaricare non è suonare |
| B5 | **Il play non è mai automatico** | «Aggiungi in coda» con la coda vuota **carica la coda e mostra il primo brano** (titolo, artista, copertina, parole) **senza farlo partire**; la riga dice «Aggiunto in coda. Premi Riproduci nel Player». Si ascolta solo con un tocco (su un brano, su Riproduci, Casuale, Suona o sul tasto play). **Lettura della frase:** «il play non deve essere automatico» l'ho riferita a questo (l'unico punto in cui la musica partiva senza un tocco sul brano); se intendevi altro dimmelo |

## 4. Test

- `BulkDownloadTests` (12): i brani ordinati per ciò che deve succedere a ciascuno (pronto → motore; mancante o fallito → chiesto al server, **non** quello che il server sta già preparando; già sul telefono; già in arrivo; tolto da te: fuori; senza sorgente); la dimensione è la somma di quelli che la dicono; un brano due volte è uno; oltre 200 lo dice e taglia; la domanda e i dettagli; con niente da fare non chiede; **esecuzione**: i pronti al motore e gli altri al server, un errore è contato e gli altri vanno avanti, **al massimo sei richieste insieme** (e non una alla volta), niente richieste se non manca nulla; e una scansione dei sorgenti che fa fallire la build se «Scarica tutti» tocca il Player.
- `SearchPlaybackTests` (2): il messaggio del primo brano in una coda vuota e che `append` carichi senza chiamare `play`.
- iOS **891** test, il target macOS compila.

## 5. Domande per Michele

1. **«Il play non deve essere automatico»**: è questo (aggiungere in coda non suona), o intendevi un'altra cosa (per esempio che un tocco su un risultato non debba far partire la musica)?
2. «Scarica tutti» serve anche nelle pagine **Sfoglia** (Playlist, Album, Autori, Anni, Tipi)? Oggi è nella ricerca, negli artisti e negli album trovati.
