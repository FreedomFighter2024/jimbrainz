"""
Deleting an album.

The only code in jimbrainz that removes something the user did not just download, and the
only one with no undo - so nearly all of this is about what it refuses to do. The happy
path is one test; the rest are guards.
"""

from pathlib import Path

import pytest
from mutagen.flac import FLAC

from src import library
from src.library import delete_album, summarize_for_deletion

STREAMINFO = (
    b"fLaC" + b"\x80\x00\x00\x22"
    + b"\x10\x00\x10\x00\x00\x00\x00\x00\x00\x00\x0a\xc4\x42\xf0\x00\x00\x00\x00" + b"\x00" * 16
)


def seed(root, artist="Tame Impala", folder="Currents (2015)", tracks=3):
    directory = root / artist / folder
    directory.mkdir(parents=True, exist_ok=True)
    for n in range(1, tracks + 1):
        p = directory / f"{n:02d} - Track {n}.flac"
        p.write_bytes(STREAMINFO)
        a = FLAC(str(p)); a["album"] = "Currents"; a["artist"] = artist; a.save()
    return directory


@pytest.fixture(autouse=True)
def clear_cache():
    library._album_cache.clear()
    yield
    library._album_cache.clear()


# ---------------------------------------------------------------- the happy path

def test_deletes_the_album_and_reports_what_went(tmp_path):
    directory = seed(tmp_path)
    (directory / "cover.jpg").write_bytes(b"\xff\xd8art")

    result = delete_album(str(tmp_path), "Tame Impala/Currents (2015)")

    assert result["deleted"] is True
    assert result["audio_files"] == 3
    assert result["total_bytes"] > 0
    assert not directory.exists()


def test_an_emptied_artist_folder_is_tidied_away(tmp_path):
    seed(tmp_path)
    delete_album(str(tmp_path), "Tame Impala/Currents (2015)")
    assert not (tmp_path / "Tame Impala").exists()


def test_an_artist_with_other_albums_is_left_alone(tmp_path):
    seed(tmp_path, folder="Currents (2015)")
    seed(tmp_path, folder="The Slow Rush (2020)")

    delete_album(str(tmp_path), "Tame Impala/Currents (2015)")

    assert (tmp_path / "Tame Impala").is_dir()
    assert (tmp_path / "Tame Impala" / "The Slow Rush (2020)").is_dir()


def test_the_scan_cache_forgets_it(tmp_path):
    """Otherwise the album keeps appearing in the library after it's gone."""
    from src.library import scan_library

    seed(tmp_path)
    scan_library(str(tmp_path))
    assert len(library._album_cache) == 1

    delete_album(str(tmp_path), "Tame Impala/Currents (2015)")
    assert len(library._album_cache) == 0
    assert scan_library(str(tmp_path))["album_count"] == 0


# ---------------------------------------------------------------- what it refuses

@pytest.mark.parametrize("attempt", ["../..", "", "/etc", "Tame Impala/../../..", "."])
def test_refuses_anything_outside_the_library(tmp_path, attempt):
    seed(tmp_path)
    result = delete_album(str(tmp_path), attempt)

    assert result["deleted"] is False
    assert (tmp_path / "Tame Impala" / "Currents (2015)").is_dir()


def test_refuses_the_library_root_itself(tmp_path):
    """rmtree here would take the entire collection."""
    seed(tmp_path)

    for attempt in ("", ".", "./"):
        assert delete_album(str(tmp_path), attempt)["deleted"] is False

    assert (tmp_path / "Tame Impala" / "Currents (2015)").is_dir()


def test_refuses_a_symlink_pointing_out_of_the_library(tmp_path):
    import os
    outside = tmp_path.parent / "outside-delete"
    outside.mkdir(exist_ok=True)
    (outside / "precious.flac").write_bytes(STREAMINFO)

    seed(tmp_path)
    os.symlink(outside, tmp_path / "escape")

    assert delete_album(str(tmp_path), "escape")["deleted"] is False
    assert (outside / "precious.flac").exists()


def test_refuses_a_folder_with_no_audio(tmp_path):
    """
    An artist folder, or anything else the user keeps in there. "Delete this album" should
    not be able to remove something that isn't one.
    """
    seed(tmp_path)
    assert delete_album(str(tmp_path), "Tame Impala")["deleted"] is False
    assert (tmp_path / "Tame Impala").is_dir()

    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "todo.txt").write_text("keep me")
    assert delete_album(str(tmp_path), "notes")["deleted"] is False
    assert (notes / "todo.txt").exists()


def test_refuses_a_folder_that_is_already_gone(tmp_path):
    seed(tmp_path)
    result = delete_album(str(tmp_path), "Tame Impala/Nothing Here")
    assert result["deleted"] is False
    assert "not there" in result["problem"]


def test_refuses_when_no_library_is_configured(tmp_path):
    assert delete_album("", "anything")["deleted"] is False


# ---------------------------------------------------------------- the summary

def test_summary_counts_what_would_go(tmp_path):
    directory = seed(tmp_path, tracks=2)
    (directory / "cover.jpg").write_bytes(b"\xff\xd8art")
    (directory / "rip.log").write_text("EAC log")
    (directory / "album.cue").write_text("CUE")

    summary = summarize_for_deletion(directory)

    assert summary["audio_files"] == 2
    #? artwork isn't listed separately - it belongs to the album and nobody is surprised it
    #? goes. A log or a cue sheet might be the only copy, so those are named.
    assert sorted(summary["other_files"]) == ["album.cue", "rip.log"]
    assert summary["other_file_count"] == 2
    assert summary["total_bytes"] > 0
