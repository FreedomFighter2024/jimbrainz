"""
Scanning what's already on disk.

These use real files with real tags written by mutagen rather than mocks, because the whole
risk in this module is what tags actually come back off a file - which is exactly what a mock
would paper over.
"""

from mutagen.flac import FLAC

import pytest

from src import library
from src.library import scan_library


def write_flac(path, **tags):
    """
    A minimal but genuinely valid FLAC file, so mutagen reads it for real.

    Hand-rolled rather than shipping a binary fixture: a 44-byte stream is easier to reason
    about than an opaque blob in the repo, and it keeps the tags visible in the test.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    #? fLaC magic + a STREAMINFO block (mandatory, last-block flag set)
    streaminfo = (
        b"fLaC"
        + b"\x80\x00\x00\x22"
        + b"\x10\x00\x10\x00\x00\x00\x00\x00\x00\x00\x0a\xc4\x42\xf0\x00\x00\x00\x00"
        + b"\x00" * 16
    )
    path.write_bytes(streaminfo)

    audio = FLAC(str(path))
    for key, value in tags.items():
        audio[key] = str(value)
    audio.save()
    return path


@pytest.fixture
def clear_cache():
    library._album_cache.clear()
    yield
    library._album_cache.clear()


def seed_album(root, artist, folder, album, tracks=2, mbid=None, date="2020"):
    directory = root / artist / folder
    for n in range(1, tracks + 1):
        tags = {"album": album, "albumartist": artist, "artist": artist,
                "title": f"Track {n}", "tracknumber": str(n), "date": date}
        if mbid:
            tags["musicbrainz_albumid"] = mbid
        write_flac(directory / f"{n:02d} - Track {n}.flac", **tags)
    return directory


# ---------------------------------------------------------------- basics

def test_unset_library_path_is_reported_not_raised(clear_cache):
    """An unconfigured path is an unfinished setup, not a crash."""
    result = scan_library("")
    assert result["albums"] == []
    assert "not set" in result["problem"]


def test_missing_directory_is_reported(tmp_path, clear_cache):
    result = scan_library(str(tmp_path / "nope"))
    assert "does not exist" in result["problem"]


def test_scans_albums_and_rolls_up_artists(tmp_path, clear_cache):
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    seed_album(tmp_path, "Boards of Canada", "Geogaddi (2002)", "Geogaddi", tracks=3)

    result = scan_library(str(tmp_path))

    assert result["album_count"] == 2
    assert result["artist_count"] == 2
    assert [a["artist"] for a in result["artists"]] == ["Boards of Canada", "Tame Impala"]
    assert [a["album_count"] for a in result["artists"]] == [1, 1]

    geogaddi = next(a for a in result["albums"] if a["album"] == "Geogaddi")
    assert geogaddi["track_count"] == 3
    assert geogaddi["year"] == "2020"
    assert geogaddi["formats"] == ["flac"]
    assert [t["position"] for t in geogaddi["tracks"]] == [1, 2, 3]


def test_directories_without_audio_are_not_albums(tmp_path, clear_cache):
    (tmp_path / "Artist" / "notes").mkdir(parents=True)
    (tmp_path / "Artist" / "notes" / "readme.txt").write_text("hi")
    assert scan_library(str(tmp_path))["album_count"] == 0


# ---------------------------------------------------------------- editions, the point

def test_two_editions_of_one_album_are_kept_apart_and_flagged(tmp_path, clear_cache):
    """The headline case: both versions present, both visible, both marked."""
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)",
               "The Slow Rush", mbid="mbid-standard")
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020) [Deluxe edition]",
               "The Slow Rush", mbid="mbid-deluxe", tracks=4)

    result = scan_library(str(tmp_path))
    slow_rush = [a for a in result["albums"] if a["album"] == "The Slow Rush"]

    assert len(slow_rush) == 2
    assert {a["edition"] for a in slow_rush} == {"Standard", "Deluxe edition"}
    assert all(a["edition_count"] == 2 for a in slow_rush)
    #? distinct identities, so nothing merges them back together
    assert len({a["key"] for a in slow_rush}) == 2


def test_a_single_edition_album_is_not_labelled_standard(tmp_path, clear_cache):
    """Only worth saying "Standard" when there's something to contrast it with."""
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    album = scan_library(str(tmp_path))["albums"][0]
    assert album["edition"] == ""
    assert album["edition_count"] == 1


def test_identity_follows_the_mbid_not_the_folder_name(tmp_path, clear_cache):
    """Renaming a folder by hand must not split one album into two."""
    seed_album(tmp_path, "Tame Impala", "whatever i renamed it to",
               "The Slow Rush", mbid="mbid-standard")
    album = scan_library(str(tmp_path))["albums"][0]
    assert album["key"] == "mbid-standard"


