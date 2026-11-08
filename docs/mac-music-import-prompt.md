# Prompt per Claude Code sul Mac — musica del disco esterno → media server

**Come usarlo:** sul Mac crea una cartella di lavoro (`mkdir -p ~/MacMusicImport && cd ~/MacMusicImport`), lancia `claude` lì e incolla **tutto ciò che sta sotto la riga `=== INIZIO PROMPT ===`** fino a `=== FINE PROMPT ===`. La password della FRITZ!Box **non** è nel prompt: la digiti tu quando macOS la chiede. Il Mac deve essere sulla stessa rete di casa (192.168.178.x), meglio via cavo: 20–50 GB via Wi-Fi sono lenti.

Spec e decisioni: `docs/superpowers/specs/2026-11-07-mac-music-import-design.md` · ADR: `adr/0012-mac-music-import-writes-only-macmusic.md`.

=== INIZIO PROMPT ===

Sei Claude Code sul Mac di Michele. Compito: **copiare tutta la musica** del disco esterno `/Volumes/MacBook M1 - disk2/Music` sul **media server di casa** (la chiavetta USB della FRITZ!Box), **convertendo in MP3 solo ciò che serve**, **senza perdere qualità**, **senza duplicati** (né tra i file del Mac né rispetto a quello che il media server ha già), **portando tutti i metadati che il media server sa usare**. Procedi per fasi e **fermati alla Fase 3 per l'OK esplicito di Michele** prima di scrivere qualsiasi cosa sul media server. Rispondi a Michele in italiano.

## 1. Dati di connessione (esatti)

| Cosa | Valore |
|------|--------|
| Dispositivo | FRITZ!Box (media server DLNA + NAS USB) |
| **Indirizzo IP** | **`192.168.178.10`** — NON usare il nome `fritz.box`: su questa rete risolve a un IPv6 pubblico irraggiungibile. `192.168.178.1` è un router MikroTik, **non** la FRITZ!Box |
| Protocollo | **SMB 3** (SMB1 è disattivato sulla box), porta 445 |
| Share | **`FRITZ.NAS`** → `smb://192.168.178.10/FRITZ.NAS` |
| **Login (utente)** | **`geekom`** |
| **Password** | **NON è in questo prompt.** Chiedila a Michele e fai digitare a lui la password nella finestra di macOS (Finder) o al prompt di `mount_smbfs`. **Mai** scriverla in file, script, log, cronologia della shell, variabili d'ambiente, commit. Se macOS offre «Ricorda questa password nel portachiavi», va bene solo se la sceglie Michele |
| Volume (la chiavetta) | cartella **`TESLA_MEDIA`** dentro lo share (è il drive media della Tesla: 120 GB, ~44 GB usati, ~76 GB liberi misurati il 2026-11-07) |
| Catalogo DLNA (solo lettura) | `http://192.168.178.10:49000/MediaServer/ContentDirectory/Control` |
| URL dei file serviti | `http://192.168.178.10:49200/AUDIO/DLNA-1-0/<percorso relativo a TESLA_MEDIA>` (percorso con ogni componente percent-encoded) |

**Montaggio sul Mac** (due modi equivalenti, scegli il primo):

```bash
open "smb://geekom@192.168.178.10/FRITZ.NAS"          # Finder chiede la password → /Volumes/FRITZ.NAS
# oppure, da terminale (chiede la password sul tty):
mkdir -p ~/mnt/fritz && mount_smbfs "//geekom@192.168.178.10/FRITZ.NAS" ~/mnt/fritz
mount | grep 192.168.178.10                              # verifica
ls "/Volumes/FRITZ.NAS/TESLA_MEDIA"                      # deve elencare Movies, Music, ...
```

Se `TESLA_MEDIA` non compare, **fermati e dillo a Michele** (chiavetta scollegata o scambiata).

## 2. Directory (esatte) e regola d'oro

