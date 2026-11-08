# Mondrop: una Home «alla Spotify» e il mini player al posto del Player vuoto (richiesta 2026-11-08)

Stato: **costruita e provata, non ancora deployata né caricata** (Michele, 8 novembre: «A, si giallo»): SoundReel **2.18.0** (la rotta) e Mondrop **1.7.0 build 9** (l'app, mai caricata su TestFlight) aspettano il suo OK, uno per il deploy e uno per TestFlight. Una rotta nuova del server è un'API, quindi c'è l'**ADR-0020**.
Disegno: `assets/2026-11-08-mondrop-home-spotify-proposal.png` (iPad e iPhone, disegno di prova).
Codice: backend `services/mondropHome.ts` e `routes/mondrop.ts` (`GET /api/mondrop/home`); app `ios/MondropKit/{HomeModels,HomeModel,QueueSnapshot,MondropPalette}.swift`, `ios/Mondrop/{HomeView,MiniPlayer,MondropButtons,CoverArt,RootTabView,WinampPlayerView}.swift`.

## 1. Richieste di Michele (testuali)

Dopo il Player rifatto per iPad (spec `2026-11-08-mondrop-ipad-player-design.md`), alla domanda se caricare la build 9 su TestFlight:

> «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify»

Prima, con la schermata dell'iPad: «Questa la home su ipad - colori sbagliati e spazi da rivedere». La «home» di cui parlava è la scheda **Player**, la prima.

Davanti alla proposta (disegno + due strade: **A** Home + mini player + una rotta del server, **B** solo svuotare il Player vuoto) e alla domanda «vuoi il giallo anche nella barra delle schede e nei link?»:

> «A, si giallo»

## 2. Cosa non andava

La prima scheda era il Player e, **senza niente in coda, una pagina vuota** («Niente in coda», una cover finta e un pulsante «Cerca musica» che rimandava a un'altra scheda): un vicolo cieco, la prima cosa che si vede aprendo l'app. Spotify non apre sul lettore: apre su una **Home** (cosa riprendere, le tue playlist, cosa hai ascoltato), con la ricerca in cima, e il lettore è un **mini player sempre in vista** che si apre a tutto schermo.

## 3. Decisioni (con i default scelti: da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| H1 | **La prima scheda è la Home** | Saluto (secondo l'ora del telefono: «Buongiorno» dalle 5, «Buon pomeriggio» dalle 13, «Buonasera» dalle 18; con il nome se il server lo manda), **campo di ricerca in cima** (un tocco porta alla scheda Cerca con la tastiera già aperta), poi **Riprendi** e le sezioni che manda il server. «Cerca musica» **sparisce** (anche dal Player e dalla coda) |
| H2 | **Il Player non è più una scheda: è il mini player** | Sempre in vista sopra la barra delle schede, **su tutte le schede e su ogni pagina** (un solo mini player, non uno per schermata): copertina piccola, titolo e artista, ◀◀ ▶/❚❚ ▶▶, un filo di avanzamento. Compare quando c'è qualcosa di caricato. Un tocco lo **apre a tutto schermo** (il Player di ora): sull'iPhone e sull'iPad a schermo intero, sul Mac in un foglio; si chiude con la freccia in giù (e trascinando l'intestazione). Il pulsante «In coda» del mini player sparisce: la coda si apre dal Player |
| H3 | **Le schede** | **Home, Cerca, Playlist, Posta, Share, Impostazioni** (sull'iPhone: Home, Cerca, Playlist, Posta e «Altro» con Share e Impostazioni, come prima con il Player). La barra è quella di iPadOS sull'iPad |
| H4 | **Riprendi** | La coda **si salva sul telefono** (brani, posizione nella coda, secondi del brano, nome della coda, playlist) e al lancio ricompare **ferma**: il play non parte mai da solo («il play non deve essere automatico»). Oggi la coda non si salvava e un'app chiusa dal sistema perdeva tutto. La scheda «Riprendi» (solo se c'è una coda) mostra copertina, titolo, artista, «In coda: Playlist · Road trip · 2 / 7», il filo del brano e un grande play giallo; il play riprende dal secondo salvato, il tocco sulla scheda apre il Player. Un brano salvato senza le informazioni del server (indirizzi, stato) le richiede al primo play |
| H5 | **Chi decide cosa si vede** (regola P) | **Una rotta sola**, `GET /api/mondrop/home` (ADR-0020), che risponde con le **sezioni già pronte**: quali ci sono, in che ordine, con che titolo e con che brani. L'app disegna e basta (non chiama playlist, statistiche e libreria per montarsela, non calcola «recenti» né «nuovi»). Una sezione senza niente **non viene mandata**; una sezione di tipo sconosciuto l'app la ignora |
| H6 | **Le sezioni di oggi** | **Le tue playlist** (al massimo 12, le più recenti per prima, anche le dinamiche e quelle condivise, **senza quelle vuote**: una carta senza niente da suonare è rumore in una prima pagina; ognuna con fino a 4 brani per il mosaico di copertine) · **Ascoltati di recente** (fino a 20 brani **diversi**, dal più recente, solo ascolti che contano) · **Nuovi dai tuoi reel** (fino a 20 brani del diario, dal post più recente che li menziona, che questo utente **non ha ancora ascoltato**: nessun ascolto che conta; a parità di data il titolo, così l'ordine non ondeggia tra due richieste). I brani sono gli stessi oggetti di Cerca e della libreria (stato del file, `coverPath`, `downloadPath`, `mediaUrl` sempre `null`) |
| H7 | **Mai una pagina vuota** | Senza niente da mostrare (utente nuovo, diario vuoto) la Home mostra il campo di ricerca e «Sfoglia la libreria». Se il server non risponde: «Non riesco a caricare la Home» con «Riprova», e **Riprendi e il campo restano** (sono del telefono). La Home si ricarica quando si riapre e con il gesto di tirare giù |
| H8 | **Cosa fa un tocco** | Su un brano di una riga: **suona questo e i seguenti** della riga (come in Cerca; la coda si chiama come la sezione: «Ascoltati di recente», «Nuovi dai tuoi reel»); pressione prolungata: lo stesso menu di Cerca (aggiungi in coda, a una playlist, scarica). Su un brano di «Nuovi dai tuoi reel» c'è anche il **pulsante per scaricare**. Su una playlist: si apre la playlist (la pagina di sempre) |
| H9 | **Il giallo ovunque, e quindi tutta l'app scura** | Il giallo di Mondrop (quello dell'icona) è l'**accento di tutta l'app**: barra delle schede, link, pulsanti, interruttori, avvisi. Il giallo su bianco non si legge (contrasto 1,4:1; 4,5 è il minimo), quindi **tutta l'app è scura**, come il Player e come Spotify (e come il sito: «dark mode default e unico tema»), qualunque sia l'aspetto del telefono. Blu notte per Home e Player, il nero di sistema per le liste. Un pulsante pieno giallo porta il testo nero. Il foglio di condivisione (estensione) resta com'è |
| H10 | **I colori sono numeri provati** | La tavolozza del Player diventa quella dell'app (`MondropPalette`): il contrasto del giallo e del testo sul blu notte e sul nero di sistema è provato da test, come per il Player |
| H11 | **Il messaggio dopo «Aggiungi in coda»** | Con la coda vuota diceva «Premi Riproduci nel Player»: ora «Premi ▶ nel mini player» (il Player non è più una scheda) |
| H12 | **Numeri** | SoundReel **2.18.0** (la rotta); Mondrop **1.7.0 build 9** porta anche la Home (mai caricata, ferma finché Michele non dice di caricarla); la ricerca dei testi su Internet slitta alla **2.19.0** (ADR-0021) |

## 4. Il contratto del server (ADR-0020)

`GET /api/mondrop/home` (chiave `X-SoundReel-Key`, come le altre; legge soltanto, non mette in coda niente):

```json
{
  "user": "mike",
  "displayName": "Michele",
  "sections": [
    { "id": "playlists", "title": "Le tue playlist", "kind": "playlists",
      "playlists": [ { "id": "…", "name": "…", "songCount": 7, "kind": "static", "ruleSummary": null, "canEdit": true, "coverKeys": ["artista::titolo", "…"] } ] },
    { "id": "recent", "title": "Ascoltati di recente", "kind": "tracks", "tracks": [ { "songKey": "…", "…": "come in /api/mondrop/library" } ] },
    { "id": "fresh",  "title": "Nuovi dai tuoi reel",  "kind": "tracks", "tracks": [ … ] }
  ]
}
```

- `displayName`: il nome della famiglia (Michele, Archimede, Sara) o `null` per un utente sconosciuto; l'app saluta senza nome.
- `coverKeys`: fino a 4 chiavi di brano per il mosaico; l'app chiede le copertine come sempre (`GET /api/mondrop/songs/:key/cover`).
- Nessun campo nomina un negozio o un indirizzo (regola P); `mediaUrl` è `null` come in ogni risposta dalla 2.13.0.
- Tocca **solo** i dati dell'utente della chiave. Errori: `401` senza chiave valida, `500 {"error":"home failed"}`.
- Il guasto di una sezione costa **solo quella sezione** (il resto risponde; l'errore va nel log): una Home senza «recenti» è meglio di nessuna Home.

## 5. Test

- **Server** (`mondropHome.test.ts`, `mondrop.test.ts`/`mondropHome.route.test.ts`): le sezioni e il loro ordine; una sezione vuota non c'è; limiti (12 / 20 / 20); «recenti»: brani diversi, dal più recente, un brano non più in nessun posto è saltato, un brano solo-file c'è; «nuovi»: dal post più recente, senza i brani già ascoltati, senza quelli di altri utenti; `coverKeys` (max 4, dinamiche comprese); `displayName`; il guasto di una sezione non toglie le altre; senza chiave `401`; nessun `mediaUrl`, nessun indirizzo di negozio.
- **App** (XCTest): decodifica (sezione di tipo sconosciuto ignorata, campi mancanti), saluto per ora, scheda Riprendi (da cosa nasce, quando non c'è), coda salvata (salva, ricarica ferma, tetto, indice fuori misura, file rotto), tavolozza (contrasto del giallo e del testo su blu notte e nero di sistema), le schede (ordine, niente Player), un solo mini player (nessuna pagina ne disegna uno proprio), la regola P (la Home non legge la rete e non nomina negozi), il messaggio dell'H11.
- **Schermate** (simulatore): Home iPad e iPhone con dati, Home vuota, mini player su Cerca e su una playlist, Player aperto dal mini player.

## 6. Limiti noti e fuori ambito

- «Mostra tutti» per «recenti» e «nuovi»: non c'è (le righe sono corte per scelta); Cerca e le playlist restano i posti per il resto.
- La barra laterale di iPadOS 26: possibile in seguito.
- «Riprendi» è del **telefono**: non riprende su un altro dispositivo (Spotify sì: servirebbe un protocollo di posizione e non è stato chiesto).
- Il mosaico di una playlist usa i primi 4 brani (non i primi 4 con copertina): se non hanno copertina, tessere disegnate come nel Player.
- Il sito e il player web non cambiano (hanno i loro scaffali).
- **Le copertine nelle carte** (come nel disegno approvato; in ADR-0019 Michele aveva detto no alla copertina piccola *nelle righe delle liste*, qui sono le carte della Home): la **prima** apertura chiede le copertine di una trentina di brani e quelle che il server non ha ancora le cerca su Internet (iTunes: circa 20 richieste al minuto, con la coda condivisa e il «non c'è» ricordato 3 giorni): arrivano a mano a mano, poi stanno sul telefono. Le carte disegnano intanto la tessera (lettera, simbolo). Si può togliere dalle carte dei brani con una riga se non piace.

## 7. Com'è fatta (note di costruzione)

- **Il mini player è uno solo** e sta sulla `NavigationStack` di ogni scheda (`.miniPlayer(open:)`): il SwiftUI porta l'inserto alle pagine aperte da quella scheda (verificato sul simulatore: una sola barra sulla pagina di una playlist). Le cinque barre messe a mano nelle schermate (e i loro fogli «In coda») sono state tolte; la coda si apre dal Player. Sull'iPad la barra è larga al massimo 720 punti, al centro. La tastiera di Cerca la copre invece di portarla su.
- **Il Player a schermo intero** è un `fullScreenCover` (un foglio sul Mac, che non ne ha); l'intestazione ha la freccia e il nome, e trascinarla in giù chiude.
- **Il campo della Home** non è un campo vero: è un pulsante che dice al `RootRouter` «apri Cerca» (un contatore, come per la Posta: una richiesta fatta prima che Cerca esista non si perde) e Cerca attiva il suo campo con `searchable(isPresented:)`.
- **Il giallo** è anche nel catalogo delle risorse (`AccentColor`), perché è quello che usano le parti disegnate dal sistema (avvisi, menu); la scheda scura è forzata da `UIUserInterfaceStyle` (iPhone, iPad) e da `.preferredColorScheme(.dark)` (anche il Mac). L'estensione di condivisione resta com'è.
- **La coda salvata** sta in `Application Support/Mondrop/queue.json` (brani compatti: chiave, titolo, autore, percorso della copertina; al massimo 500, con una finestra attorno al brano se la coda è più lunga) e il punto del brano in poche righe di `UserDefaults`, scritto ogni 5 secondi e quando l'app va in secondo piano. Un brano a cui il tempo è arrivato quasi in fondo (a meno di 3 secondi) riparte da capo.
- **Per guardarla senza server**: build DEBUG con `-MondropDemo` (dati finti e una coda), `-MondropDemoTab`, `-MondropDemoPlayer`, `-MondropDemoSearch`, `-MondropDemoPush playlist|library` (`DemoData.swift`, tutto dentro `#if DEBUG`: TestFlight non lo contiene).
- **Numeri:** backend **2595** test (162 file); app **966** test; il Mac compila; schermate verificate sul simulatore (iPhone 17e e iPad Air 11", telefono in modo chiaro, Home con dati, Home che non riesce a caricare, Player, Cerca con la tastiera, Playlist e Impostazioni con il mini player, pagina di una playlist).
- **Trovato guardando le schermate:** nella scheda Share i due pulsanti gialli avevano il testo **bianco** (il `.borderedProminent` di sistema fa così): contrasto 1,4. Ora sono `MondropPillStyle` (testo nero) e un test vieta di rimetterli.

## 8. Domande per Michele e risposte (8 novembre)

1. **Home + mini player (A) o solo svuotare il Player vuoto (B)?** Risposta: **«A, si giallo»**.
2. **Il giallo anche nella barra delle schede e nei link?** Risposta: **sì** (H9: e quindi tutta l'app scura, perché il giallo su bianco non si legge; da correggere se non va).
3. **La build 9 la carico subito com'è o aspetti la Home?** Non chiesta in chat dopo la scelta di A: la build 9 porta la Home e **resta ferma** finché Michele non dice di caricarla («No aspetta»).
4. **Da correggere se non va (default scelti):** tutta l'app scura (H9: se la vuoi chiara di giorno servono un giallo più scuro per il chiaro e di rivedere i pulsanti); il saluto «Buonasera» da 18 a 5; «Riprendi» solo su questo telefono; le playlist vuote nascoste dalla Home.
