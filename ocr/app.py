"""OCR sidecar service (Tesseract).

Endpoints:
  GET  /health           — liveness
  POST /ocr              — body: {paths: [string], lang?: string}
                           reads files from filesystem (volume-mounted), runs Tesseract,
                           returns {results: [{path, text, error?}], merged}

Paths must be absolute and readable inside the container.
Typical invocation: paths point into /data/media/<entryId>/.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from flask import Flask, jsonify, request
from PIL import Image
import pytesseract

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("ocr-sidecar")

DEFAULT_LANG = os.environ.get("OCR_LANG", "ita+eng")
MEDIA_ROOT = os.environ.get("MEDIA_ROOT", "/data/media")
MIN_TEXT_LEN = int(os.environ.get("OCR_MIN_TEXT_LEN", "5"))

app = Flask(__name__)


def _ocr_file(path: str, lang: str) -> dict[str, Any]:
    if not os.path.isabs(path):
        return {"path": path, "text": None, "error": "path not absolute"}
    # Safety: constrain to MEDIA_ROOT
    resolved = os.path.realpath(path)
    if not resolved.startswith(os.path.realpath(MEDIA_ROOT) + os.sep):
        return {"path": path, "text": None, "error": "path outside MEDIA_ROOT"}
    if not os.path.isfile(resolved):
        return {"path": path, "text": None, "error": "not found"}
    try:
        with Image.open(resolved) as img:
            raw = pytesseract.image_to_string(img, lang=lang)
        text = raw.strip()
        if len(text) < MIN_TEXT_LEN:
            return {"path": path, "text": None}
        return {"path": path, "text": text}
    except Exception as exc:
        log.warning("OCR failed on %s: %s", resolved, exc)
        return {"path": path, "text": None, "error": str(exc)}


def _dedupe_lines(text_blocks: list[str]) -> str:
    """Dedupe identical lines across frames (overlay text often repeats)."""
    seen: set[str] = set()
    out: list[str] = []
    for block in text_blocks:
        for line in block.splitlines():
            line = line.strip()
            if not line or line in seen:
                continue
            seen.add(line)
            out.append(line)
    return "\n".join(out)


@app.get("/health")
def health() -> Any:
    return {"ok": True, "mediaRoot": MEDIA_ROOT, "defaultLang": DEFAULT_LANG}


@app.post("/ocr")
def ocr() -> Any:
    payload = request.get_json(silent=True) or {}
    paths = payload.get("paths") or []
    lang = (payload.get("lang") or DEFAULT_LANG).strip()

    if not isinstance(paths, list):
        return jsonify({"error": "paths must be a list", "success": False}), 400
    if not paths:
        return jsonify({"results": [], "merged": "", "success": True})

    results = [_ocr_file(p, lang) for p in paths]
    merged = _dedupe_lines([r["text"] for r in results if r.get("text")])

    log.info(
        "ocr batch: %d paths, %d with text, merged=%d chars, lang=%s",
        len(paths),
        sum(1 for r in results if r.get("text")),
        len(merged),
        lang,
    )
    return jsonify({"results": results, "merged": merged, "success": True})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5001"))
    host = os.environ.get("HOST", "0.0.0.0")
    log.info("Starting on %s:%d (MEDIA_ROOT=%s, lang=%s)", host, port, MEDIA_ROOT, DEFAULT_LANG)
    app.run(host=host, port=port, threaded=True)
