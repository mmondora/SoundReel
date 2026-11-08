"""Find the audio of a song on YouTube and download it as a tagged MP3.

Used by POST /yt/audio (see app.py). Everything that decides *which* video is the song lives
here as plain functions, so it is testable without network, yt-dlp or ffmpeg: the commands run
through an injected `run`.

Flow: search (ytsearch5) -> score the candidates -> download audio (yt-dlp -x, mp3 192k) ->
tag with our own metadata and cover (ffmpeg, no extra dependency) -> hand the file over in a
staging folder. The backend then moves it into the music library.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
import subprocess
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional
from urllib.parse import parse_qs, urlparse

log = logging.getLogger("instaloader-sidecar")

# Longer than this is a mix / concert / podcast, not a song.
MAX_DURATION_S = int(os.environ.get("YT_AUDIO_MAX_DURATION_SECONDS", "900"))
MIN_DURATION_S = 40
# Below this the best candidate is probably not the song: better "no source" than a wrong track.
MIN_SCORE = 6.0
SEARCH_RESULTS = 5
SEARCH_TIMEOUT_S = 45
DOWNLOAD_TIMEOUT_S = int(os.environ.get("YT_AUDIO_TIMEOUT_SECONDS", "150"))
COVER_MAX_BYTES = 5 * 1024 * 1024

# Same player-client workaround as the video download: the default client hits HTTP 403 (yt-dlp#12482).
EXTRACTOR_ARGS = "youtube:player_client=android,default"
COOKIES_FILE = os.environ.get("YTDLP_COOKIES", "/root/.config/yt-dlp/cookies.txt")

YOUTUBE_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"}
VIDEO_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
BASENAME_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")

# Versions of a song that are almost never what a playlist wants.
BAD_MARKERS = (
    "live", "cover", "karaoke", "instrumental", "remix", "slowed", "sped up", "speed up", "reverb", "8d",
    "nightcore", "tribute", "mashup", "bootleg", "reaction", "tutorial", "lesson", "acoustic", "demo",
    "version for", "ringtone",
)
STOP_WORDS = {"the", "a", "an", "and", "feat", "ft", "featuring", "with", "official", "video", "audio", "lyrics",
              "lyric", "hd", "hq", "music", "remastered", "remaster"}


# ---------------------------------------------------------------------------
# Text helpers
# ---------------------------------------------------------------------------

def normalize(text: str) -> str:
    """Lowercase, no accents, no punctuation, single spaces."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    ascii_only = "".join(c for c in decomposed if not unicodedata.combining(c))
    spaced = ascii_only.lower().replace("&", " and ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", spaced)).strip()


def tokens(text: str) -> list[str]:
    toks = normalize(text).split()
    significant = [t for t in toks if t not in STOP_WORDS]
    return significant or toks


def _has_marker(haystack_norm: str, marker: str) -> bool:
    return re.search(rf"(?:^| ){re.escape(marker)}(?: |$)", haystack_norm) is not None


# ---------------------------------------------------------------------------
# Choosing the video
# ---------------------------------------------------------------------------

@dataclass
class Pick:
    entry: dict[str, Any]
    score: float
    reasons: list[str] = field(default_factory=list)


