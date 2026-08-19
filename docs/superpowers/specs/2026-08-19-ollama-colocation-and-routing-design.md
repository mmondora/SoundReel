# Co-locazione di ollama nel gpu-router e revisione del routing

Data: 2026-08-19
Stato: in revisione

## Contesto

Quattro problemi, tutti verificati eseguendo il codice, non leggendolo.

### 1. Il container ollama vive nel compose di un progetto morto

`ollama` è definito in `/home/mike/works/mneme/deploy/docker-compose.yml`, insieme
a `mneme`, `mneme-api` e `couchdb` — tutti fermi da nove giorni con exit 137, e
un progetto che l'utente non usa.

```
mneme       Exited (137)  9 giorni fa
mneme-api   Exited (137)  9 giorni fa
couchdb     Exited (0)    9 giorni fa
ollama      Up            ← progetto compose "deploy"
```

Tre servizi dipendono da quel container attraverso il router: `soundreel`,
`mneme-api` e `image-gen-web`. Un `docker compose down` in quella directory
spegne l'inferenza locale di SoundReel. Il watchdog installato oggi punta lì
(`OLLAMA_COMPOSE_DIR=/home/mike/works/mneme/deploy`).

Nessun servizio di mneme ha un `depends_on` verso ollama: il taglio è netto.

### 2. archipc, anche acceso, non riceve traffico

I pesi attuali sono `archipc,…,0,0` e `geekom,…,100,0`. Entrambi tier 0; peso 0
significa mai selezionato. Eseguito con entrambi i backend sani:

```
modello di testo   ->  geekom 1000/1000
richiesta vision   ->  archipc 1000/1000   (solo perché il guard rimuove geekom)
```

Quindi il meccanismo di wake appena costruito accende una macchina che poi serve
**soltanto** le chiamate vision, mentre tutto il resto continua sulla iGPU che ha
il difetto ROCm. Due minuti di boot e la corrente di un PC per non usarlo.

### 3. Il rifiuto vision non scatta nel caso normale

Il guard rifiuta con il messaggio `vision model not available on local GPU` solo
quando la lista filtrata è **vuota**. Con archipc presente in configurazione ma
spento — la situazione abituale — la lista contiene archipc, non è vuota, e
l'esecuzione prosegue fino a `select_backend`, che restituisce `None`:

```
dopo il filtro vision: ['archipc']
select_backend -> None
-> 503 {"error": "no healthy backends"}
```

SoundReel confronta il corpo con `vision model not available`, quindi
`VisionUnavailableError` non viene mai sollevata e il clean skip introdotto per
distinguere "saltato" da "fallito" non funziona nello scenario che si verifica
sempre. La pipeline degrada comunque — errore generico, `describeFramesWithVision`
ritorna `null`, l'analisi prosegue — ma log e actionLog dicono "errore" dove la
verità è "capacità non disponibile".

Il predicato giusto non è "la lista filtrata è vuota" ma "non esiste un backend
vision-capable **sano**".

### 4. Un backend preferito senza il modello richiesto instrada verso un 404

`select_backend` filtra per `model_family` e, se nessun backend del pool ha quel
modello, prosegue con il pool intero. Il commento nel codice lo dichiara:
*"returns whatever — upstream will 404, better than silent drop"*. Difendibile
con un solo tier; sbagliato quando esiste un fallback reale.

## Obiettivi

- `ollama` vive nello stesso compose del router che lo bilancia.
- Quando archipc è acceso riceve il traffico; quando è spento si ripiega su
  geekom senza che nulla si accorga della differenza.
- Un modello assente sul backend preferito non produce un 404: si ripiega.
- Il rifiuto vision è distinguibile da un guasto, anche quando archipc è spento.

## Non obiettivi

- Cambiare il meccanismo di wake. Resta com'è: `WAKE_TARGET_BACKEND` per nome,
  soglia 8 su finestra 300s, sentinella più unità systemd.
- Cambiare il guard vision come politica: geekom non esegue vision, punto.
- Riaccendere o modificare i servizi di mneme.
- Toccare i consumatori (`soundreel`, `image-gen-web`, `mneme-api`): il nome
  `ollama` e la porta non cambiano, quindi `http://ollama:11434` continua a
  risolvere e nessuno di loro cambia una riga.

---

## Fase 1 — Spostamento del container

### Il volume

`deploy_ollama-models` contiene **3,94 GB** di modelli. Il prefisso `deploy_` è
il nome del progetto compose di mneme. Spostando il servizio senza accorgimenti,
compose creerebbe `gpu-router_ollama-models` vuoto e ollama riscaricherebbe tutto.

