# Co-locazione di ollama e revisione del routing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Far sì che archipc, quando è acceso, riceva davvero il traffico, che un modello mancante ripieghi invece di produrre un 404, che il rifiuto vision sia distinguibile da un guasto, e che il container ollama viva nello stesso compose del router che lo bilancia.

**Architecture:** Prima il codice: il predicato del rifiuto vision passa da "nessun backend vision-capable configurato" a "nessuno sano"; `select_backend` scende di tier quando il tier preferito non ha il modello richiesto; i due backend passano a tier diversi così che archipc sia il preferito e geekom il fallback. Poi il deploy: il servizio `ollama` si sposta nel compose del gpu-router con il volume dei modelli copiato in uno nuovo dal nome corretto, e il watchdog viene ripuntato alla nuova directory.

**Tech Stack:** Python 3 + FastAPI + pytest (gpu-router), Docker Compose, bash + systemd user units.

**Spec:** `docs/superpowers/specs/2026-08-19-ollama-colocation-and-routing-design.md`

## Global Constraints

- Il messaggio del 503 vision resta **esattamente** `vision model not available on local GPU`. SoundReel, in un altro repo, ne verifica la sottostringa `vision model not available`: cambiarlo rompe quel contratto.
- Il container mantiene `container_name: ollama` e la porta `127.0.0.1:11434`, e resta sulla rete esterna `web`. `http://ollama:11434` deve continuare a risolvere: nessun consumatore (`soundreel`, `image-gen-web`, `mneme-api`) cambia una riga.
- Il volume `deploy_ollama-models` contiene 3,94 GB di modelli e si **copia**, non si sposta. Si cancella solo dopo che `docker exec ollama ollama list` mostra `qwen2.5:3b`, `moondream:latest` e `nomic-embed-text:latest` dal nuovo compose.
- geekom non esegue mai modelli vision: è un vincolo di stabilità hardware, non una preferenza.
- Il meccanismo di wake non cambia: `WAKE_TARGET_BACKEND=archipc` per nome, soglia 8 su finestra 300s, sentinella più unità systemd.
- Nessuna chiamata reale a servizi esterni nei test.
- Non riaccendere i servizi di mneme (`mneme`, `mneme-api`, `couchdb`): restano fermi.

## File Structure

| File | Responsabilità |
|---|---|
| `geekom-hub/gpu-router/app.py` | predicato del rifiuto vision basato sulla salute |
| `geekom-hub/gpu-router/router.py` | `select_backend`: preferenza per tier con ripiego sulla disponibilità del modello |
| `geekom-hub/gpu-router/docker-compose.yml` | tier dei backend; servizio `ollama`; volume dei modelli |
| `geekom-hub/gpu-router/tests/test_router.py` | tabella di routing, ripiego di tier |
| `geekom-hub/gpu-router/tests/test_app.py` | rifiuto vision con archipc spento |
| `geekom-hub/scripts/gpu-hang-watchdog.sh` | `COMPOSE_DIR` verso la nuova directory |
| `mneme/deploy/docker-compose.yml` | rimozione del servizio e del volume |

---

### Task 1: Il rifiuto vision guarda la salute, non la presenza

**Files:**
- Modify: `/home/mike/works/geekom-hub/gpu-router/app.py:246-256`
- Test: `/home/mike/works/geekom-hub/gpu-router/tests/test_app.py`

**Interfaces:**
- Consumes: `is_vision_model`, `vision_capable` da `policy.py`
- Produces: nessuna firma nuova; cambia solo quando scatta il 503 vision

**Perché.** Il guard oggi rifiuta solo se la lista filtrata è **vuota**. Con archipc in configurazione ma spento — la situazione abituale — la lista contiene archipc, non è vuota, l'esecuzione prosegue e `select_backend` restituisce `None`, così il client riceve `no healthy backends`. SoundReel confronta il corpo con `vision model not available`, quindi non riconosce lo skip e registra un errore generico.

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in `tests/test_app.py`:

