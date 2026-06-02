"""Instaloader sidecar service.

Endpoints:
  GET  /health                    — liveness
  GET  /fetch?url=<ig-url>        — LEGACY: metadata via Instaloader GraphQL
  POST /download {url, entryId}   — NEW: full local download pipeline:
                                     1) iPhone private API for metadata
                                        (i.instagram.com/api/v1/media/{id}/info/)
                                     2) Instaloader GraphQL as fallback
                                     3) ffmpeg for audio + frame sampling

Session login (for both endpoints):
  docker exec -it soundreel-instaloader instaloader -l <username>
  # Completes interactive login, stores cookie in /root/.config/instaloader.
Volume soundreel_instaloader_session keeps the cookie across restarts.
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
import asyncio
import tempfile

from flask import Flask, jsonify, request
from shazamio import Shazam

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("instaloader-sidecar")

SHORTCODE_RE = re.compile(r"instagram\.com/(?:reel|p|tv)/([A-Za-z0-9_-]+)")
SHORTCODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"

MEDIA_ROOT = Path(os.environ.get("MEDIA_ROOT", "/data/media"))
FRAME_INTERVAL_SECONDS = int(os.environ.get("FRAME_INTERVAL_SECONDS", "2"))
MAX_FRAMES = int(os.environ.get("MAX_FRAMES", "15"))
DOWNLOAD_TIMEOUT = int(os.environ.get("DOWNLOAD_TIMEOUT_SECONDS", "60"))

IG_APP_ID = "936619743392459"
IG_USER_AGENT = (
    "Instagram 275.0.0.27.98 Android "
    "(33/13; 440dpi; 1080x2400; samsung; SM-G991B; o1s; exynos2100)"
)

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
        iphone_support=True,
        user_agent=IG_USER_AGENT,
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


def shortcode_to_media_id(shortcode: str) -> str:
    """Convert Instagram shortcode to numeric media ID (base64 custom alphabet)."""
    n = 0
    for char in shortcode:
        n = n * 64 + SHORTCODE_ALPHABET.index(char)
    return str(n)


def _session_from_loader(loader: instaloader.Instaloader) -> requests.Session:
    """Return the requests.Session backing Instaloader so we share cookies/session."""
    # Instaloader stores session on loader.context._session
    sess: requests.Session = loader.context._session  # type: ignore[attr-defined]
    return sess


def fetch_via_iphone_api(shortcode: str, loader: instaloader.Instaloader) -> Optional[dict[str, Any]]:
    """Try the iPhone private API first — more resilient to challenge flags."""
    media_id = shortcode_to_media_id(shortcode)
    url = f"https://i.instagram.com/api/v1/media/{media_id}/info/"
    sess = _session_from_loader(loader)

    # CSRF token pulled from cookies (name varies: csrftoken)
    csrf = sess.cookies.get("csrftoken", "")

    headers = {
        "User-Agent": IG_USER_AGENT,
        "X-IG-App-ID": IG_APP_ID,
        "X-CSRFToken": csrf,
        "Accept": "*/*",
        "Accept-Language": "en-US,en;q=0.9",
    }

    try:
        r = sess.get(url, headers=headers, timeout=30)
    except Exception as exc:
        log.warning("iPhone API network error for %s: %s", shortcode, exc)
        return None

    if r.status_code != 200:
        log.warning("iPhone API returned HTTP %d for %s: %s", r.status_code, shortcode, r.text[:200])
        return None

    try:
        data = r.json()
    except Exception as exc:
        log.warning("iPhone API JSON parse error for %s: %s", shortcode, exc)
        return None

    items = data.get("items") or []
    if not items:
        log.warning("iPhone API: no items for %s", shortcode)
        return None

    return items[0]


def extract_music_info_iphone(item: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Extract music info from iPhone API item."""
    clips = item.get("clips_metadata") or {}
    music = (clips.get("music_info") or {}).get("music_asset_info") or {}
    title = music.get("title")
    artist = music.get("display_artist")
    if title and artist:
        return {"title": title, "artist": artist}

    alt = (item.get("music_metadata") or {}).get("music_info", {}).get("music_asset_info") or {}
    title = alt.get("title")
    artist = alt.get("display_artist")
    if title and artist:
        return {"title": title, "artist": artist}

    return None


def extract_music_info_graphql(post: instaloader.Post) -> Optional[dict[str, Any]]:
    try:
        raw = getattr(post, "_node", None) or {}
        music = raw.get("clips_music_attribution_info") or {}
        title = music.get("song_name") or music.get("title")
        artist = music.get("artist_name") or music.get("display_artist")
        if title and artist:
            return {"title": title, "artist": artist}
    except Exception as exc:
        log.debug("music_info extract failed: %s", exc)
    return None


def post_to_fetch_dict(post: instaloader.Post) -> dict[str, Any]:
    """Legacy shape for /fetch — URLs only."""
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
        "musicInfo": extract_music_info_graphql(post),
        "carouselUrls": carousel_urls,
        "success": True,
    }


CDN_BROWSER_UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)


