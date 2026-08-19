# Fase 1 — Orchestrazione dell'inferenza — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Impedire che l'inferenza vision pianti la GPU del geekom, accendere archi-pc quando il carico lo giustifica, e recuperare automaticamente dagli hang residui.

**Architecture:** Il `gpu-router` diventa il punto in cui si applicano le politiche: blocca i modelli vision verso il backend geekom (503), inietta `keep_alive: 0` sulle chiamate locali per scaricare il modello dopo l'uso, e quando il tier-0 è giù sotto carico scrive un file sentinella. Sull'host due unità systemd raccolgono la sentinella per svegliare archi-pc e sorvegliano i log di ollama per ricreare il container quando la GPU si appende. SoundReel tratta il 503 vision come skip pulito invece che come errore.

**Tech Stack:** Python 3 + FastAPI + pytest (gpu-router), bash + systemd user units (host), TypeScript + Vitest (SoundReel), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-19-resilience-and-italian-content-design.md`

## Global Constraints

- Nessun segreto nuovo in immagini o container. La chiave SSH per archi-pc e le
  credenziali Mikrotik restano sull'host, dove già sono.
- Nessun socket Docker montato dentro un container.
- `docker compose restart` **non** recupera dal GPU hang: serve
  `docker compose up -d --force-recreate`. Verificato sul campo.
- Il backend `geekom` non deve mai ricevere un modello vision. È un vincolo di
  stabilità, non una preferenza.
- `OLLAMA_FLASH_ATTENTION=0` è stata provata e non risolve l'hang. Non
  introdurla.
- TypeScript strict, nessun `any` (convenzione SoundReel).
- Nessuna chiamata reale a servizi esterni nei test: SSH, WoL, Docker e HTTP
  vanno mockati.
- Il timer systemd è **utente** (`systemctl --user`), non di sistema: il linger
  è già attivo su questa macchina, stessa tecnica di `fritz-sync`.

## Scelta implementativa: sentinella su file, non SSH dal container

La spec lasciava aperto come il router accende archi-pc. Decisione: **file
sentinella più unità systemd `path`**, non SSH dal container.

Motivo: `archi.sh` ha bisogno della chiave SSH verso archi-pc e delle
credenziali Mikrotik per il WoL. Metterle in un'immagine Docker le espone senza
motivo. Il progetto usa già l'idioma della sentinella per il deploy
(`.rebuild` + `deploy-watcher`), quindi è coerente con il resto.

Il router scrive `/wake/archi.wake`; una unità `path` sull'host lo vede ed
esegue `archi.sh ollama`.

## File Structure

| File | Responsabilità |
|---|---|
| `geekom-hub/gpu-router/policy.py` | **nuovo** — quali modelli sono vision, quali backend possono eseguirli, iniezione di `keep_alive` |
| `geekom-hub/gpu-router/wake.py` | **nuovo** — soglia, cooldown e scrittura della sentinella |
| `geekom-hub/gpu-router/app.py` | wiring nel `proxy()`: filtro vision, keep_alive, trigger di wake |
| `geekom-hub/gpu-router/docker-compose.yml` | bind mount della directory sentinella, nuove env |
| `geekom-hub/gpu-router/tests/test_policy.py` | **nuovo** |
| `geekom-hub/gpu-router/tests/test_wake.py` | **nuovo** |
| `geekom-hub/scripts/archi-wake.sh` | **nuovo** — consuma la sentinella, chiama `archi.sh ollama` |
| `geekom-hub/scripts/gpu-hang-watchdog.sh` | **nuovo** — cerca `GPU Hang`, ricrea ollama, limite anti-loop |
| `geekom-hub/systemd/archi-wake.path` + `.service` | **nuovo** |
| `geekom-hub/systemd/gpu-hang-watchdog.timer` + `.service` | **nuovo** |
| `Soundreel/backend/src/services/ollamaClient.ts` | 503 vision → skip pulito invece di errore |
| `Soundreel/backend/src/services/ollamaClient.test.ts` | **nuovo** |
| `mneme/deploy/docker-compose.yml` | env di ollama, già modificato, da committare |

---

### Task 1: Blocco dei modelli vision verso il backend locale

**Files:**
- Create: `/home/mike/works/geekom-hub/gpu-router/policy.py`
- Create: `/home/mike/works/geekom-hub/gpu-router/tests/test_policy.py`
- Modify: `/home/mike/works/geekom-hub/gpu-router/app.py` (dentro `proxy()`, dopo il calcolo di `model_family`)

**Interfaces:**
- Produces: `is_vision_model(model_family: str | None) -> bool`,
  `vision_capable(backend_name: str) -> bool`
- Consumes: `models.Backend` (campo `.name`)

- [ ] **Step 1: Scrivi il test che fallisce**

In `tests/test_policy.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from policy import is_vision_model, vision_capable


def test_moondream_is_vision_by_default(monkeypatch):
    monkeypatch.delenv("VISION_MODELS", raising=False)
    assert is_vision_model("moondream") is True


def test_text_model_is_not_vision(monkeypatch):
    monkeypatch.delenv("VISION_MODELS", raising=False)
    assert is_vision_model("qwen2.5") is False


def test_none_model_is_not_vision(monkeypatch):
    monkeypatch.delenv("VISION_MODELS", raising=False)
    assert is_vision_model(None) is False