def score_candidate(
    entry: dict[str, Any],
    artist: str,
    title: str,
    expected_duration: Optional[int],
    rank: int,
) -> Optional[Pick]:
    """Score one search result; None = not acceptable at all (live, too short/long, no id)."""
    vid = entry.get("id")
    duration = entry.get("duration")
    if not vid or not VIDEO_ID_RE.match(str(vid)):
        return None
    if entry.get("live_status") in ("is_live", "is_upcoming", "post_live"):
        return None
    if not isinstance(duration, (int, float)) or duration < MIN_DURATION_S or duration > MAX_DURATION_S:
        return None

    video_title = str(entry.get("title") or "")
    channel = str(entry.get("channel") or entry.get("uploader") or "")
    seen = normalize(f"{video_title} {channel} {entry.get('uploader') or ''}")
    title_norm = normalize(title)
    artist_norm = normalize(artist)
    channel_norm = normalize(channel)
    reasons: list[str] = []
    score = 0.0

    title_toks = tokens(title)
    missing = [t for t in title_toks if t not in seen.split()]
    if title_toks and len(missing) * 2 > len(title_toks):
        return None
    score += 3.0
    reasons.append("title")

    artist_toks = tokens(artist) if artist else []
    if artist_toks:
        if any(t in seen.split() for t in artist_toks):
            score += 3.0
            reasons.append("artist")
        else:
            score -= 6.0
            reasons.append("artist-missing")

    if artist_norm and channel_norm:
        if channel_norm.endswith(" topic") and artist_norm in channel_norm:
            score += 4.0
            reasons.append("topic-channel")
        elif channel_norm == artist_norm:
            score += 3.0
            reasons.append("artist-channel")
        elif artist_norm in channel_norm:
            score += 1.5
            reasons.append("artist-in-channel")
    if "vevo" in channel_norm:
        score += 1.0

    wanted = f"{title_norm} {artist_norm}"
    title_seen = normalize(video_title)
    for marker in BAD_MARKERS:
        if _has_marker(title_seen, marker) and not _has_marker(wanted, marker):
            score -= 4.0
            reasons.append(f"-{marker}")
    if _has_marker(title_seen, "audio"):
        score += 1.0
        reasons.append("audio")

    if expected_duration:
        diff = abs(float(duration) - expected_duration)
        if diff <= 5:
            score += 4.0
            reasons.append("duration-exact")
        elif diff <= max(12.0, expected_duration * 0.05):
            score += 2.0
            reasons.append("duration-close")
        elif diff > max(20.0, expected_duration * 0.15):
            score -= 5.0
            reasons.append("duration-off")

    score += max(0.0, 1.5 - 0.3 * rank)
    return Pick(entry=entry, score=score, reasons=reasons)


def pick_best(
    entries: list[dict[str, Any]],
    artist: str,
    title: str,
    expected_duration: Optional[int] = None,
) -> Optional[Pick]:
    picks = [
        p for rank, e in enumerate(entries)
        if (p := score_candidate(e, artist, title, expected_duration, rank)) is not None
    ]
    if not picks:
        return None
    best = max(picks, key=lambda p: p.score)
    return best if best.score >= MIN_SCORE else None


# ---------------------------------------------------------------------------
# Errors
# ---------------------------------------------------------------------------

def classify_error(stderr: str) -> str:
    """Map a yt-dlp / ffmpeg failure to a code the backend turns into retry-or-give-up."""
    s = (stderr or "").lower()
    if "confirm your age" in s or "age-restricted" in s or "inappropriate for some users" in s:
        return "age_restricted"
    if (
        "not a bot" in s or "http error 403" in s or "http error 429" in s
        or "too many requests" in s or "sign in to confirm" in s
    ):
        return "blocked"
    if (
        "video unavailable" in s or "private video" in s or "this video is not available" in s
        or "has been removed" in s or "copyright" in s or "members-only" in s
    ):
        return "unavailable"
    if "ffmpeg" in s or "postprocessing" in s:
        return "ffmpeg"
    return "error"


def video_id_from_url(url: str) -> Optional[str]:
    """Video id of a YouTube URL, or None if it is not a plain YouTube video link."""
    try:
        u = urlparse(url.strip())
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or (u.hostname or "").lower() not in YOUTUBE_HOSTS:
        return None
    host = (u.hostname or "").lower()
    candidate: Optional[str]
    if host == "youtu.be":
        candidate = u.path.strip("/").split("/")[0] or None
    elif u.path == "/watch":
        candidate = (parse_qs(u.query).get("v") or [None])[0]
    else:
        m = re.match(r"^/(?:shorts|embed|live|v)/([^/?#]+)", u.path)
        candidate = m.group(1) if m else None
    return candidate if candidate and VIDEO_ID_RE.match(candidate) else None


# ---------------------------------------------------------------------------
# Request / result
# ---------------------------------------------------------------------------

@dataclass
class AudioRequest:
    artist: str
    title: str
    out_dir: Path
    basename: str
    album: Optional[str] = None
    cover_url: Optional[str] = None
    expected_duration_s: Optional[int] = None
    video_url: Optional[str] = None

    @staticmethod
    def from_json(body: dict[str, Any], media_root: Path) -> "AudioRequest":
        def text(key: str, limit: int = 200) -> str:
            v = body.get(key)
            return v.strip()[:limit] if isinstance(v, str) else ""

        title = text("title")
        if not title:
            raise ValueError("title richiesto")
        basename = text("basename", 80)
        if not BASENAME_RE.match(basename):
            raise ValueError("basename non valido")

        out_dir = Path(text("outDir", 400) or str(media_root / "_staging")).resolve()
        root = media_root.resolve()
        if out_dir != root and root not in out_dir.parents:
            raise ValueError("outDir fuori da MEDIA_ROOT")

        video_url = text("videoUrl", 400) or None
        if video_url and not video_id_from_url(video_url):
            raise ValueError("videoUrl non è un link YouTube")

        cover = text("coverUrl", 600) or None
        if cover and not re.match(r"^https?://", cover, re.I):
            cover = None

        expected = body.get("expectedDurationS")
        expected_s = int(expected) if isinstance(expected, (int, float)) and 20 <= expected <= 3600 else None

        return AudioRequest(
            artist=text("artist"),
            title=title,
            out_dir=out_dir,
            basename=basename,
            album=text("album") or None,
            cover_url=cover,
            expected_duration_s=expected_s,
            video_url=video_url,
        )


