# La copertina nel player di Mondrop, cercata su Internet se manca (richiesta 2026-11-08)

Stato: **in costruzione** (server 2.14.0; nell'app confluisce nella Mondrop 1.7.0, mai caricata prima: la build 8 non era ancora arrivata a Apple). ADR: `adr/0019-the-server-finds-and-serves-the-covers.md`.
Contesto: dopo «Cerca» (spec `2026-11-08-mondrop-search-spotify-style-design.md`) nel player si possono suonare anche brani che esistono solo come file (NAS, geekom): per quelli oggi il player non ha nessuna copertina vera.

## 1. Richiesta di Michele (testuale)

> «Nel player iOS voglio avere la copertina del disco o della canzone se non c'è trovale su Internet, come le parole.»

Regola P (stessa giornata, vale anche qui): i client parlano **sempre e solo con SoundReel**; dove si trova una cosa, e quanti posti ci sono, lo sa il server.

## 2. Com'è oggi (misurato l'8 novembre)

- Una traccia porta `coverUrl` solo se il **diario** ha già arricchito la canzone (Deezer o iTunes, `song_meta.cover_url`) o se il download da YouTube ha lasciato una miniatura. Un brano **solo-file** non ha nessuna riga `song_meta`: `coverUrl: null`.
- Il player (`CoverView`) e la schermata di blocco (`MPNowPlayingInfoCenter`) caricano `coverUrl` **direttamente dal sito del fornitore** (un indirizzo di iTunes o Deezer) senza passare da SoundReel, e senza copia sul telefono: offline la copertina sparisce. Se manca o non si carica, l'app **disegna** una copertina finta (`GeneratedCover`).
- Le **parole** (testo): oggi sono la **trascrizione del post** che nomina la canzone (se c'è) oppure quello che si incolla a mano nel foglio «Parole / lyrics». Per un brano solo-file non c'è né l'una né l'altra. Il server **non cerca** i testi su Internet.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

*Misurato sui dati veri prima del deploy:* nei file scaricati da Spooty l'immagine dentro l'MP3 è una **foto dell'artista di 160×160, la stessa in tutti i brani** di un artista (non una copertina): per questo la copertina del file vale solo se è abbastanza grande (300 px, le vere copertine dei dischi ripresi dal CD sono da 500 px in su); sotto, si guarda prima Internet e quella piccola resta l'ultima scelta. Con le regole sotto: *Capirai* di Bassi Maestro trova da Deezer la copertina vera di «L'ultimo testimone» (800×800), *Giorni matti*, *S.I.C.* e *Foto di gruppo* quella di «30ANNI» (l'unico disco in cui iTunes le ha), *Nightcall* e *Odd Look* di Kavinsky quella già nota, ingrandita (600 e 800 px).

| # | Decisione | Default scelto |
|---|-----------|----------------|
| C1 | **Chi cerca la copertina** | Il **server**. L'app chiede a SoundReel e basta: non parla mai con iTunes, Deezer o altri siti (regola P). Una rotta nuova `GET /api/mondrop/songs/:key/cover` risponde con l'immagine |
| C2 | **Dove la cerca, in ordine** | (1) la copertina che il server **già conosce** (diario: Deezer/iTunes), (2) la copertina **dentro il file** MP3 (ID3, `APIC`) se è quasi quadrata **e grande (almeno 300 px)**, (3) **Internet**: iTunes, poi Deezer, **solo con un riscontro forte** (artista e titolo coincidono: meglio nessuna copertina di una sbagliata), (4) la copertina del file anche se piccola o non quadrata (ritagliata al centro), (5) altrimenti l'app disegna quella finta come oggi |
| C3 | **Una volta sola** | Il server **tiene** la copertina trovata (su disco, già ridimensionata a 800×800) e ricorda anche «non c'è» per 3 giorni: Internet si interroga una volta per canzone, non a ogni ascolto. iTunes ha un limite di richieste: le ricerche passano da una coda con pausa |
| C4 | **Disco o canzone** | Si vuole «la copertina del disco o della canzone»: si prende quella che c'è, senza distinguere. Un brano con un album noto trova quella dell'album |
| C5 | **Dove si vede** | Nel **player** (copertina grande) e nella **schermata di blocco / Centro di controllo**. Nelle liste di brani no (non servono e costerebbero una richiesta a riga) |
| C6 | **Offline** | L'app **tiene sul telefono** le copertine che ha visto (cartella dei dati temporanei di iOS): un brano scaricato mostra la sua copertina anche senza rete. Una copertina non trovata si riprova al prossimo ascolto con rete |
| C7 | **Contratto** | Ogni traccia ha `coverPath` (percorso relativo come `downloadPath`, sempre presente: `/api/mondrop/songs/<key>/cover`). `coverUrl` resta com'è per le app già installate. La rotta risponde `200` con l'immagine (JPEG o PNG, `Cache-Control` privato, `ETag`) o `404` se non c'è nessuna copertina |
| C8 | **Il sito web** | Fuori da questa richiesta («player iOS»). La rotta nasce per Mondrop; il sito potrà usare la stessa logica |

## 4. Le parole, «come le parole» (domanda aperta per Michele)

La frase finale della richiesta si può leggere in due modi: (a) «come ho le parole», cioè la copertina deve esserci come ci sono già le parole; (b) «trova su Internet **anche le parole** quando mancano», com'è per la copertina. Per le copertine non cambia nulla. Per le **parole** (b) vorrebbe dire: quando un brano non ha testo, il server lo cerca su Internet (per esempio LRCLIB, un archivio libero di testi) e lo tiene come per le copertine. **Risposta di Michele (8 novembre), testuale: «Sì, cercale su Internet»** — cioè la lettura (b): quando un brano non ha testo, il server lo cerca su Internet e lo tiene come le copertine. **Release a parte** (SoundReel 2.17.0 (era la 2.16.0, fino alla ricerca nelle playlist dell’8 novembre) e l'app: il campo `lyrics` c'è già nelle tracce, ma le liste e la ricerca non lo mandano e il player lo legge solo da quello che ha già). Servirà un'ADR (da dove si prendono i testi, cosa si tiene, i limiti dei fornitori) e una spec propria. Non è costruito.

## 5. Test

- **Backend:** il lettore ID3 (`APIC` v2.2/2.3/2.4, de-sincronizzazione, intestazione estesa, tipo «copertina frontale», file senza immagine, tag troncato o corrotto); l'ordine delle fonti (diario, file, Internet, file ritagliato); un riscontro debole non vale; l'immagine è ridimensionata e tenuta; «non c'è» è ricordato e poi riprovato; due richieste insieme fanno una ricerca sola; la rotta (401, 404, 200 con tipo e `ETag`, `If-None-Match` → 304); `coverPath` nelle tracce (anche solo-file); nessuna richiesta a Internet nei test (finta).
- **App:** il caricatore (indirizzo = base + `coverPath`, intestazioni della key, copia su disco e in memoria, `404` ricordato per la sessione, risposta che non è un'immagine, offline con la copia), il lettore che pubblica i byte della copertina e li usa anche per la schermata di blocco, la copertina finta solo se non c'è niente.
- **Prova reale:** «Bassi Maestro – Capirai» (solo-file) mostra la copertina dell'album nel player e sulla schermata di blocco.

## 6. Le domande per Michele e le sue risposte (8 novembre)

1. **Le parole:** vuoi che il server cerchi su Internet anche i **testi** quando mancano (lettura b), oppure basta la copertina? Risposta: **«Sì, cercale su Internet»** (§4).
2. **Le liste:** la copertina piccola accanto a ogni brano della ricerca e delle playlist, come su Spotify? Risposta: **«No, solo nel player»** (come chiesto: «nel player iOS»). Resta fuori dalla 1.7.0.
3. **Il deploy della 2.14.0:** **«Sì, deploy ora»**.

## 7. Ordine di costruzione

1. **SoundReel 2.14.0 (server):** lettore ID3, servizio copertine con tenuta su disco, ricerca su iTunes/Deezer, `GET /api/mondrop/songs/:key/cover`, `coverPath`.
2. **Mondrop 1.7.0 (app, build 8):** caricatore con copia sul telefono, il player e la schermata di blocco usano `coverPath`. Stessa build di «Cerca» (la 1.7.0 non era ancora stata caricata). TestFlight dopo il deploy del server.
3. Il **piano di riproduzione del player web** (S11 della spec di «Cerca») slitta alla **2.15.0**.
