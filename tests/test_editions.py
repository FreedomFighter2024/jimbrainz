"""
Editions - the thing that made a second copy of an album vanish.

The bug these guard against: `{album} ({year})` gave the standard and the deluxe press of
the same record identical paths, execute_plan refused to overwrite, and the poller reported
the resulting all-skipped job as "organized". The album never arrived and the UI said it had.
"""

from pathlib import Path

import pytest

from src.editions import describe_edition, edition_discriminator, resolve_edition_label
from src.organizer import build_album_dirname, build_target_path, resolve_album_dir


BASE = {"artist": "Tame Impala", "album": "The Slow Rush", "year": "2020",
        "release_mbid": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}


# ---------------------------------------------------------------- label resolution

def test_ordinary_album_gets_no_edition_suffix():
    """The common case. Most albums have one edition and shouldn't be decorated."""
    assert resolve_edition_label(BASE) == ""
    assert build_album_dirname(BASE) == "The Slow Rush (2020)"


def test_musicbrainz_disambiguation_is_preferred_over_detected_tags():
    """It's the field editors use to tell releases apart, so it beats our own guessing."""
    release = {**BASE, "disambiguation": "deluxe edition", "edition_tags": ["DELUXE"]}
    assert resolve_edition_label(release) == "Deluxe edition"


def test_disambiguation_keeps_its_own_capitalisation():
    """Title-casing would turn 'CD/DVD reissue' into 'Cd/Dvd Reissue'."""
    assert resolve_edition_label({**BASE, "disambiguation": "CD/DVD reissue"}) == "CD/DVD reissue"
    assert resolve_edition_label({**BASE, "disambiguation": "iTunes exclusive"}) == "ITunes exclusive"


def test_falls_back_to_detected_edition_tags():
    release = {**BASE, "edition_tags": ["REMASTER", "DELUXE"]}
    #? sorted, so the same release always yields the same folder
    assert resolve_edition_label(release) == "Deluxe, Remaster"


def test_falls_back_to_format_but_only_a_notable_one():
    assert resolve_edition_label({**BASE, "media_format": "Vinyl"}) == "Vinyl"
    #? nearly everything is a CD or a digital download; saying so distinguishes nothing
    assert resolve_edition_label({**BASE, "media_format": "CD"}) == ""
    assert resolve_edition_label({**BASE, "media_format": "Digital Media"}) == ""


def test_falls_back_to_country_ignoring_the_worldwide_codes():
    assert resolve_edition_label({**BASE, "country": "JP"}) == "JP"
    #? XW/XE are MusicBrainz for "worldwide"/"Europe-wide" and distinguish nothing
    assert resolve_edition_label({**BASE, "country": "XW"}) == ""


def test_explicit_label_overrides_everything():
    """The hook for a future metadata manager: pick an edition, and it wins outright."""
    release = {**BASE, "edition_label": "The one with the bonus disc",
               "disambiguation": "deluxe edition", "edition_tags": ["DELUXE"]}
    assert resolve_edition_label(release) == "The one with the bonus disc"


def test_label_is_length_capped():
    assert len(resolve_edition_label({**BASE, "disambiguation": "x" * 500})) == 60


def test_describe_edition_never_returns_empty_for_display():
    assert describe_edition(BASE) == "Standard"
    assert describe_edition({**BASE, "disambiguation": "deluxe edition"}) == "Deluxe edition"


def test_discriminator_prefers_catalogue_number_then_falls_back_to_mbid():
    assert edition_discriminator({**BASE, "catalog_number": "MOSH 555"}) == "MOSH 555"
    assert edition_discriminator(BASE) == "aaaaaaaa"
    assert edition_discriminator({"album": "x"}) == ""


# ---------------------------------------------------------------- paths

