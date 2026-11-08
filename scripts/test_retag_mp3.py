#!/usr/bin/env python3
"""Tests for retag_mp3.py on synthetic MP3 files in a temp directory (never the real library).

Needs mutagen, which geekom does not have; run in a throw-away container from the repository root:
  docker run --rm -v "$PWD/scripts:/s:ro" --entrypoint sh soundreel-instaloader:local \\
    -c 'pip install -q --target /tmp/py mutagen && PYTHONPATH=/tmp/py:/s python -m unittest -v test_retag_mp3'
"""
import csv
import hashlib
import json
import os
import tempfile
import time
import unicodedata
import unittest

from mutagen.id3 import COMM, ID3, TALB, TIT2, TPE1, TRCK

import retag_mp3 as r

FRAME = b"\xff\xfb\x90\x00" + b"\x00" * 413  # one silent MPEG-1 Layer III frame (128 kbit/s, 44.1 kHz)


def make_mp3(path: str, artist: str, album: str, version: int = 3) -> None:
    with open(path, "wb") as f:
        f.write(FRAME * 12)
    tags = ID3()
    tags.add(TIT2(encoding=3 if version == 4 else 1, text=["Title Stays"]))
    tags.add(TPE1(encoding=0, text=[artist]))
    tags.add(TALB(encoding=0, text=[album]))
    tags.add(TRCK(encoding=0, text=["7/9"]))
    tags.add(COMM(encoding=0, lang="eng", desc="", text=["a comment"]))
    tags.save(path, v2_version=version)


def sha(path: str) -> str:
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


