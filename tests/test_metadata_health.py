"""
The metadata queue's rules.

Two halves, deliberately:

  Most of it is plain dicts, because metadata_health is pure and its input is the album shape
  library.py already produces. Building real files to test a rule about a missing string would
  be testing mutagen.

  A few go through a real scan of real tagged files. Those are the ones that matter most,
  because the `misfiled` rule compares a folder name against a name it recomputes from the
  tags - and if those two ever disagree by construction, EVERY album in a library gets flagged
  and the queue is worthless. That risk lives in the seam between two modules, so the test has
  to cross it.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import pytest  # noqa: E402

from src import library  # noqa: E402
from src.library import scan_library  # noqa: E402
from src.metadata_health import (  # noqa: E402
    ISSUE_TYPES,
    attach_issues,
    expected_dirname,
    inspect_album,
    outstanding,
    worst_severity,
)
from src.organizer import build_album_dirname  # noqa: E402
from tests.test_library import write_flac  # noqa: E402


def make_album(**overrides) -> dict:
    """
    An album with nothing wrong with it, as the scanner would report it.

    Every test below breaks exactly one thing, so a failure names the rule that fired rather
    than leaving you to work out which of nine issues was the unexpected one.
    """
    album = {
        "key": "rel-1",
        "artist": "Pink Floyd",
        "album": "Wish You Were Here",
        "year": "2011",
        "original_year": "1975",
        "edition": "2011 remaster",
        "release_mbid": "rel-1",
        "art": "file",
        "path": "Pink Floyd/Wish You Were Here (1975) [2011 remaster]",
        "track_count": 2,
        "untitled_tracks": 0,
        "mixed_tags": False,
        "tracks": [
            {"filename": "01 - Shine On.flac", "title": "Shine On", "position": 1,
             "has_title_tag": True, "artist": "Pink Floyd", "albumartist": "Pink Floyd"},
            {"filename": "02 - Welcome.flac", "title": "Welcome", "position": 2,
             "has_title_tag": True, "artist": "Pink Floyd", "albumartist": "Pink Floyd"},
        ],
    }
    album.update(overrides)
    return album


@pytest.fixture
def clear_cache():
    library._album_cache.clear()
    yield
    library._album_cache.clear()


# ---------------------------------------------------------------- a clean album

def test_a_fully_tagged_album_has_no_issues():
    assert inspect_album(make_album()) == []


def test_every_issue_code_is_described():
    """
    The interface renders label and hint straight out of the response, so a code with no entry
    would reach the browser as a blank chip.
    """
    album = make_album(
        release_mbid="", year="", original_year="", art="", mixed_tags=True,
        untitled_tracks=1, path="loose album",
        tracks=[{"filename": "a.flac", "title": "a", "position": None,
                 "has_title_tag": False, "artist": "", "albumartist": ""}],
    )

    issues = inspect_album(album)

    assert set(issues) == set(ISSUE_TYPES), "the worst-case album should trip every rule"
    for code in issues:
        assert ISSUE_TYPES[code]["label"]
        assert ISSUE_TYPES[code]["hint"]


def test_issues_come_back_worst_first():
    album = make_album(release_mbid="", art="")
    assert inspect_album(album) == ["no_release", "no_art"]


# ---------------------------------------------------------------- individual rules

def test_an_untagged_album_has_no_release():
    assert "no_release" in inspect_album(make_album(release_mbid=""))
    assert "no_release" in inspect_album(make_album(release_mbid="   "))


def test_missing_original_year_is_flagged_even_when_the_year_is_there():
    """
    The common state of any library organized before the folder convention changed: a date tag
    but no originaldate, so nothing records the album's own year.
    """
    issues = inspect_album(make_album(original_year="", year="1975",
                                      path="Pink Floyd/Wish You Were Here (1975) [2011 remaster]"))
    assert "no_original_year" in issues
    assert "no_year" not in issues


def test_no_artist_tag_only_fires_when_no_file_names_an_artist():
    """
    The displayed artist falls back to the folder name, which is indistinguishable from a real
    tag afterwards - so this reads the tracks, not the resolved album.
    """
    none_tagged = make_album(tracks=[
        {"filename": "a.flac", "title": "a", "position": 1, "has_title_tag": True,
         "artist": "", "albumartist": ""},
    ])
    assert "no_artist_tag" in inspect_album(none_tagged)

    #? one file carrying only the track artist is still an album that names its artist
    partly_tagged = make_album(tracks=[
        {"filename": "a.flac", "title": "a", "position": 1, "has_title_tag": True,
         "artist": "Pink Floyd", "albumartist": ""},
    ])
    assert "no_artist_tag" not in inspect_album(partly_tagged)


def test_untitled_tracks_come_from_the_scan_count():
    """
    A missing title is invisible after the fact - it falls back to the filename stem - so the
    scan counts it and this rule trusts that count.
    """
    assert "untitled_tracks" in inspect_album(make_album(untitled_tracks=2))
    assert "untitled_tracks" not in inspect_album(make_album(untitled_tracks=0))


def test_unnumbered_tracks_are_flagged():
    album = make_album(tracks=[
        {"filename": "a.flac", "title": "a", "position": None, "has_title_tag": True,
         "artist": "Pink Floyd", "albumartist": "Pink Floyd"},
    ])
    assert "unnumbered_tracks" in inspect_album(album)


def test_embedded_art_counts_as_having_art():
    assert "no_art" not in inspect_album(make_album(art="embedded"))
    assert "no_art" in inspect_album(make_album(art=""))


# ---------------------------------------------------------------- the misfiled rule

def test_expected_dirname_uses_the_album_year_not_the_pressings():
    """The folder is named after the album's own year - see build_album_dirname."""
    assert expected_dirname(make_album()) == "Wish You Were Here (1975) [2011 remaster]"