- **SORGENTE** (SOLA LETTURA, non modificarla mai, nemmeno i tag): `/Volumes/MacBook M1 - disk2/Music` — il nome ha spazi: **sempre tra virgolette**. Al primo accesso macOS può chiedere al Terminale il permesso per i volumi rimovibili: Michele deve concederlo.
- **DESTINAZIONE** (l'**unica** cartella in cui puoi scrivere): `/Volumes/FRITZ.NAS/TESLA_MEDIA/Music/SoundReel/_MacMusic/` (se hai montato in `~/mnt/fritz`: `~/mnt/fritz/TESLA_MEDIA/Music/SoundReel/_MacMusic/`). Nel catalogo DLNA diventa `Music/SoundReel/_MacMusic/…`. Creala se manca.
- **Area di lavoro locale** (sul Mac, NON sulla chiavetta): `~/MacMusicImport/` con `staging/` (file convertiti), `manifest.sqlite` (stato di ogni file, per poter riprendere), `report/` (piani e rapporti).

**Regola d'oro: scrivi SOLO sotto `_MacMusic/`.** Su `TESLA_MEDIA` ci sono `Boombox`, `LicensePlate`, `ASSChime.wav`, `Movies`, `FRITZ`, `watchlist.html` e le cartelle degli altri artisti in `Music/`: sono dell'auto e di Michele, **non toccarle**. Mai `--delete`, mai `rm`/`mv`/rinomina fuori da `_MacMusic/`, mai scrivere in `Music/SoundReel/` fuori da `_MacMusic/` (un rsync notturno su geekom, alle 04:00, gestisce quella cartella e non cancella `_MacMusic/`). Non cambiare nessuna impostazione della FRITZ!Box.

## 3. Controlli preliminari (Fase 0)

1. Rete: `ping -c2 192.168.178.10` e `nc -z -G 3 192.168.178.10 445`.
2. Montaggio come sopra; verifica `TESLA_MEDIA`; mostra a Michele lo spazio libero (`df -h`). **Lascia almeno 15 GB liberi** sulla chiavetta: se la stima del Piano (Fase 3) non ci sta, dillo.
3. Strumenti, mostra le versioni: `ffmpeg`/`ffprobe` **con `libmp3lame`** (`ffmpeg -hide_banner -encoders | grep mp3lame`), `python3` con `mutagen`, `rsync` **3.x** (quello di sistema può essere `openrsync`, con meno opzioni). Se mancano: `brew install ffmpeg rsync` e `python3 -m pip install --user mutagen` (chiedi a Michele prima di installare).
4. Spazio libero sul Mac per lo staging (stima: dimensione della musica da convertire × 1,2).

## 4. Fase 1 — Inventario (nessuna scrittura sulla chiavetta)

- Scansiona ricorsivamente la sorgente. **Audio da considerare:** `.mp3 .m4a .aac .flac .aif .aiff .wav .ogg .opus .wma .ape .wv` (`.m4a` può essere AAC *oppure* ALAC lossless: guarda il codec con ffprobe).
- **Ignora** (e conta nel report): file `._*` e `.DS_Store`; cartelle `.Trashes`, `.Spotlight-V100`, `.fseventsd`, `.TemporaryItems`; librerie e playlist (`*.musiclibrary`, `*.itl`, `*.xml`, `*.m3u*`); immagini, PDF, video; i file < 200 KB (elencali); i **DRM Apple `.m4p`** (non convertibili: solo in elenco); e tutto ciò che **non è musica**: podcast, audiolibri, voice memo, video musicali, suonerie (cartelle `Podcasts`, `Audiobooks`, `Books`, `Movies`, `TV Shows`, `Tones`, `Voice Memos`; atomo MP4 `stik` diverso da musica; genere «Podcast»/«Audiobook»).
- Per ogni file leggi con `ffprobe` + `mutagen`: contenitore, codec, bitrate, frequenza, canali, durata, **tag** (titolo, artista, artista album, album, traccia n/tot, disco n/tot, anno/data, genere, compositore, commento, testo, compilation, BPM, tag di ordinamento) e se c'è la **copertina** (incorporata, oppure `cover.jpg`/`folder.jpg` nella cartella). Salva tutto in `manifest.sqlite`.
- I nomi dei file su macOS sono in Unicode **NFD**: normalizza in **NFC** prima di confrontare nomi.

## 5. Fase 2 — Duplicati (due livelli)

**A. Tra i file del Mac.** Chiave = `artista|titolo` normalizzati: minuscolo, NFKD senza accenti e punteggiatura, spazi compressi; ignora nel titolo `remaster(ed) …`, `digital remaster`, `deluxe`, `bonus track`, `feat./ft./featuring …`. **Versioni diverse NON sono duplicati**: se compare `live`, `remix`, `mix`, `edit`, `acoustic`, `demo`, `instrumental`, `karaoke`, `cover`, `bootleg`, `unplugged`, `session`, `mono` in uno solo dei due, sono registrazioni distinte (si copiano entrambe). Due file con la stessa chiave sono duplicati solo se la **durata differisce ≤ 3 s**; altrimenti restano entrambi. Fra i duplicati vince **uno solo**: 1) lossless su lossy; 2) bitrate più alto; 3) con album e non-compilation (meglio l'album originale della raccolta «Greatest Hits»); 4) con copertina; 5) file più grande; 6) a parità, percorso in ordine alfabetico. Gli altri: `skip-duplicate-mac` (con il percorso del vincitore nel report), **non** si copiano.

**B. Rispetto a quello che il media server ha già.** Scarica il catalogo con una *Search* DLNA (**sola lettura**), a pagine da 200 fino a `TotalMatches` (≈ 6 450 voci, ~30 s):

```
POST http://192.168.178.10:49000/MediaServer/ContentDirectory/Control
Content-Type: text/xml; charset="utf-8"
SOAPAction: "urn:schemas-upnp-org:service:ContentDirectory:1#Search"

<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"
 s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>
<u:Search xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1"><ContainerID>0</ContainerID>
<SearchCriteria>upnp:class derivedfrom &quot;object.item.audioItem&quot;</SearchCriteria>
<Filter>dc:title,dc:creator,upnp:artist,upnp:album,upnp:genre,res,res@size,res@duration</Filter>
<StartingIndex>0</StartingIndex><RequestedCount>200</RequestedCount><SortCriteria></SortCriteria>
</u:Search></s:Body></s:Envelope>
```

La risposta contiene un `<Result>` con XML DIDL-Lite *escapato*: fai l'unescape e leggi gli `<item>`. Trappole verificate sulla box reale:
- circa **3 000 voci sono spazzatura**: file ombra di macOS il cui nome inizia per `._` (4 096 byte) → ignorali, insieme ai file < 200 KB; considera solo `.mp3` veri;
- l'artista è `upnp:artist role="Performer"` (o `dc:creator`); la **durata è spesso `0:00:00.000` (sconosciuta)**;
- il percorso del file è nell'URL di `<res>` dopo `/AUDIO/DLNA-1-0/` (decodificalo; nei nomi vecchi compaiono caratteri privati U+F0xx al posto di `:` ecc.).
Salva il catalogo in `report/fritz-catalog.json`. **Non** scandire l'albero SMB con `find`/`ls -R`: su questa box è lentissimo (oltre 90 s e va in timeout). Se il DLNA non risponde, riprova o fermati.

Un brano del Mac è **«già sul media server»** se nel catalogo c'è una voce con la stessa chiave normalizzata (stesse regole sulle versioni). Se la durata della voce della box è nota (≠ 0) deve differire ≤ 3 s; se è 0, misurala **solo per i candidati** con `ffprobe "http://192.168.178.10:49200/AUDIO/DLNA-1-0/<percorso percent-encoded>"`. Se è già lì: `skip-on-fritz` (scrivi dove sta), **non** copiare.

**C.** Le esecuzioni ripetute non duplicano mai: `manifest.sqlite` ricorda sorgente → destinazione di ogni file.

## 6. Fase 3 — Piano e **OK di Michele** (ancora nessuna scrittura sulla chiavetta)

Produci `report/plan.md` e `report/plan.csv` con, per ogni file, l'azione (`copy` = MP3 copiato così com'è · `convert` · `skip-duplicate-mac` · `skip-on-fritz` · `skip-drm` · `skip-junk` · `skip-non-music`), il motivo e la destinazione. Riepilogo per Michele: numero di file per azione, GB di sorgente, **GB stimati da scrivere**, spazio libero risultante sulla chiavetta (deve restare ≥ 15 GB), elenco dei file **lossy → MP3** (perdita di generazione inevitabile), dei file senza tag essenziali e senza copertina, dei DRM. **Fermati e chiedi conferma esplicita; procedi solo dopo il suo OK.**