def test_vision_models_env_is_honoured(monkeypatch):
    monkeypatch.setenv("VISION_MODELS", "llava,bakllava")
    assert is_vision_model("llava") is True
    assert is_vision_model("moondream") is False


def test_geekom_cannot_run_vision_by_default(monkeypatch):
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)
    assert vision_capable("geekom") is False


def test_archipc_can_run_vision(monkeypatch):
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)
    assert vision_capable("archipc") is True
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_policy.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'policy'`

- [ ] **Step 3: Scrivi l'implementazione minima**

Crea `policy.py`:

```python
from __future__ import annotations
import os

DEFAULT_VISION_MODELS = "moondream"
DEFAULT_VISION_BLOCKED_BACKENDS = "geekom"


def _env_set(name: str, default: str) -> set[str]:
    raw = os.environ.get(name, default)
    return {part.strip().split(":")[0] for part in raw.split(",") if part.strip()}


def is_vision_model(model_family: str | None) -> bool:
    """True when the requested model is one that hangs the gfx11 iGPU under ROCm."""
    if not model_family:
        return False
    return model_family in _env_set("VISION_MODELS", DEFAULT_VISION_MODELS)


def vision_capable(backend_name: str) -> bool:
    """False for backends whose GPU cannot survive vision inference."""
    return backend_name not in _env_set(
        "VISION_BLOCKED_BACKENDS", DEFAULT_VISION_BLOCKED_BACKENDS
    )
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_policy.py -v`
Expected: PASS, 6 test

- [ ] **Step 5: Scrivi il test di integrazione sul proxy**

Aggiungi in `tests/test_app.py`:

```python
def test_vision_request_is_refused_when_only_geekom_is_up(monkeypatch):
    monkeypatch.setenv("OLLAMA_BACKENDS", "geekom,http://ollama:11434,100,0")
    monkeypatch.delenv("VISION_MODELS", raising=False)
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)

    import importlib
    import app as app_module
    importlib.reload(app_module)

    with TestClient(app_module.app) as client:
        resp = client.post("/api/generate", json={"model": "moondream:latest", "prompt": "x"})

    assert resp.status_code == 503
    assert resp.json()["error"] == "vision model not available on local GPU"


def test_text_request_still_routes_to_geekom(monkeypatch):
    monkeypatch.setenv("OLLAMA_BACKENDS", "geekom,http://ollama:11434,100,0")
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)

    import importlib
    import app as app_module
    importlib.reload(app_module)

    # The upstream call fails (nothing listening), but the router must have
    # selected a backend rather than refusing on policy grounds.
    with TestClient(app_module.app) as client:
        resp = client.post("/api/generate", json={"model": "qwen2.5:3b", "prompt": "x"})

    assert resp.json().get("error") != "vision model not available on local GPU"
```

- [ ] **Step 6: Esegui e verifica che il primo fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_app.py -v -k vision`
Expected: FAIL — il router oggi inoltra la richiesta invece di rifiutarla

- [ ] **Step 7: Aggiungi il filtro in `app.py`**

In cima al file, accanto agli altri import locali:

```python
from policy import is_vision_model, vision_capable
```

Dentro `proxy()`, subito **dopo** il blocco che calcola `model_family` dal body
(quello che inizia con `if model_family is None and body and not path.startswith(...)`)
e **prima** di `backend = select_backend(...)`:

```python
    if is_vision_model(model_family):
        backends = [b for b in backends if vision_capable(b.name)]
        if not backends:
            return JSONResponse(
                {
                    "error": "vision model not available on local GPU",
                    "model": model_family,
                },
                status_code=503,
            )
```

- [ ] **Step 8: Esegui tutti i test**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/ -v`
Expected: PASS, nessuna regressione sui test esistenti

- [ ] **Step 9: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/policy.py gpu-router/tests/test_policy.py gpu-router/tests/test_app.py gpu-router/app.py
git commit -m "feat(gpu-router): refuse vision models on the local GPU

Vision inference raises a ROCm GPU Hang on the gfx11 iGPU, and once it
fires the device stays broken for every model, not just the vision one.
Refusing the request keeps text inference alive."
```

---

### Task 2: Scarico del modello dopo l'uso sul backend locale

**Files:**
- Modify: `/home/mike/works/geekom-hub/gpu-router/policy.py`
- Modify: `/home/mike/works/geekom-hub/gpu-router/tests/test_policy.py`
- Modify: `/home/mike/works/geekom-hub/gpu-router/app.py` (dentro `proxy()`, dopo la selezione del backend)

**Interfaces:**
- Consumes: `is_vision_model`, `vision_capable` (Task 1)
- Produces: `apply_keep_alive(body: bytes, backend_name: str, path: str) -> bytes`

- [ ] **Step 1: Scrivi il test che fallisce**

Aggiungi in `tests/test_policy.py`:

```python
import json
from policy import apply_keep_alive


def test_keep_alive_is_injected_for_geekom(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    body = json.dumps({"model": "qwen2.5:3b", "prompt": "x"}).encode()
    out = json.loads(apply_keep_alive(body, "geekom", "api/generate"))
    assert out["keep_alive"] == 0


def test_keep_alive_is_not_injected_for_archipc(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    body = json.dumps({"model": "qwen2.5:3b", "prompt": "x"}).encode()
    out = json.loads(apply_keep_alive(body, "archipc", "api/generate"))
    assert "keep_alive" not in out


def test_existing_keep_alive_is_preserved(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    body = json.dumps({"model": "qwen2.5:3b", "keep_alive": "10m"}).encode()
    out = json.loads(apply_keep_alive(body, "geekom", "api/generate"))
    assert out["keep_alive"] == "10m"


def test_non_inference_path_is_untouched(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    body = json.dumps({"model": "qwen2.5:3b"}).encode()
    assert apply_keep_alive(body, "geekom", "api/tags") == body


def test_non_json_body_is_untouched(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    body = b"not json at all"
    assert apply_keep_alive(body, "geekom", "api/generate") == body


def test_empty_body_is_untouched(monkeypatch):
    monkeypatch.delenv("UNLOAD_BACKENDS", raising=False)
    assert apply_keep_alive(b"", "geekom", "api/generate") == b""
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_policy.py -v -k keep_alive`
Expected: FAIL con `ImportError: cannot import name 'apply_keep_alive'`

- [ ] **Step 3: Scrivi l'implementazione minima**

Aggiungi `import json as _json` in cima a `policy.py`, accanto a `import os`,
poi aggiungi in fondo al file:

```python
DEFAULT_UNLOAD_BACKENDS = "geekom"
INFERENCE_PATHS = ("api/generate", "api/chat", "api/embeddings")


def apply_keep_alive(body: bytes, backend_name: str, path: str) -> bytes:
    """Ask Ollama to unload the model right after the call.

    The host has ~2.8GB free; holding a model resident for the default
    keep-alive to serve a handful of posts a day is waste. Remote backends
    keep the default — reloading on every call there is only slower.
    """
    if backend_name not in _env_set("UNLOAD_BACKENDS", DEFAULT_UNLOAD_BACKENDS):
        return body
    if not path.rstrip("/").endswith(INFERENCE_PATHS):
        return body
    if not body:
        return body
    try:
        payload = _json.loads(body)
    except Exception:
        return body
    if not isinstance(payload, dict) or "keep_alive" in payload:
        return body
    payload["keep_alive"] = 0
    return _json.dumps(payload).encode()
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_policy.py -v`
Expected: PASS, 12 test

- [ ] **Step 5: Collega in `app.py`**

Estendi l'import esistente:

```python
from policy import is_vision_model, vision_capable, apply_keep_alive
```

Dentro `proxy()`, subito **dopo** il controllo `if backend is None: return ...`
e **prima** del calcolo di `target_url`:

```python
    body = apply_keep_alive(body, backend.name, effective_path)
```

Nota: `fwd_headers` scarta già `content-length`, quindi il cambio di lunghezza
del body non richiede altro.

- [ ] **Step 6: Esegui tutti i test**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/policy.py gpu-router/tests/test_policy.py gpu-router/app.py
git commit -m "feat(gpu-router): unload local models right after inference

The host runs with very little headroom, so keeping a model resident
between requests costs more than reloading it does."
```

---

### Task 3: Trigger di wake su carico con tier-0 giù

**Files:**
- Create: `/home/mike/works/geekom-hub/gpu-router/wake.py`
- Create: `/home/mike/works/geekom-hub/gpu-router/tests/test_wake.py`
- Modify: `/home/mike/works/geekom-hub/gpu-router/app.py`

**Interfaces:**
- Consumes: `models.Backend` (campi `.tier`, `.healthy`)
- Produces: `WakeState`, `should_wake(state, inflight, tier0_healthy, now) -> bool`,
  `request_wake(state, now) -> bool`

**Semantica della soglia:** il router non vede la coda di SoundReel. Come
misura di "c'è arretrato da smaltire" usa il numero di richieste ollama
**concorrenti in volo**. Con `WAKE_THRESHOLD=3`, tre richieste sovrapposte
mentre archi-pc è giù fanno partire il wake. Un reel singolo non accende un PC.

- [ ] **Step 1: Scrivi il test che fallisce**

In `tests/test_wake.py`:

```python
import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from wake import WakeState, should_wake, request_wake


def test_no_wake_when_tier0_is_healthy(monkeypatch):
    monkeypatch.delenv("WAKE_THRESHOLD", raising=False)
    state = WakeState()
    assert should_wake(state, inflight=10, tier0_healthy=True, now=1000.0) is False


def test_no_wake_below_threshold(monkeypatch):
    monkeypatch.setenv("WAKE_THRESHOLD", "3")
    state = WakeState()
    assert should_wake(state, inflight=2, tier0_healthy=False, now=1000.0) is False


def test_wake_at_threshold(monkeypatch):
    monkeypatch.setenv("WAKE_THRESHOLD", "3")
    state = WakeState()
    assert should_wake(state, inflight=3, tier0_healthy=False, now=1000.0) is True


def test_cooldown_blocks_a_second_wake(monkeypatch):
    monkeypatch.setenv("WAKE_THRESHOLD", "3")
    monkeypatch.setenv("WAKE_COOLDOWN", "600")
    state = WakeState()
    state.last_wake_at = 1000.0
    assert should_wake(state, inflight=5, tier0_healthy=False, now=1500.0) is False