def test_expected_dirname_falls_back_to_the_pressing_year():
    album = make_album(original_year="", edition="")
    assert expected_dirname(album).startswith("Wish You Were Here (2011)")


def test_a_folder_matching_its_tags_is_not_misfiled():
    assert "misfiled" not in inspect_album(make_album())


def test_a_folder_named_after_the_reissue_year_is_misfiled():
    """The exact state of anything filed before the year convention changed."""
    album = make_album(path="Pink Floyd/Wish You Were Here (2011) [2011 remaster]")
    assert "misfiled" in inspect_album(album)


def test_a_folder_whose_album_name_disagrees_with_its_tags_is_misfiled():
    album = make_album(path="Pink Floyd/wish you were here (1975) [2011 remaster]")
    assert "misfiled" in inspect_album(album)


def test_an_album_in_the_wrong_artist_folder_is_misfiled():
    album = make_album(path="Roger Waters/Wish You Were Here (1975) [2011 remaster]")
    assert "misfiled" in inspect_album(album)


def test_an_album_loose_in_the_library_root_is_misfiled():
    """No artist folder at all, which is off-convention by definition."""
    album = make_album(path="Wish You Were Here (1975) [2011 remaster]")
    assert "misfiled" in inspect_album(album)


def test_the_edition_comes_from_the_folder_not_the_display_field():
    """
    The scanner rewrites `edition` to "Standard" for an unlabelled folder that has labelled
    siblings. Using that field would compute an expected name of "Album (Year) [Standard]" and
    flag a perfectly correct folder as misfiled - so this reads the folder's own suffix.
    """
    album = make_album(edition="Standard", path="Pink Floyd/Wish You Were Here (1975)")
    assert "misfiled" not in inspect_album(album)


# ---------------------------------------------------------------- ignoring

def test_ignoring_an_issue_removes_it_from_what_is_outstanding():
    assert outstanding(["no_release", "no_art"], ["no_art"]) == ["no_release"]


def test_ignoring_one_issue_leaves_the_others_reported():
    """
    The reason ignores are stored per issue: accepting that a bootleg will never be in
    MusicBrainz must not also silence the day its cover art goes missing.
    """
    assert outstanding(["no_release", "no_art"], ["no_release"]) == ["no_art"]


def test_worst_severity_of_nothing_sorts_last():
    assert worst_severity([]) == 0
    assert worst_severity(["no_art"]) < worst_severity(["no_release"])


# ---------------------------------------------------------------- attach_issues

def test_attach_issues_decorates_albums_and_counts_the_queue():
    clean = make_album()
    broken = make_album(path="Tame Impala/Currents", artist="Tame Impala", album="Currents",
                        release_mbid="", original_year="", year="", art="", edition="")

    summary = attach_issues([clean, broken])

    assert clean["needs_attention"] is False
    assert clean["issues"] == []
    assert broken["needs_attention"] is True
    assert summary["total"] == 1
    assert summary["by_issue"]["no_release"] == 1


def test_attach_issues_respects_stored_ignores():
    album = make_album(art="")
    reviews = {album["path"]: {"ignored_issues": ["no_art"], "first_seen": "2026-01-01T00:00:00+00:00"}}

    summary = attach_issues([album], reviews)

    assert album["issues"] == ["no_art"], "the issue is still reported"
    assert album["needs_attention"] is False, "but it no longer wants attention"
    assert summary["total"] == 0
    assert summary["ignored_albums"] == 1


