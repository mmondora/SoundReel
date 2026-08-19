# Orchestrazione inferenza, coda resiliente e contenuti in italiano

Data: 2026-08-19
Stato: in revisione (v3 — riscritta dopo la diagnosi del GPU hang)

## Contesto

Quattro problemi, tutti osservati in produzione e tutti verificati sul campo.

### 1. La GPU del geekom si pianta sull'inferenza vision

Causa radice dei 500 di Ollama. Dal log del runner:

```
load_tensors: offloaded 37/37 layers to GPU
ROCm0 model buffer size = 1834.83 MiB
llama runner started in 6.86 seconds
HW Exception by GPU node-1 reason :GPU Hang
```

Il modello si carica, il runner parte, poi la GPU si appende durante
l'inferenza. Il messaggio che Ollama restituisce al chiamante — *"model runner
has unexpectedly stopped, this may be due to resource limitations"* — è generico
e fuorviante: non è esaurimento di memoria.

Sequenza riprodotta a mano:

| Passo | Esito |
|---|---|
| `qwen2.5:3b`, prompt da 6k caratteri | 200 |
| `moondream`, una immagine | **500 — GPU Hang** |
| `qwen2.5:3b`, stesso prompt di prima | **500** |
| `moondream` | **500** |

Due proprietà importanti:

- **La vision è il trigger.** Cinque run consecutive di solo testo passano
  (5/5, zero hang). La prima chiamata a `moondream` appende il device.
- **L'hang è persistente e globale.** Dopo l'hang cade anche il testo.
  `docker compose restart` **non** recupera (8 hang dopo il restart);
  `docker compose up -d --force-recreate` sì (0 hang, 3/3 ok).

Combacia con l'ordine dei fallimenti nei log di produzione:
`describeFramesWithVision` cade per prima, poi in cascata `analyzeWithAi`,
`detectMusicList` e `aiAnalysisWebPage`.

Conseguenza: **oggi ogni analisi passa dal fallback Claude Opus**, 12,9 secondi
a colpo, consumando quota dell'abbonamento Max su ogni singolo post.

### 2. I job in errore di autenticazione muoiono per sempre

`handleFailure()` in `jobQueueWorker.ts` applica il backoff a *qualsiasi*
errore. Un `challenge_required` di Instagram non si risolve aspettando: consuma
tutti i tentativi di `IG_BACKOFF_MS`, poi `markJobFailed()` chiude il job. Non
esiste endpoint né UI per rimetterlo in coda, e ogni riprova usa la stessa
identica tecnica di download.

Osservato nei log, ripetuto:
```
Sidecar /download error: both iphone_api and graphql failed:
400 Bad Request - "fail" status, message "challenge_required"
```

### 3. Whisper non trascrive, e blocca la pipeline mentre ci prova

`WHISPER_URL` punta ad archi-pc (`192.168.178.23:9000`), spento e
irraggiungibile. `transcribeLocal()` ritorna `status: 'skipped'` in silenzio.
Anche quando archi-pc è acceso, la trascrizione è sincrona dentro la pipeline:
un video lungo tiene occupato il job per minuti.

### 4. I contenuti stranieri restano stranieri

Nessun prompt in `promptLoader.ts` vincola la lingua di output. Il template è
scritto in italiano ma non lo dichiara come requisito, quindi il modello segue
la lingua della fonte.

Composizione dell'archivio (euristica su marker linguistici, 652 entry con
caption > 40 caratteri): ~337 probabile inglese, ~249 italiano, ~8 spagnolo. Lo
spagnolo si concentra nelle entry recenti (9 su 60), ma il grosso del non
italiano è **inglese**.

Volume: `summary` 148k + `transcript` 427k + `notes` 85k = **660k caratteri**
sull'intero archivio, di cui non italiano stimati 350-400k. Traffico: 6-11
entry al giorno.

## Obiettivi

- L'inferenza locale smette di piantarsi, e quando serve potenza si accende
  archi-pc invece di ripiegare sempre su Claude.
- Nessun job va perso: gli errori di autenticazione restano recuperabili e le
  riprove cambiano davvero tecnica.
