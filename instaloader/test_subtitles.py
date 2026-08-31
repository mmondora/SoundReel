"""Test della scelta della traccia e della riduzione del VTT a testo.

Nessuna chiamata reale a YouTube: la logica che puo' sbagliare e' quale
traccia si sceglie e come si spoglia il VTT, ed entrambe si provano su dati
finti. Il download vero e' iniettato come callable.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from subtitles import pick_subtitle_track, vtt_to_text, fetch_subtitle_text


# ── Scelta della traccia ────────────────────────────────────────────────

def test_i_manuali_battono_gli_automatici():
    """Scritti da una persona contro generati da una macchina."""
    info = {
        "language": "it",
        "subtitles": {"it": [{"ext": "vtt"}]},
        "automatic_captions": {"it": [{"ext": "vtt"}]},
    }
    assert pick_subtitle_track(info) == ("it", "manual")


def test_automatici_nella_lingua_del_video():
    info = {
        "language": "it",
        "subtitles": {},
        "automatic_captions": {"it": [{"ext": "vtt"}], "en": [{"ext": "vtt"}]},
    }
    assert pick_subtitle_track(info) == ("it", "auto")


def test_gli_automatici_tradotti_non_si_prendono():
    """La regressione che conta. YouTube offre le didascalie automatiche
    auto-tradotte in circa duecento lingue: sono una trascrizione a macchina
    passata per una traduzione a macchina, due perdite in fila. Su un video
    italiano si prende l'italiano o niente — mai l'inglese ritradotto."""
    info = {
        "language": "it",
        "subtitles": {},
        "automatic_captions": {
            "en": [{"ext": "vtt"}],
            "es": [{"ext": "vtt"}],
            "fr": [{"ext": "vtt"}],
        },
    }
    assert pick_subtitle_track(info) is None


def test_manuale_in_altra_lingua_si_prende():
    """Un manuale, anche non nella lingua del video, e' stato scritto da
    qualcuno per quel video: non e' una traduzione automatica di una
    trascrizione automatica."""
    info = {"language": "it", "subtitles": {"en": [{"ext": "vtt"}]}, "automatic_captions": {}}
    assert pick_subtitle_track(info) == ("en", "manual")


def test_lingua_del_video_ignota_niente_automatici():
    """Senza sapere qual e' l'originale non si distingue la traccia vera
    dalle traduzioni, e indovinare significa prendere una traduzione."""
    info = {"language": None, "subtitles": {}, "automatic_captions": {"en": [{"ext": "vtt"}]}}
    assert pick_subtitle_track(info) is None


def test_un_solo_manuale_con_lingua_ignota_si_prende():
    info = {"language": None, "subtitles": {"de": [{"ext": "vtt"}]}, "automatic_captions": {}}
    assert pick_subtitle_track(info) == ("de", "manual")


def test_niente_tracce():
    assert pick_subtitle_track({"language": "it", "subtitles": {}, "automatic_captions": {}}) is None


def test_campi_mancanti_non_esplodono():
    """`info` arriva da yt-dlp e non promette nulla."""
    assert pick_subtitle_track({}) is None


def test_varianti_regionali_contano_come_la_lingua():
    """YouTube marca l'originale come `it-IT` o `en-US` a seconda del video."""
    info = {"language": "it", "subtitles": {}, "automatic_captions": {"it-IT": [{"ext": "vtt"}]}}
    assert pick_subtitle_track(info) == ("it-IT", "auto")


# ── Riduzione del VTT a testo ───────────────────────────────────────────

def test_toglie_intestazione_tempi_e_numeri():
    vtt = """WEBVTT
Kind: captions
Language: it

1
00:00:00.120 --> 00:00:02.480
Buongiorno a tutti

2
00:00:02.480 --> 00:00:04.900
e benvenuti alla puntata
"""
    assert vtt_to_text(vtt) == "Buongiorno a tutti e benvenuti alla puntata"


def test_toglie_i_marcatori_dentro_le_battute():
    """Le didascalie automatiche marcano ogni parola col suo istante."""
    vtt = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.000\n"
        "<c.colorE5E5E5>ciao</c><00:00:01.500><c> a</c><00:00:02.000><c> tutti</c>\n"
    )
    assert vtt_to_text(vtt) == "ciao a tutti"


def test_toglie_le_ripetizioni_a_scorrimento():
    """Il difetto tipico degli automatici: ogni battuta ripete la coda della
    precedente per dare l'effetto di scorrimento. Senza toglierlo il testo
    esce lungo il triplo e illeggibile."""
    vtt = """WEBVTT

00:00:00.000 --> 00:00:02.000
oggi parliamo

00:00:02.000 --> 00:00:04.000
oggi parliamo di musica

00:00:04.000 --> 00:00:06.000
di musica e di film
"""
    assert vtt_to_text(vtt) == "oggi parliamo di musica e di film"


def test_battute_identiche_consecutive_una_sola_volta():
    vtt = (
        "WEBVTT\n\n"
        "00:00:00.000 --> 00:00:02.000\nsalve\n\n"
        "00:00:02.000 --> 00:00:04.000\nsalve\n\n"
        "00:00:04.000 --> 00:00:06.000\ncome va\n"
    )
    assert vtt_to_text(vtt) == "salve come va"


def test_vtt_vuoto_da_none():
    assert vtt_to_text("WEBVTT\n\n") is None
    assert vtt_to_text("") is None


def test_allineamenti_e_posizioni_non_finiscono_nel_testo():
    vtt = (
        "WEBVTT\n\n"
        "00:00:01.000 --> 00:00:03.000 align:start position:0%\n"
        "una battuta\n"
    )
    assert vtt_to_text(vtt) == "una battuta"


# ── Il giro completo, col download iniettato ────────────────────────────

def test_fetch_usa_la_traccia_scelta_e_torna_il_testo(tmp_path):
    info = {"language": "it", "subtitles": {"it": [{"ext": "vtt"}]}, "automatic_captions": {}}
    chiamate = []

    def finto_runner(lang, kind, dest_dir):
        chiamate.append((lang, kind))
        p = dest_dir / f"sub.{lang}.vtt"
        p.write_text("WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nparole vere\n")
        return p

    res = fetch_subtitle_text(info, tmp_path, finto_runner)
    assert chiamate == [("it", "manual")]
    assert res == {"text": "parole vere", "lang": "it", "kind": "manual"}


def test_fetch_senza_tracce_non_scarica_nulla(tmp_path):
    def esplode(*a):
        raise AssertionError("non deve scaricare se non c'e' traccia")

    assert fetch_subtitle_text({"language": "it"}, tmp_path, esplode) is None


def test_fetch_sopravvive_al_download_fallito(tmp_path):
    """Un sottotitolo mancato non deve far fallire il download del video:
    si prosegue verso Whisper come se la traccia non ci fosse."""
    info = {"language": "it", "subtitles": {"it": [{"ext": "vtt"}]}, "automatic_captions": {}}

    def fallisce(lang, kind, dest_dir):
        raise RuntimeError("yt-dlp esploso")

    assert fetch_subtitle_text(info, tmp_path, fallisce) is None


def test_fetch_con_file_vuoto_da_none(tmp_path):
    info = {"language": "it", "subtitles": {"it": [{"ext": "vtt"}]}, "automatic_captions": {}}

    def vuoto(lang, kind, dest_dir):
        p = dest_dir / "sub.it.vtt"
        p.write_text("WEBVTT\n\n")
        return p

    assert fetch_subtitle_text(info, tmp_path, vuoto) is None