def test_untagged_folders_stay_separate_albums(tmp_path, clear_cache):
    """
    No MBIDs at all, as in any library predating jimbrainz. Two folders must stay two
    albums - merging them because their tags look similar would hide something the user
    deliberately keeps apart.
    """
    seed_album(tmp_path, "Tame Impala", "The Slow Rush", "The Slow Rush")
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (deluxe)", "The Slow Rush")

    albums = scan_library(str(tmp_path))["albums"]
    assert len(albums) == 2
    assert len({a["key"] for a in albums}) == 2
    assert all(a["key"].startswith("path:") for a in albums)


def test_mixed_album_tags_are_surfaced(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Various", "Comp (1999)", "Comp")
    write_flac(directory / "03 - Odd.flac", album="Something Else",
               albumartist="Various", artist="Various", title="Odd", tracknumber="3")

    album = scan_library(str(tmp_path))["albums"][0]
    assert album["mixed_tags"] is True


# ---------------------------------------------------------------- caching

def test_unchanged_folders_are_reused_on_a_second_scan(tmp_path, clear_cache):
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")

    assert scan_library(str(tmp_path))["cached"] == 0
    assert scan_library(str(tmp_path))["cached"] == 1


def test_force_rescan_ignores_the_cache(tmp_path, clear_cache):
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    scan_library(str(tmp_path))
    assert scan_library(str(tmp_path), force=True)["cached"] == 0


def test_deleted_albums_leave_the_cache(tmp_path, clear_cache):
    """A long-running container shouldn't accumulate albums the user removed."""
    import shutil
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    scan_library(str(tmp_path))
    assert len(library._album_cache) == 1

    shutil.rmtree(directory)
    result = scan_library(str(tmp_path))

    assert result["album_count"] == 0
    assert len(library._album_cache) == 0


# ---------------------------------------------------------------- cover art

def write_image(path, data=b"\xff\xd8\xff\xe0 fake jpeg body"):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def test_cover_file_beside_the_tracks_is_found(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "cover.jpg")

    assert scan_library(str(tmp_path))["albums"][0]["art"] == "file"

    data, mime = library.load_album_art(directory)
    assert mime == "image/jpeg"
    assert data.startswith(b"\xff\xd8")


def test_conventional_names_beat_an_arbitrary_image(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "zzz-band-photo.png", b"\x89PNG not the cover")
    write_image(directory / "folder.jpg", b"\xff\xd8\xff the cover")

    data, mime = library.load_album_art(directory)
    assert data == b"\xff\xd8\xff the cover"
    assert mime == "image/jpeg"


def test_a_lone_image_is_assumed_to_be_the_cover(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "scan001.png", b"\x89PNG lonely")

    assert library.find_cover_file(sorted(directory.iterdir())).name == "scan001.png"


def test_several_unconventionally_named_images_are_not_guessed_at(tmp_path, clear_cache):
    """Two candidates and no convention to pick between them - better nothing than wrong."""
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "scan001.png")
    write_image(directory / "scan002.png")

    assert library.find_cover_file(sorted(directory.iterdir())) is None


def test_embedded_art_is_found_when_there_is_no_cover_file(tmp_path, clear_cache):
    from mutagen.flac import FLAC, Picture

    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    track = sorted(directory.glob("*.flac"))[0]

    picture = Picture()
    picture.data = b"\xff\xd8\xff embedded cover"
    picture.mime = "image/jpeg"
    audio = FLAC(str(track))
    audio.add_picture(picture)
    audio.save()

    assert scan_library(str(tmp_path))["albums"][0]["art"] == "embedded"

    data, mime = library.load_album_art(directory)
    assert data == b"\xff\xd8\xff embedded cover"
    assert mime == "image/jpeg"