- La trascrizione non blocca più la pipeline.
- `summary`, `notes` e `transcript` leggibili in italiano, con l'originale
  sempre accessibile.

## Non obiettivi

- Tradurre `caption`. Resta l'originale referenziabile, immutato.
- Tradurre titoli di canzoni, film, brand o nomi propri.
- Traduzione lato browser (Google Translate): scartata — non persiste, non entra
  nella FTS, non raggiunge Telegram, e tradurrebbe anche i titoli.
- Cambiare il meccanismo di download. Instaloader e yt-dlp restano come sono.
- Aggiungere hardware o servizi residenti sul geekom.

## Repository toccati

| Repo | Cosa |
|---|---|
| `Soundreel` | coda, whisper async, traduzione, prompt |
| `geekom-hub/gpu-router` | wake di archi-pc, routing vision, `keep_alive` |
| `mneme/deploy` | env di ollama (già applicato, non committato) |
| host | timer systemd per il watchdog GPU |

---

## Fase 1 — Orchestrazione dell'inferenza

La più urgente: finché non è fatta, ogni post brucia quota Claude.

### 1a. Wake di archi-pc nel gpu-router

`archi.sh` ha già tutte le primitive:

```
./archi.sh wake      # WoL via Mikrotik, attende il boot fino a 120s
./archi.sh ollama    # avvia Ollama su archi-pc, bind LAN, 11434
./archi.sh whisper   # avvia whisper-asr, 9000, CPU
```

Il gpu-router ha già la configurazione di priorità corretta:

```
OLLAMA_BACKENDS=archipc,http://192.168.178.23:11434,0,0
                geekom,http://ollama:11434,100,0
```

Gli manca solo il wake: oggi vede archipc down, lo marca unhealthy e va sempre
su geekom. Si aggiunge in `app.py`:

- Un contatore di richieste in coda per pool. Superata la soglia
  `WAKE_THRESHOLD` (default 3) con il backend tier-0 unhealthy, parte il wake.
- Il wake è **asincrono e non bloccante**: la richiesta corrente va su geekom,
  non aspetta i 120 secondi di boot. Le successive troveranno archipc pronto.
- Debounce `WAKE_COOLDOWN` (default 600s) per non tempestare di WoL una
  macchina che non si accende.
- L'esecuzione avviene via SSH dal container verso il geekom, oppure — da
  decidere in fase di piano — via endpoint dell'hub. Le credenziali Mikrotik e
  la chiave SSH non devono finire in una nuova immagine.

### 1b. La vision non gira mai sul geekom

Vincolo duro, non una preferenza: è ciò che appende il device.

Il gpu-router impedisce il routing dei modelli vision verso il backend geekom.
Nuova env `VISION_MODELS` (default `moondream`). Se il modello richiesto è in
lista e l'unico backend sano è geekom, il router risponde **503** invece di
inoltrare.

Lato SoundReel, `describeFramesWithVision()` tratta il 503 come uno skip
pulito, non come un errore: registra in `actionLog` che la vision non era
disponibile e prosegue. La pipeline è già progettata per questo — restano OCR,
caption e trascrizione. Il risultato è più povero, la GPU resta viva.

### 1c. Scarico del modello dopo l'uso

Ogni richiesta instradata verso il backend geekom riceve `"keep_alive": 0`,
iniettato dal router. Il modello viene scaricato subito dopo l'uso invece di
restare residente. Supportato nativamente dall'API di Ollama.

Su archipc `keep_alive` resta al default: lì la memoria non è il problema, e
ricaricare a ogni chiamata sarebbe solo più lento.

### 1d. Watchdog del GPU hang

Timer systemd utente sull'host — stessa tecnica già usata per `fritz-sync`,
nessun socket Docker esposto ai container.

`gpu-hang-watchdog.sh`, ogni 2 minuti:
1. cerca `GPU Hang` nei log di ollama dall'ultimo controllo;
2. se lo trova, esegue `docker compose up -d --force-recreate ollama`
   (il `restart` non recupera, verificato);
3. logga in `~/.local/share/geekom/gpu-watchdog.log`.

