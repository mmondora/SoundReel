# Coda di riprocessamento e contenuti in italiano

Data: 2026-08-19
Stato: in revisione (v2 — rivista dopo la diagnosi di memoria)

## Contesto

Due problemi in scope, e due vincoli noti che questa spec **non** risolve ma
attorno ai quali è progettata.

### In scope

1. **I job in errore di autenticazione muoiono per sempre.** `handleFailure()`
   in `jobQueueWorker.ts` applica il backoff a *qualsiasi* errore. Un
   `challenge_required` di Instagram non si risolve aspettando: consuma tutti i
   tentativi di `IG_BACKOFF_MS`, poi `markJobFailed()` chiude il job. Non esiste
   endpoint né UI per rimetterlo in coda. Ogni riprova usa inoltre la stessa
   identica tecnica di download, anche quando ne esistono altre già implementate
   (`downloadMediaWithYtdlp`).

   Osservato nei log, ripetuto:
   ```
   Sidecar /download error: both iphone_api and graphql failed:
   400 Bad Request - "fail" status, message "challenge_required"
   ```

2. **I contenuti stranieri restano stranieri.** Causa radice: nessun prompt in
   `promptLoader.ts` vincola la lingua di output. Il template è scritto in
   italiano ma non lo dichiara mai come requisito, quindi il modello segue la
   lingua della fonte.

   Composizione reale dell'archivio (euristica su marker linguistici, 652 entry
   con caption > 40 caratteri): ~337 probabile inglese, ~249 probabile italiano,
   ~8 probabile spagnolo. Lo spagnolo è concentrato nelle entry recenti (9 su 60)
   ma il grosso del non-italiano è **inglese**.

   Volume di testo sull'intero archivio: `summary` 148k + `transcript` 427k +
   `notes` 85k = **660k caratteri**, di cui non italiano stimati 350-400k.

### Vincoli noti, fuori scope

3. **La macchina è satura di memoria e Ollama viene ucciso.**
   ```
   Mem:  15258 MB totali, 12434 usati, 2823 disponibili
   Swap:  4095 MB totali,  4095 usati,     0 liberi
   ```
   Su ogni prompt reale di SoundReel:
   ```
   Ollama HTTP 500 — "model runner has unexpectedly stopped,
   this may be due to resource limitations or an internal error"
   ```
   Colpisce `analyzeWithAi`, `analyzeSlides`, `describeFramesWithVision`,
   `detectMusicList` e `aiAnalysisWebPage`. Un prompt di prova da 31 token passa;
   quelli veri (3-6k caratteri, o `moondream` con 5 immagini) fanno morire il
   runner. earlyoom ha ucciso processi il 16, 17, 18 agosto e il 19 alle 09:12.

   **Non è un bug del gpu-router**: chiamato direttamente con un prompt corto
   risponde 200. È esaurimento di memoria.

   Decisione: non si interviene sulla macchina in questo lavoro. Si progetta
   *attorno* al vincolo, spostando l'inferenza fuori e non aggiungendo alcun
   servizio residente.

4. **Whisper non trascrive.** `WHISPER_URL` punta ad archi-pc
   (`192.168.178.23:9000`), irraggiungibile (`curl` → exit code 000). Il
   container locale è dietro `profiles: [local-whisper]` e non parte, quindi
   `transcribeLocal()` ritorna `status: 'skipped'` in silenzio ad ogni analisi.

   Fuori scope per scelta esplicita. Va affrontato a parte: l'opzione locale
   costerebbe ~1,5GB residenti, che il vincolo 3 rende impraticabili.

## Obiettivi

- Nessun job va perso: gli errori di autenticazione restano recuperabili e le
  riprove cambiano davvero tecnica.
- `summary`, `notes` e `transcript` leggibili in italiano, con l'originale
  sempre accessibile.
- Zero servizi nuovi residenti sulla macchina.

## Non obiettivi

- Tradurre `caption`. Resta l'originale referenziabile, immutato.
- Tradurre titoli di canzoni, film, brand o nomi propri.
- Traduzione lato browser (Google Translate): scartata — non persiste, non entra
  nella FTS, non raggiunge Telegram, e tradurrebbe anche i titoli.
- Risolvere la saturazione di memoria o rimettere in piedi Whisper.

---

## Fase 1 — Coda di riprocessamento

### 1a. Classificazione degli errori

Nuovo modulo `backend/src/services/errorClassifier.ts`, funzione pura:

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

### 1b. Ladder di tecniche di download

