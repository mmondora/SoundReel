"""Instaloader sidecar service.

Endpoints:
  GET  /health                    — liveness
  GET  /fetch?url=<ig-url>        — LEGACY: metadata-only extraction (URLs, no local download)
  POST /download {url, entryId}   — NEW: download video+carousel+thumbnail to /data/media/<entryId>/,
                                    extract audio.wav, sample frames, return local paths + metadata.

Session login (for rate-limit friendly requests):
  docker exec -it soundreel-instaloader instaloader -l <username>
Cookies persist in /root/.config/instaloader (volume soundreel_instaloader_session).
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

import instaloader
import requests
from flask import Flask, jsonify, request

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("instaloader-sidecar")

SHORTCODE_RE = re.compile(r"instagram\.com/(?:reel|p|tv)/([A-Za-z0-9_-]+)")
MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "/data/media"))
FRAME_INTERVAL_SECONDS = int(os.environ.get("FRAME_INTERVAL_SECONDS", "2"))
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "15"))
DOWNLOAD_TIMEOUT = int(os.environ.get("DOWNLOAD_TIMEOUT_SECONDS", "60"))

app = Flask(__name__)

_loader: Optional[instaloader.Instaloader] = None


def get_loader() -> instaloader.Instaloader:
    global _loader
    if _loader is not None:
        return _loader
    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )
    username = os.environ.get("INSTALOADER_USERNAME")
    if username:
        try:
            loader.load_session_from_file(username)
            log.info("Session loaded for %s", username)
        except FileNotFoundError:
            log.warning("No saved session for %s — anonymous mode", username)
        except Exception as exc:
            log.error("Failed loading session for %s: %s", username, exc)
    else:
        log.info("INSTALOADER_USERNAME not set — anonymous mode")
    _loader = loader
    return loader


def extract_shortcode(url: str) -> Optional[str]:
    m = SHORTCODE_RE.search(url)
    return m.group(1) if m else None


def extract_music_info(post: instaloader.Post) -> Optional[dict]:
    try:
        raw = getattr(post, "_node", None) or {}
        # Primary location for Reels music metadata
        music = raw.get("clips_music_attribution_info") or {}
        title = music.get("song_name") or music.get("title")
        artist = music.get("artist_name") or music.get("display_artist")
        if title and artist:
            return {"title": title, "artist": artist}
    except Exception as exc:
        log.debug("music_info extract failed: %s", exc)
    return None


def post_to_fetch_dict(post: instaloader.Post) -> dict[str, Any]:
    """Legacy shape for /fetch — URLs only, no download."""
    caption = post.caption or None
    thumbnail_url = post.url
    video_url = post.video_url if post.is_video else None

    carousel_urls: list[str] = []
    try:
        if post.typename == "GraphSidecar":
            for node in post.get_sidecar_nodes():
                if node.display_url:
                    carousel_urls.append(node.display_url)
    except Exception as exc:
        log.warning("sidecar iteration failed: %s", exc)

    return {
        "caption": caption,
        "thumbnailUrl": thumbnail_url,
        "videoUrl": video_url,
        "musicInfo": extract_music_info(post),
        "carouselUrls": carousel_urls,
        "success": True,
    }


def download_file(url: str, dest: Path, timeout: int = DOWNLOAD_TIMEOUT) -> bool:
    try:
        with requests.get(url, stream=True, timeout=timeout) as r:
            r.raise_for_status()
            with open(dest, "wb") as f:
                for chunk in r.iter_content(chunk_size=65536):
                    if chunk:
                        f.write(chunk)
        return True
    except Exception as exc:
        log.error("Download failed %s -> %s: %s", url, dest, exc)
        return False


def ffmpeg_extract_audio(video_path: Path, audio_path: Path) -> bool:
    try:
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(video_path),
                "-vn", "-ac", "1", "-ar", "16000",
                str(audio_path),
            ],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            log.warning("ffmpeg audio extract failed: %s", result.stderr.strip())
            return False
        return audio_path.exists()
    except Exception as exc:
        log.error("ffmpeg audio extract exception: %s", exc)
        return False


def ffmpeg_sample_frames(video_path: Path, out_dir: Path) -> list[str]:
    """Sample one frame every FRAME_INTERVAL_SECONDS, cap at MAX_FRAMES."""
    try:
        pattern = str(out_dir / "frame-%03d.jpg")
        result = subprocess.run(
            [
                "ffmpeg", "-y", "-loglevel", "error",
                "-i", str(video_path),
                "-vf", f"fps=1/{FRAME_INTERVAL_SECONDS}",
                "-frames:v", str(MAX_FRAMES),
                "-q:v", "3",
                pattern,
            ],
            capture_output=True, text=True, timeout=120,
        )
        if result.returncode != 0:
            log.warning("ffmpeg frame sample failed: %s", result.stderr.strip())
            return []
        frames = sorted(str(p) for p in out_dir.glob("frame-*.jpg"))
        return frames
    except Exception as exc:
        log.error("ffmpeg frame sample exception: %s", exc)
        return []


def download_post(post: instaloader.Post, entry_id: str) -> dict[str, Any]:
    entry_dir = MEDIA_ROOT / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)

    result: dict[str, Any] = {
        "caption": post.caption or None,
        "musicInfo": extract_music_info(post),
        "videoPath": None,
        "audioPath": None,
        "thumbnailPath": None,
        "slidePaths": [],
        "framePaths": [],
        "success": True,
    }

    # Thumbnail (post.url = display URL = cover/first-frame)
    thumb_path = entry_dir / "thumbnail.jpg"
    if post.url and download_file(post.url, thumb_path):
        result["thumbnailPath"] = str(thumb_path)
    else:
        log.warning("thumbnail download failed for %s", post.shortcode)

    # Video + audio + frames (if video)
    if post.is_video and post.video_url:
        video_path = entry_dir / "video.mp4"
        if download_file(post.video_url, video_path):
            result["videoPath"] = str(video_path)

            audio_path = entry_dir / "audio.wav"
            if ffmpeg_extract_audio(video_path, audio_path):
                result["audioPath"] = str(audio_path)

            frames = ffmpeg_sample_frames(video_path, entry_dir)
            result["framePaths"] = frames
        else:
            log.warning("video download failed for %s", post.shortcode)

    # Carousel slides
    if post.typename == "GraphSidecar":
        try:
            idx = 0
            for node in post.get_sidecar_nodes():
                idx += 1
                if node.is_video:
                    # Skip video slides for now (carousels can mix, rare)
                    continue
                slide_url = node.display_url
                if not slide_url:
                    continue
                slide_path = entry_dir / f"slide-{idx:03d}.jpg"
                if download_file(slide_url, slide_path):
                    result["slidePaths"].append(str(slide_path))
        except Exception as exc:
            log.warning("carousel iteration failed: %s", exc)

    return result


@app.get("/health")
def health() -> Any:
    return {"ok": True, "mediaRoot": str(MEDIA_ROOT)}


@app.get("/fetch")
def fetch() -> Any:
    """LEGACY: metadata + URLs only, no local download."""
    url = request.args.get("url", "").strip()
    if not url:
        return jsonify({"error": "url query param required", "success": False}), 400

    shortcode = extract_shortcode(url)
    if not shortcode:
        return jsonify({"error": "unable to extract shortcode", "success": False}), 400

    loader = get_loader()
    try:
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
    except instaloader.exceptions.LoginRequiredException:
        log.warning("login required for %s", shortcode)
        return jsonify({"error": "login required", "success": False}), 403
    except instaloader.exceptions.QueryReturnedNotFoundException:
        log.warning("post not found: %s", shortcode)
        return jsonify({"error": "not found", "success": False}), 404
    except Exception as exc:
        log.error("instaloader error for %s: %s", shortcode, exc, exc_info=True)
        return jsonify({"error": str(exc), "success": False}), 500

    return jsonify(post_to_fetch_dict(post))


@app.post("/download")
def download() -> Any:
    """NEW: full local download pipeline. Body: {url, entryId}."""
    payload = request.get_json(silent=True) or {}
    url = (payload.get("url") or "").strip()
    entry_id = (payload.get("entryId") or "").strip()

    if not url:
        return jsonify({"error": "url required", "success": False}), 400
    if not entry_id:
        return jsonify({"error": "entryId required", "success": False}), 400
    if not re.match(r"^[A-Za-z0-9_-]+$", entry_id):
        return jsonify({"error": "entryId invalid", "success": False}), 400

    shortcode = extract_shortcode(url)
    if not shortcode:
        return jsonify({"error": "unable to extract shortcode", "success": False}), 400

    loader = get_loader()
    try:
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
    except instaloader.exceptions.LoginRequiredException:
        log.warning("login required for %s", shortcode)
        return jsonify({"error": "login required", "success": False}), 403
    except instaloader.exceptions.QueryReturnedNotFoundException:
        log.warning("post not found: %s", shortcode)
        return jsonify({"error": "not found", "success": False}), 404
    except Exception as exc:
        log.error("instaloader error for %s: %s", shortcode, exc, exc_info=True)
        return jsonify({"error": str(exc), "success": False}), 500

    try:
        result = download_post(post, entry_id)
    except Exception as exc:
        log.error("download_post failed for %s: %s", shortcode, exc, exc_info=True)
        # Cleanup partial download
        shutil.rmtree(MEDIA_ROOT / entry_id, ignore_errors=True)
        return jsonify({"error": str(exc), "success": False}), 500

    log.info(
        "download ok entryId=%s video=%s audio=%s frames=%d slides=%d music=%s",
        entry_id,
        bool(result.get("videoPath")),
        bool(result.get("audioPath")),
        len(result.get("framePaths", [])),
        len(result.get("slidePaths", [])),
        bool(result.get("musicInfo")),
    )
    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "0.0.0.0")
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    log.info("Starting on %s:%d (MEDIA_ROOT=%s)", host, port, MEDIA_ROOT)
    app.run(host=host, port=port, threaded=True)