def test_wake_allowed_again_after_cooldown(monkeypatch):
    monkeypatch.setenv("WAKE_THRESHOLD", "3")
    monkeypatch.setenv("WAKE_COOLDOWN", "600")
    state = WakeState()
    state.last_wake_at = 1000.0
    assert should_wake(state, inflight=5, tier0_healthy=False, now=1601.0) is True


def test_request_wake_writes_the_sentinel(monkeypatch, tmp_path):
    sentinel = tmp_path / "run" / "archi.wake"
    monkeypatch.setenv("WAKE_SENTINEL", str(sentinel))
    state = WakeState()
    assert request_wake(state, now=1234.0) is True
    assert sentinel.read_text().strip() == "1234"
    assert state.last_wake_at == 1234.0


def test_request_wake_survives_an_unwritable_path(monkeypatch):
    monkeypatch.setenv("WAKE_SENTINEL", "/proc/definitely/not/writable/archi.wake")
    state = WakeState()
    assert request_wake(state, now=1234.0) is False
    assert state.last_wake_at == 0.0
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_wake.py -v`
Expected: FAIL con `ModuleNotFoundError: No module named 'wake'`

- [ ] **Step 3: Scrivi l'implementazione minima**

Crea `wake.py`:

```python
from __future__ import annotations
import os
from dataclasses import dataclass
from pathlib import Path

DEFAULT_THRESHOLD = "3"
DEFAULT_COOLDOWN = "600"
DEFAULT_SENTINEL = "/wake/archi.wake"


@dataclass
class WakeState:
    last_wake_at: float = 0.0


def _threshold() -> int:
    return int(os.environ.get("WAKE_THRESHOLD", DEFAULT_THRESHOLD))


def _cooldown() -> int:
    return int(os.environ.get("WAKE_COOLDOWN", DEFAULT_COOLDOWN))


def _sentinel() -> Path:
    return Path(os.environ.get("WAKE_SENTINEL", DEFAULT_SENTINEL))


def should_wake(state: WakeState, inflight: int, tier0_healthy: bool, now: float) -> bool:
    """Wake the remote box only when there is a real backlog and it is down."""
    if tier0_healthy:
        return False
    if inflight < _threshold():
        return False
    if now - state.last_wake_at < _cooldown():
        return False
    return True


def request_wake(state: WakeState, now: float) -> bool:
    """Drop a sentinel file. A systemd path unit on the host picks it up and
    runs archi.sh, so no SSH key or Mikrotik credential ever enters this image."""
    path = _sentinel()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{int(now)}\n")
    except Exception:
        return False
    state.last_wake_at = now
    return True
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/test_wake.py -v`
Expected: PASS, 7 test

- [ ] **Step 5: Collega in `app.py`**

Import, accanto agli altri import locali:

```python
from wake import WakeState, should_wake, request_wake
```

A livello di modulo, accanto a `POOLS`:

```python
WAKE_STATE = WakeState()
_INFLIGHT: dict[str, int] = {"ollama": 0}
```

Dentro `proxy()`, subito **dopo** `body = await request.body()` e **prima** del
filtro vision:

```python
    is_ollama = backends is POOLS.get("ollama")
    if is_ollama:
        _INFLIGHT["ollama"] += 1
        tier0_healthy = any(b.healthy and b.tier == 0 for b in backends)
        if should_wake(WAKE_STATE, _INFLIGHT["ollama"], tier0_healthy, time.monotonic()):
            request_wake(WAKE_STATE, time.monotonic())
```

Il contatore deve tornare a zero su **ogni** via di uscita, comprese quelle di
errore. Definisci l'helper accanto a `_INFLIGHT`:

```python
def _release_inflight(active: bool) -> None:
    if active and _INFLIGHT["ollama"] > 0:
        _INFLIGHT["ollama"] -= 1
```

`proxy()` ha esattamente cinque uscite dopo l'incremento. Aggiungi
`_release_inflight(is_ollama)` immediatamente prima di ciascuna:

1. il `return` del rifiuto vision (Task 1);
2. il `return` di `{"error": "no healthy backends"}`;
3. il `return` dentro `except Exception as exc:` attorno a `client.send(...)`;
4. nel blocco `finally` di `_stream()`, accanto a `await client.aclose()`;
5. il ramo `except Exception` di `_stream()` è seguito dal `finally` del punto 4,
   quindi **non** va rilasciato una seconda volta lì.

Attenzione al punto 4: `_stream()` è un generatore, quindi il rilascio avviene
alla chiusura della risposta, non al `return` di `proxy()`. È il comportamento
voluto — la richiesta è in volo finché lo streaming non è finito.

Il wake **non blocca**: scrive il file e la richiesta corrente prosegue sul
backend locale. Le successive troveranno archi-pc pronto.

- [ ] **Step 6: Scrivi il test di integrazione**

Aggiungi in `tests/test_app.py`:

```python
def test_inflight_returns_to_zero_after_a_refused_vision_request(monkeypatch):
    monkeypatch.setenv("OLLAMA_BACKENDS", "geekom,http://ollama:11434,100,0")
    monkeypatch.delenv("VISION_BLOCKED_BACKENDS", raising=False)

    import importlib
    import app as app_module
    importlib.reload(app_module)

    with TestClient(app_module.app) as client:
        client.post("/api/generate", json={"model": "moondream:latest", "prompt": "x"})

    assert app_module._INFLIGHT["ollama"] == 0