@dataclass
class AudioResult:
    ok: bool
    code: Optional[str] = None
    error: Optional[str] = None
    path: Optional[str] = None
    bytes: Optional[int] = None
    duration_s: Optional[int] = None
    video_id: Optional[str] = None
    video_title: Optional[str] = None
    channel: Optional[str] = None
    score: Optional[float] = None
    tagged: Optional[bool] = None

    def to_json(self) -> dict[str, Any]:
        out: dict[str, Any] = {"ok": self.ok}
        if self.ok:
            out.update(
                path=self.path, bytes=self.bytes, durationS=self.duration_s, videoId=self.video_id,
                videoTitle=self.video_title, channel=self.channel, score=self.score, tagged=self.tagged,
            )
        else:
            out.update(code=self.code, error=self.error)
            if self.video_id:
                out["videoId"] = self.video_id
        return out


def _fail(code: str, error: str, video_id: Optional[str] = None) -> AudioResult:
    return AudioResult(ok=False, code=code, error=error, video_id=video_id)


Runner = Callable[..., "subprocess.CompletedProcess[str]"]
CoverFetcher = Callable[[str], Optional[bytes]]


def _base_args() -> list[str]:
    args = ["--no-warnings", "--extractor-args", EXTRACTOR_ARGS]
    if COOKIES_FILE and os.path.isfile(COOKIES_FILE):
        args += ["--cookies", COOKIES_FILE]
    return args


def search_candidates(query: str, run: Runner) -> list[dict[str, Any]]:
    """Flat search results (id, title, duration, channel, live_status …) without extracting each video."""
    proc = run(
        ["yt-dlp", "--flat-playlist", "-J", *_base_args(), f"ytsearch{SEARCH_RESULTS}:{query}"],
        capture_output=True, text=True, timeout=SEARCH_TIMEOUT_S,
    )
    if proc.returncode != 0:
        raise RuntimeError((proc.stderr or "").strip().splitlines()[-1] if proc.stderr else f"yt-dlp exit {proc.returncode}")
    try:
        data = json.loads(proc.stdout)
    except ValueError as exc:
        raise RuntimeError("ricerca: risposta non valida") from exc
    return [e for e in (data.get("entries") or []) if isinstance(e, dict)]


def probe_duration(path: Path, run: Runner) -> Optional[int]:
    try:
        proc = run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", str(path)],
            capture_output=True, text=True, timeout=30,
        )
        return int(round(float((proc.stdout or "").strip()))) if proc.returncode == 0 else None
    except (ValueError, subprocess.SubprocessError, OSError):
        return None


def tag_mp3(src: Path, dst: Path, req: AudioRequest, cover: Optional[Path], run: Runner) -> bool:
    """Rewrite the tags with OUR metadata (YouTube's are noise) and embed the cover. False = keep untagged."""
    cmd = ["ffmpeg", "-y", "-loglevel", "error", "-i", str(src)]
    if cover:
        cmd += ["-i", str(cover)]
    cmd += ["-map", "0:a"]
    if cover:
        cmd += ["-map", "1:v"]
    cmd += ["-c", "copy", "-map_metadata", "-1", "-id3v2_version", "3", "-metadata", f"title={req.title}"]
    if req.artist:
        cmd += ["-metadata", f"artist={req.artist}"]
    if req.album:
        cmd += ["-metadata", f"album={req.album}"]
    if cover:
        cmd += ["-metadata:s:v", "title=Album cover", "-metadata:s:v", "comment=Cover (front)"]
    cmd.append(str(dst))
    try:
        proc = run(cmd, capture_output=True, text=True, timeout=60)
    except (subprocess.SubprocessError, OSError) as exc:
        log.warning("yt/audio tagging failed: %s", exc)
        return False
    return proc.returncode == 0 and dst.exists() and dst.stat().st_size > 0


