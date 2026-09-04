"""Test dell'estrazione del titolo dalla risposta della API iPhone.

Nessuna chiamata reale a Instagram: qui si prova solo come si legge un dict.

Il bug che questi test fissano: un post con `music_metadata` presente ma
`null` faceva esplodere `extract_music_info_iphone` con AttributeError. Il
chiamante rispondeva a quell'errore ripiegando su GraphQL — l'unica strada
che Instagram sfida — e un download iPhone perfettamente riuscito diventava
"Instagram richiede una nuova autorizzazione".

Le dipendenze pesanti di app.py (flask, instaloader, shazamio) sono finte:
la funzione sotto esame non le tocca.
"""
import sys
import types
from pathlib import Path
from unittest.mock import MagicMock

sys.path.insert(0, str(Path(__file__).parent))

for name in ("instaloader", "instaloader.exceptions", "requests", "flask", "shazamio", "librosa"):
    sys.modules.setdefault(name, MagicMock())
_subs = types.ModuleType("subtitles")
_subs.fetch_subtitle_text = lambda *a, **k: None
sys.modules.setdefault("subtitles", _subs)

from app import extract_music_info_iphone  # noqa: E402


def test_traccia_dai_clips_metadata():
    item = {"clips_metadata": {"music_info": {"music_asset_info": {
        "title": "Bella Ciao", "display_artist": "Modena City Ramblers"}}}}
    assert extract_music_info_iphone(item) == {
        "title": "Bella Ciao", "artist": "Modena City Ramblers"}


def test_traccia_dal_music_metadata_quando_i_clips_non_ce_l_hanno():
    item = {"clips_metadata": {}, "music_metadata": {"music_info": {"music_asset_info": {
        "title": "Vita Spericolata", "display_artist": "Vasco Rossi"}}}}
    assert extract_music_info_iphone(item) == {
        "title": "Vita Spericolata", "artist": "Vasco Rossi"}


def test_music_metadata_nullo_non_esplode():
    """Il caso reale: la chiave c'e', il valore e' null.

    `.get("music_info", {})` non basta — il default vale solo per una chiave
    *assente*.
    """
    assert extract_music_info_iphone({"music_metadata": {"music_info": None}}) is None
    assert extract_music_info_iphone({"music_metadata": None}) is None
    assert extract_music_info_iphone({"music_metadata": {"music_info": {"music_asset_info": None}}}) is None


def test_post_senza_musica():
    assert extract_music_info_iphone({}) is None
    assert extract_music_info_iphone({"clips_metadata": {"music_info": None}}) is None


def test_titolo_senza_artista_non_conta():
    """Meta' informazione non e' una traccia riconosciuta."""
    item = {"clips_metadata": {"music_info": {"music_asset_info": {"title": "Boh"}}}}
    assert extract_music_info_iphone(item) is None


def test_una_forma_inattesa_non_ferma_il_download():
    """Qualunque sorpresa nella risposta vale None, mai un'eccezione."""
    assert extract_music_info_iphone({"clips_metadata": "stringa, non dict"}) is None


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except AssertionError as exc:
                fails += 1
                print(f"FAIL {name}: {exc}")
    print(f"\n{fails} falliti" if fails else "\ntutti passati")
    sys.exit(1 if fails else 0)