Guardia anti-loop: non più di 3 ricreazioni all'ora; oltre, smette e logga.

### 1e. Env di Ollama

Già applicate a `mneme/deploy/docker-compose.yml`, **non committate**:

```yaml
- OLLAMA_KEEP_ALIVE=5m
- OLLAMA_MAX_LOADED_MODELS=1
```

Non risolvono l'hang — la causa è la vision — ma evitano di tenere due modelli
residenti per mezz'ora su una macchina con 2,8GB liberi.

Nota: `OLLAMA_FLASH_ATTENTION=0` è stata provata e **non** risolve. Non va
introdotta.

### Test

- `select_backend`: modello vision + solo geekom sano → nessun backend
  selezionabile; modello testuale + solo geekom → geekom.
- Iniezione `keep_alive`: presente sulle richieste verso geekom, assente verso
  archipc.
- Trigger di wake: sotto soglia non parte; sopra soglia parte una volta sola
  entro il cooldown; il wake non blocca la risposta.
- Watchdog: log con `GPU Hang` → ricreazione; senza → nessuna azione; quarta
  ricreazione nella stessa ora → rifiutata.
- Nessuna chiamata reale: SSH, WoL e Docker mockati.

---

## Fase 2 — Coda di riprocessamento

### 2a. Classificazione degli errori

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

