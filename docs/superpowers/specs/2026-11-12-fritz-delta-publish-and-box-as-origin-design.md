# SoundReel — sul Fritz si manda solo il nuovo, e dopo la pubblicazione l'origine di un brano è la chiavetta

- **Data:** 2026-11-12
- **Stato:** **Richiesta registrata e diagnosi fatta (§3). La proposta (§5) aspetta l'OK di Michele: niente è stato cambiato** (né lo script, né le unità systemd, né il server, né i file di geekom, né la chiavetta).
- **Owner:** Michele
- **Correlati:** `adr/0032-after-publication-the-box-is-the-origin-of-a-store-song.md` (proposto), ADR-0006 (origine su geekom, replica sul Fritz: questa spec ne ribalta la regola per i brani dello store), ADR-0010 (un brano può essere un file del Fritz; la chiavetta tolta), ADR-0012 (import dal Mac), `scripts/fritz-sync.sh`, `scripts/fritz-sync-request.path`, `services/{retireCopies,mediaServer,mediaPublish,songFiles,offlineManifest,musicStore}.ts`

## 1. Richiesta di Michele (testuale)

«perché il sync è sempre complessivo e tutta music ? io vorrei solo il delta ( tipicamente nuove cose scaricate da Soundreel ) - inoltre dopo che da soundreel sono state scaricate su geekom e poi syncate con il media server, la fonte di verità diventa il media server e possono essere eliminate da geekom. Cosa non funziona ?»

## 2. Come la leggo

- **A. Il delta.** Una canzone nuova scaricata da SoundReel va sul Fritz **da sola**, senza che si rifaccia il resto: né la libreria, né i film, né la watchlist, né un conteggio dei file.
- **B. L'origine.** Per i brani che SoundReel scarica, geekom è **solo la porta d'ingresso**. Quando il Fritz serve il file (verificato), **il Fritz è l'origine** e il file di geekom si toglie. ADR-0006 diceva il contrario (origine su geekom, replica sul Fritz).
- **C. «Cosa non funziona?»** È una domanda: la risposta è §3. Non l'ho letta come «aggiusta subito»: la proposta (§5) aspetta il tuo OK perché toglie file dal disco di geekom e fa della chiavetta l'unico esemplare.

## 3. Diagnosi (12 novembre 2026: misurata, nulla è stato cambiato)

