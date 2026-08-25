# Ingestione e consultazione di documenti

Data: 2026-08-25
Stato: in revisione

## Contesto

SoundReel ingerisce contenuti social e pagine web. Un documento — un PDF, un
`.md`, un `.txt` — oggi non ha modo di entrare: il webhook Telegram legge solo
`message.text` (`telegram.ts:40`) e non esiste alcun endpoint di upload
(`@fastify/multipart` non è fra le dipendenze).

L'obiettivo è che un documento diventi una `entry` come le altre — riassunta
dall'AI, ricercabile, riapribile — e che si possa porre domande sul suo
contenuto ottenendo risposte con il riferimento al punto esatto.

### Cosa esiste già e viene riusato

- **`nomic-embed-text`** è installato in Ollama da tre mesi (274MB). Il modello
  di embedding non va né scelto né scaricato, e con `keep_alive: 0` si scarica
  dopo ogni uso.
- **Il servizio OCR** (`soundreel-ocr:5001`) è attivo e già usato per i frame
  video: serve anche per i PDF scansionati.
- **`/data/media/<entryId>/`** persiste (677 directory) ed è già servito con
  guardia sui path da `media.ts`.
- **`entries.search_vector`** con trigger e pesi è già in piedi: il testo
  estratto vi entra senza infrastruttura nuova.
- Il **fallback Claude** è configurato e funzionante.

### Cosa non esiste

`pdf-parse` non è installato, e il runtime (`node:20-bookworm-slim`) non ha
poppler — serve per rasterizzare i PDF scansionati prima dell'OCR. Il Dockerfile
ha già un blocco `apt-get install` a cui aggiungere il pacchetto.

### Perché niente pgvector

L'immagine è `postgres:17-alpine` e non espone l'estensione `vector`. Passare a
`pgvector/pgvector:pg17` significherebbe cambiare base da Alpine a Debian, cioè
da musl a glibc: **le collation cambiano e gli indici testuali esistenti vanno
ricostruiti**. Su un database di produzione con 677 entry è un rischio
sproporzionato.

E non serve. Qualche centinaio di documenti per una ventina di chunk l'uno fa
nell'ordine di 10.000 vettori; una scansione completa con prodotto scalare in
SQL sono pochi milioni di moltiplicazioni, decine di millisecondi. Un indice
approssimato tipo HNSW paga da centinaia di migliaia di vettori in su. Sotto
quella soglia è complessità senza guadagno.

## Obiettivi

- Un PDF, `.md` o `.txt` inviato al bot o indicato per URL diventa una entry
  archiviata, riassunta e ricercabile.
- Il file originale resta scaricabile.
- Si possono porre domande sull'archivio e ricevere risposte che citano il
  documento e la pagina.

## Non obiettivi

- Un'interfaccia di upload nella web app. L'ingestione è via Telegram e URL.
  `@fastify/multipart` non viene introdotto.
- Cartella sorvegliata sul disco.
- Sostituire la ricerca full-text esistente: quella semantica la affianca.
- Formati oltre PDF, Markdown e testo semplice. Niente `.docx`, `.epub`, fogli
  di calcolo.
- Modificare pgvector, l'immagine di Postgres o le collation.

---

# Fase 1 — Ingestione e archivio consultabile

Vale da sola: senza la Fase 2 hai comunque documenti archiviati, riassunti,
ricercabili a testo pieno e riapribili.

## 1.1 Ingestione da Telegram

Il webhook impara a riconoscere `message.document` accanto a `message.text`.

Alla ricezione:

1. Filtra per estensione e MIME: `application/pdf`, `text/markdown`, `text/plain`,
   più i nomi che finiscono in `.pdf`, `.md`, `.txt`. Qualunque altra cosa
   riceve una risposta che spiega cosa è supportato, senza creare una entry.
2. **Limite di dimensione: 20MB.** È il tetto di `getFile` delle Bot API, non una
   scelta nostra. Un file oltre quella soglia non è scaricabile dal bot e va
   rifiutato con un messaggio esplicito che lo dica, invece di fallire a metà.
3. Scarica via `getFile` + `file_path` e salva in
   `/data/media/<entryId>/<nome-originale>`, con il nome ripulito da separatori
   di percorso.
4. Crea la entry con `source_platform = 'document'` e `input_channel = 'telegram'`,
   poi accoda un job `analyze` come per qualunque altro contenuto.

`sourceUrl` per un documento Telegram è `telegram-document:<file_unique_id>`,
che rende l'idempotenza già esistente valida anche qui: rimandare lo stesso file
restituisce la entry esistente invece di duplicarla.

## 1.2 Ingestione da URL

Quando l'URL inviato punta a un documento — estensione `.pdf`/`.md`/`.txt`, o
`Content-Type` corrispondente rilevato con una richiesta `HEAD` — il flusso
diverge da quello delle pagine web: si scarica il file, si salva in
`/data/media/<entryId>/` e si prosegue con l'estrazione.

Tetto di 50MB, qui scelto da noi e non imposto da terzi, per non riempire il
disco con un click distratto. `sourceUrl` resta l'URL, quindi l'idempotenza
funziona come sempre.

