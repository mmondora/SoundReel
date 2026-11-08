# Scegliere cosa suonare (iOS e web), filtri per tipo/album/autore/anni, stati del download, velocità del play — design

- **Data:** 2026-11-08
- **Stato:** Implementata nella **2.9.0** (backend e web deployati l'8 novembre con l'OK di Michele; iOS = Mondrop 1.5.0, da installare da vulcano). Backend provato su Postgres vero; web e iOS provati con test, **non** ancora sul telefono vero: notifica, riproduzione e media server restano da vedere con un dispositivo
- **Owner:** Michele
- **Correlati:** `2026-11-07-web-player-ux-design.md`, `2026-11-07-listening-stats-dynamic-playlists-design.md`, `2026-11-07-mondrop-offline-spooty-sync-design.md`, `adr/0013-song-year-and-mondrop-library.md`

## 1. Richieste di Michele (testuali, in ordine)

1. «il player ios devo poter scegliere la playlist da suonare, oppure l'album, oppure la singola canzone - ora c'è una "coda generica". Quando avviene il download voglio vedere lo spinner sulla singola canzone in download e comunque vanno notificati gli stati e che cosa sta succedendo.»
2. «dentro il player, il play è lento a partire, nella lista canzoni invece la preview è immediata ? perché ?»
3. «la scelta e il filtro delle canzoni da suonare deve farlo anche quello web, filtrando anche per tipo, album, autore, anni ( es: anni80 ) ecc»

## 2. Perché il play è lento e la preview no (richiesta 2) — misurato il 2026-11-08 sul backend in produzione

| Passo | Preview (lista canzoni) | Play dentro il player |
|-------|------------------------|-----------------------|
| Chi risponde | `GET /api/songs/:key/preview`: l'URL è già salvato → **0,01 s** | `GET /api/songs/:key/youtube`: **0,45 s** anche con l'id del video già salvato, perché ricostruiva **tutto il journal** (785 brani) a ogni chiamata; **2–3,5 s** quando manca l'id e parte la ricerca yt-dlp (15 brani su 785) |
| Cosa scarica il browser | una clip da 30 s, file minuscolo, dal CDN di Apple/Deezer: parte in un istante | la IFrame API di YouTube (caricata solo al primo play), il player, poi il buffer del **video** (1–3 s) |
| File di casa (`/file`) | — | nella 2.7.0 stessa ricostruzione del journal: **0,46–0,92 s** al primo byte |

**Decisioni (default):**
- **Fatto in 2.8.0:** `/youtube`, `/file-info` e `/file` usano la cache per utente dei brani (`services/userSongs`, 15 s) invece di ricostruire il journal; `/file-info` usa la scansione della libreria in cache. Test di regressione: due richieste, un solo accesso al journal.
- **2.9.0 (web):** precaricare la IFrame API all'avvio della pagina (idle) e `preconnect` a `youtube.com`/`i.ytimg.com`; **anticipare** l'id del video del brano successivo mentre suona quello corrente; mostrare «sto caricando…» mentre parte. Con la sorgente `Media server` (o `Auto` da rete interna) il brano parte appena arrivano i primi byte del file, senza IFrame: è il percorso più veloce.
- **Non ora:** far partire la clip di preview mentre carica il brano intero (avvio «istantaneo» con passaggio dissolvenza): da decidere se serve ancora dopo le misure sopra.

## 3. Decisioni prese con valori di default (da correggere se non vanno)

| # | Decisione | Default scelto |
|---|-----------|----------------|
| X1 | iOS: cosa suonare | Il punto d'ingresso del player non è più la «coda generica»: si sceglie **una playlist**, **un album**, **un brano** (e anche artista / tipo / anni, dalla stessa schermata «Libreria»). Il risultato diventa la coda, che resta visibile come «In coda» |
| X2 | iOS: da dove vengono album, tipi, anni | Dal server: i brani del manifest portano `album`, `genres`, `year`; per sfogliare oltre le playlist c'è `GET /api/mondrop/library` (tutti i brani dell'utente con stato e faccette), ADR-0013 |
| X3 | iOS: stati del download | Sulla riga del **singolo brano**: spinner mentre il server lo prepara o il telefono lo scarica (con avanzamento in % del trasferimento), poi segno di «pronto»; per gli altri stati: «in coda», «da cercare» (`no_source`), «errore» col motivo; una riga di stato in cima (es. «Preparo 3 brani sul server · 1 in download dal telefono») e, a sync finito in background, una **notifica locale** (interruttore nelle Impostazioni, di default acceso) |
| X4 | Web: scelta e filtri | Un pannello «Scegli cosa suonare» nel player: filtri per **tipo** (genere), **album**, **autore**, **anni** (decennio: «Anni 80» = 1980–1989), più fonte/piattaforma, tag, playlist, scaricata, FS/MS e ricerca libera; il risultato filtrato (o una playlist, un album, un autore, un brano) diventa la coda, con «mescola». Stesso motore di faccette del Playlist manager |
| X5 | Anno e decennio | Nuovo dato `song_meta.release_year`, **solo da iTunes** (`releaseDate` del risultato in cui artista e titolo coincidono): le date degli album di Deezer sono quelle delle ristampe e sbagliano il decennio per metà dei classici (misurato su 8 brani: Deezer 4 giusti, iTunes 8, ADR-0013 §5). Riempimento per i brani già in libreria con un lavoro di fondo a bassa frequenza (circa 785 brani, ~3,6 s ciascuno per il limite di iTunes, **circa 50 minuti, una sola volta**, si ferma da solo se il provider non risponde e riprova dopo un'ora); i brani senza anno restano fuori dal filtro «anni» ma compaiono con «Senza anno» (meglio ignoto che sbagliato) |
| X6 | Velocità del play | Vedi §2 |

## 4. API (2.9.0)

- `GET /api/songs`: `meta.releaseYear` (numero o null).
- Brani del manifest Mondrop e `GET /api/mondrop/songs/:key`: `album`, `genres` (canonici), `year`.
- `GET /api/mondrop/library?q=&genre=&album=&artist=&decade=&limit=&offset=&facets=` → `{ songs: [track…], total, offset, limit, facets: { genres, albums, artists, decades }, user }` (solo i brani visibili all'utente; ogni voce delle faccette è `{ value, label, count }` e conta senza il proprio filtro). Contratto completo: `docs/mondrop-sync.md`.

## 5. Test

Estrazione dell'anno (Deezer e iTunes, date incomplete, valori assurdi scartati), riempimento una tantum (idempotente, rispetta il ritmo), faccette per decennio, endpoint libreria (filtri combinati, paginazione, permessi), UI web: pannello, decennio, coda dal risultato; iOS: selettore playlist/album/brano, spinner per brano, riga di stato, notifica a sync finito, test di snapshot degli stati.
