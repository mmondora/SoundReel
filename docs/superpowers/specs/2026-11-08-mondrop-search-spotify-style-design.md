# Mondrop e player web: cercare come su Spotify, e parlare sempre e solo con SoundReel (richiesta 2026-11-08)

- **Data:** 2026-11-08
- **Stato:** **Decisioni confermate da Michele l'8 novembre (sezione 6); in costruzione** (SoundReel 2.13.0 + Mondrop 1.7.0; il piano di riproduzione del player web, S11, in una release a parte: **costruito nella 2.15.0**). Le decisioni S1–S11 sono i default scelti, **confermati o corretti dalle sue risposte** (S11 è stato riscritto sulla sua risposta). L'architettura (cosa cerca la ricerca, come suona un brano che esiste solo come file) è nell'**ADR-0018**.
- **Owner:** Michele
- **Correlati:** `adr/0018-one-search-across-journal-library-and-nas.md`, `docs/superpowers/specs/2026-11-08-player-selection-and-filters-design.md` (ADR-0013: la Libreria di oggi), `docs/superpowers/specs/2026-11-07-library-search-music-folders-design.md` (ADR-0011: la ricerca del sito), `docs/mondrop-sync.md`

## 1. Richiesta di Michele (testuale)

> «Perché non c’è modo di trovare le musiche di bassi maestro ? Ci sono sul nas ?»
>
> «Da mondrop. E la ricerca la trovo molto confusa.  Io posso cercare anche senza avere/fare playlist, alla spotify»

> «Vigkio pero che la logica di avere 3 liste o store sia server in sounreel e non in mondrop. Quelo deve andare sempre e solo su soundreel»
>
> «Idem il player web ( locale o in internet )»

**La regola che ne viene (P):** i **client** (Mondrop **e** il player web, **in casa e da internet**) parlano **sempre e solo con SoundReel**. Che ci siano **tre elenchi o negozi** (il diario, i file di geekom, il catalogo del NAS), come si cerca in tutti e tre, quale usare per far suonare un brano e da dove servirlo, è **logica del server**: i client non la conoscono, non la replicano e non contattano mai il NAS, geekom o altro. Un client cambia solo se cambia il contratto con SoundReel.

**Come la leggo (da confermare):** in Mondrop si scrive un nome (un autore, un titolo, un album) e si **trova qualunque musica che c'è**, ovunque stia (NAS, geekom, diario), e **si suona con un tocco**, come in Spotify: senza aver prima creato una playlist e senza dover ragionare per «dimensioni» (Playlist, Album, Autori, Tipi, Anni).

## 2. Com'è oggi (misurato l'8 novembre, sola lettura)

- **Bassi Maestro c'è, in abbondanza:** sul NAS ci sono **45 file audio** in tre posti (10 nella replica `Music/SoundReel/Bassi Maestro/`, **32** nella sua cartella `Music/Bassi Maestro/` in otto album, 3 dall'import del Mac in `_MacMusic/`) e 10 su geekom (`~/Music/Bassi Maestro/`). Il DLNA del Fritz li indicizza bene (29 voci con artista «Bassi Maestro», più gli album). **Nel diario non c'è nessuna canzone sua** (0): non è mai arrivata da un post.
- **Perché Mondrop non la trova:** la schermata «Libreria» interroga `GET /api/mondrop/library`, che è **`getUserSongs`**, cioè **solo le canzoni del diario**. La musica che esiste solo come file (NAS, geekom) non è nel suo mondo. Né si potrebbe suonare: tutto il servizio dei file (`findSong` → `resolveSongServing`, `/api/mondrop/songs/:key/file`) parte da una canzone del diario, e una chiave che non c'è risponde `song_not_found`.
- **Perché è confusa:** la Libreria si apre sull'elenco delle **Playlist**; i «chip» scelgono una *dimensione* (Playlist, Album, Autori, Tipi, Anni, Brani) e la casella di ricerca filtra *quella dimensione*: scrivere «bassi maestro» mentre si guardano le playlist non mostra brani. Per suonare bisogna prima scegliere cosa si sfoglia, poi toccare, poi guardare «In coda».
- **Il sito è già un passo avanti:** «Cerca in» (ADR-0011) cerca in tre ambiti (diario, media server, cartelle locali) e trova i 10 brani di geekom; ma restituisce **indici** (dove sta il file), non brani da suonare, e a Mondrop non arriva (autenticazione con chiave).
- **Dove oggi i client scavalcano il server (misurato leggendo il codice):**
  - **Mondrop** ha logica di negozio e di rete **dentro l'app**: `DownloadURLChooser` mette in cima il **URL diretto del media server** (`mediaUrl`, HTTP sulla LAN del Fritz) quando `home` è vero, e solo dopo il proxy di SoundReel; `home` lo decide l'app chiedendo `GET /api/mondrop/net`; il contratto stesso dice «stream da `mediaUrl` (solo LAN)». L'app, in casa, parla quindi **direttamente col NAS**.
  - **Il player web** ha l'interruttore **«Sorgente»** (Auto / Internet / Media server, regole W5–W7 di `2026-11-07-web-player-ux-design.md`): `effectiveSource(mode, network, location)` sceglie **nel browser** fra media server, disco di geekom e **YouTube** in base alla rete (`GET /api/net`) e a dove sta il file; **da internet suona da YouTube**, non da SoundReel («per non caricare la banda di casa»); al primo play di un brano senza file parte subito da YouTube e scarica in parallelo. La scelta del negozio, cioè, è nel client.
  - Il **sito** per i file chiede già tutto a SoundReel (`/api/songs/:key/file` fa da proxy al Fritz e al disco): è la scelta della sorgente, non il trasporto, a stare nel browser.