def test_two_editions_of_the_same_album_no_longer_collide():
    """The actual regression. These produced byte-identical paths."""
    standard = {**BASE, "edition_tags": []}
    deluxe = {**BASE, "disambiguation": "deluxe edition", "release_mbid": "ffffffff-1111"}
    track = {"position": 1, "title": "One More Year"}

    a = build_target_path("/music", standard, track, "flac")
    b = build_target_path("/music", deluxe, track, "flac")

    assert a != b
    assert a == Path("/music/Tame Impala/The Slow Rush (2020)/01 - One More Year.flac")
    assert b == Path(
        "/music/Tame Impala/The Slow Rush (2020) [Deluxe edition]/01 - One More Year.flac"
    )


def test_edition_survives_filename_sanitising():
    release = {**BASE, "disambiguation": "the AC/DC split"}
    assert "/" not in build_album_dirname(release).replace("The Slow Rush", "")
    assert build_album_dirname(release) == "The Slow Rush (2020) [The AC_DC split]"


# ---------------------------------------------------------------- collision resolution on disk

def test_resolve_album_dir_uses_the_plain_name_when_nothing_is_there(tmp_path):
    path, discriminator = resolve_album_dir(str(tmp_path), BASE)
    assert path.name == "The Slow Rush (2020)"
    assert discriminator == ""


def test_resolve_album_dir_shares_a_folder_with_the_same_release(tmp_path):
    """Re-downloading the same edition must not fork it into a second folder."""
    existing = tmp_path / "Tame Impala" / "The Slow Rush (2020)"
    existing.mkdir(parents=True)

    path, _ = resolve_album_dir(str(tmp_path), BASE)
    assert path == existing


def test_resolve_album_dir_shares_a_folder_it_cannot_identify(tmp_path):
    """
    A library that predates jimbrainz has no MBID tags. Treating "unknown" as "different"
    would fork every one of those albums into a duplicate folder, which is far worse than
    sharing one.
    """
    existing = tmp_path / "Tame Impala" / "The Slow Rush (2020)"
    existing.mkdir(parents=True)
    (existing / "01 - One More Year.flac").write_bytes(b"not really audio")

    path, _ = resolve_album_dir(str(tmp_path), BASE)
    assert path == existing


def test_resolve_album_dir_escalates_when_a_different_release_holds_the_name(tmp_path, monkeypatch):
    """Same title, year and disambiguation, different release - the pressing case."""
    import src.organizer as organizer

    taken = tmp_path / "Tame Impala" / "The Slow Rush (2020)"
    taken.mkdir(parents=True)
    monkeypatch.setattr(organizer, "read_album_mbid", lambda d: "a-completely-different-mbid")

    release = {**BASE, "catalog_number": "MOSH 555"}
    path, discriminator = resolve_album_dir(str(tmp_path), release)

    assert path.name == "The Slow Rush (2020) [MOSH 555]"
    assert discriminator == "MOSH 555"


def test_resolve_album_dir_falls_back_to_the_release_id_when_both_are_taken(tmp_path, monkeypatch):
    import src.organizer as organizer

    artist_dir = tmp_path / "Tame Impala"
    (artist_dir / "The Slow Rush (2020)").mkdir(parents=True)
    (artist_dir / "The Slow Rush (2020) [aaaaaaaa]").mkdir(parents=True)
    monkeypatch.setattr(organizer, "read_album_mbid", lambda d: "someone-elses-mbid")

    path, discriminator = resolve_album_dir(str(tmp_path), BASE)

    assert discriminator == "aaaaaaaa"
    assert path.name == "The Slow Rush (2020) [aaaaaaaa]"


# ---------------------------------------------------------------- original release year

WYWH = {"artist": "Pink Floyd", "album": "Wish You Were Here",
        "release_mbid": "mbid-2011-remaster", "disambiguation": "2011 remaster"}