def download_audio(
    req: AudioRequest,
    run: Runner = subprocess.run,
    fetch_cover: Optional[CoverFetcher] = None,
) -> AudioResult:
    """The whole job. Never raises: every failure is a result with a code."""
    video_id: Optional[str] = None
    video_title: Optional[str] = None
    channel: Optional[str] = None
    score: Optional[float] = None

    if req.video_url:
        video_id = video_id_from_url(req.video_url)
        if not video_id:
            return _fail("bad_request", "videoUrl non è un link YouTube")
        score = 99.0  # chosen by a human
    else:
        pick: Optional[Pick] = None
        queries = [f"{req.artist} {req.title}".strip(), f"{req.artist} - {req.title} official audio".strip()]
        last_error: Optional[str] = None
        for query in queries:
            try:
                entries = search_candidates(query, run)
            except subprocess.TimeoutExpired:
                last_error = "ricerca YouTube scaduta"
                continue
            except RuntimeError as exc:
                last_error = str(exc)
                continue
            pick = pick_best(entries, req.artist, req.title, req.expected_duration_s)
            if pick:
                break
        if not pick:
            if last_error:
                return _fail(classify_error(last_error), last_error)
            return _fail("no_source", "nessun video adatto trovato")
        video_id = str(pick.entry["id"])
        video_title = str(pick.entry.get("title") or "") or None
        channel = str(pick.entry.get("channel") or pick.entry.get("uploader") or "") or None
        score = round(pick.score, 2)
        log.info("yt/audio pick id=%s score=%.1f reasons=%s title=%s", video_id, pick.score, ",".join(pick.reasons), video_title)

    req.out_dir.mkdir(parents=True, exist_ok=True)
    try:
        os.chmod(req.out_dir, 0o777)  # the backend (uid node) removes the staging file after moving it
    except OSError:
        pass
    work = req.out_dir / f".work-{req.basename}"
    shutil.rmtree(work, ignore_errors=True)
    work.mkdir(parents=True)
    try:
        url = f"https://www.youtube.com/watch?v={video_id}"
        try:
            proc = run(
                [
                    "yt-dlp", "--no-playlist", "-f", "bestaudio/best", *_base_args(),
                    "--max-filesize", "80M", "--no-progress",
                    "-x", "--audio-format", "mp3", "--audio-quality", "192K",
                    "-o", str(work / "audio.%(ext)s"), url,
                ],
                capture_output=True, text=True, timeout=DOWNLOAD_TIMEOUT_S,
            )
        except subprocess.TimeoutExpired:
            return _fail("error", "download scaduto", video_id)
        raw = work / "audio.mp3"
        if proc.returncode != 0 or not raw.exists():
            err = (proc.stderr or "").strip().splitlines()
            message = err[-1] if err else f"yt-dlp exit {proc.returncode}"
            return _fail(classify_error(proc.stderr or message), message, video_id)

        cover_path: Optional[Path] = None
        if req.cover_url and fetch_cover:
            data = fetch_cover(req.cover_url)
            if data:
                cover_path = work / "cover.jpg"
                cover_path.write_bytes(data)

        final = req.out_dir / f"{req.basename}.mp3"
        tagged_path = work / "tagged.mp3"
        tagged = tag_mp3(raw, tagged_path, req, cover_path, run)
        shutil.move(str(tagged_path if tagged else raw), str(final))
        try:
            os.chmod(final, 0o666)
        except OSError:
            pass
        return AudioResult(
            ok=True, path=str(final), bytes=final.stat().st_size, duration_s=probe_duration(final, run),
            video_id=video_id, video_title=video_title, channel=channel, score=score, tagged=tagged,
        )
    finally:
        shutil.rmtree(work, ignore_errors=True)


def make_cover_fetcher(get: Callable[..., Any]) -> CoverFetcher:
    """Cover download with a size cap; `get` is requests.get (injected so tests need no network)."""
    def fetch(url: str) -> Optional[bytes]:
        try:
            res = get(url, timeout=15, stream=True)
            if res.status_code != 200:
                return None
            ctype = (res.headers.get("content-type") or "").lower()
            if not ctype.startswith("image/"):
                return None
            data = b""
            for chunk in res.iter_content(65536):
                data += chunk
                if len(data) > COVER_MAX_BYTES:
                    return None
            return data or None
        except Exception as exc:  # noqa: BLE001 - a missing cover must never fail the job
            log.info("yt/audio cover skipped: %s", exc)
            return None
    return fetch
