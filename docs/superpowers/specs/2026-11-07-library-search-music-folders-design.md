# Ricerca nella libreria: libreria, media server, cartelle locali — design

- **Data:** 2026-11-07
- **Stato:** In implementazione (versione 2.8.0). Nessun deploy senza OK di Michele
- **Owner:** Michele
- **Correlati:** `2026-11-07-web-player-ux-design.md` (W8: percorso/URL visibili), `2026-11-07-mp3-store-media-server-design.md`, `adr/0011-library-search-and-music-folders.md`

## 1. Richiesta di Michele (testuale)

1. «nella ricerca della libreria devo poter cercare fra : tutte quelle della libreria, tutte quelle del media server, e tutte quelle nel filesystem locale di spooty e altre cartelle di music da poter configurare in configurazione web. Ad esempio "Maestro Bassi" ne ho già scaricate in passato, non so dove sono.»

2. (risposta di Michele alla domanda su quali cartelle montare) «per ora ok cartella /music di spooty e anche ~/Music se non è la stessa di spooty.» → **`~/Music` e la cartella di Spooty sono la stessa** (host `/home/mike/Music`: Spooty la monta come `/data/downloads`, il backend come `/music`), quindi basta `/music`: nessun mount extra per ora. Le cartelle extra restano configurabili (L4, L8) ma non c'è nulla da montare finché Michele non ne indica altre.

*(Fatto verificato: sul disco di geekom esiste `~/Music/Bassi Maestro/` con brani scaricati in passato da Spooty, ma nessuno è nel journal, quindi la pagina Canzoni non li trova. Nota: Michele scrive «Maestro Bassi», l'artista è «Bassi Maestro»: l'ordine delle parole non deve contare.)*

## 2. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| L1 | Dove si cerca | Tre ambiti più «Tutto»: **Libreria** (le canzoni del journal, quelle che l'app già conosce) · **Media server** (tutto il catalogo del Fritz, `media_index`) · **File locali** (la cartella di Spooty, cioè `/music` = `~/Music` di geekom, **più** le cartelle extra configurate) |
| L2 | Come si cerca | Testo libero, **ordine delle parole ininfluente** («Maestro Bassi» trova «Bassi Maestro»), senza maiuscole né accenti, su artista, titolo, album **e percorso** (così trova anche una cartella intera, es. `Bassi Maestro/`). Tutte le parole devono comparire (AND) |
| L3 | Cosa si vede di un risultato | Ambito (badge), `artista – titolo`, album, **dove sta** (percorso su disco o URL del media server, come W8), dimensione; i brani già nel journal sono segnati. Numero di risultati per ambito anche oltre il limite mostrato |
| L4 | Cartelle extra | Si configurano nella **configurazione web** («Cartelle musica»): elenco di percorsi, ognuno con etichetta e interruttore on/off; solo admin; **solo dentro le radici consentite** (le cartelle montate nel container: `/music` e quelle di `MUSIC_EXTRA_ROOTS`); sola lettura, mai scritte; scansione in background (all'avvio, ogni 30 minuti, subito dopo una modifica) |
| L5 | Limiti di sicurezza e di costo | Max 100 risultati per ambito e per richiesta; scansione di una cartella: max 200 000 file e profondità 12; si saltano `._*`, file nascosti e quelli che non sono audio (`.mp3 .m4a .flac .ogg .opus .wav .aac`); i collegamenti simbolici non si seguono |
| L6 | Che cosa NON fa ancora | Trovare un file **non** lo importa nel journal né lo mette in una playlist né lo suona: è una ricerca per sapere *dove sono* i brani. Il passo successivo («Importa nella libreria», che li rende canzoni normali) va confermato da Michele |
| L7 | Chi può cercare | Ogni utente loggato (come la pagina Canzoni); chi può **cambiare** le cartelle è solo l'admin |
| L8 | Dove le cartelle extra devono stare | Nel container si vede solo ciò che è montato: `/music` (= `~/Music`, dove scrive anche Spooty) c'è già; altre cartelle dell'host vanno **montate in sola lettura** in `docker-compose.yml` sotto `MUSIC_EXTRA_ROOTS` (default `/music-extra`); il montaggio è un'operazione di deploy, non della pagina di configurazione |

## 3. API

`GET /api/library/search?q=<testo>&scope=all|songs|media|local&limit=100`

```json
{ "q": "maestro bassi", "scope": "all",
  "counts": { "songs": 0, "media": 2, "local": 41 },
  "results": [
    { "scope": "local", "artist": "Bassi Maestro", "title": "Foto di gruppo", "album": null,
      "folder": "Libreria (Spooty)", "location": "~/Music/Bassi Maestro/Bassi Maestro - Foto di gruppo.mp3",
      "bytes": 5123456, "songKey": "bassi maestro::foto di gruppo", "inJournal": false } ] }
```

- `scope=songs`: le canzoni del journal visibili all'utente (`location` = `null`; `inJournal` = true).
- `scope=media`: `location` = URL diretto sul media server, `folder` = «Media server».
- `scope=local`: `location` = percorso su disco con la radice mostrata come etichetta (`~/Music/…` per la libreria, `<etichetta cartella>/…` per le extra).
- `q` vuoto o più corto di 2 caratteri → `400 { "error": "query_too_short" }`.

`GET /api/config/music-folders` → `{ roots: [{ path, label, builtIn }], folders: [{ id, path, label, enabled, status, files, scannedAt }] }`
`POST /api/config/music-folders` (admin) con `{ folders: [{ path, label?, enabled? }] }` → sostituisce l'elenco; `400 { error: "folder_outside_roots" | "folder_missing" | "folder_not_directory" | "too_many_folders" }`.
`GET /api/config/music-folders/browse?path=` (admin) → sottocartelle di un percorso consentito, per il selettore.

## 4. Dati e architettura

Nessuna tabella nuova: l'elenco delle cartelle è una riga della tabella `config` (`music_folders`); gli indici (catalogo del Fritz e file locali) stanno in memoria, ricaricati ogni 60 secondi (media server, dalla tabella `media_index` che esiste già) e ogni 30 minuti (cartelle, scansione del disco). Ogni voce porta un testo di ricerca già normalizzato.

## 5. Interfaccia (web)

Selettore «Cerca in: Libreria · Media server · File locali · Tutto» accanto al campo di ricerca delle canzoni, con il numero di risultati per ambito; ogni risultato mostra badge dell'ambito, `artista – titolo`, album, il **percorso/URL copiabile**, dimensione, e «già in libreria» se c'è nel journal. Nella pagina di configurazione una sezione **Cartelle musica**: radici consentite, elenco delle cartelle con etichetta/interruttore/stato (n. file, ultima scansione), aggiunta tramite selettore di cartelle (admin).

## 6. Test

Ricerca: ordine delle parole, accenti/maiuscole, ricerca sul percorso, AND tra le parole, limite e conteggi, ambiti. Cartelle: percorso fuori dalle radici rifiutato (anche con `..` e collegamenti), cartella mancante, `._*` e non-audio saltati, tetto di file/profondità, interruttore off, ricarica dopo una modifica. Sicurezza: nessun endpoint serve file arbitrari (la ricerca restituisce solo l'indice).