```python
def test_vision_is_refused_with_the_vision_message_when_the_remote_is_down(monkeypatch):
    """archipc is configured but powered off — the usual state. The caller must
    still get the vision-specific 503, not the generic no-healthy-backends one,
    because SoundReel keys its clean-skip path off that exact wording."""
    monkeypatch.setenv(
        "OLLAMA_BACKENDS",
        "archipc,http://192.168.178.23:11434,100,0\ngeekom,http://ollama:11434,100,1",
    )
    monkeypatch.delenv("VISION_MODELS", raising=False)
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)

    import importlib
    import app as app_module
    importlib.reload(app_module)

    for b in app_module.POOLS["ollama"]:
        b.healthy = (b.name == "geekom")

    with TestClient(app_module.app) as client:
        resp = client.post("/api/generate", json={"model": "moondream:latest", "prompt": "x"})

    assert resp.status_code == 503
    assert resp.json()["error"] == "vision model not available on local GPU"
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_app.py -v -k remote_is_down`
Expected: FAIL — il corpo è `{"error": "no healthy backends"}`

- [ ] **Step 3: Cambia il predicato**

In `app.py`, sostituisci `if not backends:` con il controllo sulla salute:

```python
    if is_vision_model(model_family):
        backends = [b for b in backends if vision_capable(b.name)]
        # Not "is one configured" but "is one up": archipc is normally powered
        # off, and a configured-but-down backend left this falling through to
        # the generic no-healthy-backends 503, which callers cannot tell from
        # a real fault.
        if not any(b.healthy for b in backends):
            _release_inflight(is_ollama)
            return JSONResponse(
                {
                    "error": "vision model not available on local GPU",
                    "model": model_family,
                },
                status_code=503,
            )
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_app.py -v -k remote_is_down`
Expected: PASS

- [ ] **Step 5: Esegui la suite completa**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/ -v`
Expected: PASS, 85 test. Il contatore in volo deve restare bilanciato: `_release_inflight` è già presente nel ramo che hai modificato.

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/app.py gpu-router/tests/test_app.py
git commit -m "fix(gpu-router): refuse vision on health, not on presence

A configured-but-powered-off remote left the guard falling through to the
generic no-healthy-backends 503, so the caller could not tell a missing
capability from a real fault — which is the whole point of the distinction."
```

---

### Task 2: `select_backend` scende di tier quando il modello manca

**Files:**
- Modify: `/home/mike/works/geekom-hub/gpu-router/router.py:6-31`
- Test: `/home/mike/works/geekom-hub/gpu-router/tests/test_router.py`

**Interfaces:**
- Consumes: `models.Backend` (campi `.healthy`, `.tier`, `.weight`, `.models`)
- Produces: `select_backend(backends: list[Backend], model_family: str | None = None) -> Backend | None` — firma invariata, comportamento esteso

**Perché.** Oggi, se il filtro per `model_family` svuota il pool del tier preferito, il codice prosegue con il pool intero e lascia arrivare un 404 dall'upstream. Con un fallback reale disponibile è uno spreco: se archipc è acceso ma non ha `qwen2.5`, la richiesta va persa invece di finire su geekom, che ce l'ha.

- [ ] **Step 1: Scrivi i test che falliscono**

Aggiungi in `tests/test_router.py`:

```python
def _backend(name, tier, weight=100, healthy=True, models=None):
    from models import Backend
    b = Backend(name=name, url=f"http://{name}:11434", weight=weight, tier=tier)
    b.healthy = healthy
    b.models = set(models) if models is not None else set()
    return b


def test_preferred_tier_wins_when_healthy():
    from router import select_backend
    pool = [_backend("archipc", 0), _backend("geekom", 1)]
    assert select_backend(pool, model_family="qwen2.5").name == "archipc"


def test_falls_back_a_tier_when_the_preferred_one_is_down():
    from router import select_backend
    pool = [_backend("archipc", 0, healthy=False), _backend("geekom", 1)]
    assert select_backend(pool, model_family="qwen2.5").name == "geekom"


def test_falls_back_a_tier_when_the_preferred_one_lacks_the_model():
    from router import select_backend
    pool = [
        _backend("archipc", 0, models=["llama3"]),
        _backend("geekom", 1, models=["qwen2.5"]),
    ]
    assert select_backend(pool, model_family="qwen2.5").name == "geekom"


def test_routes_to_the_preferred_tier_when_no_tier_has_the_model():
    """Nobody has it: route anyway so upstream can answer with a real 404,
    rather than dropping the request silently."""
    from router import select_backend
    pool = [
        _backend("archipc", 0, models=["llama3"]),
        _backend("geekom", 1, models=["llama3"]),
    ]
    assert select_backend(pool, model_family="qwen2.5").name == "archipc"


def test_an_empty_model_set_means_unknown_and_still_matches():
    from router import select_backend
    pool = [_backend("archipc", 0, models=[]), _backend("geekom", 1, models=["qwen2.5"])]
    assert select_backend(pool, model_family="qwen2.5").name == "archipc"


def test_returns_none_when_nothing_is_healthy():
    from router import select_backend
    pool = [_backend("archipc", 0, healthy=False), _backend("geekom", 1, healthy=False)]
    assert select_backend(pool, model_family="qwen2.5") is None
```