| # | Fatto | Misura | Conseguenza |
|---|-------|--------|-------------|
| D1 | **Un lavoro solo per tutto.** `fritz-sync.sh` è lo specchio di tutta `~/Music` (664 file, 3,2 GB: le cartelle di Spooty e lo store `SoundReel/`) **più** i film, **più** l'esportazione della watchlist (`docker exec`, circa 60 s), **più** due `find` su SMB per contare i file. L'unità `fritz-sync-request.path`, che scatta a **ogni** download, avvia lo **stesso** script intero | Un giro dura circa 1 min 50 s anche per un brano solo (log: 04:00:08 → 04:01:58; 22:25:48 → 22:27:44) | Un brano nuovo = il giro completo: «complessivo» |
| D2 | **Il giro non converge.** 39 file di «ITALIAN SONGS REMIXED BY EDMEA» (158 MB, cartella di Spooty) sono stati riscritti sul disco di geekom l'8 novembre da `retag_mp3.py` (solo i tag; data 8 nov, 11:57). Sulla chiavetta hanno **gli stessi byte** (confrontati con `smbclient` su tre file) ma la **data del 1° giugno**: la chiavetta non tiene la data nuova di un file sostituito (già noto dall'8 novembre) | La prova a secco (`rsync -n -i` con i parametri dello script), **7 ore dopo** il giro delle 04:00, li segna ancora `>f..t` (differisce solo l'ora). Il passo musica dura 47–51 s a ogni giro contro i 5 s della scansione a secco: i ~43 s di differenza corrispondono a 158 MB a ~3,7 MB/s (**dedotto dai tempi, non misurato direttamente**) | Anche una notte senza niente di nuovo manda 158 MB **identici** alla chiavetta: nessun giro è mai un delta |
| D3 | **Il «1592» del log non è tutta geekom.** `OK music=1592` conta tutto `Music/SoundReel/` sulla chiavetta: 914 in `_MacMusic/` (li scrive il Mac, ADR-0012), 539 lo specchio del resto di `~/Music`, 139 lo store | Da geekom partono 664 file, non 1592 | Corregge ciò che ho detto in chat il 12 novembre («tutta `~/Music`, 1589 brani») |
| D4 | **Niente toglie i brani da geekom.** Nel registro (`song_files`): 138 righe `ytdlp` `ready`, **tutte** `published` con `media_url` (la replica sul Fritz risponde a un HEAD con gli stessi byte) **e tutte** con il file locale (`rel_path`, 861 MB). `retireCopies` prende solo `source = 'existing'` (le copie legacy della 2.7.0) | 138 su 138 sono già nel caso che descrivi | La condizione di Michele («scaricate, syncate, il media server le serve») è **già vera per tutti**: manca chi agisce |
| D5 | **Anche se si togliessero, la replica sparirebbe.** Lo script è `rsync -a --delete` (ADR-0006 §3: «deleting a song locally removes its replica»): al giro dopo cancellerebbe la copia sulla chiavetta e il brano non esisterebbe più da nessuna parte. È il motivo per cui `findBoxOriginal` non conta mai la replica del proprio store come «originale» | Il codice difende la regola di ADR-0006 | Oggi la chiavetta è una **copia derivata**, non una fonte: la regola di Michele è l'opposto di ADR-0006 |
| D6 | **Mezzo lavoro c'è già.** `reconcilePublished` verifica la replica (HEAD, stessi byte) ogni 5 minuti e la ricontrolla ogni 6 ore; `markMediaOnly` fa di una riga «il file del Fritz» (le 6 righe `mediaserver` di oggi sono questo); contro la chiavetta tolta c'è la guardia di ADR-0010 §9 (`mediaVolumePresent`: un 404 si crede solo se risponde un file di controllo) | | Il ritiro riusa questi pezzi; non serve un meccanismo nuovo |
| D7 | **Una trappola trovata leggendo.** La `version` che il telefono confronta (`<byte>-<mtimeMs>`, `docs/mondrop-sync.md`) per una riga **senza file locale** viene dai campi `bytes` e `mtime_ms` **della riga**, e `markMediaOnly` sovrascrive `mtime_ms` con il `Last-Modified` HTTP del Fritz (precisione di un secondo) | | Ritirare così un brano ne cambierebbe la `version`: ogni telefono che lo ha già lo **riscaricherebbe** (861 MB a telefono). Il ritiro deve lasciare `bytes` e `mtime_ms` **come sono** (quelli del file locale, `fileFacts`) |

## 4. Regole (la richiesta di Michele, in forma di regole)

- **R1 — Delta.** Una pubblicazione manda **solo ciò che il registro dice non ancora pubblicato**. Non scandisce l'albero e non rifà film, watchlist e conteggi.
- **R2 — Mai cancellare sulla chiavetta ciò che geekom non ha più.** Nessun `--delete` sulla replica dello store (né sul resto, se Michele lo conferma: Q2).
- **R3 — Ritiro solo dopo la prova.** Un file di geekom si toglie **solo** quando, **nello stesso giro**: la riga è `ytdlp`, `ready` e `published`; il file sta dentro la cartella dello store; la replica risponde a un HEAD con **gli stessi byte**; **la chiavetta c'è** (un file di controllo risponde).
- **R4 — La versione non cambia.** Il ritiro mantiene `bytes` e `mtime_ms` del file locale: nessun telefono riscarica niente.
- **R5 — Prima la riga, poi il file.** Si aggiorna la riga (`source = 'mediaserver'`, `rel_path` nullo, `media_rel_path`, `media_url`) **e poi** si toglie il file; mai il contrario (un file tolto mentre la riga lo nomina diventa un nuovo download da YouTube, `vanished`).
- **R6 — Spento finché Michele non lo accende; anteprima per prima.** Il ritiro automatico sta dietro `RETIRE_PUBLISHED=1` (default spento); lo smaltimento dei 138 di oggi è uno script con **anteprima per default** e `--apply` solo con l'OK di Michele (la convenzione del progetto per ciò che cancella).
- **R7 — Il backend non scrive mai sulla chiavetta** (ADR-0006 resta): scrivono gli script di pubblicazione e notturno, e il Mac in `_MacMusic/`.

## 5. Proposta (i default sono miei: da correggere)

**Passo 1 — Solo il delta (nessun brano cambia posto).**
- Il backend, oltre al sentinella `.publish-request`, scrive `<store>/.publish-list`: i nomi (relativi a `~/Music`, uno per riga) delle righe `ready` e **non** `published` con il file locale (`listReadyUnpublished`, la stessa lista che `reconcilePublished` già usa; copre anche un file **sostituito** da `placeIntoStore(replace)`, che un semplice «solo i nuovi» non manderebbe).
- Nuovo `scripts/fritz-publish.sh` (e `fritz-sync-request.path` punta a un'unità nuova `fritz-publish.service`): monta come oggi, `rsync -a --files-from=<lista>` verso la replica, **senza** `--delete`, film, watchlist e `find`. Circa 5 secondi per un brano.
- `scripts/fritz-sync.sh` (notturno) esegue **anche** la pubblicazione (così un guasto della richiesta non lascia brani indietro), poi lo specchio del resto di `~/Music` diventa **solo aggiunta** (`--ignore-existing`, **senza** `--delete`): **i 39 file smettono di essere rimandati** e una cancellazione su geekom non tocca più la chiavetta. Restano la watchlist e i film. Il conteggio finale via `find` su SMB si toglie: la riga del log dice quanti file e byte sono stati mandati (`rsync --stats`).
- Costo dichiarato: con `--ignore-existing`, un file **già sulla chiavetta e poi cambiato** su geekom (un ritocco dei tag come quello dell'8 novembre) non arriva più da solo: si manda per nome. È la conseguenza di «la chiavetta è l'origine».

**Passo 2 — Il ritiro (la regola nuova).** `retirePublishedCopies()` nel backend, dopo ogni `reconcilePublished`, con R3–R6; `markMediaOnly` ha una variante che **non tocca** `bytes` e `mtime_ms`. Script una tantum `retirePublishedCopies.js` per i 138 di oggi (861 MB): anteprima, poi `--apply`.

**Ordine di rilascio, un OK per ognuno:** (1) il Passo 1: lo script **è** quello che gira in produzione (l'unità lo lancia dal repository), quindi cambiarlo è rilasciarlo; (2) il server 2.27.0 con il ritiro **spento**; (3) l'anteprima dei 138; (4) `--apply`; (5) `RETIRE_PUBLISHED=1`. **Il Passo 2 non parte mai prima del Passo 1:** con lo specchio che cancella, un ritiro farebbe sparire la replica (D5).

## 6. Cosa cambia, e domande aperte

- ⚠️ **La chiavetta diventa l'unico esemplare** dei brani ritirati. Chiavetta rotta, formattata o scambiata: il brano non c'è più sul server. Il registro resta (artista, titolo) e `reconcilePublished` lo vede mancare (404 con la chiavetta presente) e lo rimette in coda, **ma YouTube può non averlo più o darne un'altra versione** (oggi 24 righe su 170 del registro sono `no_source`).
- ⚠️ **Con la chiavetta fuori** (la tolgo per la Tesla, ADR-0010 §9) il server **non serve** i brani ritirati: Mondrop non può **scaricarli** (quelli già sul telefono suonano) e il player del sito ripiega su YouTube. Oggi il disco di geekom copre questo caso; ADR-0010 §9 evita solo che la chiavetta tolta faccia scaricare tutto da YouTube.
- ✅ Libera 861 MB su geekom (oggi 159 GB liberi su 937: non è un'urgenza) e il disco non cresce più a ogni brano.
- ✅ **Il Passo 1 vale da solo:** smette i 158 MB notturni, il giro da 1 min 50 s a ogni download e le cancellazioni a cascata, e non sposta nessun brano.
- **Q1.** Accetti i due ⚠️ del Passo 2, o ti fermi al Passo 1 (geekom resta la copia di sicurezza)?
- **Q2.** Il resto di `~/Music` (le cartelle di Spooty, 524 file) deve **smettere** di cancellare sulla chiavetta quando cancelli su geekom? Default: sì.
- **Q3.** Un brano nuovo di **Spooty** va sulla chiavetta **subito** o va bene di notte? Default: di notte (come oggi).

## 7. Test (da scrivere prima del codice)

- R3 con HEAD, volume e disco finti: ritira / non ritira (byte diversi, chiavetta assente, rete giù, file fuori dallo store, riga non `ytdlp`, non `published`).
- R4: `fileVersion` prima e dopo il ritiro è **la stessa stringa**.
- R5: se `rm` fallisce la riga è già giusta e il file resta (l'anteprima lo elenca); se l'aggiornamento della riga fallisce il file **non** si toglie.
- Spento (`RETIRE_PUBLISHED` diverso da `1`) non fa niente; l'anteprima non scrive niente.
- Passo 1: `.publish-list` contiene i non pubblicati e solo quelli; lo script con una lista vuota non fa niente; con un file sostituito lo manda; **mai** `--delete` negli script (un test legge il sorgente, come `RulePTests`). Prova con cartelle temporanee e `rsync` vero.
- Rotture volute (mutazioni) sul codice nuovo, come per le build di Mondrop.
