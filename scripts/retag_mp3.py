#!/usr/bin/env python3
"""Rewrites the artist (TPE1) and album (TALB) of ID3v2.3 MP3 files listed in a CSV, and nothing else.

Asked for by the Mac-import agent (8 November 2026) for the 39 files of "ITALIAN SONGS REMIXED BY EDMEA": the TV searches
the box by artist name, and these remixes carried only the remixer ("B-Groove"), not the original artist ("Mina").
The origin of the box's `Music/SoundReel/` is geekom's library (`~/Music`), so the tags are changed there: the nightly
`fritz-sync.sh` carries them to the box. A file the box holds alone would be overwritten by that sync.

CSV columns: rel_path, artist_attuale, artist_proposto, album_proposto
  rel_path       as the box sees it (`SoundReel/<folder>/<file>.mp3`); --strip-prefix removes the leading `SoundReel/`
                 and the rest is looked up under --root. File names are compared Unicode-normalised (macOS writes
                 decomposed accents, Linux keeps them composed).

What it will NOT do:
  - rename a file, change a title, a track number, a cover or any frame other than TPE1 and TALB;
  - touch a file whose current artist is not the CSV's `artist_attuale` (somebody changed it since: reported, skipped);
  - touch a file that is not ID3v2.3 (the agent asked for v2.3; a v2.4 tag would be converted: reported, skipped);
  - change the audio: before and after, the bytes after the tag must hash the same, or the file is put back.

Dry run unless --apply. With --apply it first writes a backup (JSON, 0600) holding for every file the old tag bytes, the
old TPE1/TALB and the hash of the audio; --restore puts the old tags back from that backup.

Needs `mutagen` (not installed on geekom): run it in a throw-away container, e.g.
  docker run --rm --user 1000:1000 -v ~/Music:/library -v $PWD/scripts:/s:ro -v $PWD/tmp:/c:ro --entrypoint sh soundreel-instaloader:local \\
    -c 'pip install -q --target /tmp/py mutagen && PYTHONPATH=/tmp/py python /s/retag_mp3.py --csv /c/mac-import-edmea-tags.csv --root /library --strip-prefix SoundReel/'
(mount the library at /library, NOT at /lib: that would shadow the container's own /lib and nothing could start)
"""
import argparse
import base64
import csv
import hashlib
import json
import os
import sys
import unicodedata
from typing import Dict, List, Optional

from mutagen.id3 import ID3, ID3NoHeaderError, TALB, TPE1


def nfc(text: str) -> str:
    return unicodedata.normalize("NFC", text)


def tag_end(path: str) -> int:
    """Offset of the first byte after the ID3v2 tag (0 when there is none), read from the header, not from mutagen."""
    with open(path, "rb") as f:
        head = f.read(10)
    if len(head) < 10 or head[:3] != b"ID3":
        return 0
    size = (head[6] & 0x7F) << 21 | (head[7] & 0x7F) << 14 | (head[8] & 0x7F) << 7 | (head[9] & 0x7F)
    footer = 10 if head[5] & 0x10 else 0
    return 10 + size + footer


def audio_sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        f.seek(tag_end(path))
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def text_of(tags: ID3, frame: str) -> Optional[str]:
    if frame not in tags:
        return None
    return "/".join(str(t) for t in tags[frame].text)


def locate(root: str, rel_path: str, strip_prefix: str) -> Optional[str]:
    """The real file for a CSV path, comparing names Unicode-normalised."""
    rel = rel_path[len(strip_prefix):] if strip_prefix and rel_path.startswith(strip_prefix) else rel_path
    folder, name = os.path.split(rel)
    real_folder = os.path.join(root, folder)
    if not os.path.isdir(real_folder):
        return None
    wanted = nfc(name)
    for candidate in os.listdir(real_folder):
        if nfc(candidate) == wanted:
            return os.path.join(real_folder, candidate)
    return None


def plan(rows: List[Dict[str, str]], root: str, strip_prefix: str) -> List[Dict[str, object]]:
    out: List[Dict[str, object]] = []
    for row in rows:
        path = locate(root, row["rel_path"], strip_prefix)
        item: Dict[str, object] = {"rel_path": row["rel_path"], "path": path, "new_artist": row["artist_proposto"], "new_album": row["album_proposto"]}
        if path is None:
            item["status"] = "missing"
            out.append(item)
            continue
        try:
            tags = ID3(path)
        except ID3NoHeaderError:
            item["status"] = "no_id3"
            out.append(item)
            continue
        item["version"] = "ID3v2.%d" % tags.version[1]
        item["old_artist"] = text_of(tags, "TPE1")
        item["old_album"] = text_of(tags, "TALB")
        if tags.version[:2] != (2, 3):
            item["status"] = "not_v23"
        elif item["old_artist"] not in (row["artist_attuale"], row["artist_proposto"]):
            item["status"] = "artist_differs"
        elif item["old_artist"] == row["artist_proposto"] and item["old_album"] == row["album_proposto"]:
            item["status"] = "already"
        else:
            item["status"] = "change"
        out.append(item)
    return out


