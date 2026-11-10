# La configurazione del sito — per utente, sul server (contratto API)

Spec: `docs/superpowers/specs/2026-11-10-web-look-and-feel-rethink-design.md` (§3.3, L4–L5). Architettura: `adr/0026-the-configuration-of-the-site-belongs-to-the-user-and-lives-on-the-server.md`. Piano: `docs/superpowers/plans/2026-11-10-web-look-and-feel.md` (Task 5).
Richiesta di Michele del 10 novembre: «configurazione per utente - di default vista A».
**Stato: implementato nel backend** (`services/uiPrefs.ts`, `routes/uiPrefs.ts`, migrazione `023_user_prefs.sql`); il sito la legge dalla fase P3 del piano.

## Che cosa si configura (e che cosa no)

La **vista** di una pagina (Studio, Bacheca, Home), le **sezioni della Home** (quali e in che ordine), il **posto del Player** (in basso, fluttuante con la sua posizione, a destra, nascosto). **Non c'è nessun colore**: i colori sono quelli di Mondrop, uno solo per sito e app (ADR-0025).

## Chi è l'utente — e la sicurezza

L'utente è **solo** l'utente Authelia della richiesta (`Remote-User`: `mike`, `archi`, `sara`, in qualunque maiuscola), **mai** il corpo né la query: una configurazione la legge e la scrive solo il suo proprietario (anche un amministratore scrive la propria). Un `Remote-User` assente o sconosciuto è «nessun utente».
La rotta **deve restare dietro il middleware `auth-family` di Traefik**, accanto a `/api/me`: mai sotto `/api/mondrop` né `/api/share` (quei router saltano Authelia, `Remote-User` diventerebbe controllato dal client e chiunque potrebbe scrivere la configurazione di chiunque; vedi `routes/mondropConnect.ts`).

## Il documento

```json
{
  "v": 1,
  "views": { "inbox": "studio", "links": "studio" },
  "home": { "sections": [
    { "id": "resume", "visible": true }, { "id": "songs", "visible": true }, { "id": "playlists", "visible": true },
    { "id": "collections", "visible": true }, { "id": "films", "visible": true }
  ] },
  "player": { "dock": "bottom", "float": { "x": 1, "y": 1 } }
}
```

| Campo | Valori | Note |
|-------|--------|------|
| `views.inbox` | `studio` · `wall` · `home` | La pagina Inbox (`/`): elenco e dettaglio, parete di schede, sezioni |
| `views.links` | `studio` · `wall` | La pagina Link (`/entries`); **`home` non è ammessa** |
| `home.sections` | esattamente i cinque id `resume`, `songs`, `playlists`, `collections`, `films`, **ognuno una volta**, ognuno con `visible` booleano | L'ordine della lista è l'ordine della Home; si sostituisce **tutta** insieme |
| `player.dock` | `bottom` · `float` · `side` · `hidden` | Dove sta il Player |
| `player.float.x`, `.y` | numeri finiti tra `0` e `1` (estremi inclusi) | Il posto del Player fluttuante, come frazione dell'area libera; `(1, 1)` è l'angolo in basso a destra |

**I valori di partenza li decide il server** (regola P: i client non ne hanno una tabella): **ogni pagina si apre in Studio** (la vista A), le cinque sezioni tutte visibili nell'ordine sopra, il Player in basso. Nel database sta **solo ciò che l'utente ha scelto** (documento rado): un valore di partenza può cambiare in un posto solo, e chi non ha mai toccato quella voce lo segue.

## Rotte

`GET`, `PUT` e `DELETE` rispondono sempre `Cache-Control: no-store`.

| Rotta | Che cosa fa | Risposta |
|-------|-------------|----------|
| `GET /api/me/prefs` | La configurazione **completa**: ciò che l'utente ha scelto sopra i valori di partenza. Senza utente: i valori di partenza (`200`, il database non viene nemmeno interrogato) | `200 { "prefs": { … } }` |
| `PUT /api/me/prefs` | Un documento **parziale** (solo le parti da cambiare), controllato contro uno schema chiuso e **unito** a ciò che l'utente aveva scelto | `200 { "prefs": { … } }` (il documento completo) |
| `DELETE /api/me/prefs` | Toglie le scelte dell'utente | `200 { "prefs": { … } }` (i valori di partenza) |

- Senza utente: `PUT` e `DELETE` rispondono **`401`** `{ "error": "authentication required", "hint": "Authelia Remote-User missing" }` e non scrivono niente.
- L'unione: le **viste** si uniscono pagina per pagina; le **sezioni** si sostituiscono tutte insieme (con ordine e interruttori); il **dock** si sostituisce; la **posizione** si unisce asse per asse. Il documento completo che il server ha risposto si può rimandare così com'è.
- Due salvataggi nello stesso momento (due dispositivi) si **accodano** (un lucchetto nel database per utente): nessuno cancella l'altro.
- Un valore salvato che il codice non conosce più (vecchio, o rovinato) **non rompe la pagina**: quella voce torna al suo valore di partenza, le altre restano. Se il database non risponde, `GET` risponde comunque i valori di partenza (e lo scrive nel log), `PUT` e `DELETE` rispondono `500 { "error": "prefs_unavailable" }`.