Si copia in un volume con il nome corretto:

```bash
docker volume create gpu-router_ollama-models
docker run --rm \
  -v deploy_ollama-models:/from \
  -v gpu-router_ollama-models:/to \
  alpine sh -c 'cd /from && cp -a . /to/'
```

Spazio disponibile: 537 GB, la copia è locale e breve.

Il volume vecchio si cancella **solo dopo** aver verificato che ollama, ripartito
dal nuovo compose, elenchi gli stessi modelli. Fino ad allora resta come rete di
sicurezza: la verifica è `docker exec ollama ollama list`, che deve mostrare
`qwen2.5:3b`, `moondream:latest` e `nomic-embed-text:latest`.

### Il servizio

Il blocco `ollama` si sposta in `gpu-router/docker-compose.yml` invariato —
stessa immagine `ollama/ollama:rocm`, stesso `container_name: ollama`, stessi
device `/dev/kfd` e `/dev/dri/renderD128`, stesso `HSA_OVERRIDE_GFX_VERSION`,
stessa porta `127.0.0.1:11434`, stessa rete `web`, e le env di igiene memoria
(`OLLAMA_KEEP_ALIVE=5m`, `OLLAMA_MAX_LOADED_MODELS=1`).

Il volume si dichiara con il nome esplicito, così il progetto lo possiede senza
ambiguità:

```yaml
volumes:
  ollama-models:
    name: gpu-router_ollama-models
```

Da `mneme/deploy/docker-compose.yml` si rimuovono il servizio `ollama` e la voce
`ollama-models` dalla sezione `volumes`.

### Il watchdog

`scripts/gpu-hang-watchdog.sh` ha `COMPOSE_DIR` con default
`/home/mike/works/mneme/deploy`. Va cambiato in `/home/mike/works/geekom-hub/gpu-router`.
Se lo spostamento avviene senza questa modifica, al primo GPU hang il watchdog
cerca di ricreare un servizio che in quella directory non esiste più e il
recovery smette di funzionare in silenzio — il caso peggiore, perché la
protezione sembra installata e non lo è.

### Ordine delle operazioni

1. copia il volume;
2. `docker compose stop ollama` in `mneme/deploy` (stop, non `down`: il volume
   vecchio non va toccato);
3. sposta il blocco nel compose del router, aggiorna il watchdog, rimuovi il
   servizio da mneme;
4. `docker compose up -d ollama` in `gpu-router`;
5. verifica `docker exec ollama ollama list` e una generate di prova;
6. solo allora `docker rm` del vecchio container e `docker volume rm deploy_ollama-models`.

Downtime: i secondi fra il passo 2 e il passo 4. SoundReel degrada sul fallback
Claude nel frattempo, che è ciò che fa già quando Ollama non risponde.

---

## Fase 2 — Revisione del routing

### 2a. archipc preferito, geekom fallback

I due backend passano a tier diversi:

```
archipc,http://192.168.178.23:11434,100,0
geekom,http://ollama:11434,100,1
```

`select_backend` usa già il pool tier 0 quando contiene almeno un backend sano e
ripiega su tier 1 altrimenti. Quindi:

| Situazione | Backend scelto |
|---|---|
| archipc spento (abituale) | geekom |
| archipc acceso | archipc |
| archipc acceso, modello di testo assente lì | geekom (vedi 2b) |
| archipc acceso, modello **vision** assente lì | nessuno: 503 vision (vedi 2b) |

I pesi diventano irrilevanti fra i due — restano a 100 entrambi perché il peso
discrimina all'interno dello stesso tier, e qui ogni tier ha un solo backend.

Questa modifica era stata esplicitamente evitata in un lavoro precedente perché
il wake dipendeva dal tier. Ora non più: `WAKE_TARGET_BACKEND` identifica archipc
per nome, quindi ri-tierare è sicuro.

### 2b. Ripiego quando il preferito non ha il modello

`select_backend` oggi, quando il filtro per `model_family` svuota il pool,
prosegue con il pool intero e lascia arrivare un 404. Con un fallback reale
disponibile questo è uno spreco.

Nuovo comportamento: se il pool del tier preferito non contiene alcun backend con
quel modello, si scende al tier successivo e si riapplica il filtro. Se nessun
tier ha il modello, si mantiene il comportamento attuale — instrada comunque e
lascia parlare l'upstream — perché a quel punto il 404 è l'informazione corretta.