- [ ] **Step 2: Esegui i test e verifica quali falliscono**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_router.py -v -k "tier or model"`
Expected: `test_falls_back_a_tier_when_the_preferred_one_lacks_the_model` FALLISCE (oggi restituisce `archipc`); gli altri passano già.

- [ ] **Step 3: Riscrivi `select_backend`**

Sostituisci l'intera funzione in `router.py`:

```python
def _weighted_choice(pool: list[Backend]) -> Backend | None:
    pool = [b for b in pool if b.weight >= 0]
    if not pool:
        return None
    total = sum(b.weight for b in pool)
    if total == 0:
        return random.choice(pool)
    r = random.randint(0, total - 1)
    cum = 0
    for b in pool:
        cum += b.weight
        if r < cum:
            return b
    return pool[-1]


def select_backend(backends: list[Backend], model_family: str | None = None) -> Backend | None:
    """Pick a backend, preferring lower tiers, with weighted choice inside a tier.

    A tier is skipped when it holds no healthy backend and — when a model is
    named — when no healthy backend in it carries that model. Only when no tier
    carries the model do we route anyway, so upstream can answer with a real 404
    instead of us dropping the request silently. An empty `models` set means
    "catalogue unknown", which matches everything.
    """
    healthy_pools = []
    for tier in sorted({b.tier for b in backends}):
        pool = [b for b in backends if b.healthy and b.tier == tier]
        if pool:
            healthy_pools.append(pool)
    if not healthy_pools:
        return None

    if model_family:
        for pool in healthy_pools:
            carrying = [b for b in pool if not b.models or model_family in b.models]
            if carrying:
                return _weighted_choice(carrying)

    return _weighted_choice(healthy_pools[0])
```

Nota: la versione precedente considerava solo i tier 0 e 1 hardcodati. Questa
generalizza a qualunque tier presente in configurazione, il che non cambia nulla
oggi (esistono solo 0 e 1) ma toglie un limite arbitrario.

- [ ] **Step 4: Esegui i test e verifica che passino**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_router.py -v`
Expected: PASS, compresi i test preesistenti su pesi e tier

- [ ] **Step 5: Esegui la suite completa**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/router.py gpu-router/tests/test_router.py
git commit -m "feat(gpu-router): fall to the next tier when the preferred one lacks the model

Routing to a backend that demonstrably does not have the model, when another
tier does, trades a working answer for a guaranteed 404."
```

---

### Task 3: archipc preferito, geekom fallback

**Files:**
- Modify: `/home/mike/works/geekom-hub/gpu-router/docker-compose.yml` (blocco `OLLAMA_BACKENDS`)
- Test: `/home/mike/works/geekom-hub/gpu-router/tests/test_router.py`

**Interfaces:**
- Consumes: `select_backend` del Task 2, `parse_backends` da `models.py`
- Produces: la configurazione `OLLAMA_BACKENDS` che il Task 4 lascia invariata

**Perché.** Oggi `archipc` ha peso 0, che in una scelta pesata significa *mai selezionato*. Verificato eseguendo: con entrambi i backend sani, 1000 richieste di testo vanno tutte a geekom. Il wake accende quindi una macchina che poi serve solo le chiamate vision.

- [ ] **Step 1: Scrivi il test che fallisce**

Questo test legge la configurazione **reale** dal compose e verifica l'intera tabella di routing. È la giuntura fra configurazione e codice, dove nessun test per modulo guarda.

Aggiungi in `tests/test_router.py`:

```python
def _deployed_backends():
    """Parse OLLAMA_BACKENDS out of the committed compose file, so config and
    code cannot drift apart silently."""
    import re
    from pathlib import Path
    from models import parse_backends

    compose = Path(__file__).resolve().parents[1] / "docker-compose.yml"
    text = compose.read_text()
    block = re.search(r"OLLAMA_BACKENDS:\s*\|\n((?:\s+\S+,\S+\n)+)", text)
    assert block, "OLLAMA_BACKENDS block not found in docker-compose.yml"
    return parse_backends("\n".join(line.strip() for line in block.group(1).splitlines()))


