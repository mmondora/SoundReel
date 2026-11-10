# L'elenco dei post, a pagine, con i filtri — contratto API (`GET /api/entries?view=summary`, `GET /api/entries/facets`)

Spec: `docs/superpowers/specs/2026-11-10-web-look-and-feel-rethink-design.md` §3.6. Richiesta di Michele (10 novembre): «in inbox sulla lista non voglio avere "apri tutta la libreria" ma la paginazione con 30 o 40 per pagina».
**Stato: contratto scritto prima del codice** (10 novembre), **poi realizzato dal server** (stesso giorno: `services/entriesIndex.ts`, `routes/entriesIndex.ts`, il ramo `view=summary` di `routes/entries.ts` e una riga in `server.ts`); il sito (Inbox a pagine, `pages/Home.tsx`) si costruisce su questo testo. Dove il codice precisa il contratto, è corretto qui (le righe «come fa il codice» sotto).

## Che cosa è

L'Inbox non mostra più «le ultime cinque voci e un collegamento alla libreria»: mostra **tutta la libreria a pagine da 40**, e **i filtri della barra «Filtra»** (piattaforma, canale, utente, categoria, verdetto, tag), che prima agivano sulle sole ultime cinquanta voci già scaricate, **li fa il server su tutta la libreria** (regola P: il sito disegna, il server decide pagina, totale e filtri). Le **faccette** (quali piattaforme, quanti tag, con che conteggi) sono la risposta di una rotta a parte, perché non dipendono dalla pagina.

## Chi è l'utente — e la sicurezza

Come `GET /api/entries` oggi: l'utente è **solo** `Remote-User` (Authelia), mai la query né il corpo; si vedono i **propri** post e quelli **condivisi** con la persona (stessa visibilità, stesso helper). **Un filtro non allarga mai la visibilità**: filtra ciò che la persona può già leggere. Le due rotte **restano dietro `auth-family`** (mai sotto `/api/mondrop` né `/api/share`).

## Le rotte

