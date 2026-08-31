"""Sottotitoli di YouTube come trascrizione, quando ci sono.

Whisper resta il ripiego, non il contrario: una traccia gia' scritta e'
immediata, gratis, e soprattutto non tocca la GPU — che su questa macchina si
appende (`HW Exception ... reason :GPU Hang`) e trascina giu' l'intero pool di
ollama per le richieste successive.

Nessuna dipendenza da Flask o da yt-dlp qui dentro: il download vero e'
iniettato come callable, cosi' la logica che puo' sbagliare — quale traccia si
sceglie, come si spoglia il VTT — si prova senza rete.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any, Callable

log = logging.getLogger(__name__)

# Traccia scelta: (codice lingua, "manual" | "auto")
Track = tuple[str, str]


def _primary(lang: str | None) -> str | None:
    """`it-IT` e `it` sono la stessa lingua. YouTube marca l'originale in un
    modo o nell'altro a seconda del video."""
    if not lang:
        return None
    return lang.split("-")[0].lower()


def _find_lang(tracks: dict[str, Any], lang: str | None) -> str | None:
    """La chiave che corrisponde a questa lingua, variante regionale inclusa."""
    want = _primary(lang)
    if not want:
        return None
    for key in sorted(tracks):
        if _primary(key) == want:
            return key
    return None


def pick_subtitle_track(info: dict[str, Any]) -> Track | None:
    """Quale traccia vale la pena scaricare, o None.

    L'ordine e' per qualita' della fonte, non per comodita':

    1. manuale nella lingua del video — scritta da una persona;
    2. manuale in un'altra lingua — comunque scritta per QUESTO video;
    3. automatica nella lingua del video — macchina, ma sull'audio originale.

    Quello che non si prende mai e' un'automatica in una lingua diversa
    dall'originale. YouTube le offre in circa duecento lingue, e sono
    auto-traduzioni della trascrizione automatica: due passaggi a macchina in
    fila. Meglio Whisper sull'audio vero che una traduzione di una
    trascrizione.

    Per lo stesso motivo, se la lingua del video e' ignota le automatiche si
    lasciano stare del tutto: senza sapere qual e' l'originale, sceglierne una
    significa prendere a caso fra le traduzioni.
    """
    subs = info.get("subtitles") or {}
    autos = info.get("automatic_captions") or {}
    lang = info.get("language")

    key = _find_lang(subs, lang)
    if key:
        return (key, "manual")

    if subs:
        return (sorted(subs)[0], "manual")

    key = _find_lang(autos, lang)
    if key:
        return (key, "auto")

    return None


_TAG = re.compile(r"<[^>]*>")
_CUE_SETTINGS = re.compile(r"\s+(align|position|size|line|vertical|region):\S+")


def _cue_lines(vtt: str) -> list[str]:
    """Le sole righe di testo, senza intestazione, tempi, numeri e marcatori."""
    out: list[str] = []
    for raw in vtt.splitlines():
        line = raw.strip()
        if not line:
            continue
        if line.startswith("WEBVTT") or line.startswith("NOTE"):
            continue
        # Intestazioni `Kind: captions`, `Language: it`
        if re.match(r"^[A-Z][A-Za-z]*:\s", line):
            continue
        if "-->" in line:
            continue
        # Numero di battuta su riga propria
        if line.isdigit():
            continue
        line = _TAG.sub("", line)
        line = _CUE_SETTINGS.sub("", line)
        line = line.strip()
        if line:
            out.append(line)
    return out


def vtt_to_text(vtt: str | None) -> str | None:
    """Il VTT ridotto a prosa, o None se non c'e' nulla da leggere.

    Le didascalie automatiche ripetono la coda della battuta precedente a ogni
    nuova battuta, per dare l'effetto di scorrimento sullo schermo. Preso alla
    lettera il testo esce lungo il triplo e illeggibile, quindi la
    sovrapposizione si toglie: di ogni battuta si tiene solo la parte che non
    era gia' stata detta. Il confronto e' per parole intere e non per
    caratteri, o `di` in fondo a una battuta si incollerebbe a `dicembre`
    all'inizio della successiva.
    """
    if not vtt:
        return None

    acc: list[str] = []
    for cue in _cue_lines(vtt):
        words = cue.split()
        if not words:
            continue
        massimo = min(len(acc), len(words))
        salto = 0
        for k in range(massimo, 0, -1):
            if acc[-k:] == words[:k]:
                salto = k
                break
        acc.extend(words[salto:])

    testo = " ".join(acc).strip()
    return testo or None


def fetch_subtitle_text(
    info: dict[str, Any],
    dest_dir: Path,
    runner: Callable[[str, str, Path], Path | None],
) -> dict[str, Any] | None:
    """Scarica la traccia migliore e restituiscila come testo, o None.

    `runner(lang, kind, dest_dir)` fa il download vero e restituisce il file
    scritto. Qualunque cosa vada storta qui vale None e basta: un sottotitolo
    mancato non deve far fallire il download del video, si prosegue verso
    Whisper come se la traccia non ci fosse mai stata.
    """
    track = pick_subtitle_track(info)
    if track is None:
        return None
    lang, kind = track

    try:
        path = runner(lang, kind, dest_dir)
    except Exception as exc:
        log.warning("sottotitoli %s/%s non scaricati: %s", lang, kind, exc)
        return None

    if not path:
        return None
    path = Path(path)
    if not path.exists():
        return None

    try:
        testo = vtt_to_text(path.read_text(encoding="utf-8", errors="replace"))
    except Exception as exc:
        log.warning("sottotitoli %s illeggibili: %s", path, exc)
        return None

    if not testo:
        return None
    return {"text": testo, "lang": lang, "kind": kind}
