"""
Applying a release to an album already in the library.

This is the second thing in jimbrainz that writes to the user's filesystem, and unlike the
organizer it operates on files the user already had rather than ones we just downloaded. The
guards matter more than the happy path here, so most of these are about what it refuses.
"""

import shutil
from pathlib import Path

import pytest
from mutagen.flac import FLAC

from src.retag import execute_retag, plan_retag, read_current_tags

STREAMINFO = (
    b"fLaC" + b"\x80\x00\x00\x22"
    + b"\x10\x00\x10\x00\x00\x00\x00\x00\x00\x00\x0a\xc4\x42\xf0\x00\x00\x00\x00" + b"\x00" * 16
)


def write_flac(path, **tags):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(STREAMINFO)
    audio = FLAC(str(path))
    for key, value in tags.items():
        audio[key] = str(value)
    audio.save()
    return path


def seed(root, artist="Tame Impala", folder="The Slow Rush (2020)", album="The Slow Rush",
         titles=("One More Year", "Instant Destiny"), **extra):
    directory = root / artist / folder
    for n, title in enumerate(titles, start=1):
        write_flac(directory / f"{n:02d} - {title}.flac", album=album, albumartist=artist,
                   artist=artist, title=title, tracknumber=str(n), date="2020", **extra)
    return directory


RELEASE = {
    "artist": "Tame Impala",
    "album": "The Slow Rush",
    "year": "2020",
    "release_mbid": "mbid-deluxe",
    "disambiguation": "deluxe edition",
    "tracks": [
        {"position": 1, "title": "One More Year", "length_ms": 1000},
        {"position": 2, "title": "Instant Destiny", "length_ms": 1000},
    ],
}


# ---------------------------------------------------------------- planning

def test_plan_reports_the_tags_that_would_change(tmp_path):
    seed(tmp_path)
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    assert plan["file_count"] == 2
    assert plan["matched_tracks"] == 2
    assert plan["changed_file_count"] == 2

    first = plan["files"][0]
    #? the album already carried these, so they aren't listed as changes
    assert "album" not in first["changes"]
    #? but it had no MBID, so that's new
    assert first["changes"]["musicbrainz_albumid"] == {"from": "", "to": "mbid-deluxe"}


def test_plan_writes_nothing(tmp_path):
    directory = seed(tmp_path)
    before = {p.name: p.read_bytes() for p in directory.iterdir()}

    plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before


def test_plan_targets_the_edition_aware_folder_name(tmp_path):
    """A hand-corrected album should land where a freshly downloaded one would have."""
    seed(tmp_path)
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    assert plan["moves"] is True
    assert plan["target_path"] == "Tame Impala/The Slow Rush (2020) [Deluxe edition]"
    assert plan["edition_label"] == "Deluxe edition"


def test_plan_does_not_move_when_the_name_is_already_right(tmp_path):
    seed(tmp_path, folder="The Slow Rush (2020) [Deluxe edition]")
    plan = plan_retag("Tame Impala/The Slow Rush (2020) [Deluxe edition]", RELEASE, str(tmp_path))
    assert plan["moves"] is False


def test_plan_refuses_to_merge_into_an_existing_folder(tmp_path):
    """Two albums becoming one is not something to do quietly."""
    seed(tmp_path)
    (tmp_path / "Tame Impala" / "The Slow Rush (2020) [Deluxe edition]").mkdir(parents=True)

    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    assert plan["moves"] is False
    assert any("already exists" in p for p in plan["problems"])


def test_plan_flags_a_tracklist_that_does_not_fit(tmp_path):
    seed(tmp_path, titles=("One More Year",))
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))
    assert any("2 track(s) but the folder has 1" in p for p in plan["problems"])