- **Il catalogo del NAS in SoundReel** (`media_index`) si rinfresca ogni ora e oggi (8 novembre, dopo il rimontaggio della chiavetta) era vuoto fino al giro delle 12:58: un'altra ragione per cui il NAS «sembrava vuoto».

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| S1 | **Una sola ricerca su tutto** | Cerca nel **diario**, nei **file di geekom** e nel **catalogo del NAS**, e mostra **un risultato per canzone** (stesso brano in più posti, o con più grafie dell'artista, = una riga, che **non dice** in quali posti sta: regola P). *Corretto dopo la prova reale (2.13.1), vedi §8: «una riga per `songKey`» mostrava «Giorni matti» tre volte.* Ordine delle parole, maiuscole e accenti non contano (come oggi) |
| S2 | **Una scheda «Cerca», come Spotify** | Un campo grande **sempre visibile in cima** (non nascosto nella barra), e sotto, mentre si scrive (pausa di 300 ms), tre sezioni: **Brani**, **Artisti**, **Album**. Nessuna «dimensione» da scegliere, nessuna playlist richiesta. Prima di scrivere: le ricerche recenti (sul telefono) e le **scorciatoie per sfogliare** (Playlist, Album, Autori, Anni, Tipi, Sul telefono) |
| S3 | **Un tocco suona** | Toccare un brano lo suona **subito** e mette in coda **i brani che seguono nella stessa lista**; tenendo premuto (o con lo scorrimento) si può «Aggiungere in coda», «Aggiungere a una playlist», «Scaricare sul telefono». Il mini player e «In coda» restano com'è. Il server ha la rotta per «Aggiungere a una playlist» già dalla 2.13.0 (`POST /api/mondrop/playlists/:id/songs`: solo le playlist **statiche proprie**, `canEdit` in `GET /playlists`; un brano che esiste solo come file va bene); l'app la usa dalla 1.7.0 |
| S4 | **Pagine autore e album** | Toccare un autore o un album apre la sua pagina con **Riproduci** e **Casuale** e l'elenco dei brani (per l'autore, anche i suoi album). «Mostra tutti i brani» quando sono più di quelli in anteprima |
| S5 | **La vecchia «Libreria» si assorbe** | La scheda **Libreria** sparisce dalla barra e la sua funzione di sfogliare (per Album, Autori, Tipi, Anni, Playlist) vive dentro **Cerca**, nello stato vuoto. La scheda **Playlist** resta. «Spazio» e «Solo sul telefono» passano nel menu di Cerca |
| S6 | **Si suona anche ciò che non è nel diario** | Un brano che esiste solo come **file** (NAS o geekom) si può suonare, scaricare sul telefono e mettere in una playlist, **senza creare nessuna voce nel diario** («una cosa = una voce», ADR-0017). Il server lo serve solo se il file c'è davvero; **non avvia mai un download da YouTube** per una chiave che non è nel diario (ADR-0018). Lo serve **esattamente dal file che quella chiave nomina**, mai per somiglianza di nome (la somiglianza toglie «(2019 Remastered)»): «S.I.C.» e «S.I.C. (2019 Remastered)» sono due brani con due file. Nessuna riga in `song_files`, nessuna voce nel diario |
| S7 | **Offline** | Senza rete, o con «Solo sul telefono», la ricerca vale **solo per quello che è scaricato** (come oggi); lo dice una riga in cima |
| S8 | **Dove sta il brano (per l'utente, non per il codice)** | Ogni risultato dice solo se è **📱 sul telefono** o **☁︎ su SoundReel**; **l'app non sa** se il file è su geekom, sul NAS o nel diario (regola P). Un brano suonabile ma non ancora sul telefono si ascolta in streaming da SoundReel |
| S9 | **La regola P** | I client parlano **sempre e solo con SoundReel**; la logica dei tre elenchi, la ricerca su tutti, la scelta del negozio e della sorgente sono **del server**. La ricerca restituisce **brani**, non negozi: il contratto **non ha** un campo che dica in quale negozio sta un file |
| S10 | **Mondrop non va più direttamente al NAS** | L'app **toglie** il percorso diretto verso il media server (`mediaUrl` e la scelta `home`/`/net` per i download): scarica e suona sempre da `GET /api/mondrop/songs/:key/file`. Il server **smette di mandare `mediaUrl`** (le app già installate ripiegano da sole sul proxy, che per un brano `ready` è sempre valido). `GET /api/mondrop/net` resta solo informativo |
| S11 | **Il player web non sceglie più né il negozio né la rete: lo decide il server** *(risposta di Michele)* | Il browser **non fa più nessun test di rete** (via `GET /api/net`) né sceglie fra media server, disco e YouTube: chiede a SoundReel «cosa suono per questo brano?» e **segue la risposta** (un *piano di riproduzione*, `GET /api/songs/:key/play`). Le regole sono quelle che Michele ha dato e vivono nel server: **da internet, YouTube, sempre**; **in casa, il file di SoundReel se c'è, altrimenti YouTube nel frattempo** mentre il server lo prepara, e appena il file c'è il player passa al file. Il server riconosce «in casa» o «da internet» dalla richiesta (come già fa per `/api/net`). L'interruttore «Sorgente» resta come *preferenza* che il browser manda al server (`?prefer=`); a decidere resta il server. Mondrop non riproduce da YouTube: suona sempre dal file di SoundReel e per un brano non pronto aspetta la preparazione, com'è già |

## 4. Contratto della nuova rotta

`GET /api/mondrop/search` (chiave Mondrop, solo lettura; contratto da aggiungere a `docs/mondrop-sync.md`).

| Parametro | Significato |
|-----------|-------------|
| `q` | Testo libero su autore, titolo, album; ordine delle parole e accenti ininfluenti |
| `artist`, `album` | Restringono ai brani di quell'autore o di quell'album (per le pagine autore e album); uguaglianza senza maiuscole/accenti/punteggiatura |
| `limit`, `offset` | Pagina dei **brani**: `limit` 1–200 (default 30) |
| `sections` | `1` (default) manda anche `artists` e `albums`; `0` solo i brani (per sfogliare le pagine successive) |

Con `q` vuoto e nessun filtro: `400 { "error": "invalid_query" }` (la ricerca vuota non elenca tutta la musica).

```json
{
  "q": "bassi maestro",
  "tracks": [
    { "songKey": "bassi maestro::foto di gruppo", "title": "Foto di gruppo", "artist": "Bassi Maestro", "album": "Foto di gruppo",
      "year": null, "genres": [], "state": "ready", "plays": 0 }
  ],
  "artists": [ { "name": "Bassi Maestro", "tracks": 45 } ],
  "albums":  [ { "title": "Mia maestà", "artist": "Bassi Maestro", "tracks": 14 } ],
  "total": 45,
  "offset": 0,
  "limit": 30
}
```

I brani hanno gli stessi campi di quelli della Libreria (`songKey`, `title`, `artist`, `album`, `genres`, `year`, `state`, `version`, `plays`); **non c'è** nessun campo che dica in quale negozio sta il file (regola P). I file di cui il server non conosce l'anno o i generi li lasciano vuoti. `state` di un brano che esiste come file è `ready` (niente da preparare).

Le rotte che già servono i brani del diario (`GET /api/mondrop/songs/:key`, `…/file`, `…/download`, la sincronizzazione) **accettano anche la chiave di un brano della libreria**, alle condizioni dell'ADR-0018. Il server **non manda più `mediaUrl`** (sempre `null`). Rotta correlata (S3): `POST /api/mondrop/playlists/:id/songs` con `{ "songKey": "…" }` (contratto in `docs/mondrop-sync.md`).

## 5. Test

- **Backend:** la ricerca unisce diario, geekom e NAS e dà **una riga per canzone** (senza dire dove sta); ordine delle parole, accenti, «Maestro Bassi» trova «Bassi Maestro»; le sezioni Artisti e Album contano giusto; `artist=` e `album=` restringono; `q` vuoto è `400`; un brano solo-file si **serve** (disco prima, poi media server, con `Range`), non fa partire nessun download e non crea nessuna entry; una chiave inventata o un file sparito dà `404`; l'utente vede il **suo** diario e la libreria comune; `media_index` vuoto non fa fallire la ricerca (lo dice, non spacca).
- **Backend, brani solo-file:** un brano di geekom e uno del NAS si servono dal **loro** file esatto (disco prima per Mondrop, NAS prima per il web) e **mai** per somiglianza di nome: due versioni dello stesso brano non si scambiano il file, e il NAS non entra tra le origini di un brano che ha già i suoi file; un file sparito dal disco è `missing` con «file non più presente» e non mette in coda nulla; `POST /api/mondrop/playlists/:id/songs` (401, 400, 404 brano, 404 playlist non propria, 409 dinamica, 500 senza dettagli, riga nel log).
- **Regola P, come test:** un controllo automatico sui sorgenti dell'app e del sito **fallisce** se vi compaiono indirizzi di negozi (porte e indirizzi del Fritz, `49152`, `192.168.`, DLNA/UPnP), se `mediaUrl` è usato per riprodurre o scaricare, o se un client sceglie la sorgente in base alla rete (`/api/net`, `/net`, `home`). Il backend non manda più `mediaUrl`.
- **App (MondropKit):** il modello della ricerca (pausa, annullamento, sezioni, errori, offline), la coda a partire dal brano toccato, le pagine autore e album.
- **Prova reale:** «bassi maestro» trova i 45 brani (dopo il giro del catalogo), «maestro bassi» pure, e un tocco suona.

## 6. Le risposte di Michele (8 novembre)

1. **La scheda «Libreria»:** risposta «Cerca la sostituisce». Sparisce la scheda Libreria; lo sfogliare (Album, Autori, Tipi, Anni, Playlist, «Sul telefono») diventa scorciatoie dentro **Cerca**, prima di scrivere. Restano Player, Cerca, Playlist, Posta, Share, Impostazioni.
2. **Il tocco** su un brano: risposta «Suona e accoda i seguenti». Parte quel brano e dopo vanno quelli che lo seguono nella stessa lista; tenendo premuto: Aggiungi in coda, Aggiungi a playlist, Scarica sul telefono.
3. **Le playlist** restano una scheda a parte e non servono per suonare (nessuna obiezione).
4. **Il player web quando un brano non è ancora un file** (S11), risposta testuale: «se siamo su internet parte da youtube, sempre. se siamo in casa parte da youtube nel frattempo.» Quindi: da internet YouTube sempre; in casa YouTube mentre il server prepara il file, poi il file. La logica è nel server (regola P), non nel browser.

## 7. Ordine di costruzione

1. **SoundReel 2.13.0 (server):** `GET /api/mondrop/search`; i brani solo-file si servono e si scaricano (ADR-0018); `POST /api/mondrop/playlists/:id/songs`; il server smette di mandare `mediaUrl` ai client; test della regola P. Nella stessa uscita, trovata mentre si misurava: il ritiro delle copie (ADR-0010) **non** deve prendere come «originale» sul Fritz la replica della copia stessa (`findBoxOriginal`), altrimenti cancellerebbe l'unico file di un brano.
2. **Mondrop 1.7.0 (app):** scheda **Cerca** (sezioni Brani / Artisti / Album / Playlist, pagine autore e album, tocco che suona e accoda, pressione prolungata con *Aggiungi in coda*, *Aggiungi a playlist…* e *Scarica sul telefono*, ricerche recenti, «Sfoglia»); via il percorso diretto verso il NAS e la scelta `home`; Libreria assorbita. **Costruita e provata l'8 novembre** (843 test, il target macOS compila, schermata controllata nel simulatore); la build TestFlight aspetta l'OK di Michele.
3. **Release a parte (SoundReel 2.15.0, costruita): il piano di riproduzione del player web** (`GET /api/songs/:key/play?prefer=…`, S11): il browser non chiama più `GET /api/net`, manda la preferenza e segue la risposta. Il 2.14.0 è stato preso dalle copertine.

## 8. La prova reale dopo la 2.13.0 (8 novembre): una riga per canzone, non per file (2.13.1)

La 2.13.0 era in produzione e la ricerca funzionava («bassi maestro» in 0,05 s, 21 righe, tutte pronte), ma 21 righe per circa 11 canzoni: nella spec S1 vale «un risultato per canzone», e una riga per `songKey` non lo garantisce quando la **stessa registrazione** è nel catalogo più volte con grafie diverse. I dati veri di Bassi Maestro: l'originale del NAS ha il **tag** dell'album e l'artista «Bassi Maestro»; la copia che la replica notturna fa della libreria di geekom ha l'artista **ricavato dal nome del file** («Bassi Maestro, Ape, Zampa») e nessun album; l'import dal Mac scrive «Bassi Maestro feat. Ape & Zampa». Risultato: «Giorni matti» ×3, «Non muovono il collo» ×3, «King's Supreme» ×4 (con un apostrofo tipografico e un «En?gma» rovinato dal media server), «S.I.C» e «S.I.C.».

**Regola adottata (default scelto, da correggere se non va):** le voci si **raggruppano** se hanno lo **stesso titolo** (senza maiuscole, accenti, punteggiatura, spazi né un «(feat. X)» finale) e **almeno un artista accreditato in comune**. La `songKey` **non cambia** (resta la chiave di playlist, file, metadati e ascolti: nessuna modifica dell'identità, ADR-0017): il gruppo è solo come la **ricerca** lo mostra.
- Una **versione** («(2019 Remastered)», «(Instrumental)») ha un altro titolo e resta una canzone a sé.
- I nomi si separano su virgola, `;`, `feat.`/`ft.`/`featuring`, « x » e « vs »; **non** su `&` («Simon & Garfunkel» è un nome) né su parole che iniziano con «feat» («Feather») o su una «X» in un nome («X Japan», «Malcolm X»). «Various Artists», «Unknown» e simili non contano come artista in comune.
- Il gruppo è mostrato con **sempre la stessa voce** (così «già sul telefono» non cambia con le parole scritte): quella del diario, poi quella con un file sul disco di geekom, poi la più completa; nella pagina di un album, la voce che è su quell'album (si suona il suo file).
- **L'album** mostrato è il **tag** del file del NAS quando c'è; il nome di una cartella di geekom (una playlist di Spooty, non un album) solo in mancanza di meglio. Così «Giorni matti» sta sotto «Classe 73» e non sotto «Bassi Maestro».
- `artists` e `albums` e il totale contano **canzoni**. Un artista accreditato su **uno qualsiasi** dei file di una canzone è un artista di quella canzone.
- Si cerca anche nelle **cartelle** del file, ma non nelle radici che tutti i file hanno in comune («Music», «SoundReel», «_MacMusic») né nell'estensione: prima «music» o «mp3» trovavano tutto il catalogo.
- Un limite noto: due canzoni **diverse** con lo stesso titolo e lo stesso artista (un «Intro» su due album) sono una riga sola nella ricerca libera; nella pagina di ciascun album ci sono tutte e due, ognuna col suo file.

**Misurato sui dati veri (sola lettura, prima del deploy):** «bassi maestro» **21 → 11 righe** (tutte pronte); «giorni matti» 1 riga sotto «Classe 73»; «fabri fibra» 3; «kavinsky» 13; «music» 214 (non più tutto il catalogo). Test: raggruppamento (grafie, punteggiatura, apostrofi, nomi accreditati, «Various Artists», titoli senza lettere, versioni, due artisti diversi con lo stesso titolo), voce mostrata stabile, album e artisti per canzone, pagine, cartelle nel testo cercato.