def test_deployed_config_prefers_archipc_and_falls_back_to_geekom():
    from router import select_backend

    backends = _deployed_backends()
    names = {b.name for b in backends}
    assert names == {"archipc", "geekom"}

    by_name = {b.name: b for b in backends}
    assert by_name["archipc"].tier < by_name["geekom"].tier, (
        "archipc must be the preferred tier: it is the machine with the real GPU"
    )

    # archipc up -> it takes the traffic
    for b in backends:
        b.healthy = True
    assert {select_backend(backends, model_family="qwen2.5").name for _ in range(200)} == {"archipc"}

    # archipc down (the usual state) -> geekom serves
    by_name["archipc"].healthy = False
    assert {select_backend(backends, model_family="qwen2.5").name for _ in range(200)} == {"geekom"}
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_router.py -v -k deployed_config`
Expected: FAIL sull'assert dei tier — oggi entrambi sono tier 0

- [ ] **Step 3: Cambia i tier nel compose**

In `gpu-router/docker-compose.yml`, sostituisci il blocco `OLLAMA_BACKENDS`:

```yaml
      # Tier is preference, weight only splits traffic inside one tier.
      # archipc has the real GPU and is normally powered off; geekom is the
      # always-on fallback whose iGPU hangs under vision. archipc used to sit
      # at weight 0, which in a weighted draw means never chosen — so waking it
      # powered on a machine that then served nothing but vision requests.
      OLLAMA_BACKENDS: |
        archipc,http://192.168.178.23:11434,100,0
        geekom,http://ollama:11434,100,1
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/test_router.py -v -k deployed_config`
Expected: PASS

- [ ] **Step 5: Verifica che il wake non sia stato disturbato**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/ -v`
Expected: PASS. In particolare i test del wake devono restare verdi: `WAKE_TARGET_BACKEND` identifica archipc **per nome**, quindi il cambio di tier non lo tocca. Se un test del wake fallisce, fermati e riporta: significa che c'è una dipendenza dal tier che la spec non aveva previsto.

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/docker-compose.yml gpu-router/tests/test_router.py
git commit -m "feat(gpu-router): prefer archipc, fall back to geekom

archipc sat at weight 0, which in a weighted draw means never chosen: the
wake booted a machine that then served nothing but vision. Tier expresses the
preference; the new test reads the deployed config so the two cannot drift."
```

---

### Task 4: Sposta il servizio ollama nel compose del router

**Files:**
- Modify: `/home/mike/works/geekom-hub/gpu-router/docker-compose.yml`
- Modify: `/home/mike/works/mneme/deploy/docker-compose.yml`
- Modify: `/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh`

**Interfaces:**
- Consumes: la configurazione dei backend del Task 3 (`http://ollama:11434` invariato)
- Produces: il servizio `ollama` nel progetto compose `gpu-router`, volume `gpu-router_ollama-models`

**Questo task non esegue il cutover.** Prepara i file e copia il volume; l'avvio, la verifica e la cancellazione del volume vecchio sono il Task 5.

- [ ] **Step 1: Copia il volume dei modelli**

```bash
docker volume create gpu-router_ollama-models
docker run --rm \
  -v deploy_ollama-models:/from:ro \
  -v gpu-router_ollama-models:/to \
  alpine sh -c 'cd /from && cp -a . /to/'
```

Verifica che la copia abbia la stessa dimensione della sorgente:

```bash
docker run --rm -v deploy_ollama-models:/v:ro alpine du -sh /v
docker run --rm -v gpu-router_ollama-models:/v:ro alpine du -sh /v
```
Expected: le due dimensioni coincidono, circa 3.9G. Se differiscono, fermati e riporta — non proseguire.

- [ ] **Step 2: Aggiungi il servizio al compose del router**

In `gpu-router/docker-compose.yml`, dopo il servizio `gpu-router`, aggiungi:

