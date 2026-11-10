# Il like sulla canzone — contratto API di Mondrop (`/api/mondrop/likes`, `/api/mondrop/songs/:key/like`)

Spec: `docs/superpowers/specs/2026-11-10-mondrop-like-and-repeat-design.md`, ADR-0028. Richiesta di Michele (10 novembre): «in mondrop voglio il like sulla canzone e il loop da player bluetooth es dalla auto».
**Stato: contratto scritto prima del codice** (10 novembre). L'app (Mondrop 1.8.0) si costruisce su questo testo con un'API finta nei test; il server (tabella `song_likes`, tre rotte) viene dopo il rilascio 2.24.0. Dove il codice precisa il contratto, si corregge qui.

## Che cosa è

Un **like** è «questo brano mi piace»: **di una persona**, non di tutti, e **sta sul server** (regola P: l'app lo disegna, non lo decide). Un solo stato per persona e brano: piace o non piace (non c'è il «non mi piace»). Non cambia nient'altro: non tocca il «preferito», il like e il dislike del sito (`song_meta`, uguali per tutti), né gli ascolti.

## Chi è l'utente — e la sicurezza

Come tutte le rotte `/api/mondrop/*`: header `X-SoundReel-Key`; **l'utente è quello della key**, mai il corpo, la query o il percorso. Si vedono e si toccano **solo i like della persona della key**: non esiste modo di leggere o cambiare quelli di un altro. Le rotte stanno sotto `/api/mondrop` (Traefik senza Authelia, come `/api/share`), mai dietro Authelia. Senza key `401` prima di tutto.

## Le rotte

| Rotta | Che cosa fa | Risposta |
|-------|-------------|----------|
| `GET /api/mondrop/likes` | L'insieme dei brani che piacciono a questa persona, **dal like più recente**. L'app lo chiede all'avvio e quando torna in primo piano, e lo fonde con le operazioni che non sono ancora partite | `200 { "user": "mike", "total": 2, "likes": [ { "songKey": "daft punk::one more time", "likedAt": "2026-11-10T18:00:00.000Z" }, … ] }`, `Cache-Control: no-store` |
| `PUT /api/mondrop/songs/:key/like` | Mette il like. **Idempotente**: se c'è già non cambia niente (resta la data del primo). Corpo facoltativo `{ "at": "2026-11-10T17:58:00.000Z" }`: **quando** la persona l'ha dato sul telefono (per le operazioni che partono dopo, senza rete); il server tiene `min(at, adesso)` e **ignora** un valore che non è una data | `200 { "songKey": "…", "liked": true, "likedAt": "…" }` |
| `DELETE /api/mondrop/songs/:key/like` | Toglie il like. **Idempotente**: va bene anche se non c'era | `200 { "songKey": "…", "liked": false }` |

**Come parla l'app (Mondrop 1.8.0, scritto dopo averla costruita):** manda l'ora di `at` **senza frazioni di secondo** (`2026-11-10T17:58:00Z`, come gli ascolti), e — come in ogni chiamata — `?user=` e `X-SoundReel-User`: per una key legata a un utente il server li **ignora**. `:key` è la `songKey` di sempre (`artista::titolo` normalizzato, percent-encoded come nelle altre rotte `/api/mondrop/songs/:key…`). **Il server non controlla che il brano esista** nel diario o nella libreria: una chiave ben formata basta (un brano che esiste solo come file ha la sua chiave e può piacere come gli altri). La chiave **non** identifica un utente.

## Errori

| Risposta | Quando |
|----------|--------|
| `400 { "error": "invalid_song_key" }` | la chiave è vuota (dopo il `trim`) o più lunga di 300 caratteri |
| `401` | key mancante o non valida (prima di tutto) |
| `500 { "error": "likes_failed" }` | un guasto del server (va nel log, mai nel corpo); l'app riprova più tardi e **non perde l'operazione** |

## La playlist «Mi piace» (Michele, 10 novembre: «1 si»)

Il server fa, **per ogni persona**, una playlist **dinamica** «Mi piace»: i brani con **il suo** like, **i più recenti per primi**, al massimo 200 (come ogni regola dinamica). **Nasce al primo like** (nessuna playlist vuota in giro) e **non si ricrea** se la persona la cancella. È una regola nuova delle playlist dinamiche («i brani che mi piacciono») con il suo riassunto in parole (`ruleSummary`), così Mondrop e il sito la vedono come ogni altra playlist dinamica: **nessun cambiamento nell'app e nessuna rotta nuova**. In F2 si controlla che l'editor delle regole del sito, davanti a una regola che non conosce, non la rovini, e che le app fino alla build 12 la mostrino senza errori.

## Come si comporta l'app (non lo decide il server, ma la risposta deve reggerlo)

- **Si vede subito** (cuore pieno) e **parte quando c'è rete**: le operazioni (`like`, `unlike`, chiave, ora) stanno in una coda sul telefono, **in ordine**, come gli ascolti (`PlayRecorder`); un like e un unlike dello stesso brano ancora in coda si annullano; un'operazione che il server rifiuta con `400` si scarta, con `5xx` o senza rete si riprova.
- **Cosa fa l'app a ogni risposta** (Mondrop 1.8.0): `400` e ogni altro `4xx` che non sia `401`, `403`, `404`, `408` o `429` → l'operazione si **scarta** (la richiesta è sbagliata, riprovare non cambia nulla) e il cuore torna a ciò che dice il server; `408`, `429`, `5xx` e nessuna rete → resta in coda e si riprova dopo **30 s, poi 60, 120… al massimo 15 minuti** (anche con l'app in background che suona: un like dato in galleria parte da solo); **`404` = un server che i like non li ha ancora** (SoundReel prima della 2.25.0): la coda resta, **nessun errore a schermo**, nessun timer, si riprova al prossimo avvio o quando l'app torna in primo piano; `401`/`403` = key mancante o rifiutata: la coda resta e aspetta una key nuova. Un solo giro alla volta: se mentre una chiamata è in volo la persona toglie il like, l'`unlike` si accoda **dopo** quello in volo (non lo cancella).
- **L'insieme che arriva da `GET /likes` è la verità**; le operazioni ancora in coda ci si applicano sopra, così un like dato in macchina senza rete non sparisce quando l'app si sincronizza.
- Il like si può dare dal Player, dal mini player, dalla riga di un brano e dai **comandi remoti** (Bluetooth, auto, schermata di blocco).

## Come si prova

Unitari con il database finto e d'integrazione su Postgres vero (scratch `collections_check`, mai `soundreel-db`): `PUT` poi `GET`; `PUT` due volte (resta la data del primo); `DELETE` di un like che non c'è; `at` nel futuro (si porta a adesso) e `at` che non è una data (ignorato); **un utente che non vede i like di un altro**, anche chiedendo la stessa chiave; la chiave vuota o troppo lunga (`400`, niente scritto); senza key `401`; l'ordine di `GET` (il più recente per primo, a pari data per chiave). Rotture provate con il banco delle mutazioni.

**I file (previsti):** `backend/src/db/migrations/025_song_likes.sql` (+ `init.sql`), `backend/src/services/songLikes.ts` (le regole e le query), `backend/src/routes/mondropLikes.ts` (le tre rotte), registrate in `server.ts` accanto alle altre `/api/mondrop`; la regola «i brani che mi piacciono» in `services/dynamicRules.ts` e la playlist al primo like (il punto che già fa nascere le playlist automatiche).