## Errori: `400 { "error": "invalid_prefs:<chiave>" }`

La chiave dice **che cosa** non va; non si scrive mai niente. L'ordine dei controlli è fisso: corpo, dimensione, chiavi sconosciute (nell'ordine in cui arrivano), poi le parti note.

| Errore | Quando |
|--------|--------|
| `invalid_prefs:body` | Il corpo non è un oggetto (assente, lista, stringa, numero) o non si può scrivere come JSON |
| `invalid_prefs:size` | Più di **4096 byte** di JSON (contati in byte, non in caratteri) |
| `invalid_prefs:<chiave>` | Una chiave sconosciuta al primo livello: anche `user_id` o `user` (l'utente non si legge dal corpo) |
| `invalid_prefs:v` | `v` che non è `1` |
| `invalid_prefs:views` · `views.<pagina>` | `views` non è un oggetto; una pagina che non ha viste (`views.songs`); una vista che non esiste o non è ammessa per quella pagina (`views.links` con `home`) |
| `invalid_prefs:home` · `home.<chiave>` | `home` non è un oggetto; una chiave sconosciuta |
| `invalid_prefs:home.sections` | Non è una lista di **esattamente cinque** voci |
| `invalid_prefs:home.sections.<i>` · `.<i>.<chiave>` · `.<i>.id` · `.<i>.visible` | La voce `i` non è un oggetto; ha una chiave sconosciuta; ha un id che non esiste **o già comparso** (così ne manca un altro); `visible` non è un booleano |
| `invalid_prefs:player` · `player.<chiave>` · `player.dock` | `player` non è un oggetto; una chiave sconosciuta; un dock che non esiste |
| `invalid_prefs:player.float` · `player.float.<chiave>` · `player.float.x` · `.y` | `float` non è un oggetto; una chiave sconosciuta; un valore che non è un numero finito tra 0 e 1 |

## Esempi

```bash
# la configurazione di Michele (in produzione l'utente lo mette Authelia; qui lo si simula in locale)
curl -s -H 'Remote-User: mike' "$SOUNDREEL_URL"/api/me/prefs

# la Bacheca per l'Inbox e il Player fluttuante nell'angolo in alto a sinistra: solo queste due cose cambiano
curl -s -X PUT -H 'Remote-User: mike' -H 'Content-Type: application/json' \
  -d '{"views":{"inbox":"wall"},"player":{"dock":"float","float":{"x":0,"y":0}}}' "$SOUNDREEL_URL"/api/me/prefs

# la Home con le sezioni in un altro ordine e «Da vedere» nascosta
curl -s -X PUT -H 'Remote-User: mike' -H 'Content-Type: application/json' -d '{"home":{"sections":[
  {"id":"songs","visible":true},{"id":"resume","visible":true},{"id":"playlists","visible":true},
  {"id":"collections","visible":true},{"id":"films","visible":false}]}}' "$SOUNDREEL_URL"/api/me/prefs

# un errore
curl -s -X PUT -H 'Remote-User: mike' -H 'Content-Type: application/json' -d '{"views":{"links":"home"}}' "$SOUNDREEL_URL"/api/me/prefs
# 400 {"error":"invalid_prefs:views.links"}

# tornare ai valori di partenza
curl -s -X DELETE -H 'Remote-User: mike' "$SOUNDREEL_URL"/api/me/prefs
```

## Dati

Tabella `user_prefs (user_id TEXT PRIMARY KEY, prefs JSONB NOT NULL DEFAULT '{}', updated_at TIMESTAMPTZ NOT NULL DEFAULT now())` (migrazione `023_user_prefs.sql`, idempotente, anche in `init.sql`). `prefs` contiene solo le parti scelte; `updated_at` si muove a ogni salvataggio.

## Test

Unitari (`services/uiPrefs.test.ts`, `routes/uiPrefs.test.ts`) con un finto database delle quattro istruzioni usate; d'integrazione su un Postgres vero (`services/uiPrefs.int.test.ts`, solo con `PREFS_INT=1` e un database usa-e-getta, mai la produzione; **`--no-file-parallelism`**, i file d'integrazione condividono il database):

```bash
PREFS_INT=1 DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=prefs_check DB_USER=postgres DB_PASSWORD=… \
  npx vitest run --no-file-parallelism src/services/uiPrefs.int.test.ts
```