## 7. Fase 4 — Conversione e tag (solo in `staging/` locale)

**Formato di arrivo: MP3** (è il formato che la FRITZ!Box e l'archivio SoundReel usano; l'indice di SoundReel ignora i file non `.mp3`).

| Sorgente | Azione |
|----------|--------|
| `.mp3` | **Copia senza ricodificare** (audio identico bit a bit); sulla COPIA (mai sull'originale) riscrivi solo i tag in ID3v2.3 |
| Lossless: FLAC, ALAC (`.m4a`), AIFF, WAV, APE, WV | **MP3 VBR V0** (LAME, ~245 kbps, trasparente): `ffmpeg -i "IN" -map 0:a:0 -c:a libmp3lame -q:a 0 -ar 44100 -map_metadata 0 -id3v2_version 3 -write_id3v1 1 "OUT.mp3"`; `-ar 44100` se la frequenza di origine è multipla di 44 100 (44,1/88,2/176,4 kHz), **48000** se è multipla di 48 000; se è 44,1 o 48 kHz **non** ricampionare; **mantieni** stereo/mono come in origine |
| Lossy non-MP3: AAC, OGG, Opus, WMA | **MP3 V0** (la qualità massima praticabile; una perdita di generazione è inevitabile → elencali nel report). **Mai** convertire MP3 → MP3 |
| `.m4p` (DRM) | saltare |

Se Michele preferisce il massimo possibile: `-b:a 320k` al posto di `-q:a 0` (file più grandi); chiedi prima, non decidere tu.

**Validazione di ogni file prodotto:** `ffprobe` → codec `mp3`, nessun errore, **durata entro ±0,5 s** dall'originale (±1 s per le sorgenti lossy), dimensione > 200 KB, bitrate medio ≥ 190 kbps per le sorgenti lossless. Un file che non passa **non** va sulla chiavetta: finisce in `report/errori.csv`.

### Metadati — tutti quelli che il media server usa (verificato sul catalogo reale della box)

Il media server (FRITZ!Mediaserver) espone via DLNA: `dc:title`, `upnp:artist` (Performer), `upnp:artist role="AlbumArtist"`, `upnp:album`, `upnp:genre`, `upnp:originalTrackNumber`, `dc:date` (anno) e `upnp:albumArtURI` (la copertina **incorporata** nel file, estratta dalla box). Ogni MP3 che scrivi deve quindi avere **ID3v2.3** (non 2.4) con:

`TIT2` titolo · `TPE1` artista · `TPE2` artista album · `TALB` album · `TRCK` «n/totale» · `TPOS` «d/totale» (se multi-disco) · `TYER` anno a 4 cifre · `TCON` genere **come testo** («Rock», mai il codice numerico «(17)») · `TCOM` compositore · `COMM` commento · `USLT` testo · `TBPM` · `TCMP`=`1` se compilation · `TSOP`/`TSOA`/`TSOT` se presenti · **`APIC` copertina frontale (tipo 3), JPEG *baseline* (non progressivo), al massimo 600×600 px e 400 KB** (riduci, non ingrandire; se la sorgente non ha copertina ma c'è `cover.jpg`/`folder.jpg` nella cartella usa quella). Testo in UTF-16 (ID3v2.3) per i caratteri non latin-1. Scrivi anche un `folder.jpg` (stesso JPEG) una volta per cartella album.

Dopo la conversione **rileggi con mutagen e confronta con i tag della sorgente**: tabella per campo (ok / mancante). Se ffmpeg ne ha perso (tipico: `TCMP`, `TPOS`, `TCOM`, `USLT`, `TBPM`, artista album) **riscrivili con mutagen**. Se mancano titolo/artista/album, ricavali dal percorso (`Artista/Album/NN - Titolo.ext`) e segnalalo in `report/tag-derivati.csv`; se non sono ricavabili, **non inventare**: il file va in `report/senza-tag.csv` e non si copia.

### Nomi e cartelle di destinazione (la chiavetta è exFAT)

`_MacMusic/<Artista album>/<Album>/<[D-]NN> - <Titolo>.mp3` — prefisso disco «1-» solo se multi-disco; senza numero di traccia: `<Titolo>.mp3`. Compilation: `Various Artists/<Album>/`. Senza album: `<Artista>/Singoli/`. Regole: Unicode **NFC**; sostituisci `\ / : * ? " < > |`, i caratteri di controllo e i caratteri privati U+F000–U+F0FF con `-` o spazio; niente punti o spazi finali; massimo 120 caratteri per componente e percorso totale < 240; in caso di collisione aggiungi ` (2)`.

## 8. Fase 5 — Copia sulla chiavetta (solo dopo l'OK di Michele)

- Copia **solo** da `staging/` verso `/Volumes/FRITZ.NAS/TESLA_MEDIA/Music/SoundReel/_MacMusic/`, **un album alla volta**, con `COPYFILE_DISABLE=1` e rsync 3.x:
  `rsync -rt --partial --timeout=180 --no-perms --no-owner --no-group --exclude '._*' --exclude '.DS_Store' --exclude '*.part' "staging/<album>/" "…/_MacMusic/<album>/"`
  **Mai** `-E`, `-X`, `-A` (creano file `._*` sullo share), **mai** `--delete`, mai un percorso di destinazione diverso da `_MacMusic/`.
- Dopo ogni album: confronta numero e dimensione dei file (e `shasum`/`cmp` a campione). A fine lavoro pulisci **solo dentro `_MacMusic/`** i file `._*`, `.DS_Store` e i temporanei di rsync (`.nome.mp3.XXXXXX`).
- Se il montaggio cade: rimonta (password a Michele) e **riprendi** dal manifest; non ripartire da zero, non ricopiare quello che c'è già con la dimensione giusta.

## 9. Fase 6 — Verifica finale e rapporto

1. Conteggio e byte: manifest vs. chiavetta, nessun `._*` in `_MacMusic/`.
2. 20 file a caso: `ffprobe` direttamente dall'URL DLNA `http://192.168.178.10:49200/AUDIO/DLNA-1-0/Music/SoundReel/_MacMusic/…` (la box può metterci minuti o ore a indicizzare i file nuovi: **non** forzare nulla sulla FRITZ!Box senza chiedere).
3. Quando compaiono nel catalogo DLNA, fai una *Search* sulle voci copiate (con `<Filter>*</Filter>`) e controlla che `dc:title`, `upnp:artist`, `upnp:album`, `upnp:genre`, `upnp:originalTrackNumber`, `dc:date`, `upnp:albumArtURI` siano presenti; riporta le eccezioni.
4. `report/final.md`: copiati / convertiti / duplicati saltati (con il percorso dell'originale) / già sul media server (con dove) / DRM / non-musica / senza tag / errori; GB scritti, spazio rimasto, tempi.
5. **Non cancellare niente**: `staging/` resta finché Michele non dice di toglierlo.

## 10. Non farlo mai

- Scrivere, rinominare o cancellare fuori da `…/TESLA_MEDIA/Music/SoundReel/_MacMusic/`; usare `--delete`/`rm -rf` sulla chiavetta; toccare `Boombox`, `LicensePlate`, `ASSChime.wav`, `Movies`, `FRITZ`, `watchlist.html` o le altre cartelle di `Music/`.
- Modificare la sorgente (file, tag, nomi) o creare file nel disco esterno.
- Salvare o stampare la password; cambiare impostazioni della FRITZ!Box.
- Inviare file o tag della libreria a servizi esterni (lookup online dei tag solo se Michele lo chiede).
- Procedere oltre la Fase 3 senza l'OK esplicito di Michele; indovinare quando qualcosa non torna: **fermati e chiedi**.

=== FINE PROMPT ===