def download_file(url: str, dest: Path, session: Optional[requests.Session] = None,
                  timeout: int = DOWNLOAD_TIMEOUT) -> bool:
    """Download URL to file.

    IG CDN (scontent-*.cdninstagram.com) rejects the Instagram-Android user-agent
    with HTTP 404. Use a browser UA + plain requests (signed URLs don't need our
    login session anyway — the signature is already in the URL).
    """
    try:
        with requests.get(url, stream=True, timeout=timeout,
                          headers={"User-Agent": CDN_BROWSER_UA}) as r:
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


def download_from_iphone_item(item: dict[str, Any], entry_id: str,
                              session: requests.Session) -> dict[str, Any]:
    """Download all media from an iPhone-API item dict into MEDIA_ROOT/<entry_id>/."""
    entry_dir = MEDIA_ROOT / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    # World-writable so backend (uid=node) can create additional files here
    # (e.g. thumbnail.jpg resized by sharp). Risk: container-local only.
    os.chmod(entry_dir, 0o777)

    caption_text = ((item.get("caption") or {}).get("text")) or None
    result: dict[str, Any] = {
        "caption": caption_text,
        "musicInfo": extract_music_info_iphone(item),
        "videoPath": None,
        "audioPath": None,
        "thumbnailPath": None,
        "slidePaths": [],
        "framePaths": [],
        "success": True,
        "source": "iphone_api",
    }

    # Thumbnail — prefer first image_versions2 candidate (highest quality).
    # Saved as thumbnail-source.jpg; backend resizes it to thumbnail.jpg (320px)
    # to avoid permission conflict on overwrite (backend runs as node, we as root).
    candidates = ((item.get("image_versions2") or {}).get("candidates")) or []
    thumb_url = candidates[0].get("url") if candidates else None
    if thumb_url:
        thumb_path = entry_dir / "thumbnail-source.jpg"
        if download_file(thumb_url, thumb_path, session=session):
            os.chmod(thumb_path, 0o644)
            result["thumbnailPath"] = str(thumb_path)

    # Video (single-post video/reel)
    video_versions = item.get("video_versions") or []
    if video_versions:
        video_url = video_versions[0].get("url")
        if video_url:
            video_path = entry_dir / "video.mp4"
            if download_file(video_url, video_path, session=session):
                result["videoPath"] = str(video_path)

                audio_path = entry_dir / "audio.wav"
                if ffmpeg_extract_audio(video_path, audio_path):
                    result["audioPath"] = str(audio_path)

                result["framePaths"] = ffmpeg_sample_frames(video_path, entry_dir)

    # Carousel
    carousel = item.get("carousel_media") or []
    if carousel:
        idx = 0
        for slide in carousel:
            idx += 1
            if slide.get("video_versions"):
                # carousel videos are rare — skip for simplicity (audio/frames handled
                # only for primary video of reels)
                continue
            slide_candidates = ((slide.get("image_versions2") or {}).get("candidates")) or []
            if not slide_candidates:
                continue
            slide_url = slide_candidates[0].get("url")
            if not slide_url:
                continue
            slide_path = entry_dir / f"slide-{idx:03d}.jpg"
            if download_file(slide_url, slide_path, session=session):
                result["slidePaths"].append(str(slide_path))

    return result


def download_from_graphql_post(post: instaloader.Post, entry_id: str) -> dict[str, Any]:
    """Fallback: download via Instaloader Post object (original behaviour)."""
    entry_dir = MEDIA_ROOT / entry_id
    entry_dir.mkdir(parents=True, exist_ok=True)
    os.chmod(entry_dir, 0o777)

    result: dict[str, Any] = {
        "caption": post.caption or None,
        "musicInfo": extract_music_info_graphql(post),
        "videoPath": None,
        "audioPath": None,
        "thumbnailPath": None,
        "slidePaths": [],
        "framePaths": [],
        "success": True,
        "source": "graphql",
    }

    thumb_path = entry_dir / "thumbnail-source.jpg"
    if post.url and download_file(post.url, thumb_path):
        result["thumbnailPath"] = str(thumb_path)

    if post.is_video and post.video_url:
        video_path = entry_dir / "video.mp4"
        if download_file(post.video_url, video_path):
            result["videoPath"] = str(video_path)
            audio_path = entry_dir / "audio.wav"
            if ffmpeg_extract_audio(video_path, audio_path):
                result["audioPath"] = str(audio_path)
            result["framePaths"] = ffmpeg_sample_frames(video_path, entry_dir)

    if post.typename == "GraphSidecar":
        try:
            idx = 0
            for node in post.get_sidecar_nodes():
                idx += 1
                if node.is_video:
                    continue
                if not node.display_url:
                    continue
                slide_path = entry_dir / f"slide-{idx:03d}.jpg"
                if download_file(node.display_url, slide_path):
                    result["slidePaths"].append(str(slide_path))
        except Exception as exc:
            log.warning("carousel iteration failed: %s", exc)

    return result


@app.get("/health")
def health() -> Any:
    return {"ok": True, "mediaRoot": str(MEDIA_ROOT)}