**Il ripiego di tier non vale per le richieste vision.** `app.py` restringe
`backends` al sottoinsieme vision-capable *prima* di chiamare `select_backend`,
quindi per una richiesta vision non esiste un secondo tier su cui scendere: il
ciclo di 2b non trova nulla, `_weighted_choice` prende comunque il tier
preferito e la richiesta parte verso archipc. Il risultato sarebbe un 404
upstream il cui corpo non contiene `vision model not available`, e SoundReel
registrerebbe un errore generico invece dello skip pulito. 2b è
strutturalmente inerte sul percorso vision.

Perciò il rifiuto di 2c deve essere esso stesso model-aware: si rifiuta quando
nessun backend vision-capable **sano** porta il modello richiesto. Un `models`
vuoto significa "catalogo ignoto" (la health loop non ha ancora letto
`/api/tags`) e continua a valere per tutto, esattamente come lo legge
`select_backend`.

Nota operativa: il catalogo cachato dal router live mostra che archipc ha
davvero `moondream`, oltre a `qwen2.5`, `nomic-embed-text`, `qwen3` e `gemma4`.
Il caso "modello vision assente su archipc" è quindi latente, non attivo — ma
va coperto lo stesso, perché è il caso in cui una macchina accesa smette di
servire vision senza dire perché.

### 2c. Il rifiuto vision guarda la salute, non la presenza

Il predicato cambia da "nessun backend vision-capable in configurazione" a
"nessun backend vision-capable **sano**":

```python
if is_vision_model(model_family):
    backends = [b for b in backends if vision_capable(b.name)]
    if not any(
        b.healthy and (not b.models or model_family in b.models)
        for b in backends
    ):
        return JSONResponse(
            {"error": "vision model not available on local GPU", "model": model_family},
            status_code=503,
        )
```

Il predicato copre entrambi i casi di 2b: nessun backend vision-capable sano, e
backend sano il cui catalogo non contiene il modello.

Con archipc spento questo restituisce il messaggio vision invece di
`no healthy backends`, quindi SoundReel solleva `VisionUnavailableError`, registra
lo skip a livello info e scrive `status: 'skipped'` nell'actionLog — il
comportamento che era stato progettato e che oggi non si verifica mai.

Il messaggio resta invariato: SoundReel confronta la sottostringa
`vision model not available`, e cambiarlo romperebbe quel contratto.

### Test

- `select_backend`: archipc sano → archipc; archipc malato → geekom; archipc sano
  ma senza il modello → geekom; nessun tier con il modello → instrada comunque.
- Rifiuto vision: archipc spento → 503 con il messaggio vision, **non**
  `no healthy backends`; archipc acceso e con `moondream` → instrada ad archipc;
  archipc acceso con catalogo ancora ignoto → instrada ad archipc; archipc
  acceso ma senza `moondream` → 503 vision, e **niente** deve partire upstream.
- Un test che costruisce il pool dalla stringa `OLLAMA_BACKENDS` reale del compose
  e verifica la tabella di 2a per intero. È la giuntura fra configurazione e
  codice, ed è esattamente dove si sono nascosti tre dei quattro difetti qui
  sopra: nessun test che guardi un solo modulo li avrebbe trovati.
- Nessuna chiamata reale a servizi esterni.

---

## Ordine di implementazione

1. **Fase 2** (routing) per prima: è codice con test, indipendente dallo
   spostamento, e chiude un difetto già in produzione.
2. **Fase 1** (spostamento) dopo: tocca stato di deploy e ha una finestra di
   downtime, quindi conviene farla quando il resto è verde.

## Rischi

| Rischio | Mitigazione |
|---|---|
| I modelli spariscono nello spostamento | Il volume vecchio si cancella solo dopo aver verificato `ollama list` sul nuovo. Copia, non spostamento |
| Il watchdog resta puntato alla directory vecchia | Modifica nello stesso commit dello spostamento; verifica esplicita dopo |
| archipc acceso ma senza i modelli di testo | 2b ripiega su geekom invece di 404 |
| archipc acceso ma senza il modello vision | 2b non si applica (il guard ha già ristretto il pool): il rifiuto di 2c è model-aware e risponde 503 vision |
| Ri-tierare cambia il routing per tutti i consumatori | È l'intento. I consumatori non cambiano codice: cambia solo quale macchina risponde |
| Il traffico si sposta su archipc e i modelli su geekom si raffreddano | `keep_alive: 0` su geekom li scarica comunque dopo ogni uso: nessuna regressione |