| Rotta | Che cosa fa | Risposta |
|-------|-------------|----------|
| `GET /api/entries?view=summary&limit&offset&platform&channel&user&category&verdict&tag` | L'elenco a pagine, dal più recente (**a pari data, l'`id` più grande per primo**: due pagine non mostrano mai due volte la stessa voce). `limit` 1–1000, senza `limit` 200 (l'Inbox chiede 40), `offset` ≥ 0 (come oggi). Ogni filtro è facoltativo; **più filtri si sommano (E)** | `200 { entries: EntrySummaryRow[], total, limit, offset }` — `total` = **quante voci passano i filtri** (non quante nella pagina; giusto anche con `offset` oltre la fine); `limit` e `offset` sono quelli **usati** (già portati in range) |
| `GET /api/entries/facets` | Quali valori ci sono, con quante voci, **su tutte le voci visibili** (non filtrate: servono a scegliere un filtro) | `200 { platforms, channels, users, categories, verdicts, tags }` |

Tutte rispondono `Cache-Control: no-store`. **Come fa il codice:** l'elenco `view=summary` lo dice in tutte e tre le sue risposte (200, 400, 500); l'elenco intero (senza `view=summary`) **non** lo dice, come non l'ha mai detto.

**I filtri** (stringhe di 1–100 caratteri dopo il `trim`; vuoto = ignorato):

| Parametro | Quali voci passano |
|-----------|--------------------|
| `platform` | `sourcePlatform` uguale (`instagram`, `tiktok`, `youtube`…) |
| `channel` | `inputChannel` uguale (`telegram`, `web`, `ios`) |
| `user` | `inputUser` uguale (chi ha mandato il link) |
| `category` | `results.enrichments.category` uguale (`tech`, `security`, `claim`, `generic`) |
| `verdict` | `results.enrichments.verdict.label` uguale |
| `tag` | la voce ha questo tag, **senza `#`/`@` davanti e senza badare alle maiuscole** (come oggi sul sito: un tag dell'AI o scritto da Telegram: `vino`, `#vino`, `@Vino` e `##VINO` sono lo stesso tag). Un valore fatto solo di segni (`#`, `@@`) **non trova niente** (come fa il codice); un tag a metà (`vin`) nemmeno: il confronto è per tag intero |

**La riga** (`EntrySummaryRow`) è quella di oggi (`id`, `sourceUrl`, `sourcePlatform`, `caption`, `thumbnailUrl`, `status`, `createdAt`, `summary`, `songCount`, `filmCount`, `noteCount`, `tags`, e i chip `collections` della 2.24.0) **più quattro campi**, che l'Inbox usa per disegnare la riga e che i filtri leggono. **Come fa il codice:** i quattro campi ci sono **sempre** nella risposta `view=summary`, anche senza filtri, e il resto della riga è **identico** a quello di prima (la prova d'integrazione lo confronta campo per campo con `listEntrySummaries`); i chip si attaccano alle righe **già filtrate** e un guasto dei chip non rompe mai l'elenco (le righe escono con `collections: []`, il guasto va nel log):

```ts
inputChannel: string;                                   // 'telegram' | 'web' | 'ios'
inputUser: string | null;
category: string | null;                                // enrichments.category
verdict: { label: string; confidence: number } | null;  // enrichments.verdict (la tooltip dell'icona; la spiegazione sta nel post)
//   `verdict` è null senza etichetta (anche un'etichetta vuota); con l'etichetta ma senza una `confidence` leggibile, `confidence` è 0
```

**Le faccette**:

```ts
interface EntryFacets {
  platforms: Array<{ platform: string; count: number }>;   // dal più frequente
  channels:  Array<{ channel: string;  count: number }>;
  users:     Array<{ user: string;     count: number }>;   // solo chi ha un inputUser
  categories: Array<{ category: string; count: number }>;
  verdicts:  Array<{ verdict: string;  count: number }>;
  tags:      Array<{ tag: string;      count: number }>;   // i 40 più frequenti, a pari conteggio per nome; il tag com'è scritto (con #/@); MAI i segnaposto del modello (#tag, @utente, #hashtag, con o senza segno e in qualunque maiuscola: spec raccolte §6.5)
}
```
Un elenco senza valori è `[]`. Un utente senza voci: tutti `[]` e `total: 0`.

**Come fa il codice** (le faccette): sono su **tutte** le voci visibili, **non** seguono né i filtri né la pagina; ogni conteggio è il `total` che quel filtro dà (la prova d'integrazione lo verifica per ogni valore). Piattaforme, canali, utenti, categorie e verdetti: dal più frequente, **a pari conteggio per nome**; un valore vuoto (`''`) o assente non è mai una faccetta (un post senza mittente non è un «utente»). I **tag**: contati **una volta per voce** (`#cantina` scritto due volte nello stesso post conta uno), `#Vino`, `#vino` e `@vino` sono **un solo tag**, mostrato **come l'hanno scritto più voci** (a pari uso, il primo per nome); un tag fatto di soli segni non è un tag; a pari conteggio l'ordine è quello **per nome com'è mostrato**, secondo l'ordinamento del database; solo i 40 più usati. Un post i cui `tags` non sono una lista (riga vecchia o rotta) non ha tag e **non rompe** né l'elenco né le faccette. Le due rotte non fidano mai di un valore: filtri, utente, `limit` e `offset` sono tutti **parametri** della query, mai testo SQL.

## Errori

| Risposta | Quando |
|----------|--------|
| `400 { "error": "invalid_query:<campo>" }` | `limit` o `offset` **non numerici** (`abc`, dato due volte), un filtro più lungo di 100 caratteri (contati in caratteri, non in byte), un filtro dato più volte (array). **Come fa il codice:** un `limit` o un `offset` numerici ma **fuori range** NON sono un 400: si portano in range come ha sempre fatto l'elenco (`limit` in 1–1000, `offset` ≥ 0 e intero; un `limit` vuoto vale 1; `Infinity` vale 1000 per il `limit`), e la risposta dice quelli usati. Con più errori il campo nominato è il primo di: `limit`, `offset`, poi i filtri nell'ordine `platform`, `channel`, `user`, `category`, `verdict`, `tag`; un 400 non interroga il database |
| `500 { "error": "entries_failed" }` | un guasto che non è dell'utente (va nel log, mai nel corpo): vale per **tutte e due** le rotte, anche per l'elenco `view=summary` (prima un guasto usciva col messaggio di Fastify) |

Senza `view=summary` la rotta risponde **com'è oggi** (l'array di voci intere: le app e le pagine vecchie non cambiano) e **ignora** i filtri.

## Come si prova

Unitari con il database finto e d'integrazione su Postgres vero (`ENTRIES_INT=1`, scratch `collections_check`, mai `soundreel-db`): ogni filtro da solo e in coppia, il `total` che segue i filtri, `offset` oltre la fine (`entries: []`, `total` giusto), un tag con `#`/`@`/maiuscole, i quattro campi nuovi (e `null` quando non ci sono), le faccette con conteggi veri, **un utente che non vede le voci di un altro anche con il filtro giusto**, `?user=` della query che non sceglie l'utente (il filtro `user` è `inputUser`, un'altra cosa). Rotture provate con il banco delle mutazioni.

**I file:** `backend/src/services/entriesIndex.ts` (`parseEntryFilter`, `listEntrySummariesFiltered`, `entryFacets`) con `entriesIndex.test.ts` (unitari) e `entriesIndex.int.test.ts` (Postgres vero, `ENTRIES_INT=1 DB_NAME=collections_check …`, id `eidx-…`, utenti `eidx_…`, ripulisce per prefisso); `backend/src/routes/entriesIndex.ts` (`entriesIndexFor`, `registerEntriesIndexRoutes` = solo `GET /api/entries/facets`) con `entriesIndex.test.ts`; il ramo `view=summary` di `routes/entries.ts` (chiama `entriesIndexFor`, poi attacca i chip) con `entries.test.ts`; la riga di `server.ts` che registra la rotta (accanto a `registerEntriesRoutes`, dietro Authelia). La visibilità è **la stessa funzione** di ogni altro elenco (`visibilitySql` di `utils/db.ts`, ora esportata) e sta sempre nel `WHERE` come parametro.