def test_the_folder_uses_the_albums_year_not_the_pressings():
    """
    A 2011 remaster of a 1975 record belongs under 1975.

    The year identifies the album and the edition identifies the pressing. Naming the folder
    after the reissue date files the same record under two different decades depending on
    which copy you happened to get, which is exactly the kind of split this project exists
    to avoid.
    """
    release = {**WYWH, "year": "2011", "original_year": "1975"}
    assert build_album_dirname(release) == "Wish You Were Here (1975) [2011 remaster]"


def test_a_reissue_and_the_original_still_get_separate_folders():
    """Sharing a year must not merge them - that's what the edition suffix is for."""
    original = {**WYWH, "year": "1975", "original_year": "1975",
                "disambiguation": "", "release_mbid": "mbid-original"}
    remaster = {**WYWH, "year": "2011", "original_year": "1975"}

    assert build_album_dirname(original) == "Wish You Were Here (1975)"
    assert build_album_dirname(remaster) == "Wish You Were Here (1975) [2011 remaster]"
    assert build_album_dirname(original) != build_album_dirname(remaster)


def test_without_an_original_year_nothing_changes():
    """Everything already in a library predates this field and must keep its folder."""
    assert build_album_dirname({**WYWH, "year": "2011"}) == \
        "Wish You Were Here (2011) [2011 remaster]"


def test_the_pressing_year_is_still_what_the_date_tag_records():
    """The folder says 1975; the file should still say which copy it actually is."""
    from src.organizer import tag_values

    values = tag_values({**WYWH, "year": "2011", "original_year": "1975"}, None)
    assert values["date"] == "2011"
    assert values["originaldate"] == "1975"


# ===== alternate performances ================================================
#
# A different KIND of edition from deluxe/remaster, and the reason it matters more:
#
#   A deluxe edition is more of the same album, so colliding it with the standard press
#   loses a few bonus tracks. An instrumental is a different RECORDING of the same album -
#   identical track titles, identical numbers, identical count - so colliding it means every
#   file matches one already on disk, all of them are skipped, and the job reports that
#   nothing needed doing. You asked for an album and got neither.
#
# Dance Gavin Dance is the case that surfaced it. Verified against the live API: MusicBrainz
# holds the instrumental as a RELEASE inside the ordinary album's group, carrying
# "(instrumental)" in its TITLE with an EMPTY disambiguation - so every source
# resolve_edition_label() consults returned blank.


def test_an_instrumental_release_does_not_share_the_standard_album_folder():
    """The reported bug, pinned end to end."""
    standard = {**BASE, "album": "Afterburner", "title": "Afterburner",
                "disambiguation": "", "edition_tags": []}
    instrumental = {**BASE, "album": "Afterburner", "title": "Afterburner (instrumental)",
                    "disambiguation": "", "edition_tags": ["INSTRUMENTAL"],
                    "release_mbid": "11111111-2222-3333-4444-555555555555"}

    assert resolve_edition_label(standard) == ""
    assert resolve_edition_label(instrumental) == "Instrumental"

    assert build_album_dirname(standard, "") != build_album_dirname(instrumental, "")
    assert build_album_dirname(instrumental, "") == "Afterburner (2020) [Instrumental]"


@pytest.mark.parametrize(
    "tag, expected",
    [
        (["INSTRUMENTAL"], "Instrumental"),
        (["ACOUSTIC"], "Acoustic"),
        (["A CAPPELLA"], "A Cappella"),
    ],
)
def test_every_alternate_performance_marker_produces_a_label(tag, expected):
    assert resolve_edition_label({**BASE, "edition_tags": tag}) == expected


def test_an_instrumental_still_defers_to_musicbrainz_disambiguation():
    """
    The precedence order is unchanged. If an editor has said what the release IS, that beats
    a keyword scraped out of the title - the whole reason disambiguation sits above tags.
    """
    release = {**BASE, "title": "Afterburner (instrumental)",
               "disambiguation": "instrumental version, Japanese pressing",
               "edition_tags": ["INSTRUMENTAL"]}

    assert resolve_edition_label(release) == "Instrumental version, Japanese pressing"
