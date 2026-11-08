# Mondrop: una Home «alla Spotify» al posto del Player vuoto (richiesta 2026-11-08)

Stato: **proposta, non costruita** (aspetta la scelta di Michele). Interfaccia più una rotta del server: la rotta è un'API, quindi se si costruisce servirà anche un'ADR.
Disegno: `assets/2026-11-08-mondrop-home-spotify-proposal.png` (iPad e iPhone, disegno di prova).

## 1. Richieste di Michele (testuali)

Dopo il Player rifatto per iPad (spec `2026-11-08-mondrop-ipad-player-design.md`), alla domanda se caricare la build 9 su TestFlight:

> «No aspetta, non mi piace il "cerca musica" - fai una proposta alla spotify»

Prima, con la schermata dell'iPad: «Questa la home su ipad - colori sbagliati e spazi da rivedere». La «home» di cui parlava è la scheda **Player**, la prima.

## 2. Cosa non va oggi

La prima scheda è il Player, e **senza niente in coda è una pagina vuota** («Niente in coda», una cover finta e un pulsante «Cerca musica» che rimanda a un'altra scheda): un vicolo cieco, la prima cosa che si vede aprendo l'app. Spotify non apre sul lettore: apre su una **Home** (cosa riprendere, le tue playlist, cosa hai ascoltato), con la ricerca in cima, e il lettore è un **mini player sempre in vista** che si apre a tutto schermo.

## 3. La proposta (vedi il disegno)

| # | Idea | Come |
|---|------|------|
| H1 | **La prima scheda è la Home** | Saluto, **campo di ricerca in cima** (tocco → la scheda Cerca, con la tastiera), poi le sezioni: **Riprendi** (la coda dov'eri: «In coda · Playlist · test · 2 / 7», con il play), **Le tue playlist** (copertina a mosaico, anche le dinamiche con il loro segno), **Ascoltati di recente**, **Nuovi dai tuoi reel** (i brani trovati nei post, con «scarica»). «Cerca musica» sparisce |
| H2 | **Il Player non è più una scheda** | È il **mini player** in basso, su tutte le schede (cover, titolo, artista, ◀◀ ▶ ▶▶, un filo di progresso), che si **apre a tutto schermo** (il Player di ora, rifatto, a sheet con la freccia per chiuderlo). Le altre schede restano: **Home, Cerca, Playlist, Posta, Share, Impostazioni** |
| H3 | **Mai una pagina vuota** | Senza niente in coda, la Home mostra le playlist e i nuovi brani dai reel; con niente di niente, il campo di ricerca e «Sfoglia» |
| H4 | **iPad** | La barra delle schede è quella flottante di iPadOS (in alto); una colonna di contenuti larga quanto serve (le sezioni scorrono in orizzontale), il mini player in basso a tutta larghezza. Possibile in seguito la barra laterale di iPadOS 26 |
| H5 | **I colori** | Quelli del Player nuovo: blu notte, testo bianco, accento giallo (e la domanda aperta: il giallo anche nel resto dell'app?) |
| H6 | **Chi decide cosa si vede** (regola P) | Una rotta sola del server, `GET /api/mondrop/home`, che risponde con le sezioni già pronte: *Riprendi* (dalla coda salvata dall'app, quindi in realtà locale), *playlist* (già esistono), *recenti* (ultimo ascolto di ogni brano: il server lo sa dagli eventi di ascolto), *nuovi dai reel* (i brani del diario per data del post, con lo stato del file). L'app non calcola niente: disegna |

## 4. Cosa costa

- **App:** la scheda Home (sezioni orizzontali), il mini player su tutte le schede (oggi c'è già nelle pagine di Cerca: si generalizza), il Player a sheet, test (contrasto già c'è, l'ordine delle schede, il vuoto, i tocchi). Circa una build.
- **Server:** la rotta `GET /api/mondrop/home` (+ test, ADR). Una release (SoundReel 2.18.0; i testi slittano alla 2.19.0).
- **Versione ridotta (solo togliere il vicolo cieco):** senza Home nuova, il Player vuoto mostra le playlist e i nuovi brani al posto di «Cerca musica». Un'ora di lavoro, nessun server, ma la prima scheda resta un lettore.

## 5. Domande per Michele

1. **Vai con la Home + mini player (H1–H6)**, oppure solo la versione ridotta, oppure cambia qualcosa (che sezioni? altre schede?).
2. Il giallo anche nel resto dell'app (barra delle schede, link, pulsanti)? Oggi è blu fuori dal Player.
3. La build 9 (Player su iPad, «Scarica tutti», «Aggiungi in coda» che non suona) la carico **subito** com'è, o aspetti la Home?