```

- [ ] **Step 7: Esegui tutti i test**

Run: `cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/ -v`
Expected: PASS

- [ ] **Step 8: Aggiungi il mount e le env al compose del router**

In `geekom-hub/gpu-router/docker-compose.yml`, nel servizio `gpu-router`:

```yaml
    volumes:
      - /home/mike/works/geekom-hub/run:/wake
    environment:
      - VISION_MODELS=moondream
      - VISION_BLOCKED_BACKENDS=geekom
      - UNLOAD_BACKENDS=geekom
      - WAKE_THRESHOLD=3
      - WAKE_COOLDOWN=600
      - WAKE_SENTINEL=/wake/archi.wake
```

Se `volumes:` o `environment:` esistono già, aggiungi le righe a quelle liste
invece di crearne di nuove.

- [ ] **Step 9: Crea la directory della sentinella**

```bash
mkdir -p /home/mike/works/geekom-hub/run
```

- [ ] **Step 10: Commit**

```bash
cd /home/mike/works/geekom-hub
git add gpu-router/wake.py gpu-router/tests/test_wake.py gpu-router/tests/test_app.py gpu-router/app.py gpu-router/docker-compose.yml
git commit -m "feat(gpu-router): wake archi-pc when the local GPU is carrying a backlog

Writes a sentinel file rather than running archi.sh itself, so the SSH key
and Mikrotik credentials stay on the host instead of entering the image."
```

---

### Task 4: Consumo della sentinella sull'host

**Files:**
- Create: `/home/mike/works/geekom-hub/scripts/archi-wake.sh`
- Create: `/home/mike/works/geekom-hub/systemd/archi-wake.path`
- Create: `/home/mike/works/geekom-hub/systemd/archi-wake.service`

**Interfaces:**
- Consumes: il file `/home/mike/works/geekom-hub/run/archi.wake` scritto dal Task 3
- Produces: `archi.sh ollama` eseguito sull'host

- [ ] **Step 1: Scrivi lo script**

Crea `scripts/archi-wake.sh`:

```bash
#!/usr/bin/env bash
# archi-wake.sh — consuma la sentinella scritta dal gpu-router e accende
# archi-pc con i suoi servizi Ollama. Girato da archi-wake.service, che è
# innescato da archi-wake.path.
set -euo pipefail

SENTINEL="${WAKE_SENTINEL:-/home/mike/works/geekom-hub/run/archi.wake}"
LOG_DIR="${HOME}/.local/share/geekom"
LOG="${LOG_DIR}/archi-wake.log"
ARCHI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/archi.sh"

mkdir -p "$LOG_DIR"

log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

# Consuma la sentinella per prima cosa: se archi.sh fallisce non vogliamo che
# il path unit riparta in loop sullo stesso file.
if [ ! -f "$SENTINEL" ]; then
    log "nessuna sentinella, esco"
    exit 0
fi
rm -f "$SENTINEL"

log "sentinella raccolta, avvio archi.sh ollama"
if "$ARCHI" ollama >> "$LOG" 2>&1; then
    log "archi.sh ollama: ok"
else
    log "archi.sh ollama: FALLITO (exit $?)"
fi
```

- [ ] **Step 2: Rendilo eseguibile e verificane la sintassi**

```bash
chmod +x /home/mike/works/geekom-hub/scripts/archi-wake.sh
bash -n /home/mike/works/geekom-hub/scripts/archi-wake.sh
docker run --rm -v /home/mike/works/geekom-hub/scripts:/mnt koalaman/shellcheck:stable /mnt/archi-wake.sh
```
Expected: nessun output, exit 0

- [ ] **Step 3: Verifica che lo script sia inerte senza sentinella**

```bash
rm -f /home/mike/works/geekom-hub/run/archi.wake
/home/mike/works/geekom-hub/scripts/archi-wake.sh
tail -1 ~/.local/share/geekom/archi-wake.log
```
Expected: l'ultima riga contiene `nessuna sentinella, esco`, e archi-pc **non**
viene acceso

- [ ] **Step 4: Scrivi le unità systemd**

Crea `systemd/archi-wake.path`:

```ini
[Unit]
Description=Watch for the gpu-router wake sentinel

[Path]
PathExists=/home/mike/works/geekom-hub/run/archi.wake
Unit=archi-wake.service

[Install]
WantedBy=default.target
```

Crea `systemd/archi-wake.service`:

```ini
[Unit]
Description=Wake archi-pc and start its Ollama service

[Service]
Type=oneshot
ExecStart=/home/mike/works/geekom-hub/scripts/archi-wake.sh
# archi.sh wake waits up to 120s for the box to boot, then archi.sh ollama
# waits for the service. Do not cut it short.
TimeoutStartSec=0
```

- [ ] **Step 5: Installa e attiva le unità**

```bash
mkdir -p ~/.config/systemd/user
cp /home/mike/works/geekom-hub/systemd/archi-wake.path ~/.config/systemd/user/
cp /home/mike/works/geekom-hub/systemd/archi-wake.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now archi-wake.path
systemctl --user status archi-wake.path --no-pager
```
Expected: `Active: active (waiting)`

- [ ] **Step 6: Verifica end-to-end il percorso della sentinella**

```bash
touch /home/mike/works/geekom-hub/run/archi.wake
sleep 5
tail -3 ~/.local/share/geekom/archi-wake.log
ls /home/mike/works/geekom-hub/run/archi.wake 2>&1
```
Expected: il log riporta `sentinella raccolta`, e il file non esiste più
(`No such file or directory`). archi-pc si accende — questo test accende
davvero la macchina, quindi eseguilo quando va bene che si avvii.

- [ ] **Step 7: Commit**

```bash
cd /home/mike/works/geekom-hub
git add scripts/archi-wake.sh systemd/archi-wake.path systemd/archi-wake.service
git commit -m "feat(scripts): pick up the router wake sentinel and start archi-pc

