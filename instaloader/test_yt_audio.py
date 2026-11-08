"""Tests for the YouTube audio picker/downloader (yt_audio.py).

No network, no yt-dlp, no ffmpeg: commands go through a fake `run`. The search results below are a real
`yt-dlp --flat-playlist -J "ytsearch5:Bishop Briggs White Flag"` capture (2026-11-07), trimmed to the fields
the picker reads.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).parent))

import yt_audio  # noqa: E402
from yt_audio import (  # noqa: E402
    AudioRequest, classify_error, download_audio, make_cover_fetcher, normalize, pick_best, score_candidate,
    tokens, video_id_from_url,
)

# --- real capture -----------------------------------------------------------------------------------
WHITE_FLAG = [
    {"id": "syhBqULC99I", "title": "Bishop Briggs - White Flag", "duration": 254, "channel": "Bishop Briggs",
     "uploader": "Bishop Briggs", "live_status": None},
    {"id": "RWzZeA2GMsk", "title": "Bishop Briggs - White Flag (Audio)", "duration": 231, "channel": "Bishop Briggs",
     "uploader": "Bishop Briggs", "live_status": None},
    {"id": "scBk723GuPQ", "title": "Bishop Briggs - White Flag (Lyrics)", "duration": 231, "channel": "Alternate",
     "uploader": "Alternate", "live_status": None},
    {"id": "GRx6113yyYs", "title": "6 Underground 2019- Soundtrack Bishop Briggs - White Flag.mp4", "duration": 176,
     "channel": "Nidhin Sony", "uploader": "Nidhin Sony", "live_status": None},
    {"id": "hj64cIVlHZw", "title": "Bishop Briggs - White  Flag (Lyric Video)", "duration": 231, "channel": "Sadwich",
     "uploader": "Sadwich", "live_status": None},
]


def entry(vid="abcdefghijk", title="Artist - Song", duration=200, channel="Artist", live=None):
    return {"id": vid, "title": title, "duration": duration, "channel": channel, "uploader": channel, "live_status": live}


# --- text helpers -----------------------------------------------------------------------------------
def test_normalize_drops_accents_punctuation_and_case():
    assert normalize("  Beyoncé — Halo!! ") == "beyonce halo"
    assert normalize("Simon & Garfunkel") == "simon and garfunkel"


def test_tokens_skip_filler_but_never_return_nothing():
    assert tokens("The Official Audio of Halo") == ["of", "halo"]
    assert tokens("The Official") == ["the", "official"]


# --- choosing the video -----------------------------------------------------------------------------
def test_prefers_the_official_audio_when_the_expected_duration_is_known():
    best = pick_best(WHITE_FLAG, "Bishop Briggs", "White Flag", expected_duration=230)
    assert best is not None and best.entry["id"] == "RWzZeA2GMsk"


def test_prefers_the_audio_upload_over_the_video_even_without_a_duration():
    best = pick_best(WHITE_FLAG, "Bishop Briggs", "White Flag")
    assert best is not None and best.entry["id"] == "RWzZeA2GMsk"


def test_follows_the_expected_duration_to_the_music_video_when_that_is_the_version_wanted():
    best = pick_best(WHITE_FLAG, "Bishop Briggs", "White Flag", expected_duration=254)
    assert best is not None and best.entry["id"] == "syhBqULC99I"


def test_the_wrong_length_soundtrack_upload_is_never_chosen():
    scores = {
        e["id"]: score_candidate(e, "Bishop Briggs", "White Flag", 230, rank).score  # type: ignore[union-attr]
        for rank, e in enumerate(WHITE_FLAG)
    }
    assert scores["GRx6113yyYs"] < yt_audio.MIN_SCORE
    assert max(scores, key=scores.get) == "RWzZeA2GMsk"


def test_topic_channel_beats_everything():
    entries = [
        entry("aaaaaaaaaaa", "Artist - Song (Official Video)", 200, "ArtistVEVO"),
        entry("bbbbbbbbbbb", "Song", 201, "Artist - Topic"),
    ]
    best = pick_best(entries, "Artist", "Song", expected_duration=200)
    assert best is not None and best.entry["id"] == "bbbbbbbbbbb" and "topic-channel" in best.reasons


@pytest.mark.parametrize("bad", ["live", "cover", "remix", "karaoke", "slowed", "instrumental"])
def test_unwanted_versions_lose_to_the_plain_song(bad):
    entries = [
        entry("aaaaaaaaaaa", f"Artist - Song ({bad})", 200, "Artist"),
        entry("bbbbbbbbbbb", "Artist - Song", 200, "Artist"),
    ]
    best = pick_best(entries, "Artist", "Song", expected_duration=200)
    assert best is not None and best.entry["id"] == "bbbbbbbbbbb"


def test_a_marker_that_is_part_of_the_wanted_title_is_not_a_penalty():
    best = pick_best([entry("aaaaaaaaaaa", "Queen - Live and Let Die", 190, "Queen")], "Queen", "Live and Let Die")
    assert best is not None


def test_live_streams_and_absurd_durations_are_not_candidates():
    assert score_candidate(entry(live="is_live"), "Artist", "Song", None, 0) is None
    assert score_candidate(entry(duration=3 * 3600), "Artist", "Song", None, 0) is None
    assert score_candidate(entry(duration=10), "Artist", "Song", None, 0) is None
    assert score_candidate(entry(duration=None), "Artist", "Song", None, 0) is None
    assert score_candidate({**entry(), "id": "short"}, "Artist", "Song", None, 0) is None


def test_better_no_source_than_the_wrong_song():
    # Another artist's song with the same title, and a video that never mentions the title.
    entries = [
        entry("aaaaaaaaaaa", "Someone Else - Song", 200, "Someone Else"),
        entry("bbbbbbbbbbb", "Completely unrelated clip", 200, "Artist"),
    ]
    assert pick_best(entries, "Artist", "Song", expected_duration=200) is None
    assert pick_best([], "Artist", "Song") is None


# --- errors and urls --------------------------------------------------------------------------------
@pytest.mark.parametrize("text,code", [
    ("ERROR: [youtube] x: Sign in to confirm your age. This video may be inappropriate", "age_restricted"),
    ("ERROR: Sign in to confirm you're not a bot", "blocked"),
    ("ERROR: unable to download video data: HTTP Error 403: Forbidden", "blocked"),
    ("HTTP Error 429: Too Many Requests", "blocked"),
    ("ERROR: [youtube] x: Video unavailable. This video is private", "unavailable"),
    ("ERROR: Private video. Sign in if you've been granted access", "unavailable"),
    ("ERROR: Postprocessing: ffprobe and ffmpeg not found", "ffmpeg"),
    ("something else went wrong", "error"),
    ("", "error"),
])
def test_classify_error(text, code):
    assert classify_error(text) == code


@pytest.mark.parametrize("url,vid", [
    ("https://www.youtube.com/watch?v=syhBqULC99I&list=x", "syhBqULC99I"),
    ("https://youtu.be/syhBqULC99I?si=abc", "syhBqULC99I"),
    ("https://music.youtube.com/watch?v=syhBqULC99I", "syhBqULC99I"),
    ("https://www.youtube.com/shorts/syhBqULC99I", "syhBqULC99I"),
    ("https://evil.example/watch?v=syhBqULC99I", None),
    ("https://youtube.com.evil.example/watch?v=syhBqULC99I", None),
    ("https://www.youtube.com/watch?v=short", None),
    ("https://www.youtube.com/results?search_query=x", None),
    ("ftp://www.youtube.com/watch?v=syhBqULC99I", None),
    ("not a url", None),
])
def test_video_id_from_url(url, vid):
    assert video_id_from_url(url) == vid


# --- request validation -----------------------------------------------------------------------------
def make_request(tmp_path, **over):
    body = {"artist": "Bishop Briggs", "title": "White Flag", "basename": "job-1", "outDir": str(tmp_path / "_staging")}
    body.update(over)
    return AudioRequest.from_json(body, tmp_path)


def test_request_defaults_and_clamps(tmp_path):
    req = make_request(tmp_path, expectedDurationS=230, coverUrl="https://x/c.jpg", album="Church of Scars")
    assert (req.artist, req.title, req.expected_duration_s, req.album) == ("Bishop Briggs", "White Flag", 230, "Church of Scars")
    assert req.out_dir == (tmp_path / "_staging").resolve()
    assert make_request(tmp_path, expectedDurationS=5).expected_duration_s is None
    assert make_request(tmp_path, expectedDurationS="x").expected_duration_s is None
    assert make_request(tmp_path, coverUrl="javascript:alert(1)").cover_url is None
    assert AudioRequest.from_json({"title": "T", "basename": "b"}, tmp_path).out_dir == (tmp_path / "_staging").resolve()


@pytest.mark.parametrize("over", [
    {"title": " "}, {"basename": "../x"}, {"basename": ""}, {"basename": "a b"}, {"outDir": "/etc"},
    {"outDir": "{tmp}/../x"}, {"videoUrl": "https://evil.example/watch?v=syhBqULC99I"},
])
def test_request_rejects_bad_input(tmp_path, over):
    over = {k: (v.replace("{tmp}", str(tmp_path)) if isinstance(v, str) else v) for k, v in over.items()}
    with pytest.raises(ValueError):
        make_request(tmp_path, **over)


# --- the whole job, with fake commands --------------------------------------------------------------
class FakeRun:
    """Stands in for subprocess.run: search -> JSON, download -> writes audio.mp3, ffprobe -> duration, ffmpeg -> tagged."""

    def __init__(self, entries=None, search_rc=0, search_err="", dl_rc=0, dl_err="", tag_rc=0, timeout_on=None):
        self.entries = entries if entries is not None else WHITE_FLAG
        self.search_rc, self.search_err = search_rc, search_err
        self.dl_rc, self.dl_err = dl_rc, dl_err
        self.tag_rc = tag_rc
        self.timeout_on = timeout_on
        self.calls: list[list[str]] = []

    def __call__(self, cmd, **kwargs):
        self.calls.append(list(cmd))
        done = lambda rc=0, out="", err="": subprocess.CompletedProcess(cmd, rc, out, err)  # noqa: E731
        if cmd[0] == "yt-dlp" and "--flat-playlist" in cmd:
            if self.timeout_on == "search":
                raise subprocess.TimeoutExpired(cmd, 1)
            return done(self.search_rc, json.dumps({"_type": "playlist", "entries": self.entries}), self.search_err)
        if cmd[0] == "yt-dlp":
            if self.timeout_on == "download":
                raise subprocess.TimeoutExpired(cmd, 1)
            if self.dl_rc == 0:
                template = cmd[cmd.index("-o") + 1]
                Path(template.replace("%(ext)s", "mp3")).write_bytes(b"ID3" + b"\0" * 50_000)
            return done(self.dl_rc, "", self.dl_err)
        if cmd[0] == "ffprobe":
            return done(0, "231.4\n")
        if cmd[0] == "ffmpeg":
            if self.tag_rc == 0:
                Path(cmd[-1]).write_bytes(b"ID3tagged" + b"\0" * 60_000)
            return done(self.tag_rc, "", "boom" if self.tag_rc else "")
        raise AssertionError(f"unexpected command {cmd}")


def test_happy_path_downloads_tags_and_hands_over_a_clean_staging_folder(tmp_path):
    run = FakeRun()
    req = make_request(tmp_path, album="Church of Scars", expectedDurationS=230, coverUrl="https://img/c.jpg")

    res = download_audio(req, run=run, fetch_cover=lambda url: b"\xff\xd8jpeg")

    assert res.ok and res.code is None
    assert res.path == str(req.out_dir / "job-1.mp3")
    assert Path(res.path).read_bytes().startswith(b"ID3tagged")
    assert (res.video_id, res.channel, res.duration_s, res.tagged) == ("RWzZeA2GMsk", "Bishop Briggs", 231, True)
    assert sorted(p.name for p in req.out_dir.iterdir()) == ["job-1.mp3"]  # work dir gone
    # The video URL is rebuilt from the id (never the raw search entry URL) and the tags are ours.
    dl = next(c for c in run.calls if c[0] == "yt-dlp" and "--flat-playlist" not in c)
    assert dl[-1] == "https://www.youtube.com/watch?v=RWzZeA2GMsk"
    assert "-x" in dl and "mp3" in dl and "192K" in dl
    tag = next(c for c in run.calls if c[0] == "ffmpeg")
    assert "title=White Flag" in tag and "artist=Bishop Briggs" in tag and "album=Church of Scars" in tag
    assert "-map_metadata" in tag and "1:v" in tag
    assert res.to_json()["durationS"] == 231


def test_no_cover_and_a_failing_tagger_still_deliver_the_song(tmp_path):
    req = make_request(tmp_path)
    res = download_audio(req, run=FakeRun(tag_rc=1), fetch_cover=lambda url: None)
    assert res.ok and res.tagged is False
    assert Path(res.path).read_bytes().startswith(b"ID3\0")  # the untagged download


def test_a_human_chosen_link_skips_the_search(tmp_path):
    run = FakeRun()
    req = make_request(tmp_path, videoUrl="https://youtu.be/syhBqULC99I")
    res = download_audio(req, run=run)
    assert res.ok and res.video_id == "syhBqULC99I" and res.score == 99.0
    assert not any("--flat-playlist" in c for c in run.calls)


def test_nothing_suitable_is_no_source_after_trying_both_queries(tmp_path):
    run = FakeRun(entries=[entry("aaaaaaaaaaa", "Totally different", 200, "Nobody")])
    res = download_audio(make_request(tmp_path), run=run)
    assert (res.ok, res.code) == (False, "no_source")
    assert sum(1 for c in run.calls if "--flat-playlist" in c) == 2
    assert list(Path(tmp_path / "_staging").glob("*")) == [] if (tmp_path / "_staging").exists() else True


@pytest.mark.parametrize("kwargs,code", [
    ({"dl_rc": 1, "dl_err": "ERROR: unable to download video data: HTTP Error 403: Forbidden"}, "blocked"),
    ({"dl_rc": 1, "dl_err": "ERROR: [youtube] x: Sign in to confirm your age"}, "age_restricted"),
    ({"dl_rc": 1, "dl_err": "ERROR: Video unavailable"}, "unavailable"),
    ({"timeout_on": "download"}, "error"),
])
def test_download_failures_get_a_code_the_backend_can_act_on(tmp_path, kwargs, code):
    req = make_request(tmp_path)
    res = download_audio(req, run=FakeRun(**kwargs))
    assert (res.ok, res.code) == (False, code)
    assert res.video_id == "RWzZeA2GMsk"
    assert sorted(p.name for p in req.out_dir.iterdir()) == []  # nothing left behind


def test_search_failures_are_reported_not_raised(tmp_path):
    assert download_audio(make_request(tmp_path), run=FakeRun(timeout_on="search")).code == "error"
    blocked = download_audio(make_request(tmp_path), run=FakeRun(search_rc=1, search_err="ERROR: HTTP Error 429: Too Many Requests"))
    assert (blocked.ok, blocked.code) == (False, "blocked")


# --- cover download ---------------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, status=200, ctype="image/jpeg", chunks=(b"abc",)):
        self.status_code = status
        self.headers = {"content-type": ctype}
        self._chunks = chunks

    def iter_content(self, _size):
        return iter(self._chunks)


def test_cover_fetcher_accepts_images_and_swallows_everything_else():
    assert make_cover_fetcher(lambda *a, **k: FakeResponse())("https://x") == b"abc"
    assert make_cover_fetcher(lambda *a, **k: FakeResponse(status=404))("https://x") is None
    assert make_cover_fetcher(lambda *a, **k: FakeResponse(ctype="text/html"))("https://x") is None
    big = FakeResponse(chunks=(b"x" * (yt_audio.COVER_MAX_BYTES + 1),))
    assert make_cover_fetcher(lambda *a, **k: big)("https://x") is None

    def boom(*a, **k):
        raise OSError("down")
    assert make_cover_fetcher(boom)("https://x") is None