def test_album_with_no_art_anywhere_reports_none(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    assert scan_library(str(tmp_path))["albums"][0]["art"] == ""
    assert library.load_album_art(directory) is None


# ---------------------------------------------------------------- the art endpoint

def make_client(tmp_path, monkeypatch):
    """A test client wired to a throwaway library, with the poller and clients stubbed out."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from src.config import Config
    from src.routes import library as library_route

    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path))
    app = FastAPI()
    app.include_router(library_route.router, prefix="/jimbrainz/library")
    return TestClient(app)


def test_art_endpoint_serves_the_cover(tmp_path, monkeypatch, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "cover.jpg", b"\xff\xd8\xff real bytes")

    client = make_client(tmp_path, monkeypatch)
    response = client.get("/jimbrainz/library/art",
                          params={"album": "Tame Impala/The Slow Rush (2020)"})

    assert response.status_code == 200
    assert response.headers["content-type"] == "image/jpeg"
    assert response.content == b"\xff\xd8\xff real bytes"


def test_art_endpoint_404s_when_there_is_no_art(tmp_path, monkeypatch, clear_cache):
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    client = make_client(tmp_path, monkeypatch)
    assert client.get("/jimbrainz/library/art",
                      params={"album": "Tame Impala/The Slow Rush (2020)"}).status_code == 404


@pytest.mark.parametrize("attempt", [
    "../../../../etc",
    "Tame Impala/../../../../etc",
    "/etc",
    "",
])
def test_art_endpoint_refuses_to_read_outside_the_library(tmp_path, monkeypatch, attempt, clear_cache):
    """
    This is the only endpoint that turns user input into a filesystem read. Every one of
    these resolves outside LIBRARY_PATH and must be refused - and refused with the same 404
    as a missing album, so a probe learns nothing about what exists out there.
    """
    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    client = make_client(tmp_path, monkeypatch)

    response = client.get("/jimbrainz/library/art", params={"album": attempt})
    assert response.status_code == 404


def test_art_endpoint_refuses_a_symlink_pointing_out_of_the_library(tmp_path, monkeypatch, clear_cache):
    """A path can be inside the library textually and still resolve elsewhere."""
    import os
    outside = tmp_path.parent / "outside-the-library"
    outside.mkdir(exist_ok=True)
    write_image(outside / "cover.jpg", b"\xff\xd8\xff secret")

    seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    os.symlink(outside, tmp_path / "escape")

    client = make_client(tmp_path, monkeypatch)
    assert client.get("/jimbrainz/library/art", params={"album": "escape"}).status_code == 404


# ---------------------------------------------------------------- picking the RIGHT picture

def embed(path, *pictures):
    """Attach picture blocks in the given order, so order-vs-type can be told apart."""
    from mutagen.flac import FLAC, Picture
    audio = FLAC(str(path))
    for data, kind in pictures:
        p = Picture()
        p.data = data
        p.mime = "image/jpeg"
        p.type = kind
        audio.add_picture(p)
    audio.save()


def test_the_front_cover_wins_even_when_the_disc_scan_comes_first(tmp_path, clear_cache):
    """
    The bug this exists for: albums showing a picture of a CD instead of their sleeve.

    Rips from EAC and dBpoweramp routinely embed BOTH, in no guaranteed order. Taking
    pictures[0] meant whichever block happened to be written first won.
    """
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    track = sorted(directory.glob("*.flac"))[0]

    #? disc first, on purpose
    embed(track, (b"\xff\xd8 the disc", 6), (b"\xff\xd8 the sleeve", 3))

    data, _ = library.load_album_art(directory)
    assert data == b"\xff\xd8 the sleeve"


def test_the_disc_is_still_used_when_it_is_all_there_is(tmp_path, clear_cache):
    """A picture of the disc beats no picture at all."""
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    embed(sorted(directory.glob("*.flac"))[0], (b"\xff\xd8 only the disc", 6))

    data, _ = library.load_album_art(directory)
    assert data == b"\xff\xd8 only the disc"


def test_untyped_art_beats_a_back_cover(tmp_path, clear_cache):
    """Type 0 is 'other' and is usually just an untagged front; a back cover never is."""
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    embed(sorted(directory.glob("*.flac"))[0], (b"\xff\xd8 back", 4), (b"\xff\xd8 untyped", 0))

    data, _ = library.load_album_art(directory)
    assert data == b"\xff\xd8 untyped"


def test_a_tiny_file_icon_is_never_chosen_over_real_art(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    embed(sorted(directory.glob("*.flac"))[0], (b"\xff\xd8 icon", 1), (b"\xff\xd8 disc", 6))

    data, _ = library.load_album_art(directory)
    assert data == b"\xff\xd8 disc"


@pytest.mark.parametrize("stem", ["disc", "disc2", "cd", "cd 1", "back", "inlay", "booklet", "matrix"])
def test_a_lone_disc_or_back_scan_is_not_treated_as_the_cover(tmp_path, stem, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / f"{stem}.jpg")

    assert library.find_cover_file(sorted(directory.iterdir())) is None


@pytest.mark.parametrize("stem", ["Discovery", "Cdiscover", "backstreet", "label maker"])
def test_names_that_merely_contain_a_disc_word_are_still_covers(tmp_path, stem, clear_cache):
    """A substring check here would throw away real covers."""
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / f"{stem}.jpg")

    assert library.find_cover_file(sorted(directory.iterdir())).stem == stem


def test_a_conventional_cover_still_wins_over_a_disc_scan(tmp_path, clear_cache):
    directory = seed_album(tmp_path, "Tame Impala", "The Slow Rush (2020)", "The Slow Rush")
    write_image(directory / "disc.jpg", b"\xff\xd8 disc")
    write_image(directory / "cover.jpg", b"\xff\xd8 cover")

    data, _ = library.load_album_art(directory)
    assert data == b"\xff\xd8 cover"