The sentinel is deleted before archi.sh runs, so a failed wake cannot make
the path unit spin on the same file."
```

---

### Task 5: Watchdog del GPU hang

**Files:**
- Create: `/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh`
- Create: `/home/mike/works/geekom-hub/systemd/gpu-hang-watchdog.timer`
- Create: `/home/mike/works/geekom-hub/systemd/gpu-hang-watchdog.service`

**Interfaces:**
- Consumes: i log del container `ollama`, il compose in `/home/mike/works/mneme/deploy`
- Produces: ricreazione del container quando la GPU si appende

- [ ] **Step 1: Scrivi lo script**

Crea `scripts/gpu-hang-watchdog.sh`:

```bash
#!/usr/bin/env bash
# gpu-hang-watchdog.sh — la iGPU gfx11 si appende sotto inferenza vision e
# resta rotta per ogni modello. `docker compose restart` non recupera: solo
# `up -d --force-recreate` lo fa. Verificato sul campo il 2026-08-19.
set -euo pipefail

COMPOSE_DIR="${OLLAMA_COMPOSE_DIR:-/home/mike/works/mneme/deploy}"
STATE_DIR="${HOME}/.local/share/geekom"
LOG="${STATE_DIR}/gpu-watchdog.log"
STAMPS="${STATE_DIR}/gpu-watchdog.recreations"
WINDOW_SECONDS=3600
MAX_RECREATIONS=3
LOOKBACK="${WATCHDOG_LOOKBACK:-3m}"

mkdir -p "$STATE_DIR"
log() { printf '%s %s\n' "$(date -Is)" "$*" >> "$LOG"; }

if ! docker logs ollama --since "$LOOKBACK" 2>&1 | grep -q "GPU Hang"; then
    exit 0
fi

now=$(date +%s)

# Tieni solo le ricreazioni dell'ultima ora.
recent=""
if [ -f "$STAMPS" ]; then
    while read -r ts; do
        [ -z "$ts" ] && continue
        if [ $((now - ts)) -lt "$WINDOW_SECONDS" ]; then
            recent="${recent}${ts}"$'\n'
        fi
    done < "$STAMPS"
fi
printf '%s' "$recent" > "$STAMPS"

# grep -c prints 0 AND exits 1 on no match, so `|| echo 0` would yield "0\n0"
# and blow up the arithmetic below. Assign, then correct on failure.
count=$(grep -c . "$STAMPS" 2>/dev/null) || count=0
if [ "$count" -ge "$MAX_RECREATIONS" ]; then
    log "GPU Hang rilevato ma già $count ricreazioni nell'ultima ora: mi fermo"
    exit 0
fi

log "GPU Hang rilevato, ricreo il container ollama (ricreazione $((count + 1)))"
if (cd "$COMPOSE_DIR" && docker compose up -d --force-recreate ollama) >> "$LOG" 2>&1; then
    printf '%s\n' "$now" >> "$STAMPS"
    log "ricreazione riuscita"
else
    log "ricreazione FALLITA (exit $?)"
fi
```

- [ ] **Step 2: Rendilo eseguibile e verificane la sintassi**

```bash
chmod +x /home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
bash -n /home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
docker run --rm -v /home/mike/works/geekom-hub/scripts:/mnt koalaman/shellcheck:stable /mnt/gpu-hang-watchdog.sh
```
Expected: nessun output, exit 0

- [ ] **Step 3: Verifica che sia inerte senza hang**

```bash
rm -f ~/.local/share/geekom/gpu-watchdog.recreations
/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
echo "exit: $?"
docker ps --format '{{.Names}} {{.Status}}' | grep '^ollama'
```
Expected: exit 0, e l'uptime del container **non** riparte da zero

- [ ] **Step 4: Verifica la guardia anti-loop**

```bash
now=$(date +%s)
printf '%s\n%s\n%s\n' "$now" "$now" "$now" > ~/.local/share/geekom/gpu-watchdog.recreations
WATCHDOG_LOOKBACK=90d /home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
tail -1 ~/.local/share/geekom/gpu-watchdog.log
```
Expected: l'ultima riga contiene `mi fermo`, e il container non viene ricreato.
`WATCHDOG_LOOKBACK=90d` fa sì che lo script trovi gli hang storici nei log senza
doverne provocare uno nuovo.

- [ ] **Step 5: Pulisci lo stato di prova**

```bash
rm -f ~/.local/share/geekom/gpu-watchdog.recreations
```

- [ ] **Step 6: Scrivi le unità systemd**

Crea `systemd/gpu-hang-watchdog.service`:

```ini
[Unit]
Description=Recreate the ollama container after a ROCm GPU hang