@app.get("/fetch")
def fetch() -> Any:
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
        return jsonify({"error": "login required", "success": False}), 403
    except instaloader.exceptions.QueryReturnedNotFoundException:
        return jsonify({"error": "not found", "success": False}), 404
    except Exception as exc:
        log.error("instaloader error for %s: %s", shortcode, exc)
        return jsonify({"error": str(exc), "success": False}), 500

    return jsonify(post_to_fetch_dict(post))


@app.post("/download")
def download() -> Any:
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
    session = _session_from_loader(loader)

    # Strategy 1: iPhone private API (preferred — more resilient to challenges)
    iphone_item = fetch_via_iphone_api(shortcode, loader)
    if iphone_item is not None:
        try:
            result = download_from_iphone_item(iphone_item, entry_id, session)
            log.info(
                "download via iphone_api entryId=%s video=%s audio=%s frames=%d slides=%d music=%s",
                entry_id,
                bool(result.get("videoPath")),
                bool(result.get("audioPath")),
                len(result.get("framePaths", [])),
                len(result.get("slidePaths", [])),
                bool(result.get("musicInfo")),
            )
            return jsonify(result)
        except Exception as exc:
            log.error("iphone download pipeline failed for %s: %s", shortcode, exc, exc_info=True)
            shutil.rmtree(MEDIA_ROOT / entry_id, ignore_errors=True)
            # Don't return yet — try GraphQL fallback

    # Strategy 2: Instaloader GraphQL (legacy path, may hit challenge_required)
    try:
        post = instaloader.Post.from_shortcode(loader.context, shortcode)
    except instaloader.exceptions.LoginRequiredException:
        return jsonify({"error": "login required; seed session via `instaloader -l <user>`", "success": False}), 403
    except instaloader.exceptions.QueryReturnedNotFoundException:
        return jsonify({"error": "not found", "success": False}), 404
    except Exception as exc:
        log.error("graphql fallback failed for %s: %s", shortcode, exc)
        return jsonify({"error": f"both iphone_api and graphql failed: {exc}", "success": False}), 500

    try:
        result = download_from_graphql_post(post, entry_id)
    except Exception as exc:
        log.error("graphql download pipeline failed for %s: %s", shortcode, exc, exc_info=True)
        shutil.rmtree(MEDIA_ROOT / entry_id, ignore_errors=True)
        return jsonify({"error": str(exc), "success": False}), 500

    log.info(
        "download via graphql entryId=%s video=%s audio=%s frames=%d slides=%d music=%s",
        entry_id,
        bool(result.get("videoPath")),
        bool(result.get("audioPath")),
        len(result.get("framePaths", [])),
        len(result.get("slidePaths", [])),
        bool(result.get("musicInfo")),
    )
    return jsonify(result)


# ---------------------------------------------------------------------------
# Shazam helpers
# ---------------------------------------------------------------------------

def _shazam_recognize(audio_path: str) -> dict | None:
    """Run Shazam fingerprint on a local audio file. Returns track dict or None."""
    async def _run():
        shazam = Shazam()
        return await shazam.recognize(audio_path)

    try:
        result = asyncio.run(_run())
    except Exception as exc:
        log.warning("shazam recognize error: %s", exc)
        return None

    track = result.get("track")
    if not track:
        return None

    title = track.get("title", "")
    artist = track.get("subtitle", "")  # Shazam uses 'subtitle' for artist

    # Extract Spotify URI from hub providers
    spotify_url: str | None = None
    hub = track.get("hub", {})
    for provider in hub.get("providers", []):
        caption = (provider.get("caption") or "").lower()
        if "spotify" in caption:
            for action in provider.get("actions", []):
                uri = action.get("uri", "")
                if uri.startswith("spotify:track:"):
                    spotify_url = f"https://open.spotify.com/track/{uri.split(':')[-1]}"
                    break
        if spotify_url:
            break

    return {
        "title": title,
        "artist": artist,
        "spotifyUrl": spotify_url,
        "youtubeUrl": None,  # resolved separately via /yt/url
    }


@app.route("/shazam/recognize", methods=["POST"])
def shazam_recognize():
    """Fingerprint a single local audio file with Shazam.

    Request JSON: {"audioPath": "/data/media/<entryId>/audio.wav"}
    Response: {"title": ..., "artist": ..., "spotifyUrl": ..., "youtubeUrl": null}
              or null body with 204 if not recognized.
    """
    data = request.get_json(silent=True) or {}
    audio_path = data.get("audioPath")
    if not audio_path or not Path(audio_path).is_file():
        return jsonify({"error": "audioPath missing or not found"}), 400

    log.info("shazam/recognize path=%s", audio_path)
    track = _shazam_recognize(audio_path)
    if not track:
        return "", 204

    log.info("shazam recognized title=%s artist=%s", track["title"], track["artist"])
    return jsonify(track)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "5000"))
    host = os.environ.get("HOST", "0.0.0.0")
    MEDIA_ROOT.mkdir(parents=True, exist_ok=True)
    log.info("Starting on %s:%d (MEDIA_ROOT=%s)", host, port, MEDIA_ROOT)
    app.run(host=host, port=port, threaded=True)