Se `Content-Type` e estensione si contraddicono, comanda il `Content-Type`.

## 1.3 Estrazione del testo

Nuovo servizio `backend/src/services/documentExtractor.ts`:

```ts
export type ExtractionMethod = 'pdf-text' | 'pdf-ocr' | 'plain';

export interface DocumentExtraction {
  text: string;
  pageCount: number | null;
  /** Testo per pagina, indice 0-based. Vuoto per i formati non paginati. */
  pages: string[];
  method: ExtractionMethod;
  status: 'ok' | 'empty' | 'error';
  reason?: string;
}

export async function extractDocument(filePath: string, mimeType: string): Promise<DocumentExtraction>;
```

**Markdown e testo semplice** si leggono direttamente, `method: 'plain'`,
`pages: []`.

**PDF**: prima `pdf-parse`, JavaScript puro, nessuna dipendenza di sistema.
Copre tutto ciò che nasce digitale.

**PDF senza testo** — scansionati o fotografati — vengono rasterizzati pagina per
pagina con `pdftoppm` (pacchetto `poppler-utils`, aggiunto al blocco `apt-get`
già presente nel Dockerfile) e passati al servizio OCR esistente.
`method: 'pdf-ocr'`.

Due guardie sull'OCR, perché è lento e su pagine dense impreciso:

- massimo **30 pagine** per documento; oltre, si processano le prime 30 e si
  registra nell'`actionLog` quante ne sono state saltate. Un tetto silenzioso
  farebbe credere che il documento sia stato letto per intero;
- le pagine rasterizzate sono file temporanei e vengono cancellate dopo l'OCR,
  in un `finally` — non devono restare accanto all'originale.

Se nemmeno l'OCR produce testo, `status: 'empty'`: la entry esiste, il file è
archiviato e riapribile, ma non è ricercabile. È un esito onesto, non un errore.

## 1.4 Persistenza