Nuova colonna su `job_queue`:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS strategy_idx INT NOT NULL DEFAULT 0;
```

Ladder per piattaforma, definito in `contentExtractor.ts`:

- `instagram`: `instaloader` → `ytdlp` → `og_scrape`
- `other`: `ytdlp` → `og_scrape`

Su fallimento `transient`, oltre allo scheduling del retry il worker incrementa
`strategy_idx`, saturando all'ultimo elemento. L'estrattore riceve la strategia
da usare e non riprova quelle già bruciate.

Un fallimento `auth` **non** incrementa `strategy_idx`: va rinnovata la sessione,
non cambiata la tecnica.

### 1c. Sblocco al rinnovo sessione

Nuovo stato `blocked` in `JobStatus`. I job `blocked` non vengono mai raccolti
da `claimNextInstagramJob` / `claimNextOtherJob`.

Nuovo endpoint `POST /api/admin/jobs/unblock`, protetto dalla guard già
esistente su `/api/admin/*`. Rimette in `queued` tutti i job `blocked` della
piattaforma indicata, azzerando `next_attempt_at`.

Quando lo sblocco riporta in coda almeno un job, il bot manda **un solo**
messaggio riepilogativo — non uno per job — e solo se ci sono job con
`notify = true`:

```
🔓 Sessione rinnovata: N contenuti rimessi in coda.
```

### 1d. Pannello Coda nel frontend

Nuova pagina `/queue`. Mostra i job `blocked` e `failed` con: URL sorgente,
piattaforma, tentativi, ultimo errore, strategia raggiunta.

Azioni per riga:
- **Riprova** — rimette in `queued` con `attempts = 0`
- **Riprova con…** — select della tecnica, imposta `strategy_idx` esplicito

Azione globale: **Sblocca tutti** per piattaforma.

Nessun bottone su Telegram: il webhook non gestisce `callback_query` e non è
previsto introdurlo. L'unica novità lato bot è la notifica di sblocco di 1c.

### 1e. Colonne per l'ultimo errore

Oggi `job_queue` non conserva il messaggio d'errore, quindi il pannello non
avrebbe nulla da mostrare:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS error_class TEXT;
```

### Test

- `classifyError`: un caso per pattern, più il default su stringa ignota.
- `handleFailure`: `auth` → `blocked` con `attempts` invariato; `permanent` →
  `failed` al primo colpo; `transient` → backoff e `strategy_idx` incrementato;
  `strategy_idx` satura sull'ultimo elemento del ladder.
- Endpoint di sblocco: solo i `blocked` della piattaforma richiesta cambiano
  stato; una sola notifica Telegram per sblocco.

---

## Fase 2 — Contenuti in italiano

Due meccanismi distinti, perché post nuovi e archivio hanno costi diversi.

### 2a. Post nuovi — vincolo di lingua nel prompt

Causa radice del problema, e la parte a costo zero. Ai prompt `contentAnalysis`,
`webPageAnalysis`, `slideAnalysis` ed `enrichment` viene aggiunta una regola:

```
LINGUA: scrivi SEMPRE "summary" e i "text" delle note in italiano, anche
quando la fonte è in un'altra lingua. NON tradurre titoli di canzoni, film,
brand, nomi propri e citazioni testuali (category "quote"): quelli restano
nella lingua originale.
```

Funziona su **entrambi** i motori: `aiAnalysis.ts` renderizza il prompt una volta
(`getPrompt('contentAnalysis')` + `renderTemplate`) e passa la stessa stringa sia
a Ollama sia a `runClaudePrompt()`. Dato il vincolo 3 — Ollama muore e risponde
il fallback Claude — la regola ha effetto immediato sulla via che oggi funziona.

Costo: zero chiamate aggiuntive.

I prompt sono persistiti in tabella `config` e modificabili da UI. La modifica va
applicata sia a `DEFAULT_PROMPTS` sia, con una migration, ai prompt già salvati
in DB — altrimenti la produzione continua con la versione vecchia. La migration
**appende** la regola al template esistente invece di sostituirlo, per non
perdere personalizzazioni fatte a mano.

`transcript` è escluso: è un dato grezzo verbatim, come `caption`. Va tradotto,
non riscritto — vedi 2b.

### 2b. Archivio e transcript — traduzione on-demand con Claude

Nuovo servizio `backend/src/services/translationService.ts`:

```ts
export async function detectLanguage(text: string): string | null;
export async function translateEntry(entryId: string): Promise<EntryTranslation | null>;
```

**Rilevamento lingua** — `tinyld`, libreria JS pura (~50KB, nessun modello,
nessuna rete, nessuna RAM significativa) applicata a `caption`. Se la caption è
assente o più corta di 20 caratteri si ripiega su `results.transcript`, e infine
sul `language` restituito da Whisper quando presente.

**Traduzione** — riuso di `runClaudePrompt()` da `claudeFallback.ts`, che già
invoca `claude -p --output-format json` con env allowlist (non eredita password
DB, token Telegram né altri segreti). Il binario è presente nel container
(`/usr/local/bin/claude`, v2.1.197) e `CLAUDE_CODE_OAUTH_TOKEN` è già
configurato: nessun account nuovo, nessun segreto nuovo.

Due modifiche necessarie a `claudeFallback.ts`:

1. `runClaudePrompt(prompt, opts?: { model?: string })` — oggi il modello arriva
   solo da `CLAUDE_FALLBACK_MODEL`. Serve poterlo passare per chiamata.
2. Nuova env `TRANSLATION_MODEL`, default `haiku`. Il fallback gira oggi su
   `claude-opus-4-8` e l'ultima chiamata riuscita ha impiegato **12.963 ms**:
   per tradurre è sproporzionato e consuma quota dell'abbonamento senza motivo.

**Serializzazione — obbligatoria.** Ogni `claude -p` è un processo Node locale,
misurato tra 225 e 581 MB RSS. L'inferenza è in cloud, l'orchestrazione no. Con
2,8GB disponibili, due traduzioni concorrenti sono un rischio concreto di OOM.
`translationService` mantiene quindi una coda interna a concorrenza **1**: una
seconda richiesta attende, non spawna un secondo processo.

**Trigger** — solo al primo click sul toggle "IT" di una entry non ancora
tradotta. Nessun batch, nessun backfill dell'archivio: sarebbero centinaia di
spawn seriali su una macchina già satura.

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
peso `B`, così una ricerca in italiano trova anche i post inglesi e spagnoli. La
funzione va ricreata e il vettore ricalcolato sulle entry già tradotte.

### UI

Sulla card del journal: badge con la lingua rilevata (`EN`, `ES`, …) e toggle
`IT / originale`, visibile solo quando `sourceLang !== 'it'`. Al primo click su
una entry non tradotta parte la chiamata: la card mostra uno stato di
caricamento, perché anche con Haiku si parla di secondi, non di millisecondi.

### Limite noto e accettato

`noteKey` resta calcolato sul testo **originale**, perché è la chiave di
aggregazione di `NotesPage` e delle tabelle `note_meta`: cambiarla
invaliderebbe tutti gli arricchimenti già fatti. Conseguenza: la stessa nota in
inglese e in italiano resta contata come due note distinte nella pagina Note. La
traduzione è display-only.

### Test

- `detectLanguage`: caption inglese → `en`; caption vuota → fallback su
  transcript; testo sotto i 20 caratteri → fallback.
- `translateEntry`: `runClaudePrompt` mockato; l'originale resta immutato; una
  entry già tradotta non ritraduce; due chiamate concorrenti producono **uno
  solo** spawn alla volta.
- Vincolo di lingua nei prompt: il template renderizzato contiene la regola.
- Nessuna chiamata reale a Claude, Ollama o servizi esterni.

---

## Ordine di implementazione

1. **Fase 1 (Coda)** — indipendente, sblocca i job Instagram fermi per
   `challenge_required`.
2. **Fase 2a (regola di lingua)** — una modifica ai prompt più una migration.
   Effetto immediato sui post nuovi.
3. **Fase 2b (traduzione on-demand)** — la parte con più codice nuovo.

Branch unico, merge quando tutte le fasi sono verdi.

## Rischi

| Rischio | Mitigazione |
|---|---|
| Gli spawn di `claude -p` aggravano la saturazione di memoria | Concorrenza 1, processo effimero, solo su richiesta esplicita dell'utente. Nessun backfill |
| La quota dell'abbonamento Claude si esaurisce | Haiku invece di Opus, e traduzione solo on-demand invece che su tutto l'archivio |
| Il vincolo di lingua fa tradurre anche i titoli | La regola elenca esplicitamente le eccezioni; test sul template renderizzato |
| La migration dei prompt sovrascrive personalizzazioni fatte da UI | La migration appende la regola al template esistente invece di sostituirlo |
| `claude -p` non disponibile o token scaduto a runtime | `runClaudePrompt` non lancia mai eccezioni: ogni fallimento risolve in uno stato non-`ok`. Il toggle IT mostra un errore, la entry resta leggibile in originale |

## Questioni aperte, da affrontare a parte

- **Memoria e Ollama** (vincolo 3). Finché non è risolto, tutta l'analisi AI
  passa dal fallback Claude a ogni post: più lento e consuma quota. È il
  problema più grave dei quattro emersi.
- **Whisper** (vincolo 4). Nessun transcript nuovo viene prodotto. Quelli in
  archivio (427k caratteri) restano traducibili, ma non se ne aggiungono.