### 2b. Ladder di tecniche di download

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS strategy_idx INT NOT NULL DEFAULT 0;
```

Ladder per piattaforma, in `contentExtractor.ts`:

- `instagram`: `instaloader` → `ytdlp` → `og_scrape`
- `other`: `ytdlp` → `og_scrape`

Su fallimento `transient` il worker incrementa `strategy_idx`, saturando
all'ultimo elemento. Su fallimento `auth` **non** lo incrementa: va rinnovata la
sessione, non cambiata la tecnica.

Il meccanismo di download in sé non cambia: cambia solo quale delle tecniche già
esistenti viene scelta al tentativo N.

### 2c. Sblocco al rinnovo sessione

Nuovo stato `blocked` in `JobStatus`, mai raccolto da `claimNextInstagramJob` /
`claimNextOtherJob`.

`POST /api/admin/jobs/unblock`, dietro la guard già esistente su
`/api/admin/*`, rimette in `queued` tutti i `blocked` della piattaforma
indicata azzerando `next_attempt_at`.

Un solo messaggio riepilogativo su Telegram, non uno per job, e solo se ci sono
job con `notify = true`:

```
🔓 Sessione rinnovata: N contenuti rimessi in coda.
```

### 2d. Pannello Coda

Nuova pagina `/queue`: job `blocked` e `failed` con URL, piattaforma,
tentativi, ultimo errore, strategia raggiunta.

Per riga: **Riprova** (torna in `queued`, `attempts = 0`) e **Riprova con…**
(select della tecnica, imposta `strategy_idx`). Globale: **Sblocca tutti**.

Nessun bottone su Telegram: il webhook non gestisce `callback_query` e non è
previsto introdurlo.

### 2e. Colonne per l'ultimo errore

Oggi `job_queue` non conserva il messaggio d'errore:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS last_error TEXT;
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS error_class TEXT;
```

### Test

- `classifyError`: un caso per pattern, più il default su stringa ignota.
- `handleFailure`: `auth` → `blocked` con `attempts` invariato; `permanent` →
  `failed` al primo colpo; `transient` → backoff e `strategy_idx` incrementato;
  saturazione sull'ultimo elemento del ladder.
- Sblocco: solo i `blocked` della piattaforma richiesta cambiano stato; una sola
  notifica per sblocco.

---

## Fase 3 — Whisper asincrono

Oggi la trascrizione è sincrona dentro la pipeline: un video lungo tiene
occupato il job per minuti, e se Whisper è giù il tempo è sprecato comunque.

### Design

Nuovo tipo di job in coda: `job_queue.kind` (`'analyze' | 'transcribe'`,
default `'analyze'` per retrocompatibilità).

Flusso:

1. La pipeline di analisi **non** chiama più `transcribeLocal()`. Completa con
   caption, OCR e vision, salva la entry e risponde su Telegram. L'utente vede
   subito un risultato.
2. Se esiste un `audioPath`, accoda un job `transcribe` per la stessa entry.
3. Il worker esegue il job `transcribe`: se archi-pc è giù, chiede il wake
   (stessa soglia e stesso cooldown della fase 1a) e ritenta col backoff
   esistente.
4. A trascrizione ottenuta, salva `results.transcript` e accoda una **seconda
   passata di analisi** che rielabora `summary`, `notes` e `songs` con il
   transcript incluso.

### Idempotenza

La seconda passata deve **arricchire, non azzerare**. Regole:

- Canzoni e film già trovati non vengono rimossi: si fa merge per chiave
  (`title` + `artist` normalizzati), riusando la logica già presente in
  `resultMerger.ts`.
- Gli arricchimenti già fatti (`song_meta`, `film_meta`, `note_meta`) non
  vengono invalidati.
- La seconda passata non accoda mai un terzo giro: il job `analyze` di
  ri-analisi nasce con un flag che disabilita l'accodamento di `transcribe`.
- Nessuna notifica Telegram sulla seconda passata (`notify = false`), come già
  avviene per i repair.

### Test

- La pipeline di analisi non chiama `transcribeLocal`.
- Con `audioPath` presente viene accodato un job `transcribe`; senza, no.
- La seconda passata fa merge e non cancella canzoni trovate al primo giro.
- La ri-analisi non accoda un ulteriore job `transcribe`.
- Nessuna notifica Telegram sulla seconda passata.

---

## Fase 4 — Contenuti in italiano

### 4a. Post nuovi — vincolo di lingua nel prompt

Causa radice, e la parte a costo zero. Ai prompt `contentAnalysis`,
`webPageAnalysis`, `slideAnalysis` ed `enrichment` si aggiunge:

```
LINGUA: scrivi SEMPRE "summary" e i "text" delle note in italiano, anche
quando la fonte è in un'altra lingua. NON tradurre titoli di canzoni, film,
brand, nomi propri e citazioni testuali (category "quote"): quelli restano
nella lingua originale.
```

Funziona su entrambi i motori: `aiAnalysis.ts` renderizza il prompt una volta
(`getPrompt` + `renderTemplate`) e passa la stessa stringa sia a Ollama sia a
`runClaudePrompt()`. Zero chiamate aggiuntive.

I prompt sono persistiti in tabella `config` e modificabili da UI: serve una
migration che **appenda** la regola ai template già salvati, senza sostituirli,
per non perdere personalizzazioni fatte a mano.

`transcript` è escluso: è un dato grezzo verbatim, come `caption`. Va tradotto,
non riscritto — vedi 4b.

### 4b. Archivio e transcript — traduzione on-demand

Nuovo servizio `backend/src/services/translationService.ts`:

```ts
export function detectLanguage(text: string): string | null;
export async function translateEntry(entryId: string): Promise<EntryTranslation | null>;
```

**Rilevamento lingua** — `tinyld`, libreria JS pura (~50KB, nessun modello,
nessuna rete) su `caption`. Se assente o sotto i 20 caratteri, ripiega su
`results.transcript`, infine sul `language` di Whisper.

**Traduzione** — riuso di `runClaudePrompt()`, che già invoca
`claude -p --output-format json` con env allowlist (non eredita password DB né
token Telegram). Il binario è nel container (`/usr/local/bin/claude`, v2.1.197)
e `CLAUDE_CODE_OAUTH_TOKEN` è già configurato: **nessun account nuovo, nessun
costo aggiuntivo, nessuna API key**. Consuma quota dell'abbonamento Max.

Due modifiche a `claudeFallback.ts`:

1. `runClaudePrompt(prompt, opts?: { model?: string })` — oggi il modello arriva
   solo da `CLAUDE_FALLBACK_MODEL`.
2. Nuova env `TRANSLATION_MODEL`, default `haiku`. Il fallback gira su
   `claude-opus-4-8` e l'ultima chiamata riuscita ha impiegato **12.963 ms**:
   per tradurre è sproporzionato.

**Serializzazione, obbligatoria.** Ogni `claude -p` è un processo Node locale,
misurato tra 225 e 581 MB RSS: l'inferenza è remota, l'orchestrazione no. Con
2,8GB disponibili, due traduzioni concorrenti sono un rischio reale. Coda
interna a concorrenza **1**.

**Trigger** — solo al primo click sul toggle "IT" di una entry non tradotta.
Nessun batch, nessun backfill.

### Storage

Dentro `results` (JSONB, nessuna migration di schema):

```ts
export interface EntryTranslation {
  sourceLang: string;          // 'en', 'es', …
  summary: string | null;
  transcript: string | null;
  notes: Array<{ index: number; text: string }>;
  model: string;
  translatedAt: string;
}
```

L'originale non viene **mai** sovrascritto.

### Ricerca

`entries_build_search_vector()` include il testo tradotto con peso `B`, così una
ricerca in italiano trova anche i post inglesi. Funzione da ricreare e vettore
da ricalcolare sulle entry tradotte.

### UI

Badge con la lingua rilevata e toggle `IT / originale`, visibile solo quando
`sourceLang !== 'it'`. Stato di caricamento al primo click: anche con Haiku si
parla di secondi.

### Limite noto e accettato

`noteKey` resta calcolato sul testo **originale**, perché è la chiave di
aggregazione di `NotesPage` e di `note_meta`: cambiarla invaliderebbe tutti gli
arricchimenti fatti. La stessa nota in inglese e in italiano resta contata due
volte. La traduzione è display-only.

### Test

- `detectLanguage`: caption inglese → `en`; vuota → fallback su transcript;
  sotto 20 caratteri → fallback.
- `translateEntry`: `runClaudePrompt` mockato; originale immutato; entry già
  tradotta non ritraduce; due chiamate concorrenti → un solo spawn per volta.
- Il template renderizzato contiene la regola di lingua.
- Nessuna chiamata reale a Claude, Ollama o servizi esterni.

---

## Ordine di implementazione

1. **Fase 1 (orchestrazione)** — la più urgente: ferma il consumo di quota
   Claude su ogni post e rimette in piedi l'inferenza locale.
2. **Fase 2 (coda errori)** — indipendente, sblocca i job Instagram fermi.
3. **Fase 3 (whisper async)** — dipende dal wake della fase 1.
4. **Fase 4 (italiano)** — 4a è una modifica ai prompt con effetto immediato,
   4b è la parte con più codice nuovo.

Branch unico su Soundreel. Le modifiche a `gpu-router`, `mneme/deploy` e al
timer systemd vivono fuori e vanno coordinate nel piano.

## Rischi

| Rischio | Mitigazione |
|---|---|
| Il wake accende archi-pc troppo spesso | Soglia sulla profondità di coda più cooldown; il wake non blocca mai la richiesta in corso |
| archi-pc non si accende e la coda si ferma | Il fallback su geekom resta sempre attivo per i modelli testuali; solo la vision viene saltata |
| Saltare la vision peggiora i risultati | Perdita accettata e loggata: caption, OCR e transcript restano. Meglio di una GPU appesa che fa cadere tutto |
| Il watchdog entra in loop di ricreazioni | Massimo 3 all'ora, poi si ferma e logga |
| Gli spawn di `claude -p` aggravano la pressione di memoria | Concorrenza 1, processo effimero, solo su richiesta esplicita. Nessun backfill |
| La quota Max si esaurisce | Haiku invece di Opus per la traduzione, e la fase 1 elimina il fallback sistematico su Opus per l'analisi |
| La seconda passata di analisi cancella risultati | Merge per chiave via `resultMerger.ts`, mai sostituzione; test dedicato |
| La migration dei prompt sovrascrive personalizzazioni | Appende la regola invece di sostituire il template |

## Questione aperta

Il GPU hang è un problema di ROCm su gfx11, non di configurazione. Questa spec
lo aggira — niente vision in locale, più watchdog — ma non lo risolve. Se un
domani serve la vision sul geekom, va indagato a parte: versione dell'immagine
`ollama/ollama:rocm`, versione del kernel, `HSA_OVERRIDE_GFX_VERSION`.