[Service]
Type=oneshot
ExecStart=/home/mike/works/geekom-hub/scripts/gpu-hang-watchdog.sh
TimeoutStartSec=300
```

Crea `systemd/gpu-hang-watchdog.timer`:

```ini
[Unit]
Description=Check for ROCm GPU hangs every two minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=2min
AccuracySec=30s

[Install]
WantedBy=timers.target
```

- [ ] **Step 7: Installa e attiva**

```bash
cp /home/mike/works/geekom-hub/systemd/gpu-hang-watchdog.service ~/.config/systemd/user/
cp /home/mike/works/geekom-hub/systemd/gpu-hang-watchdog.timer ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now gpu-hang-watchdog.timer
systemctl --user list-timers gpu-hang-watchdog.timer --no-pager
```
Expected: il timer compare con un `NEXT` entro 2 minuti

- [ ] **Step 8: Commit**

```bash
cd /home/mike/works/geekom-hub
git add scripts/gpu-hang-watchdog.sh systemd/gpu-hang-watchdog.service systemd/gpu-hang-watchdog.timer
git commit -m "feat(scripts): recreate ollama after a ROCm GPU hang

A restart leaves the device hung; only a force-recreate clears it. Capped
at three recreations an hour so a persistent fault cannot become a loop."
```

---

### Task 6: SoundReel tratta il 503 vision come skip pulito

**Files:**
- Modify: `/home/mike/works/Soundreel/backend/src/services/ollamaClient.ts`
- Create: `/home/mike/works/Soundreel/backend/src/services/ollamaClient.test.ts`

**Interfaces:**
- Consumes: il 503 con `error: "vision model not available on local GPU"` del Task 1
- Produces: `VisionUnavailableError` esportata da `ollamaClient.ts`;
  `describeFramesWithVision` continua a restituire `string | null`

- [ ] **Step 1: Scrivi il test che fallisce**

Crea `backend/src/services/ollamaClient.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('ollamaClient', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.OLLAMA_URL = 'http://gpu-router:9000';
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('throws VisionUnavailableError on the router 503 for vision models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'vision model not available on local GPU', model: 'moondream' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    const { generateText, VisionUnavailableError } = await import('./ollamaClient');
    await expect(generateText('x', [{ mimeType: 'image/jpeg', base64: 'AAAA' }]))
      .rejects.toBeInstanceOf(VisionUnavailableError);
  });

  it('throws a plain error on an unrelated 503', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'no healthy backends' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    const { generateText, VisionUnavailableError } = await import('./ollamaClient');
    await expect(generateText('x'))
      .rejects.not.toBeInstanceOf(VisionUnavailableError);
  });

  it('returns null from describeFramesWithVision when vision is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: 'vision model not available on local GPU' }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    )));

    // A real file, not a mocked fs: vi.mock() is hoisted out of the test body
    // and would not apply here anyway.
    const { mkdtemp, writeFile } = await import('fs/promises');
    const { tmpdir } = await import('os');
    const { join } = await import('path');
    const dir = await mkdtemp(join(tmpdir(), 'ollama-test-'));
    const frame = join(dir, 'frame1.jpg');
    await writeFile(frame, Buffer.from([0xff, 0xd8, 0xff]));

    const { describeFramesWithVision } = await import('./ollamaClient');
    await expect(describeFramesWithVision([frame])).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Esegui il test e verifica che fallisca**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/ollamaClient.test.ts`
Expected: FAIL — `VisionUnavailableError` non è esportata

- [ ] **Step 3: Implementa**

In `ollamaClient.ts`, dopo le interfacce esistenti:

```ts
/**
 * The router refuses vision models when the only healthy backend is the local
 * GPU, which hangs under ROCm vision inference. Not a failure: a capability
 * that is not available right now.
 */
export class VisionUnavailableError extends Error {
  constructor(message = 'vision model not available on local GPU') {
    super(message);
    this.name = 'VisionUnavailableError';
  }
}
```

Sostituisci il blocco `if (!response.ok)` dentro `generateText`:

```ts
    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      if (response.status === 503 && errText.includes('vision model not available')) {
        logInfo('Vision non disponibile sul backend locale, salto', { model });
        throw new VisionUnavailableError();
      }
      logError('Ollama HTTP error', { status: response.status, body: errText.substring(0, 500) });
      throw new Error(`Ollama HTTP ${response.status}`);
    }
```

In `describeFramesWithVision`, sostituisci il blocco `catch`:

```ts
  } catch (err) {
    if (err instanceof VisionUnavailableError) {
      logInfo('Vision describe saltata: backend vision non disponibile');
      return null;
    }
    logError('Vision describe failed', err);
    return null;
  }