```yaml
  # Lives here rather than in the mneme project: this is the container the
  # router balances, and mneme's own services have been stopped for weeks.
  ollama:
    image: ollama/ollama:rocm
    container_name: ollama
    restart: unless-stopped
    ports:
      - "127.0.0.1:11434:11434"
    volumes:
      - ollama-models:/root/.ollama
    devices:
      - /dev/kfd
      - /dev/dri/renderD128
    environment:
      # Host has ~2.8GB free, so holding two models resident for half an hour
      # to serve a handful of posts a day is waste. Not the cause of the 500s
      # (that is a ROCm GPU hang triggered by vision inference), just tidier.
      - OLLAMA_KEEP_ALIVE=5m
      - OLLAMA_MAX_LOADED_MODELS=1
      - HSA_OVERRIDE_GFX_VERSION=11.0.0
    networks:
      - web
```

E in fondo al file, accanto alla sezione `networks`, aggiungi:

```yaml
volumes:
  ollama-models:
    name: gpu-router_ollama-models
```

- [ ] **Step 3: Valida il compose senza avviare nulla**

```bash
cd /home/mike/works/geekom-hub/gpu-router && docker compose config >/dev/null && echo "compose valido"
```
Expected: `compose valido`. Non lanciare `up`.

- [ ] **Step 4: Rimuovi il servizio dal compose di mneme**

In `/home/mike/works/mneme/deploy/docker-compose.yml`, elimina l'intero blocco del servizio `ollama` e la riga `ollama-models:` dalla sezione `volumes`. Lascia intatti `mneme`, `mneme-api`, `couchdb` e `couchdb-data`.

Valida:
```bash
cd /home/mike/works/mneme/deploy && docker compose config >/dev/null && echo "compose valido"
```

- [ ] **Step 5: Ripunta il watchdog**

In `/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh`, cambia il default di `COMPOSE_DIR`:

```bash
COMPOSE_DIR="${OLLAMA_COMPOSE_DIR:-/home/mike/works/geekom-hub/gpu-router}"
```

Questa riga è la ragione per cui il Task 4 e il Task 5 non vanno separati nel tempo: finché il servizio sta ancora in mneme ma il watchdog punta al router, un GPU hang non verrebbe recuperato. Il Task 5 chiude la finestra.

Verifica sintassi e lint:
```bash
bash -n /home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
docker run --rm -v /home/mike/works/geekom-hub/scripts:/mnt koalaman/shellcheck:stable /mnt/gpu-hang-watchdog.sh
```
Expected: nessun output, exit 0

- [ ] **Step 6: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/docker-compose.yml scripts/gpu-hang-watchdog.sh
git commit -m "feat(gpu-router): bring the ollama container into this project

It is the container this router balances, and it was living in the compose
file of a project whose own services have been stopped for weeks. The models
volume is carried over by name so nothing re-downloads."

cd /home/mike/works/mneme
git add deploy/docker-compose.yml
git commit -m "chore(deploy): hand the ollama service over to gpu-router

Nothing here depends on it — the services in this file reach Ollama through
the router, when they run at all."
```

---

### Task 5: Cutover e verifica

**Files:** nessuna modifica al codice. Questo task esegue lo spostamento sullo stato di deploy.

**Interfaces:**
- Consumes: i file preparati dal Task 4 e il volume `gpu-router_ollama-models`

**Attenzione:** questo task ferma e riavvia il container da cui dipende l'inferenza locale di SoundReel. Il downtime è di qualche secondo; durante quella finestra SoundReel degrada sul fallback Claude, che è ciò che fa già quando Ollama non risponde. L'ultimo passo cancella dati in modo irreversibile e ha una condizione esplicita.

- [ ] **Step 1: Fotografa lo stato di partenza**

```bash
docker exec ollama ollama list
```
Annota l'elenco nel report: serve come riferimento per la verifica del passo 4.

- [ ] **Step 2: Ferma il container vecchio**

```bash
cd /home/mike/works/mneme/deploy && docker compose stop ollama && docker compose rm -f ollama
```

`stop` e `rm -f` del solo servizio, **mai** `docker compose down`: quest'ultimo rimuoverebbe anche i volumi di progetto se invocato con `-v`, e tocca servizi che non ci riguardano.

- [ ] **Step 3: Avvia dal nuovo compose**

```bash
cd /home/mike/works/geekom-hub/gpu-router && docker compose up -d ollama
```

- [ ] **Step 4: Verifica che i modelli ci siano**

```bash
docker exec ollama ollama list
docker inspect ollama --format '{{range .Mounts}}{{.Name}} -> {{.Destination}}{{println}}{{end}}'
docker inspect ollama --format '{{index .Config.Labels "com.docker.compose.project"}}'
```
Expected: l'elenco coincide con quello del passo 1 e contiene `qwen2.5:3b`, `moondream:latest`, `nomic-embed-text:latest`; il mount è `gpu-router_ollama-models`; il progetto è `gpu-router`.

Se l'elenco è vuoto o incompleto, **fermati**: il volume vecchio è ancora intatto, rimetti il servizio in mneme e riporta.

- [ ] **Step 5: Verifica che l'inferenza funzioni attraverso il router**

```bash
docker run --rm --network web curlimages/curl:latest -s -m 120 -o /dev/null -w "%{http_code}\n" \
  http://gpu-router:9000/api/generate \
  -d '{"model":"qwen2.5:3b","prompt":"Rispondi in italiano: ciao","stream":false}'
