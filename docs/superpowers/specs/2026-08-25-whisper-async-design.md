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

I media sopravvivono all'analisi. Sul disco ci sono **683 directory** sotto
`/data/media/<entryId>/`, e **494 contengono `audio.wav`**. Il percorso è
deterministico: un job differito ritrova l'audio dall'`entryId`, senza doverlo
trasportare, e lo storico non trascritto è recuperabile.

### Ma le entry da recuperare sono 83, non 494

Una prima stesura di questo documento contava le directory con `audio.wav` e si
fermava lì, arrivando a 489. È il numero sbagliato, di sei volte. Whisper ha
funzionato per mesi e si è rotto solo di recente: di quelle 494 directory,
**410 appartengono a entry che un transcript ce l'hanno già** e una non ha più
una entry corrispondente. L'insieme che conta è l'intersezione — audio sul
disco **e** nessun transcript.

| Misura | Valore |
|---|---|
| directory media con `audio.wav` | 494 |
| entry con transcript | 454 |
| entry senza transcript | 428 |
| **intersezione: audio sul disco, nessun transcript** | **83** |

Lo script di backfill calcola questo insieme a tempo di esecuzione, quindi non
è mai esistito un difetto funzionale: era il documento a promettere sei volte
il lavoro reale. Un operatore che avesse seguito il runbook e ne avesse visto
accodare 83 dove il testo ne prometteva 479 avrebbe avuto tutte le ragioni per
fermarsi e sospettare che qualcosa stesse scartando entry in silenzio.

## Obiettivi

- La trascrizione non blocca più la pipeline: l'entry si completa e risponde
  subito, il transcript arriva dopo.
- I job di trascrizione sopravvivono ad archi-pc spento e si smaltiscono da soli
  quando torna disponibile.
- Le 83 entry storiche con audio ma senza transcript vengono recuperate.
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
`/data/media/<entryId>/audio.wav` sul disco e `results.transcript` vuoto, con
`priority = 10`, che basta da solo a far passare davanti qualunque contenuto
appena inviato.

**Nessuno scaglionamento per difetto.** Una prima stesura di questa spec
distanziava i job di due minuti. Misurato **sulle 83 candidate** (non sulle 494
directory con audio, che è l'errore della prima stesura): 137 MB di WAV mono
16 kHz a 16 bit — cioè **1,25 ore di audio**, 75 minuti in tutto, circa 54
secondi a clip. Con `faster-whisper` `small` su un 5900X sono dieci-venti
minuti di elaborazione, mentre lo scaglionamento avrebbe imposto 83 × 2 = 166
minuti, quasi tre ore, di sola attesa.

*La correzione del numero rafforza questa decisione invece di indebolirla.* Il
lavoro reale è sei volte più piccolo di quanto si credesse, ma l'attesa che lo
scaglionamento impone resta proporzionale al numero di job: il rapporto fra le
due passa da sedici ore contro una-due a tre ore contro venti minuti, cioè
peggiora. Proteggeva da una saturazione che non esiste: whisper gira su una
macchina dedicata, senza rate limit da rispettare, e la priorità basta già a non
far aspettare i contenuti nuovi. Lo scaglionamento resta disponibile come
opzione, ma vale zero per difetto.

**Il recupero avviene in due ondate**, e la sicurezza sta nel controllo, non
nella lentezza. La prima accoda un numero limitato di entry — scelte fra quelle
con più arricchimenti da perdere, che sono le uniche capaci di rivelare un
difetto del merge — e ci si ferma a verificare a mano che canzoni, film e note
non siano diminuiti e che i riassunti preesistenti siano intatti. Solo dopo si
accoda il resto.

Lo script è idempotente: non accoda un'entry che ha già un job `transcribe`
pendente. Stampa quante ne accoda e si ferma, senza eseguire nulla.

## 5. La seconda passata arricchisce, non sostituisce

È la parte con più rischio: 83 entry storiche già arricchite.

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

**Ricalcola solo ciò che manca, e mai da un servizio esterno.**

La seconda passata non rifà la pipeline. Le derivazioni della prima sono già
persistite — misurato: 236 entry hanno `overlayText`, 302 hanno `slides`, 62
hanno `visualContext` — e vengono **riusate** invece che ricalcolate. Solo
l'analisi AI viene rieseguita, con il transcript nuovo in aggiunta.

Dove una derivazione **manca** e i suoi ingressi sono sul disco, viene calcolata:
un'entry archiviata prima che l'OCR esistesse guadagna l'OCR. La regola è una
sola e uniforme — *se non ce l'ho e posso ottenerlo in casa, lo ottengo* — non
un elenco di eccezioni per operazione.

Il confine è netto e sta sui **servizi esterni**: Shazam e la risoluzione
YouTube non vengono mai eseguiti in una seconda passata, nemmeno quando il
risultato manca. L'assenza di un risultato non dimostra che il servizio non sia
mai stato interrogato — un'entry senza canzoni può semplicemente essere una in
cui Shazam non ha trovato nulla — e **48 delle 83 candidate non hanno canzoni**,
cioè 48 scansioni verso un endpoint non ufficiale per riottenere lo stesso
silenzio. Un eventuale recupero di Shazam sullo storico è uno script separato e
opt-in.

*Il cancello resta chiuso anche col numero corretto.* La cifra di partenza era
146 su un insieme di 489; ricontata sulle 83 reali diventa 48. È un terzo delle
scansioni, ma l'argomento non era mai stato di volume: è che una scansione non
richiesta verso un endpoint non ufficiale è indesiderabile a prescindere da
quante ne sono, e 48 sono comunque ampiamente sufficienti a farsi notare.

Questo sostituisce l'approccio a cancelli per singola operazione. Ogni cancello
dimenticato sarebbe stato un servizio esterno colpito centinaia di volte, e il
prossimo che tocca `analyze.ts` avrebbe dovuto ricordarseli tutti.

**Nessun terzo giro.** Un job con `reanalyze` non accoda mai un `transcribe`,
qualunque cosa trovi sul disco.

**E soprattutto: nessun nuovo scaricamento.** `analyze.ts` chiama
`extractContent()`, che scarica da Instagram *incondizionatamente* — non
controlla se i file sono già in locale. Una seconda passata che lo attraversasse
rifarebbe 83 download da Instagram, che è precisamente ciò che il `CLAUDE.md`
vieta per non far bannare l'account. Il divieto non dipende dal numero: 83
download non richiesti in sequenza verso Instagram bastano da soli.

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
si esegue solo dopo che i primi quattro sono verdi in produzione: accodare 83
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