def encoding_for(text: str) -> int:
    """ID3v2.3 text: ISO-8859-1 (0) when the text fits, else UTF-16 (1)."""
    try:
        text.encode("latin-1")
        return 0
    except UnicodeEncodeError:
        return 1


def write_backup(items: List[Dict[str, object]], backup_path: str) -> None:
    entries = []
    for item in items:
        path = str(item["path"])
        end = tag_end(path)
        with open(path, "rb") as f:
            old_head = f.read(end)
        entries.append(
            {
                "path": path,
                "size": os.path.getsize(path),
                "mtime": os.path.getmtime(path),
                "old_artist": item["old_artist"],
                "old_album": item["old_album"],
                "tag_bytes_b64": base64.b64encode(old_head).decode("ascii"),
                "audio_sha256": audio_sha256(path),
            }
        )
    os.makedirs(os.path.dirname(os.path.abspath(backup_path)), exist_ok=True)
    fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"kind": "retag_mp3", "files": entries}, f, ensure_ascii=False, indent=1)


def apply_one(item: Dict[str, object]) -> str:
    path = str(item["path"])
    before = audio_sha256(path)
    tags = ID3(path)
    tags.setall("TPE1", [TPE1(encoding=encoding_for(str(item["new_artist"])), text=[str(item["new_artist"])])])
    tags.setall("TALB", [TALB(encoding=encoding_for(str(item["new_album"])), text=[str(item["new_album"])])])
    tags.save(path, v2_version=3)
    after = audio_sha256(path)
    check = ID3(path)
    ok = before == after and text_of(check, "TPE1") == item["new_artist"] and text_of(check, "TALB") == item["new_album"] and check.version[:2] == (2, 3)
    return "ok" if ok else "VERIFY-FAILED"


def restore(backup_path: str, apply: bool) -> int:
    with open(backup_path, encoding="utf-8") as f:
        data = json.load(f)
    bad = 0
    for entry in data["files"]:
        path = entry["path"]
        if not os.path.exists(path):
            print("MISSING  %s" % path)
            bad += 1
            continue
        if audio_sha256(path) != entry["audio_sha256"]:
            print("AUDIO CHANGED, not restoring  %s" % path)
            bad += 1
            continue
        print("%s  %s" % ("restore" if apply else "would restore", path))
        if apply:
            with open(path, "rb") as f:
                f.seek(tag_end(path))
                audio = f.read()
            temp = path + ".retag-restore.part"
            with open(temp, "wb") as f:
                f.write(base64.b64decode(entry["tag_bytes_b64"]))
                f.write(audio)
            os.replace(temp, path)
    return 1 if bad else 0


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--csv")
    ap.add_argument("--root", default=os.path.expanduser("~/Music"))
    ap.add_argument("--strip-prefix", default="SoundReel/")
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--backup", default=None)
    ap.add_argument("--restore", default=None, help="a backup JSON written by --apply")
    args = ap.parse_args(argv)
    do_apply = args.apply and not args.dry_run

    if args.restore:
        return restore(args.restore, do_apply)
    if not args.csv:
        ap.error("--csv is required")
    with open(args.csv, encoding="utf-8", newline="") as f:
        rows = list(csv.DictReader(f))
    items = plan(rows, args.root, args.strip_prefix)
    counts: Dict[str, int] = {}
    for item in items:
        counts[str(item["status"])] = counts.get(str(item["status"]), 0) + 1
    print("files: %d | %s" % (len(items), ", ".join("%s %d" % (k, v) for k, v in sorted(counts.items()))))
    for item in items:
        if item["status"] != "change":
            print("  %-14s %s" % (item["status"], item["rel_path"]))
        else:
            name = os.path.basename(str(item["path"]))
            art = "" if item["old_artist"] == item["new_artist"] else "  artist: %r -> %r" % (item["old_artist"], item["new_artist"])
            print("  change         %s%s  album: %r -> %r" % (name[:60], art, item["old_album"], item["new_album"]))
    todo = [i for i in items if i["status"] == "change"]
    if not do_apply:
        print("DRY RUN: nothing changed (--apply writes: backup first, then TPE1/TALB only)")
        return 0
    if not todo:
        return 0
    backup = args.backup or os.path.join(os.getcwd(), "retag-mp3-backup.json")
    write_backup(todo, backup)
    print("backup: %s (%d files, 0600)" % (backup, len(todo)))
    failed = 0
    for item in todo:
        try:
            result = apply_one(item)
        except Exception as err:  # keep going: one bad file must not stop the others
            result = "ERROR %s" % err
        if result != "ok":
            failed += 1
        print("  %-13s %s" % (result, os.path.basename(str(item["path"]))))
    print("done: %d changed, %d failed" % (len(todo) - failed, failed))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