```
Expected: `200`

Nota: il container `gpu-router` in esecuzione monta ancora l'immagine precedente finché non viene ricostruito. Questo passo verifica che il *backend* risponda attraverso il routing esistente, non le modifiche dei Task 1-3.

- [ ] **Step 6: Verifica il watchdog contro la nuova directory**

```bash
/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
echo "exit: $?"
docker ps --format '{{.Names}} {{.Status}}' | grep '^ollama'
```
Expected: exit 0 e l'uptime del container **non** riparte da zero — non ci sono hang recenti, quindi lo script deve restare inerte. Questo prova che trova la nuova directory: se puntasse ancora a quella vecchia fallirebbe solo al primo hang vero, cioè quando serve.

- [ ] **Step 7: Cancella il volume vecchio**

Solo se il passo 4 ha mostrato l'elenco completo dei modelli.

```bash
docker volume rm deploy_ollama-models
docker volume ls | grep ollama
```
Expected: resta solo `gpu-router_ollama-models`.

- [ ] **Step 8: Registra l'esito**

Riporta nel report: l'elenco dei modelli prima e dopo, l'esito dei passi 5 e 6, e conferma che il volume vecchio è stato cancellato.

---

## Verifica finale

- [ ] **Suite gpu-router verde**

```bash
cd /home/mike/works/geekom-hub/gpu-router && python3 -m pytest tests/ -v
```

- [ ] **Il router ricostruito rifiuta la vision con il messaggio giusto**

```bash
cd /home/mike/works/geekom-hub/gpu-router && docker compose up -d --build gpu-router
sleep 5
docker run --rm --network web curlimages/curl:latest -s -m 30 \
  http://gpu-router:9000/api/generate -d '{"model":"moondream:latest","prompt":"x"}'
```
Expected: `{"error":"vision model not available on local GPU","model":"moondream"}` — con archipc spento. Prima di questo lavoro la stessa chiamata rispondeva `no healthy backends`.

- [ ] **Il testo continua a funzionare**

```bash
docker run --rm --network web curlimages/curl:latest -s -m 120 -o /dev/null -w "%{http_code}\n" \
  http://gpu-router:9000/api/generate \
  -d '{"model":"qwen2.5:3b","prompt":"ciao","stream":false}'
```
Expected: `200`, servito da geekom perché archipc è spento.

- [ ] **SoundReel registra lo skip, non un errore**

Manda un reel con video al bot Telegram, poi:

```bash
docker logs soundreel --since 10m 2>&1 | grep -i "vision"
```
Expected: compare `Vision describe saltata: backend vision non disponibile` a livello info, **non** `Vision describe failed`. È il comportamento che era stato progettato e che finora non si è mai verificato.

- [ ] **Alla prima accensione di archipc** (non ora, quando capita)

```bash
/home/mike/works/geekom-hub/scripts/archi.sh ollama
ssh mike@192.168.178.23 'ollama list' 2>/dev/null || docker run --rm --network web curlimages/curl:latest -s http://192.168.178.23:11434/api/tags
```
Verifica quali modelli abbia davvero. Se `moondream` non c'è, la vision ripiegherebbe su geekom, che il guard blocca, quindi il risultato resta il 503 vision — corretto ma silenzioso sul perché. Installarlo lì è ciò che rende utile il wake.
