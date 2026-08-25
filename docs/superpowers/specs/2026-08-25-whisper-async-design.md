# Whisper asincrono

Data: 2026-08-25
Stato: in revisione

## Contesto

La trascrizione è sincrona dentro la pipeline: `analyze.ts:385` chiama
`transcribeLocal()` e attende. Tre conseguenze, tutte osservate.

**Un video lungo tiene occupato il job per minuti.** Il budget di pipeline è
120 secondi; una trascrizione che sfora lo consuma tutto.

**Se whisper è giù, il tempo è sprecato comunque.** Nei log, ripetuto:

```
Whisper network error: fetch failed
  at transcribeLocal (/app/dist/services/whisperClient.js:34:30)
  at Object.<anonymous> (/app/dist/routes/analyze.js:324:37)
```

**E whisper è giù quasi sempre.** `WHISPER_URL` punta ad archi-pc, che è spento
la maggior parte del tempo. Il meccanismo di wake costruito la settimana scorsa
serve il pool Ollama del gpu-router; whisper viene chiamato direttamente, fuori
dal router, quindi niente lo accendeva. Corretto il 2026-08-25 (`647145c`):
`archi-wake.sh` ora avvia sia `archi.sh ollama` sia `archi.sh whisper`. Ma
questo copre solo il caso in cui archi-pc si accende per altri motivi.

### Il fatto che rende possibile il design

I media sopravvivono all'analisi. Sul disco ci sono **677 directory** sotto
`/data/media/<entryId>/`, e **488 contengono `audio.wav`**. Il percorso è
deterministico: un job differito ritrova l'audio dall'`entryId`, senza doverlo
trasportare, e lo storico non trascritto è recuperabile.

## Obiettivi

- La trascrizione non blocca più la pipeline: l'entry si completa e risponde
  subito, il transcript arriva dopo.
- I job di trascrizione sopravvivono ad archi-pc spento e si smaltiscono da soli
  quando torna disponibile.
- Le 488 entry storiche con audio ma senza transcript vengono recuperate.
- Nessun risultato già arricchito viene peggiorato dal recupero.

## Non obiettivi

- **Svegliare archi-pc per trascrivere.** Decisione esplicita. La soglia del wake
  di Ollama è 8 richieste in 300 secondi proprio perché un contenuto singolo non
  deve accendere un PC; un wake per trascrizione reintrodurrebbe lo stesso
  problema dalla porta di servizio. I job attendono che la macchina si accenda
  per altri motivi.
- Reintrodurre un container whisper locale. Costerebbe ~1,5 GB residenti su una
  macchina con poca memoria libera, ed è già stato escluso.
- Cambiare il meccanismo di wake, il guard vision o il routing.

---