```sql
CREATE TABLE IF NOT EXISTS documents (
  entry_id      TEXT PRIMARY KEY REFERENCES entries(id) ON DELETE CASCADE,
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size_bytes    BIGINT NOT NULL,
  page_count    INT,
  text          TEXT NOT NULL DEFAULT '',
  extraction    TEXT NOT NULL,          -- pdf-text | pdf-ocr | plain
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Il testo integrale sta qui e non in `entries.results`, che è già voluminoso e
viene letto per intero a ogni pagina del journal.

## 1.5 Analisi e ricerca full-text

Il testo estratto entra nella pipeline di analisi già esistente al posto della
caption, così un documento riceve riassunto, note, tag e link con gli stessi
prompt. Per i documenti lunghi si passano al modello i primi 12.000 caratteri:
oltre, il contesto di `qwen2.5:3b` non regge e la qualità peggiora invece di
migliorare.

`entries_build_search_vector()` viene esteso per includere `documents.text` con
peso `B`. La funzione va ricreata e il vettore ricalcolato sulle entry
documentali.

## 1.6 Interfaccia

Nel journal un documento si distingue con un'icona e il nome del file, e il
riassunto AI si legge come per ogni altra entry. Un pulsante apre l'originale
servito da `media.ts`, che ha già la guardia sui path.

Nuovo filtro "Documenti" accanto a quelli esistenti.

## Test — Fase 1

- Un `message.document` con MIME PDF crea una entry `source_platform='document'`;
  un `.zip` no e riceve la risposta di formato non supportato.
- Un file oltre 20MB viene rifiutato con un messaggio che cita il limite, senza
  creare la entry.
- Rimandare lo stesso documento non crea un duplicato.
- Un nome file con `../` non scrive fuori da `/data/media/<entryId>/`.
- `extractDocument` su un PDF testuale usa `pdf-text`; su uno senza testo ripiega
  su `pdf-ocr`; su un `.md` usa `plain`.
- Un PDF di 50 pagine ne processa 30 e registra le 20 saltate.
- Le pagine rasterizzate vengono cancellate anche quando l'OCR fallisce.
- Un documento senza testo estraibile produce `status: 'empty'`, entry creata e
  file riapribile.
- La ricerca full-text trova un documento per una parola contenuta nel testo.
- Nessuna chiamata reale a Telegram, Ollama o OCR nei test.

---

# Fase 2 — Domande sul contenuto

Si appoggia alla Fase 1 e non ha senso senza.

## 2.1 Suddivisione in chunk

Il testo si divide in blocchi di circa **1.000 caratteri con 200 di
sovrapposizione**, rispettando i confini di paragrafo quando cadono entro il 20%
dal taglio ideale. La sovrapposizione evita che una frase spezzata renda
irrecuperabile il passaggio che la contiene.

Ogni chunk conserva il numero di pagina quando il formato lo prevede: è ciò che
permette alla risposta di citare *dove*.

## 2.2 Embedding e persistenza

```sql
CREATE TABLE IF NOT EXISTS doc_chunks (
  id          BIGSERIAL PRIMARY KEY,
  entry_id    TEXT NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,
  page        INT,
  text        TEXT NOT NULL,
  embedding   REAL[] NOT NULL,
  UNIQUE (entry_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_doc_chunks_entry ON doc_chunks (entry_id);
```

Gli embedding si ottengono da `nomic-embed-text` attraverso il gpu-router
(`POST /api/embeddings`), che è anche il motivo per cui quella rotta è stata
**esclusa** dall'iniezione di `keep_alive: 0`: un ciclo di carica-e-scarica per
ogni chunk sarebbe patologico.

**I vettori si normalizzano alla scrittura.** Con vettori di norma 1 la
similarità coseno coincide con il prodotto scalare, quindi l'interrogazione non
calcola radici quadrate:

```sql
CREATE OR REPLACE FUNCTION dot_product(a REAL[], b REAL[]) RETURNS REAL AS $$
  SELECT COALESCE(SUM(x * y), 0)::REAL FROM unnest(a, b) AS t(x, y)
$$ LANGUAGE SQL IMMUTABLE STRICT PARALLEL SAFE;
```

`dot_product` presuppone due vettori della stessa lunghezza: `unnest` a due
argomenti riempie di `NULL` il più corto, e `SUM` li ignorerebbe restituendo un
punteggio troppo alto invece di un errore. La dimensione si verifica alla
scrittura, non alla lettura.

## 2.3 Recupero e risposta

`POST /api/ask` con `{ question, entryId? }`:

1. Calcola l'embedding della domanda con lo stesso modello.
2. Seleziona i **6 chunk** con `dot_product` più alto, filtrati su `entryId` se
   la domanda è rivolta a un singolo documento.
3. Se il punteggio migliore è sotto **0,35**, risponde che l'archivio non
   contiene nulla di pertinente e **non chiama il modello**. Inventare una
   risposta su chunk irrilevanti è peggio che ammettere di non sapere.
4. Costruisce un prompt con i chunk numerati e le loro fonti, chiedendo di
   rispondere solo con ciò che vi compare e di citare i riferimenti usati.
5. Ollama `qwen2.5:3b`, con il fallback Claude già esistente quando la risposta
   è vuota o non parsabile.

La risposta include le citazioni — nome del documento, pagina, `entryId` — così
ogni affermazione è verificabile risalendo al testo.

## 2.4 Indicizzazione differita

L'embedding di un documento lungo è decine di chiamate a Ollama e non deve
bloccare l'ingestione. Si riusa il meccanismo dei job: nuovo `kind = 'embed'`
accodato a estrazione completata.

Questo presuppone la colonna `job_queue.kind` introdotta dalla spec del whisper
asincrono del 2026-08-25. Se quella non è ancora implementata, questa fase la
introduce con la stessa forma — non due colonne diverse per lo stesso scopo.

## 2.5 Interfaccia

Una casella "Chiedi all'archivio" nella pagina di ricerca. La risposta compare
con le citazioni cliccabili che aprono la entry corrispondente.

Sulla pagina di un documento, la stessa casella limitata a quel file.

## Test — Fase 2

- La suddivisione rispetta la sovrapposizione e i confini di paragrafo entro la
  tolleranza; un testo più corto di un chunk ne produce esattamente uno.
- I vettori scritti hanno norma 1 entro tolleranza numerica.
- `dot_product` rifiuta vettori di lunghezza diversa invece di restituire un
  punteggio.
- Il recupero classifica per similarità: un chunk pertinente batte uno che
  ripete le parole della domanda senza rispondere.
- Sotto la soglia di 0,35 il modello **non** viene chiamato.
- Le citazioni puntano ai chunk effettivamente usati.
- L'indicizzazione è idempotente: rielaborare un documento non duplica i chunk.
- Ollama mockato ovunque; nessuna chiamata reale.

---

## Ordine di implementazione

Fase 1 per intera, in produzione e verificata, prima di iniziare la Fase 2.
L'archivio consultabile ha valore da solo; le domande senza documenti dentro non
ne hanno.

## Rischi

| Rischio | Mitigazione |
|---|---|
| L'OCR satura la CPU su PDF lunghi | Tetto di 30 pagine, con lo scarto registrato invece che silenzioso |
| Le pagine rasterizzate riempiono il disco | Cancellate in un `finally`, anche in caso di errore dell'OCR |
| Un nome file ostile scrive fuori dalla directory | Nome ripulito dai separatori; `media.ts` ha già la guardia sui path |
| Gli embedding pesano sulla memoria | `nomic-embed-text` sono 274MB e `api/embeddings` è escluso da `keep_alive: 0`, quindi si carica una volta per lotto |
| La ricerca vettoriale rallenta al crescere dell'archivio | Scansione completa fino a qualche decina di migliaia di chunk; oltre, si valuta pgvector con la migrazione di collation che oggi non vale la pena |
| Il modello inventa risposte | Soglia di pertinenza sotto la quale non viene interpellato, e citazioni verificabili su ogni affermazione |
| `qwen2.5:3b` non regge documenti lunghi | Analisi sui primi 12.000 caratteri; il recupero lavora sui chunk, non sul testo integrale, quindi le domande non hanno questo limite |