class RetagTest(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.root = self.tmp.name
        self.dir = os.path.join(self.root, "REMIXES")
        os.makedirs(self.dir)
        self.addCleanup(self.tmp.cleanup)

    def file(self, name: str, artist: str = "B-Groove", album: str = "Old Album", version: int = 3) -> str:
        path = os.path.join(self.dir, name)
        make_mp3(path, artist, album, version)
        return path

    def rows(self, *specs):
        return [
            {"rel_path": "SoundReel/REMIXES/" + name, "artist_attuale": cur, "artist_proposto": new, "album_proposto": "Italian Songs Remixed by Edmea"}
            for name, cur, new in specs
        ]

    def run_plan(self, *specs):
        return r.plan(self.rows(*specs), self.root, "SoundReel/")

    def test_the_status_of_each_file(self) -> None:
        self.file("change.mp3")
        self.file("already.mp3", artist="B-Groove, Mina", album="Italian Songs Remixed by Edmea")
        self.file("differs.mp3", artist="Somebody Else")
        self.file("v24.mp3", version=4)
        with open(os.path.join(self.dir, "plain.mp3"), "wb") as f:
            f.write(FRAME * 3)
        items = self.run_plan(
            ("change.mp3", "B-Groove", "B-Groove, Mina"),
            ("already.mp3", "B-Groove", "B-Groove, Mina"),
            ("differs.mp3", "B-Groove", "B-Groove, Mina"),
            ("v24.mp3", "B-Groove", "B-Groove, Mina"),
            ("plain.mp3", "B-Groove", "B-Groove, Mina"),
            ("gone.mp3", "B-Groove", "B-Groove, Mina"),
        )
        self.assertEqual([i["status"] for i in items], ["change", "already", "artist_differs", "not_v23", "no_id3", "missing"])

    def test_names_are_compared_unicode_normalised(self) -> None:
        composed = unicodedata.normalize("NFC", "Nu Genea - Sciallà.mp3")
        decomposed = unicodedata.normalize("NFD", composed)
        self.assertNotEqual(composed, decomposed)
        self.file(composed, artist="Nu Genea")
        items = self.run_plan((decomposed, "Nu Genea", "Nu Genea"))
        self.assertEqual(items[0]["status"], "change")
        self.assertEqual(os.path.basename(str(items[0]["path"])), composed)

    def test_dry_run_changes_nothing(self) -> None:
        path = self.file("a.mp3")
        csv_path = os.path.join(self.root, "f.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["rel_path", "artist_attuale", "artist_proposto", "album_proposto"])
            w.writeheader()
            w.writerows(self.rows(("a.mp3", "B-Groove", "B-Groove, Mina")))
        before = sha(path)
        code = r.main(["--csv", csv_path, "--root", self.root])
        self.assertEqual(code, 0)
        self.assertEqual(sha(path), before)
        code = r.main(["--csv", csv_path, "--root", self.root, "--apply", "--dry-run"])
        self.assertEqual(sha(path), before)

    def test_apply_changes_only_artist_and_album_and_keeps_the_audio(self) -> None:
        path = self.file("a.mp3")
        audio_before = r.audio_sha256(path)
        item = self.run_plan(("a.mp3", "B-Groove", "B-Groove, Mina & Adriano Celentano"))[0]
        self.assertEqual(r.apply_one(item), "ok")
        tags = ID3(path)
        self.assertEqual(tags.version[:2], (2, 3))
        self.assertEqual(r.text_of(tags, "TPE1"), "B-Groove, Mina & Adriano Celentano")
        self.assertEqual(r.text_of(tags, "TALB"), "Italian Songs Remixed by Edmea")
        self.assertEqual(r.text_of(tags, "TIT2"), "Title Stays")
        self.assertEqual(r.text_of(tags, "TRCK"), "7/9")
        self.assertEqual(str(tags.getall("COMM")[0].text[0]), "a comment")
        self.assertEqual(r.audio_sha256(path), audio_before)

    def test_text_outside_latin1_is_written_as_utf16(self) -> None:
        path = self.file("a.mp3")
        item = self.run_plan(("a.mp3", "B-Groove", "B-Groove, 久石譲"))[0]
        self.assertEqual(r.apply_one(item), "ok")
        self.assertEqual(r.text_of(ID3(path), "TPE1"), "B-Groove, 久石譲")
        self.assertEqual(r.encoding_for("Mina"), 0)
        self.assertEqual(r.encoding_for("久石譲"), 1)

    def test_backup_then_restore_gives_back_the_exact_file(self) -> None:
        path = self.file("a.mp3")
        original = open(path, "rb").read()
        items = [i for i in self.run_plan(("a.mp3", "B-Groove", "B-Groove, Mina")) if i["status"] == "change"]
        backup = os.path.join(self.root, "b", "backup.json")
        r.write_backup(items, backup)
        self.assertEqual(oct(os.stat(backup).st_mode & 0o777), "0o600")
        self.assertEqual(r.apply_one(items[0]), "ok")
        self.assertNotEqual(open(path, "rb").read(), original)
        self.assertEqual(r.restore(backup, True), 0)
        self.assertEqual(open(path, "rb").read(), original)
        saved = json.load(open(backup, encoding="utf-8"))["files"][0]
        self.assertEqual(saved["old_artist"], "B-Groove")
        self.assertEqual(saved["old_album"], "Old Album")

    def test_restore_refuses_when_the_audio_changed(self) -> None:
        path = self.file("a.mp3")
        items = [i for i in self.run_plan(("a.mp3", "B-Groove", "B-Groove, Mina")) if i["status"] == "change"]
        backup = os.path.join(self.root, "backup.json")
        r.write_backup(items, backup)
        with open(path, "ab") as f:
            f.write(b"\x00" * 5)
        self.assertEqual(r.restore(backup, True), 1)

    def test_main_apply_end_to_end_skips_what_it_must_not_touch(self) -> None:
        good = self.file("good.mp3")
        other = self.file("other.mp3", artist="Somebody Else")
        csv_path = os.path.join(self.root, "f.csv")
        with open(csv_path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=["rel_path", "artist_attuale", "artist_proposto", "album_proposto"])
            w.writeheader()
            w.writerows(self.rows(("good.mp3", "B-Groove", "B-Groove, Mina"), ("other.mp3", "B-Groove", "B-Groove, Mina")))
        untouched = sha(other)
        backup = os.path.join(self.root, "backup.json")
        self.assertEqual(r.main(["--csv", csv_path, "--root", self.root, "--apply", "--backup", backup]), 0)
        self.assertEqual(r.text_of(ID3(good), "TPE1"), "B-Groove, Mina")
        self.assertEqual(sha(other), untouched)
        self.assertEqual(len(json.load(open(backup, encoding="utf-8"))["files"]), 1)


if __name__ == "__main__":
    unittest.main()
