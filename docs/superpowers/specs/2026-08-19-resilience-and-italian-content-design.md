# Resilienza pipeline e contenuti in italiano

Data: 2026-08-19
Stato: in revisione

## Contesto

Tre problemi osservati in produzione, indipendenti fra loro ma che condividono
lo stesso obiettivo — rendere il journal utilizzabile senza intervento manuale:

1. **Whisper non trascrive da settimane.** `WHISPER_URL` punta al servizio
   nativo su archi-pc (`192.168.178.23:9000`), che risulta irraggiungibile
   (`curl` → exit code 000). Il container locale `soundreel-whisper` esiste ma
   è dietro `profiles: [local-whisper]`, quindi non parte. `transcribeLocal()`
   ritorna `status: 'skipped'` silenziosamente ad ogni analisi.

2. **I job in errore di autenticazione muoiono per sempre.** `handleFailure()`
   in `jobQueueWorker.ts` applica il backoff a *qualsiasi* errore. Un
   `challenge_required` di Instagram non si risolve aspettando: consuma tutti i
   tentativi della tabella `IG_BACKOFF_MS`, poi `markJobFailed()` chiude il job.
   Non esiste alcun endpoint né UI per rimetterlo in coda. Inoltre ogni riprova
   usa la stessa identica tecnica di download, anche quando ne esistono altre
   già implementate (`downloadMediaWithYtdlp`).

3. **I contenuti stranieri restano stranieri.** Molti diari recenti sono in
   spagnolo. Causa radice: nessun prompt in `promptLoader.ts` vincola la lingua
   di output — il template è scritto in italiano ma non lo dichiara mai come
   requisito, quindi il modello segue la lingua della fonte.

## Obiettivi

- Whisper torna a trascrivere e resta operativo anche con archi-pc spento.
- Nessun job va perso: gli errori di autenticazione restano recuperabili e le
  riprove cambiano davvero strategia.
- `summary`, `notes` e `transcript` leggibili in italiano, con l'originale
  sempre accessibile.

## Non obiettivi

- Tradurre `caption`. Resta l'originale referenziabile, immutato.
- Tradurre titoli di canzoni, film o nomi propri.
- Traduzione lato browser (Google Translate): scartata — non persiste, non
  entra nella FTS, non raggiunge Telegram, e traduce anche i titoli.

---

## Fase 1 — Whisper con fallback automatico

### Design

`whisperClient.ts` accetta una lista ordinata di endpoint invece di un singolo
URL. Nuova env `WHISPER_URLS` (CSV), con `WHISPER_URL` mantenuta come fallback
retrocompatibile per non rompere il deploy esistente.

```
WHISPER_URLS=http://192.168.178.23:9000,http://soundreel-whisper:9000
```

`transcribeLocal()` prova gli endpoint in ordine. Un endpoint è considerato
fallito su errore di rete, timeout o status >= 500; in quel caso passa al
successivo. Un 4xx è un errore della richiesta, non dell'endpoint: interrompe
subito senza provare gli altri.

Ogni tentativo produce una riga in `actionLog` con endpoint, esito e durata,
così dal journal si vede quale servizio ha risposto.

### Modifiche compose

- `soundreel-whisper`: rimosso `profiles: [local-whisper]`, il container parte
  sempre. `ASR_MODEL` resta `small` (~1.5GB RSS).
- `soundreel`: `depends_on` su `soundreel-whisper` ripristinato con
  `condition: service_started`.

### Vincolo di memoria

La macchina ha 14GB totali con ~5GB disponibili ed earlyoom attivo per storico
di OOM. Il container aggiunge ~1.5GB stabili. Nel compose va quindi aggiunto un
`mem_limit: 2g` su `soundreel-whisper`, così un picco del modello colpisce il
container e non innesca earlyoom sugli altri servizi.

Passo operativo separato, fuori dal repo: la configurazione di earlyoom sull'host
(`--prefer`) va estesa perché `whisper` sia sacrificato prima di `soundreel` e
`soundreel-db`. Non è codice, è una modifica a `/etc/default/earlyoom` da fare a
mano al momento del deploy — va nel piano come task esplicito, non nel branch.

### Test

- Unit su `transcribeLocal`: primo endpoint down → usa il secondo; entrambi down
  → `status: 'error'` con la ragione di entrambi; 4xx sul primo → nessun
  tentativo sul secondo.