## 1. Un nuovo tipo di job

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'analyze';
CREATE INDEX IF NOT EXISTS idx_job_queue_kind ON job_queue (kind, status, next_attempt_at);
```

`kind` vale `'analyze'` o `'transcribe'`. Il default preserva il comportamento
dei job già in coda al momento della migration.

`enqueueJob` accetta `kind` (default `'analyze'`) e `priority`, quest'ultimo
descritto in §4.

## 2. La pipeline accoda invece di attendere

In `analyze.ts`, il blocco alle righe 384-405 non chiama più `transcribeLocal`.
Al suo posto:

- se `featuresConfig.transcriptionEnabled` e `localPaths?.audioPath` esistono,
  accoda un job `transcribe` per la stessa entry e registra in `actionLog` un
  `whisper_asr` con `status: 'queued'`;
- altrimenti registra `status: 'skipped'` con la ragione, come oggi.

`transcript` e `transcriptLanguage` restano `null` per questa passata. L'analisi
AI prosegue con caption, OCR e contesto visivo, l'entry si completa e Telegram
risponde. È lo stesso degrado che la pipeline già applica quando whisper non
risponde — con la differenza che ora il transcript arriverà.

## 3. Il worker di trascrizione non sveglia nessuno

Il worker guadagna un ramo per `kind = 'transcribe'`:

1. **Precondizione.** `GET {WHISPER_URL}/` con timeout 3s. Se non risponde, il
   job torna in coda con `next_attempt_at = NOW() + 30 minuti` **senza
   incrementare `attempts`** e senza scrivere alcuna sentinella. Non è un
   fallimento: è una capacità non disponibile, la stessa distinzione applicata
   al rifiuto vision.
2. **Trascrizione.** `transcribeLocal('/data/media/<entryId>/audio.wav')`. Il
   percorso si deriva dall'`entryId`; se il file non esiste il job va in `failed`
   con ragione `audio file missing` — nessun retry ha senso.
3. **Salvataggio.** `results.transcript` e la lingua rilevata, più una riga
   `whisper_asr` in `actionLog` con esito e durata.
4. **Seconda passata.** Accoda un job `analyze` per la stessa entry con
   `notify = false` e il flag di ri-analisi di §5.

Un fallimento vero di whisper (risponde ma erroria) consuma un tentativo e usa
il backoff esistente.

Il worker tratta i job `transcribe` come `platform = 'other'`: non toccano
Instagram e non devono ereditarne la serializzazione anti-ban.

## 4. Priorità e backfill

Nuova colonna:

```sql
ALTER TABLE job_queue ADD COLUMN IF NOT EXISTS priority INT NOT NULL DEFAULT 0;
```

`claimNext*` ordina per `priority ASC, next_attempt_at ASC`. I job normali hanno
priorità 0; il backfill storico usa 10, quindi **cede sempre il passo ai
contenuti nuovi**.

Uno script `backfillTranscripts.ts` accoda le entry che hanno
`/data/media/<entryId>/audio.wav` sul disco e `results.transcript` vuoto,
con `priority = 10` e `next_attempt_at` scaglionato di 2 minuti l'uno dall'altro,
così whisper non viene saturato e un reel appena mandato non aspetta mai dietro
allo storico.

Lo script è idempotente: non accoda un'entry che ha già un job `transcribe`
pendente. Stampa quante ne accoda e si ferma, senza eseguire nulla.

## 5. La seconda passata arricchisce, non sostituisce

È la parte con più rischio: 488 entry storiche già arricchite.

Il job `analyze` di ri-analisi porta un flag `reanalyze` che impone quattro
regole.

Il flag serve anche a un secondo scopo, scoperto scrivendo il piano:
`analyze.ts:148` restituisce immediatamente la entry quando la trova già
`completed`, senza riprocessare. Senza un modo per scavalcare quel corto
circuito la seconda passata sarebbe un no-op silenzioso. `reanalyze: true`
viaggia nel corpo della richiesta e disattiva quel ritorno anticipato,
mantenendo l'`entryId` esistente.

**Canzoni e film si fondono per chiave.** Si riusa la normalizzazione di
`resultMerger.ts` (`normalizeSongKey`, `normalizeFilmKey`). Un elemento già
presente non viene toccato; uno nuovo viene aggiunto. **Nulla viene mai rimosso**,
nemmeno se la seconda passata non lo ritrova.

**Le note si fondono per `noteKey`**, la stessa chiave usata da `NotesPage` e
dalle tabelle `note_meta`. Gli arricchimenti esistenti restano validi.

**Il `summary` si scrive solo se era vuoto.** Non è fondibile — è una stringa
sola — e su un'entry storica quello esistente potrebbe essere migliore di
quanto una seconda passata produca. Con il transcript il riassunto sarebbe
spesso migliore, ma non abbastanza da giustificare la sovrascrittura in blocco
di centinaia di summary senza possibilità di confronto.

**Nessun terzo giro.** Un job con `reanalyze` non accoda mai un `transcribe`,
qualunque cosa trovi sul disco.

**E soprattutto: nessun nuovo scaricamento.** `analyze.ts` chiama
`extractContent()`, che scarica da Instagram *incondizionatamente* — non
controlla se i file sono già in locale. Una seconda passata che lo attraversasse
rifarebbe 488 download da Instagram, che è precisamente ciò che il `CLAUDE.md`
vieta per non far bannare l'account.

Quindi un job `reanalyze` **salta del tutto l'estrazione** e ricostruisce
`ExtractedContentLocalPaths` da `/data/media/<entryId>/`, dove i file già sono:

```
audio.wav          → audioPath
video.mp4          → videoPath
thumbnail.jpg      → thumbnailPath
frame-NNN.jpg      → framePaths
slide-NNN.jpg      → slidePaths
```

La caption si rilegge dalla entry invece che dalla rete. La seconda passata non
tocca alcun endpoint esterno di scaricamento: solo il disco e il modello.

Se la directory non contiene nulla di utilizzabile — media cancellati a mano,
per esempio — la ri-analisi non deve ripiegare sullo scaricamento: registra lo
stato e termina. Meglio una entry senza seconda passata che un download non
richiesto.

`song_meta`, `film_meta` e `note_meta` non vengono invalidati: le loro chiavi
derivano dal testo originale, che non cambia.

## 6. Notifiche

La seconda passata non manda nulla su Telegram (`notify = false`), come già
avviene per i repair. L'utente ha ricevuto la risposta alla prima passata; un
secondo messaggio per la stessa entry sarebbe rumore.

Il backfill storico è per definizione `notify = false`: quelle entry sono state
inviate settimane fa.

## Test

- `analyze.ts` non chiama più `transcribeLocal`; con `audioPath` presente accoda
  un `transcribe`, senza no.
- Precondizione: whisper irraggiungibile → il job torna in coda con backoff
  lungo e `attempts` **invariato**; nessuna sentinella scritta.
- Audio mancante sul disco → `failed`, nessun retry.
- La seconda passata fonde e non cancella: una canzone trovata al primo giro
  sopravvive anche se il secondo non la ritrova.
- Il `summary` esistente non viene sovrascritto; un `summary` vuoto sì.
- Un job `reanalyze` non accoda un ulteriore `transcribe`.
- Nessuna notifica Telegram sulla seconda passata né sul backfill.
- `claimNext*` serve un job `priority = 0` prima di uno `priority = 10` a parità
  di `next_attempt_at`.
- Lo script di backfill è idempotente: rieseguirlo non duplica i job.
- Nessuna chiamata reale a whisper, Ollama, Telegram o Instagram.

## Ordine di implementazione

1. Migration (`kind`, `priority`, indice) e `enqueueJob` esteso.
2. Ramo `transcribe` nel worker, con la precondizione.
3. La pipeline accoda invece di attendere.
4. Seconda passata con merge additivo.
5. Script di backfill.

I punti 1-4 valgono per i contenuti nuovi e sono verificabili da soli. Il punto 5
si esegue solo dopo che i primi quattro sono verdi in produzione: accodare 488
job su un merge non ancora provato è il modo più rapido per rovinare lo storico.

## Rischi

| Rischio | Mitigazione |
|---|---|
| La seconda passata peggiora entry storiche | Merge additivo, nulla viene rimosso, summary solo se vuoto. Il backfill parte solo dopo la verifica in produzione sui contenuti nuovi |
| I job di trascrizione si accumulano all'infinito | Priorità 10 e scaglionamento; si smaltiscono quando archi-pc è sveglio. Se non si accende mai, restano in coda senza consumare risorse |
| Il backfill fa aspettare i contenuti nuovi | `priority ASC` nel claim: i nuovi passano sempre davanti |
| La seconda passata sveglia archi-pc | Non può: la trascrizione avviene solo a macchina già sveglia, quindi la ri-analisi trova archipc su e non accumula richieste verso un backend assente |
| L'audio viene cancellato prima che il job giri | Il job va in `failed` con ragione esplicita; nessun retry inutile |

## Questione aperta

Se archi-pc non si accende per giorni, i transcript non arrivano. È la
conseguenza accettata del non svegliarlo per trascrivere. Se in futuro dovesse
pesare, la leva è la stessa già usata per Ollama: una soglia sull'arretrato di
job `transcribe` che scrive la sentinella. Non è in questa spec.