def test_attach_issues_counts_unreviewed_imports_only():
    fresh = make_album(path="a/one")
    seen = make_album(path="a/two")
    found = make_album(path="a/three")

    summary = attach_issues([fresh, seen, found], {
        "a/one": {"source": "import"},
        "a/two": {"source": "import", "reviewed_at": "2026-01-01T00:00:00+00:00"},
        "a/three": {"source": "scan"},
    })

    assert summary["new_imports"] == 1
    assert fresh["imported"] is True
    assert found["imported"] is False


def test_attach_issues_works_with_no_store_at_all():
    """The SQLite store is allowed to be unopenable; the queue just stops remembering ignores."""
    album = make_album(art="")
    summary = attach_issues([album], None)

    assert album["ignored_issues"] == []
    assert summary["total"] == 1


# ---------------------------------------------------------------- against real files

def seed_organized_album(root, release):
    """
    File an album exactly the way the organizer would, then let the scanner find it.

    Uses build_album_dirname rather than a hand-written folder name on purpose: the point is to
    prove the two ends of the convention agree, so hard-coding the expected name here would
    quietly test this test instead.
    """
    directory = root / release["artist"] / build_album_dirname(release)

    for n in (1, 2):
        write_flac(
            directory / f"{n:02d} - Track {n}.flac",
            album=release["album"], albumartist=release["artist"], artist=release["artist"],
            title=f"Track {n}", tracknumber=str(n),
            date=release["year"], originaldate=release["original_year"],
            musicbrainz_albumid=release["release_mbid"],
        )

    (directory / "cover.jpg").write_bytes(b"\xff\xd8\xff")
    return directory


def test_an_album_the_organizer_filed_has_nothing_wrong_with_it(tmp_path, clear_cache):
    """
    The load-bearing test in this file.

    If `expected_dirname` and `build_album_dirname` ever disagree, every album in a real
    library is reported as misfiled and the queue becomes noise you learn to ignore. Nothing
    else catches that - both sides would still pass their own unit tests.
    """
    release = {
        "artist": "Pink Floyd", "album": "Wish You Were Here",
        "year": "2011", "original_year": "1975",
        "release_mbid": "f5093c06-0000-0000-0000-000000000000",
        "edition_label": "2011 remaster",
    }
    seed_organized_album(tmp_path, release)

    result = scan_library(str(tmp_path))
    attach_issues(result["albums"])
    album = result["albums"][0]

    assert album["issues"] == [], f"a freshly organized album was flagged: {album['issues']}"
    assert album["needs_attention"] is False


def test_an_album_with_no_suffix_is_also_clean(tmp_path, clear_cache):
    """The ordinary case: one edition, so build_album_dirname writes no `[...]` at all."""
    release = {
        "artist": "Tame Impala", "album": "Currents",
        "year": "2015", "original_year": "2015",
        "release_mbid": "aaaaaaaa-0000-0000-0000-000000000000",
    }
    seed_organized_album(tmp_path, release)

    result = scan_library(str(tmp_path))
    attach_issues(result["albums"])

    assert result["albums"][0]["issues"] == []


def test_an_untagged_folder_is_flagged_for_everything_it_lacks(tmp_path, clear_cache):
    """A library that predates jimbrainz: files with a title and nothing else."""
    directory = tmp_path / "Some Artist" / "some album"
    for n in (1, 2):
        write_flac(directory / f"track{n}.flac", title=f"Track {n}")

    result = scan_library(str(tmp_path))
    attach_issues(result["albums"])
    issues = result["albums"][0]["issues"]

    assert "no_release" in issues
    assert "no_artist_tag" in issues
    assert "no_year" in issues
    assert "no_original_year" in issues
    assert "unnumbered_tracks" in issues
    assert "no_art" in issues


def test_a_file_with_no_title_tag_is_counted_by_the_scan(tmp_path, clear_cache):
    """
    The scan has to record this, because afterwards an untitled file is indistinguishable from
    a titled one - read_track falls back to the filename stem.
    """
    directory = tmp_path / "Some Artist" / "some album"
    write_flac(directory / "01 - Real Title.flac", title="Real Title", tracknumber="1")
    write_flac(directory / "02 - No Tag.flac", tracknumber="2")

    result = scan_library(str(tmp_path))
    album = result["albums"][0]

    assert album["untitled_tracks"] == 1
    assert "untitled_tracks" in inspect_album(album)