```

- [ ] **Step 4: Esegui il test e verifica che passi**

Run: `cd /home/mike/works/Soundreel/backend && npx vitest run src/services/ollamaClient.test.ts`
Expected: PASS, 3 test

- [ ] **Step 5: Distingui lo skip nell'actionLog**

`backend/src/routes/analyze.ts:483` registra già un `vision_describe`, ma non
distingue "nessun testo prodotto" da "backend vision non disponibile".
Sostituisci il blocco alle righe 479-487:

```ts
          let visualContext: string | null = null;
          if (featuresConfig.mediaAnalysisEnabled && localPaths?.framePaths.length) {
            const keyFrames = pickKeyFrames(localPaths.framePaths, KEY_FRAMES_COUNT);
            visualContext = await describeFramesWithVision(keyFrames);
            await appendActionLog(entryId, createActionLog('vision_describe', {
              status: visualContext ? 'ok' : 'skipped',
              frames: keyFrames.length,
              chars: visualContext?.length || 0,
              provider: 'ollama-moondream',
            }));
          } else {
```

Lo `status` rende leggibile dal journal quando la vision è stata saltata invece
di aver semplicemente prodotto poco.

- [ ] **Step 6: Esegui typecheck e suite completa**

```bash
cd /home/mike/works/Soundreel/backend
npm run typecheck
npm test
```
Expected: entrambi PASS, nessuna regressione

- [ ] **Step 7: Commit**

```bash
cd /home/mike/works/Soundreel
git add backend/src/services/ollamaClient.ts backend/src/services/ollamaClient.test.ts backend/src/routes/analyze.ts
git commit -m "feat(ollama): treat a refused vision model as a skip, not a failure

The router now returns 503 when vision would land on the local GPU. That is
a capability gap, not an error, so the pipeline logs it and carries on with
caption, OCR and transcript."
```

---

### Task 7: Committa le env di ollama

**Files:**
- Modify: `/home/mike/works/mneme/deploy/docker-compose.yml` (già modificato, non committato)

- [ ] **Step 1: Rileggi la modifica**

```bash
git -C /home/mike/works/mneme diff deploy/docker-compose.yml
```
Expected: `OLLAMA_KEEP_ALIVE` passa da `30m` a `5m`, viene aggiunta
`OLLAMA_MAX_LOADED_MODELS=1`, più un commento. Nessun'altra modifica.

- [ ] **Step 2: Verifica che il container giri con quelle env**

```bash
docker inspect ollama --format '{{range .Config.Env}}{{println .}}{{end}}' | grep -i ollama
```
Expected: compaiono `OLLAMA_MAX_LOADED_MODELS=1` e `OLLAMA_KEEP_ALIVE=5m`

- [ ] **Step 3: Commit**

```bash
cd /home/mike/works/mneme
git add deploy/docker-compose.yml
git commit -m "chore(ollama): cap loaded models and shorten keep-alive

Not a fix for the 500s — those are a ROCm GPU hang under vision inference —
just an end to holding two models resident for half an hour on a host with
very little free memory."
```

---

## Verifica finale della fase

- [ ] **Test unitari verdi in entrambi i repo**

```bash
cd /home/mike/works/geekom-hub/gpu-router && python -m pytest tests/ -v
cd /home/mike/works/Soundreel/backend && npm test
```

- [ ] **Il router rifiuta davvero la vision**

```bash
cd /home/mike/works/geekom-hub/gpu-router && docker compose up -d --build gpu-router
sleep 5
docker run --rm --network web curlimages/curl:latest -s -m 30 \
  http://gpu-router:9000/api/generate \
  -d '{"model":"moondream:latest","prompt":"x","images":[]}'
```
Expected: `{"error":"vision model not available on local GPU","model":"moondream"}`

- [ ] **Il testo continua a funzionare**

```bash
docker run --rm --network web curlimages/curl:latest -s -m 120 -o /dev/null -w "%{http_code}\n" \
  http://gpu-router:9000/api/generate \
  -d '{"model":"qwen2.5:3b","prompt":"Rispondi in italiano: ciao","stream":false}'
```
Expected: `200`

- [ ] **Il modello viene scaricato dopo l'uso**

```bash
sleep 10 && docker exec ollama ollama ps
```
Expected: la lista è vuota, oppure il modello ha un `UNTIL` già scaduto —
`keep_alive: 0` lo scarica subito dopo la risposta

- [ ] **Nessun hang dopo un ciclo di analisi reale**

Manda un reel al bot Telegram, attendi il completamento, poi:

```bash
docker logs ollama --since 10m 2>&1 | grep -c "GPU Hang"
docker logs soundreel --since 10m 2>&1 | grep -c "Ollama HTTP 500"
```
Expected: `0` per entrambi

- [ ] **Il fallback Claude non è più sistematico**

```bash
docker logs soundreel --since 10m 2>&1 | grep -c "Fallback Claude"
```
Expected: **molto meno frequente di un post su uno — non zero.**

Attenzione a non leggere un conteggio diverso da zero come una regressione.
Il fallback non è innescato dall'hang della GPU: scatta ogni volta che
`isEmptyAnalysis(ollamaResult)` è vera, e il commento in `aiAnalysis.ts` lo
dice esplicitamente — «the local model returns nothing at all on a large share
of entries even when handed a full caption + transcript + OCR payload». È una
questione ortogonale alla fase 1. Anzi: rinunciare alla vision sul GPU locale
rende l'estrazione vuota *marginalmente più probabile* sui reel video, perché
il payload perde la descrizione dei frame.

Quello che questa fase deve spostare è il caso in cui Ollama non risponde
affatto (HTTP 500 dopo l'hang), non il caso in cui risponde a vuoto. Il
segnale giusto è quindi il rapporto: prima il fallback partiva su
*praticamente ogni* post, adesso deve restare confinato ai post con poco
testo sorgente.
