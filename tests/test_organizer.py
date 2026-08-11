"""
Tests for the library organizer.

This is the only code in jimbrainz that writes to the user's filesystem, so it gets the most
paranoid coverage: everything below runs against real files in a pytest tmp_path, and the
destructive cases (overwrite, collision, move-vs-copy) are asserted explicitly rather than
assumed.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.organizer import (  # noqa: E402
    build_target_path,
    execute_plan,
    find_local_file,
    organize_job,
    plan_organization,
    sanitize_filename,
)

RELEASE = {
    "artist": "Boards of Canada",
    "album": "Music Has the Right to Children",
    "year": "1998",
    "release_mbid": "mb-1",
    "tracks": [
        {"position": 1, "title": "Wildlife Analysis", "length_ms": 87000},
        {"position": 2, "title": "An Eagle in Your Mind", "length_ms": 383000},
    ],
}


def make_job(files, release=None, directory="share/BoC/MHTRTC"):
    return {
        "id": 1, "artist": "Boards of Canada", "album": "Music Has the Right to Children",
        "username": "bob", "directory": directory,
        "release": release or RELEASE,
        "files": [{"filename": f, "size": 1000} for f in files],
    }


def seed_downloads(tmp_path, names, subdir="MHTRTC"):
    """Create files where slskd would have put them."""
    folder = tmp_path / "downloads" / subdir
    folder.mkdir(parents=True, exist_ok=True)
    for name in names:
        (folder / name).write_bytes(b"audio")
    return tmp_path / "downloads"


# ---------------------------------------------------------------- naming

def test_sanitize_strips_path_separators_and_illegal_chars():
    assert sanitize_filename('AC/DC: Back?') == "AC_DC_ Back_"


def test_sanitize_falls_back_when_nothing_survives():
    assert sanitize_filename("", "Unknown Artist") == "Unknown Artist"
    assert sanitize_filename("...") == "unknown"


def test_target_path_layout():
    target = build_target_path("/music", RELEASE, RELEASE["tracks"][0], "flac")
    assert target == Path("/music/Boards of Canada/Music Has the Right to Children (1998)/01 - Wildlife Analysis.flac")


def test_target_path_without_year_omits_the_parens():
    release = {**RELEASE, "year": ""}
    assert build_target_path("/music", release, RELEASE["tracks"][0], "flac").parent.name \
        == "Music Has the Right to Children"


def test_unmatched_track_keeps_its_original_name_rather_than_inventing_a_number():
    """A wrong track number is worse than no track number."""
    target = build_target_path("/music", RELEASE, {"filename": "hidden track"}, "flac")
    assert target.name == "hidden track.flac"


# ---------------------------------------------------------------- locating files

def test_find_local_file_locates_by_basename(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    found = find_local_file(str(root), r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac")
    assert found is not None and found.name == "01 - Wildlife Analysis.flac"


def test_find_local_file_prefers_the_matching_folder_when_ambiguous(tmp_path):
    """Same filename under two albums - the remote directory disambiguates."""
    seed_downloads(tmp_path, ["01.flac"], subdir="Geogaddi")
    seed_downloads(tmp_path, ["01.flac"], subdir="MHTRTC")
    root = tmp_path / "downloads"

    found = find_local_file(str(root), r"share\BoC\MHTRTC\01.flac", r"share\BoC\MHTRTC")
    assert found.parent.name == "MHTRTC"


def test_find_local_file_returns_none_when_absent(tmp_path):
    root = seed_downloads(tmp_path, ["other.flac"])
    assert find_local_file(str(root), r"share\x\missing.flac") is None


def test_find_local_file_tolerates_a_missing_download_root(tmp_path):
    assert find_local_file(str(tmp_path / "nope"), r"share\x\a.flac") is None


# ---------------------------------------------------------------- planning

def test_plan_maps_files_to_their_tracks(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac", "02 - An Eagle in Your Mind.flac"])
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac",
                    r"share\BoC\MHTRTC\02 - An Eagle in Your Mind.flac"])

    plan = plan_organization(job, str(root), str(tmp_path / "music"))

    assert len(plan["operations"]) == 2
    assert plan["problems"] == []
    assert Path(plan["operations"][0]["target"]).name == "01 - Wildlife Analysis.flac"
    assert plan["matched_tracks"] == 2


def test_plan_reports_files_missing_from_disk(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac",
                    r"share\BoC\MHTRTC\02 - An Eagle in Your Mind.flac"])

    plan = plan_organization(job, str(root), str(tmp_path / "music"))

    assert len(plan["operations"]) == 1
    assert any("not found on disk" in p for p in plan["problems"])


def test_plan_refuses_to_map_two_sources_onto_one_target(tmp_path):
    """Without this guard one file would silently destroy the other."""
    root = seed_downloads(tmp_path, ["a.flac", "b.flac"])
    release = {**RELEASE, "tracks": []}  # no tracklist -> names come from the files
    job = make_job([r"share\x\a.flac", r"share\x\a.flac"], release=release)

    plan = plan_organization(job, str(root), str(tmp_path / "music"))

    assert len(plan["operations"]) == 1
    assert any("same destination" in p for p in plan["problems"])


def test_plan_writes_nothing(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    plan_organization(job, str(root), str(library))

    assert not library.exists()


# ---------------------------------------------------------------- executing

def test_dry_run_touches_nothing(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    plan = plan_organization(job, str(root), str(library))
    results = execute_plan(plan, RELEASE, mode="dry_run")

    assert results["dry_run"] is True
    assert results["organized"] == 1      # reports what it *would* do
    assert not library.exists()           # but nothing exists
    assert (root / "MHTRTC" / "01 - Wildlife Analysis.flac").exists()


def test_off_mode_does_nothing_at_all(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    results = execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="off")

    assert results["organized"] == 0
    assert not library.exists()


def test_copy_leaves_the_source_in_place(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    results = execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="copy")

    assert results["organized"] == 1
    assert (library / "Boards of Canada" / "Music Has the Right to Children (1998)"
            / "01 - Wildlife Analysis.flac").exists()
    assert (root / "MHTRTC" / "01 - Wildlife Analysis.flac").exists()


def test_move_removes_the_source(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="move")

    assert (library / "Boards of Canada" / "Music Has the Right to Children (1998)"
            / "01 - Wildlife Analysis.flac").exists()
    assert not (root / "MHTRTC" / "01 - Wildlife Analysis.flac").exists()


def test_existing_destination_is_never_overwritten(tmp_path):
    """An existing file is far more likely to be the user's real album than something safe to clobber."""
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    destination = (library / "Boards of Canada" / "Music Has the Right to Children (1998)"
                   / "01 - Wildlife Analysis.flac")
    destination.parent.mkdir(parents=True)
    destination.write_bytes(b"the copy i already had")

    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])
    results = execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="move")

    assert results["skipped"] == 1
    assert results["organized"] == 0
    assert destination.read_bytes() == b"the copy i already had"
    assert (root / "MHTRTC" / "01 - Wildlife Analysis.flac").exists()  # source untouched too


