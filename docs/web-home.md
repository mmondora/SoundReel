# La Home del sito, a sezioni — contratto API (`GET /api/home`)

Spec: `docs/superpowers/specs/2026-11-10-web-look-and-feel-rethink-design.md` (§3.2, L1: «mi piace la A con le sezioni di C - possiamo metterle tute e tre configurabili ?»). Piano: `docs/superpowers/plans/2026-11-10-web-look-and-feel.md` (Task 8). La configurazione di quali sezioni si vedono e in che ordine: `docs/ui-prefs.md` (`home.sections`, ADR-0026).
**Stato: implementato nel backend** (`services/webHome.ts` le regole, `services/webHomeData.ts` le fonti vere, `routes/webHome.ts` la rotta); il sito la legge dalla fase P3 del piano. È la gemella, per il sito, di `GET /api/mondrop/home` (l'app, ADR-0020): stessa idea (sezioni già pronte, il client disegna e non calcola), contenuti diversi.

## Che cosa è

La **vista Home** delle pagine Inbox e Link: le sezioni della direzione C, già pronte da disegnare. Il server decide **quali sezioni ci sono, che cosa contiene ognuna e in che ordine stanno gli elementi** (regola P: i client mostrano, non decidono). L'**ordine delle sezioni e la loro visibilità** sono invece scelta dell'utente (`home.sections` di `GET /api/me/prefs`): il sito disegna le sezioni **nell'ordine della configurazione**, salta quelle che la configurazione nasconde, quelle che non conosce e quelle che il server non ha mandato (una sezione senza niente dentro non si manda).

| `id` | Che cosa è | Quanti elementi (massimo) |
|------|-----------|---------------------------|
| `resume` | Gli **ultimi post** (la riga è esattamente quella di `GET /api/entries?view=summary`, così il sito usa la scheda che ha già) | 6 |
| `songs` | Le **canzoni nuove dei post**, quella del post più recente per prima | 12 |
| `playlists` | Le **playlist** dell'utente, le ultime create per prime | 12 |
| `films` | I **film nuovi dei post**, una scheda per film | 12 |

**`collections` non c'è**: le raccolte (ADR-0022) non sono ancora costruite, quindi la sezione è **assente**, non vuota. Quando esisteranno comparirà qui, come quinto `id`, e il sito non cambierà (salta ciò che non conosce).

## Chi è l'utente — e la sicurezza

Come tutte le liste del sito, l'utente è **solo** l'utente Authelia della richiesta (`Remote-User`: `mike`, `archi`, `sara`, in qualunque maiuscola), **mai** la query, il corpo o un altro header: nessun parametro nomina un altro utente (`?user=sara` è ignorato). Un `Remote-User` assente o sconosciuto è l'utente `anonymous` (**non** un `401`, come le altre liste del sito: la rotta risponde con ciò che `anonymous` può leggere, di solito niente); il gruppo `admins` senza utente non fa un amministratore.
La Home mostra **ciò che quella persona può leggere** attraverso le liste esistenti, né più né meno: i **suoi** post, brani, film e playlist **e quelli condivisi con lei**; un **amministratore** vede anche quelli di `anonymous`, come nelle liste. Niente di un altro utente arriva nella risposta (provato su un Postgres vero, vedi i test). Nessun campo nomina un negozio (regola P) e non c'è nessun segreto.
La rotta **deve restare dietro il middleware `auth-family` di Traefik**, con le altre rotte del sito: mai sotto `/api/mondrop` né `/api/share` (quei router saltano Authelia, `Remote-User` diventerebbe controllato dal client e chiunque potrebbe leggere la Home di chiunque; vedi `routes/mondropConnect.ts`).

## La risposta

`GET /api/home` → `200 { "sections": WebHomeSection[] }`, sempre `Cache-Control: no-store` (la stessa scheda si rilegge dopo l'arrivo di un post).

```ts
type WebHomeSectionId = 'resume' | 'songs' | 'playlists' | 'films';   // 'collections' non c'è ancora (ADR-0022)

interface WebHomeSong { songKey: string; title: string; artist: string; coverUrl: string | null; entryId: string; sourceUrl: string | null; createdAt: string }
interface WebHomePlaylist { id: string; name: string; songCount: number; createdAt: string; kind: 'static' | 'dynamic'; origin: 'user' | 'auto'; ruleSummary: string | null; ownerUser: string }
interface WebHomeFilm { filmKey: string; title: string; year: string | null; posterUrl: string | null; imdbUrl: string | null; entryId: string; sourceUrl: string | null; createdAt: string }

type WebHomeSection =
  | { id: 'resume'; total: number; items: EntrySummaryRow[] }
  | { id: 'songs'; total: number; items: WebHomeSong[] }
  | { id: 'playlists'; total: number; items: WebHomePlaylist[] }
  | { id: 'films'; total: number; items: WebHomeFilm[] };

interface WebHomeResponse { sections: WebHomeSection[] }
```

`EntrySummaryRow` è la riga di `GET /api/entries?view=summary` (`id`, `sourceUrl`, `sourcePlatform`, `caption`, `thumbnailUrl`, `status`, `createdAt`, `summary`, `songCount`, `filmCount`, `noteCount`, `tags`): passa **così com'è**.

## Le regole

- **Le sezioni**: nell'ordine `resume`, `songs`, `playlists`, `films`. Una sezione **senza elementi non si manda**; una sezione che **fallisce non si manda** e il guasto va nel log (`web home: section <id> failed`), mentre le altre rispondono lo stesso (un guasto costa solo la sua sezione). **Un diario vuoto risponde `{ "sections": [] }`**, `200`.
- **`total`** è **quanti ce ne sono in tutto** per quella persona (per «vedi tutti (N)»); `items` sono i primi del massimo sopra. Per i post è il totale delle voci che la persona legge; per le canzoni e i film le schede distinte; per le playlist tutte quelle che legge.
- **`resume`**: gli ultimi 6 post, i più recenti per primi, qualunque stato (anche uno ancora in analisi: lo dice `status`).
- **`songs`**: le canzoni **dei post** (mai un brano che esiste solo come file: `libraryOnly`), **una per `songKey`**; le **versioni** (Instrumental, Slowed + Reverb, Live…) restano una scheda a sé, accanto all'originale. Ordine: il post **più recente che nomina** il brano per primo (un brano nominato ieri e un anno fa conta ieri); a pari momento (i brani di uno stesso post) per titolo (come lo legge una persona: «Track 9» prima di «Track 10», senza maiuscole né accenti) e poi per chiave, così l'ordine non cambia tra due richieste. `entryId`, `sourceUrl` e `createdAt` sono quelli di **quel** post più recente (`sourceUrl` è `null` se non è noto); senza nessuna data leggibile parla la prima menzione e il brano va in fondo; un brano senza nessun post non è un brano dei post. `coverUrl` è la copertina che i metadati conoscono, altrimenti `null`.
- **`playlists`**: quelle che `GET /api/playlists` elenca per quella persona (le sue e quelle condivise con lei; un amministratore anche quelle di `anonymous`), **le ultime create per prime** (non le ultime toccate), a pari data per nome. `kind` è `static` o `dynamic` (una regola, ADR-0008) e `origin` è `auto` (fatta dal server da un post di musica, ADR-0023) o `user` (fatta a mano); `ruleSummary` è il riepilogo della regola o `null`; `ownerUser` dice di chi è (una playlist condivisa dice di chi). Per una regola `songCount` è quanti brani sceglie **adesso**: si valuta **solo per le 12 mostrate**, mai per le altre.
- **`films`**: come la pagina Film, **una scheda per film** (`collapseFilms`: «Dune» e «Dune» senza anno sono uno; due anni diversi restano due film), il film del post più recente per primo, a pari momento per titolo. `year` è sempre testo (anche se salvato come numero) o `null`; `entryId`, `sourceUrl` e `createdAt` sono quelli del post più recente che nomina il film.

## Errori

| Risposta | Quando |
|----------|--------|
| `200` | Sempre, anche con zero sezioni e anche se una o più sezioni sono fallite |
| `500 { "error": "home failed" }` | Solo se la Home **intera** non si può costruire (guasto che non è di una sezione); va nel log come `GET /api/home failed`. Anche questa risposta è `no-store` |

Non ci sono `400` (nessun parametro; quelli sconosciuti sono ignorati) né `401` (utente assente = `anonymous`, come le liste del sito). Qualunque altro metodo (`POST`, `PUT`, `PATCH`, `DELETE`) e qualunque altro percorso sotto `/api/home` rispondono `404`: è una lettura.

## Esempi

```bash
# la Home di Michele (in produzione l'utente lo mette Authelia; qui lo si simula in locale)
curl -s -H 'Remote-User: mike' "$SOUNDREEL_URL"/api/home

# solo i nomi delle sezioni, nell'ordine in cui arrivano
curl -s -H 'Remote-User: mike' "$SOUNDREEL_URL"/api/home | jq -r '.sections[] | "\(.id)\t\(.total)\t\(.items | length)"'

# la stessa richiesta come amministratore: vede anche i post, i film e le playlist di anonymous
curl -s -H 'Remote-User: mike' -H 'Remote-Groups: admins' "$SOUNDREEL_URL"/api/home

# la query non sceglie l'utente: questa è la Home di Michele, non quella di Sara
curl -s -H 'Remote-User: mike' "$SOUNDREEL_URL"/api/home?user=sara
```

## Costo

Le canzoni e i film leggono lo **stesso diario**: si legge **una volta sola per richiesta** (e una per persona: un set di fonti non risponde mai a un utente con il diario di un altro), e niente si tiene da una richiesta alla successiva. A freddo la lettura del diario è la parte cara (circa mezzo secondo per un diario di qualche centinaio di voci, come `GET /api/songs`); i post e le playlist sono letture leggere. Le playlist-regola si valutano solo per le dodici mostrate.

## Dati

Nessuna tabella nuova e nessuna scrittura: legge `entries` e `entry_shares` (post, canzoni e film), `song_meta` e `film_meta` (le copertine e i dati dei film), `playlists`, `playlist_shares` e `playlist_songs` (le playlist), con la stessa visibilità delle liste del sito.

## Test

Unitari: `services/webHome.test.ts` (le regole con fonti finte: ordine, limiti, una per `songKey`, `libraryOnly`, versioni, film raccolti, `total`, diario vuoto, una sezione che fallisce, utente), `services/webHomeData.test.ts` (il cablaggio: per chi si legge e una sola lettura del diario) e `routes/webHome.test.ts` (utente solo da `Remote-User`, `no-store`, un set di fonti per richiesta, `500`, registrazione in `server.ts` dietro Authelia). D'integrazione su un Postgres vero (`services/webHome.int.test.ts`, solo con `WEBHOME_INT=1` e un database usa-e-getta, mai la produzione; **`--no-file-parallelism`**, i file d'integrazione condividono il database, e **cancella** post, playlist e metadati di quel database): visibilità per utente, amministratore e anonimo, una regola contata davvero, la rotta con le fonti vere.

```bash
WEBHOME_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=webhome_check DB_USER=postgres DB_PASSWORD=… \
  npx vitest run --no-file-parallelism src/services/webHome.int.test.ts
```