def test_unmatched_files_keep_their_own_title_and_number(tmp_path):
    """A wrong track number is worse than none - same rule as the organizer."""
    seed(tmp_path, titles=("One More Year", "Something Else Entirely"))
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    unmatched = [f for f in plan["files"] if not f["matched"]]
    assert len(unmatched) == 1
    assert "title" not in unmatched[0]["changes"]
    assert "tracknumber" not in unmatched[0]["changes"]
    assert any("didn't match the tracklist" in p for p in plan["problems"])


@pytest.mark.parametrize("attempt", ["../../../etc", "", "/etc", "Tame Impala/../../.."])
def test_plan_refuses_anything_outside_the_library(tmp_path, attempt):
    seed(tmp_path)
    plan = plan_retag(attempt, RELEASE, str(tmp_path))
    assert plan["source"] is None
    assert plan["problems"] == ["that album is not inside the library"]


def test_plan_refuses_a_symlink_out_of_the_library(tmp_path):
    import os
    outside = tmp_path.parent / "outside-retag"
    outside.mkdir(exist_ok=True)
    write_flac(outside / "01 - Track.flac", album="Elsewhere")

    seed(tmp_path)
    os.symlink(outside, tmp_path / "escape")

    assert plan_retag("escape", RELEASE, str(tmp_path))["source"] is None


# ---------------------------------------------------------------- executing

def test_dry_run_changes_nothing_on_disk(tmp_path):
    directory = seed(tmp_path)
    before = {p.name: p.read_bytes() for p in directory.iterdir()}

    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))
    results = execute_retag(plan, RELEASE, "dry_run")

    assert results["dry_run"] is True
    assert results["tagged"] == 2
    assert directory.exists()
    assert {p.name: p.read_bytes() for p in directory.iterdir()} == before


def test_apply_writes_the_tags_and_refiles_the_folder(tmp_path):
    seed(tmp_path)
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))
    results = execute_retag(plan, RELEASE, "apply")

    moved = tmp_path / "Tame Impala" / "The Slow Rush (2020) [Deluxe edition]"
    assert results["failed"] == 0
    assert results["moved_to"] == str(moved)
    assert moved.is_dir()
    assert not (tmp_path / "Tame Impala" / "The Slow Rush (2020)").exists()

    tags = read_current_tags(sorted(moved.glob("*.flac"))[0])
    assert tags["musicbrainz_albumid"] == "mbid-deluxe"
    assert tags["title"] == "One More Year"


def test_applying_twice_is_a_no_op_the_second_time(tmp_path):
    """The album is already correct, so there is nothing left to change."""
    seed(tmp_path)
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))
    execute_retag(plan, RELEASE, "apply")

    again = plan_retag("Tame Impala/The Slow Rush (2020) [Deluxe edition]", RELEASE, str(tmp_path))
    assert again["empty"] is True
    assert again["changed_file_count"] == 0
    assert again["moves"] is False


def test_an_explicit_edition_label_beats_the_disambiguation(tmp_path):
    """The metadata-manager override: name this edition whatever the user says."""
    seed(tmp_path)
    release = {**RELEASE, "edition_label": "Japanese promo"}

    plan = plan_retag("Tame Impala/The Slow Rush (2020)", release, str(tmp_path))
    execute_retag(plan, release, "apply")

    assert (tmp_path / "Tame Impala" / "The Slow Rush (2020) [Japanese promo]").is_dir()


def test_the_folder_stays_put_when_a_file_fails(tmp_path, monkeypatch):
    """Half an album in one folder and half in another is the worst possible outcome."""
    import src.retag as retag

    seed(tmp_path)
    plan = plan_retag("Tame Impala/The Slow Rush (2020)", RELEASE, str(tmp_path))

    def explode(*args, **kwargs):
        raise OSError("disk went away")

    monkeypatch.setattr(retag, "write_tags", explode)
    results = execute_retag(plan, RELEASE, "apply")

    assert results["failed"] == 2
    assert results["moved_to"] is None
    assert (tmp_path / "Tame Impala" / "The Slow Rush (2020)").is_dir()
    assert any("left the folder in place" in p for p in results["problems"])
