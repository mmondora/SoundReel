# Import della musica del Mac sul media server — design

- **Data:** 2026-11-07
- **Stato:** Prompt consegnato (`docs/mac-music-import-prompt.md`); l'esecuzione la fa il Claude Code sul Mac di Michele, non questo repo
- **Owner:** Michele
- **Correlati:** `adr/0012-mac-music-import-writes-only-macmusic.md`, ADR-0006, `scripts/fritz-sync.sh`

## 1. Richieste di Michele (testuali, in ordine)

1. «volgio anche poter copiare tutte le musiche presenti sul mio pc osx, sul disco esterno /Volumes/MacBook M1 - disk2/Music sul media server - evidentemente convertite se necessario nel formato, mantenedo la qualità, e pure evitando duplicati. devono portare tutti i metadati che il media server sa usare. Dammi un prompt per il claude code che ho sul mac.»
2. «il prompt deve essere preciso ed indicare ip/login/directory in dettagli per fare la copia»
3. (sui file ombra `._*` della chiavetta) «i file fantasma vanno cancellati, salvo servano al media server.»

## 2. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| M1 | Chi copia | Il **Mac** (Claude Code sul Mac), direttamente sullo share SMB della FRITZ!Box. Il backend di SoundReel non scrive mai sul Fritz (ADR-0006) e non c'entra |
| M2 | Dove | `TESLA_MEDIA/Music/SoundReel/_MacMusic/` (SMB: `smb://192.168.178.10/FRITZ.NAS`, utente `geekom`). **Solo lì**: la chiavetta è il drive media della Tesla (contiene `Boombox`, `LicensePlate`, `ASSChime.wav`, `Movies`, `Music/<altri>`) e la regola di progetto è scrivere solo in `Music/SoundReel` e `Movies/SoundReel` |
| M3 | Protezione dal mirror notturno | `scripts/fritz-sync.sh` (04:00, `rsync --delete` su `Music/SoundReel`) ora esclude `/_MacMusic/`: senza, cancellerebbe ogni notte quello che il Mac ha copiato (la cartella non esiste in `~/Music`). Provato con un rsync su cartelle temporanee |
| M4 | Formato | **MP3** (formato dell'archivio SoundReel; l'indice del media server di SoundReel ignora i non-`.mp3`). MP3 sorgente: copiato **senza ricodificare**. Lossless (FLAC, ALAC, AIFF, WAV, APE, WV) → **MP3 VBR V0** (LAME). Lossy non-MP3 (AAC, OGG, Opus, WMA) → MP3 V0 con avviso di perdita di generazione. DRM `.m4p` saltati. 320 kbps CBR solo se Michele lo chiede |
| M5 | Duplicati | Due livelli: tra i file del Mac (chiave `artista\|titolo` normalizzata + durata ±3 s; versioni live/remix/acoustic/… **non** sono duplicati; vince la migliore: lossless > bitrate > album originale > copertina > dimensione) e **contro il catalogo del media server** (DLNA Search, sola lettura, ignorando i ~3 000 file ombra `._*` che sporcano il catalogo) |
| M6 | Metadati | ID3v2.3 con tutto ciò che la box espone via DLNA (verificato sul catalogo reale: `dc:title`, `upnp:artist` Performer e AlbumArtist, `upnp:album`, `upnp:genre`, `upnp:originalTrackNumber`, `dc:date`, `upnp:albumArtURI` = copertina **incorporata**) più disco, compositore, commento, testo, BPM, compilation, ordinamenti; copertina JPEG baseline ≤ 600×600 e `folder.jpg` per album |
| M7 | Cautele | Sorgente sola lettura; password **mai** nel prompt né salvata (la digita Michele); niente `._*`/`.DS_Store` sulla chiavetta (`COPYFILE_DISABLE=1`, rsync 3.x senza `-E/-X/-A`); nomi exFAT-safe in Unicode NFC; almeno 15 GB liberi (oggi 120 GB totali, ~44 usati, ~76 liberi); piano + **OK esplicito** prima di scrivere; esecuzione riprendibile (manifest) |
| M8 | Dopo la copia | I file entrano nel catalogo DLNA (la box può metterci minuti/ore) e nell'`media_index` di SoundReel (ogni ora): da lì il backend può **adottarli** («riuso») senza copiarli, e compaiono nella ricerca «Media server» (spec ricerca) |

## 3. Fatti verificati su questa rete (2026-11-07)

- FRITZ!Box `192.168.178.10`, SMB3 (`vers=3.0`, SMB1 spento), share `FRITZ.NAS` → volume `TESLA_MEDIA`; `fritz.box` risolve a un IPv6 irraggiungibile e `192.168.178.1` è un router MikroTik.
- Login dello share: utente `geekom` (la password sta solo in `~/.config/soundreel/fritz-credentials` su geekom, 0600, e non viaggia mai).
- Catalogo DLNA: 6 449 voci, di cui ~3 000 sono file ombra macOS `._*` da 4 096 byte (rimasugli di una vecchia copia da Mac); durata spesso `0:00:00.000`; `Music/` ha 736 voci di primo livello.
- La scansione dell'albero SMB con `find` è lentissima (oltre 90 s, timeout): il prompt impone il catalogo DLNA.

## 3 bis. Stato al 2026-11-08 01:40

La chiavetta **non è collegata** al Fritz: lo share espone solo la memoria interna (9,8 MB, con `.DS_Store`), il catalogo DLNA ha 1 voce. La pulizia dei fantasmi `._*` è stata **interrotta senza cancellare nulla** (la verifica della firma AppleDouble prima di ogni rimozione ha rilevato che i file non c'erano più: 0 rimossi, 0 errori). I 14 fantasmi di `~/Music` su geekom sono stati rimossi. Il sync notturno si ferma da solo (controllo del volume in `fritz-sync.sh`). Import dal Mac e pulizia ripartono quando la chiavetta torna.

## 4. Non incluso (da chiedere a Michele)

- Pulizia dei ~3 000 file ombra `._*` già presenti sulla chiavetta (fuori da `Music/SoundReel`): è una cancellazione sulla chiavetta della Tesla, serve un OK esplicito e un'operazione separata.
- Una versione per Mac che metta la musica in `~/Music` di geekom invece che direttamente sul Fritz (raddoppierebbe lo spazio su geekom).