- Nessuna chiamata reale: `fetch` mockato.

---

## Fase 2 — Coda di riprocessamento

### 2a. Classificazione degli errori

Nuovo modulo `backend/src/services/errorClassifier.ts`, funzione pura,
facilmente testabile:

```ts
export type ErrorClass = 'transient' | 'auth' | 'permanent';
export function classifyError(err: string): ErrorClass;
```

| Classe | Pattern | Comportamento |
|---|---|---|
| `auth` | `challenge_required`, `login_required`, `checkpoint_required`, `401`, `403` | job → `blocked`, **`attempts` non incrementato** |
| `permanent` | `unable to extract shortcode`, `404`, `not found`, `unsupported url` | job → `failed` subito, nessun retry |
| `transient` | tutto il resto (default) | backoff attuale, invariato |

Il default è `transient`: un errore non riconosciuto viene ritentato, mai
scartato.

### 2b. Ladder di tecniche di download

Nuova colonna su `job_queue`:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS strategy_idx INT NOT NULL DEFAULT 0;
```

Ladder per piattaforma, definito in `contentExtractor.ts`:

- `instagram`: `instaloader` → `ytdlp` → `og_scrape`
- `other`: `ytdlp` → `og_scrape`

Su fallimento `transient`, oltre allo scheduling del retry il worker incrementa
`strategy_idx` (saturando all'ultimo elemento del ladder). L'estrattore riceve
la strategia da usare e non riprova quelle già bruciate.

Un fallimento `auth` **non** incrementa `strategy_idx`: la sessione va rinnovata,
non la tecnica cambiata.

### 2c. Sblocco al rinnovo sessione

Nuovo stato `blocked` in `JobStatus`. I job `blocked` non vengono mai raccolti
da `claimNextInstagramJob` / `claimNextOtherJob`.

Nuovo endpoint `POST /api/admin/jobs/unblock`, protetto dalla guard già
esistente su `/api/admin/*`. Rimette in `queued` tutti i job `blocked` della
piattaforma indicata, azzerando `next_attempt_at`.

Quando lo sblocco riporta in coda almeno un job, il bot manda **un solo**
messaggio riepilogativo — non uno per job — ai soli job con `notify = true`:

```
🔓 Sessione rinnovata: N contenuti rimessi in coda.
```

### 2d. Pannello Coda nel frontend

Nuova pagina `/queue`. Mostra i job in stato `blocked` e `failed` con: URL
sorgente, piattaforma, tentativi, ultimo errore, strategia raggiunta.

Azioni per riga:
- **Riprova** — rimette in `queued` con `attempts = 0`
- **Riprova con…** — select della tecnica, imposta `strategy_idx` esplicito

Azione globale: **Sblocca tutti** per piattaforma.

Nessun bottone su Telegram: il webhook non gestisce `callback_query` e non è
previsto introdurlo. L'unica novità lato bot è la notifica di sblocco di 2c.

### Serve una colonna per l'ultimo errore

Oggi `job_queue` non conserva il messaggio d'errore, quindi il pannello non
avrebbe nulla da mostrare:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS error_class TEXT;
```

### Test

- `classifyError`: un caso per pattern, più il default su stringa ignota.
- `handleFailure`: `auth` → `blocked` e `attempts` invariato; `permanent` →
  `failed` al primo colpo; `transient` → backoff e `strategy_idx` incrementato;
  `strategy_idx` satura sull'ultimo elemento del ladder.
- Endpoint di sblocco: solo i `blocked` della piattaforma richiesta cambiano
  stato; una sola notifica Telegram per sblocco.

---

## Fase 3 — Contenuti in italiano

Due meccanismi distinti, perché i post nuovi e lo storico hanno costi diversi.

### 3a. Post nuovi — vincolo di lingua nel prompt

Causa radice del problema. Ai prompt `contentAnalysis`, `webPageAnalysis`,
`slideAnalysis` ed `enrichment` viene aggiunta una regola esplicita:

```
LINGUA: scrivi SEMPRE "summary" e i "text" delle note in italiano, anche
quando la fonte è in un'altra lingua. NON tradurre titoli di canzoni, film,
brand, nomi propri e citazioni testuali (category "quote"): quelli restano
nella lingua originale.
```

Costo aggiuntivo: zero chiamate Ollama. `summary` e `notes` nascono in italiano.

I prompt sono persistiti in tabella `config` e modificabili da UI: la modifica
va applicata sia a `DEFAULT_PROMPTS` sia, con una migration, ai prompt già
salvati in DB — altrimenti l'istanza in produzione continua a usare la versione
vecchia.

`transcript` è escluso: è un dato grezzo verbatim, come `caption`. Va tradotto,
non riscritto — vedi 3b.

### 3b. Storico e transcript — traduzione on-demand

Nuovo servizio `backend/src/services/translationService.ts`:

```ts
export async function detectLanguage(text: string): Promise<string | null>;
export async function translateToItalian(text: string): Promise<string | null>;
export async function translateEntry(entryId: string): Promise<EntryTranslation | null>;
```

- **Rilevamento lingua**: `tinyld` (libreria locale, ~50KB, nessuna rete) su
  `caption`. Se la caption è vuota o troppo corta (< 20 caratteri) si ripiega su
  `results.transcript` e infine sul `language` restituito da Whisper.
- **Traduzione**: Ollama `qwen2.5:3b` via `generateText()`, già nello stack.
- **Trigger**: al primo click sul toggle "IT" di una entry non ancora tradotta.
  Nessun batch, nessun ricalcolo dello storico.

### Storage

Campo nuovo dentro `results` (JSONB, nessuna migration di schema):

```ts
export interface EntryTranslation {
  sourceLang: string;          // 'es', 'en', …
  summary: string | null;
  transcript: string | null;
  notes: Array<{ index: number; text: string }>;
  model: string;
  translatedAt: string;
}
```

L'originale non viene **mai** sovrascritto. Le note sono indicizzate per
posizione nell'array `results.notes`.

### Ricerca

`entries_build_search_vector()` viene esteso per includere il testo tradotto con
peso `B`, così una ricerca in italiano trova anche i post spagnoli. La funzione
va ricreata e il vettore ricalcolato sulle entry già tradotte.

### UI

Sulla card del journal: badge con la lingua rilevata (`ES`, `EN`, …) e toggle
`IT / originale`. Il toggle è visibile solo quando `sourceLang !== 'it'`. Al
primo click su una entry non tradotta parte la chiamata e la card mostra uno
stato di caricamento.

### Limite noto e accettato

`noteKey` resta calcolato sul testo **originale**, perché è la chiave di
aggregazione di `NotesPage` e delle tabelle `note_meta`: cambiarla
invaliderebbe tutti gli arricchimenti già fatti. Conseguenza: la stessa nota in
spagnolo e in italiano resta contata come due note distinte nella pagina Note.
La traduzione è display-only. Accettato per questa iterazione.

### Test

- `detectLanguage`: caption spagnola → `es`; caption vuota → fallback su
  transcript; testo troppo corto → fallback.
- `translateEntry`: Ollama mockato; l'originale resta immutato; entry già
  tradotta non ritraduce.
- Vincolo di lingua nei prompt: verifica che il template renderizzato contenga
  la regola.
- Nessuna chiamata reale a Ollama o a servizi esterni.

---

## Ordine di implementazione

1. **Fase 1 (Whisper)** — indipendente, sblocca il `language` di Whisper che
   serve come fallback al rilevamento lingua della fase 3.
2. **Fase 2 (Coda)** — indipendente.
3. **Fase 3 (Italiano)** — usa il rilevamento lingua, quindi per ultima.

Branch unico, merge quando tutte e tre le fasi sono verdi.

## Rischi

| Rischio | Mitigazione |
|---|---|
| Il container Whisper spinge la macchina in OOM | `mem_limit: 2g` e priorità earlyoom più alta di `soundreel` |
| `qwen2.5:3b` traduce male dallo spagnolo | La traduzione è additiva: l'originale resta sempre visibile. Se la qualità non basta, si cambia modello senza toccare lo schema |
| Il vincolo di lingua nel prompt fa tradurre anche i titoli | La regola elenca esplicitamente le eccezioni; test sul template renderizzato |
| La migration dei prompt sovrascrive personalizzazioni manuali fatte da UI | La migration aggiunge la regola in coda al template esistente invece di sostituirlo |