def test_unknown_mode_falls_back_to_dry_run(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    results = execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="nonsense")

    assert results["dry_run"] is True
    assert not library.exists()


# ---------------------------------------------------------------- tagging

def write_minimal_flac(path: Path) -> None:
    """
    Hand-build the smallest valid FLAC: the "fLaC" marker plus one STREAMINFO block.

    Worth the fiddliness - tagging is the part most likely to silently do nothing, so the
    test needs mutagen to genuinely parse and round-trip a real container rather than a file
    that merely ends in .flac.
    """
    sample_rate, channels, bits_per_sample, total_samples = 44100, 2, 16, 44100

    packed = (sample_rate << 44) | ((channels - 1) << 41) | ((bits_per_sample - 1) << 36) | total_samples

    streaminfo = (
        (4096).to_bytes(2, "big")      # min blocksize
        + (4096).to_bytes(2, "big")    # max blocksize
        + (0).to_bytes(3, "big")       # min framesize (0 = unknown)
        + (0).to_bytes(3, "big")       # max framesize
        + packed.to_bytes(8, "big")    # rate / channels / depth / sample count
        + b"\x00" * 16                 # md5 of the audio, unused here
    )
    assert len(streaminfo) == 34

    header = bytes([0x80]) + len(streaminfo).to_bytes(3, "big")  # last-block flag | type 0
    path.write_bytes(b"fLaC" + header + streaminfo)


def test_tags_are_written_from_the_release(tmp_path):
    """
    Uses a real FLAC so mutagen actually round-trips, rather than trusting that the tag call
    would have worked on a fake file.
    """
    from mutagen.flac import FLAC

    root = tmp_path / "downloads" / "MHTRTC"
    root.mkdir(parents=True)
    write_minimal_flac(root / "01 - Wildlife Analysis.flac")

    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])
    execute_plan(plan_organization(job, str(tmp_path / "downloads"), str(library)), RELEASE, mode="copy")

    written = FLAC(str(library / "Boards of Canada" / "Music Has the Right to Children (1998)"
                       / "01 - Wildlife Analysis.flac"))
    assert written["album"][0] == "Music Has the Right to Children"
    assert written["artist"][0] == "Boards of Canada"
    assert written["title"][0] == "Wildlife Analysis"
    assert written["tracknumber"][0] == "1"
    assert written["musicbrainz_albumid"][0] == "mb-1"


def test_untaggable_file_is_still_filed(tmp_path):
    """A filed-but-untagged file beats a half-organized album."""
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac"])  # not a real flac
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    results = execute_plan(plan_organization(job, str(root), str(library)), RELEASE, mode="copy")

    assert results["organized"] == 1
    assert results["failed"] == 0


# ---------------------------------------------------------------- end to end

def test_organize_job_end_to_end_dry_run(tmp_path):
    root = seed_downloads(tmp_path, ["01 - Wildlife Analysis.flac", "02 - An Eagle in Your Mind.flac"])
    library = tmp_path / "music"
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac",
                    r"share\BoC\MHTRTC\02 - An Eagle in Your Mind.flac"])

    results = asyncio.run(organize_job(job, str(root), str(library), "dry_run"))

    assert results["organized"] == 2
    assert results["plan"]["album_dir"].endswith("Music Has the Right to Children (1998)")
    assert not library.exists()


def test_organize_job_reports_when_nothing_is_on_disk(tmp_path):
    root = tmp_path / "downloads"
    root.mkdir()
    job = make_job([r"share\BoC\MHTRTC\01 - Wildlife Analysis.flac"])

    results = asyncio.run(organize_job(job, str(root), str(tmp_path / "music"), "copy"))

    assert results["organized"] == 0
    assert results["plan"]["problems"]
