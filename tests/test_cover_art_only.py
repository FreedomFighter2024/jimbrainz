"""
Fetching just the cover, without applying a release.

The narrow counterpart to the retag. Applying a release rewrites every file's tags and can
rename the folder, which is a great deal to agree to when the only thing missing is the
picture - and an album whose tags are already right shouldn't have to be re-tagged to gain a
sleeve.

Two properties make it safe to fire with no preview, and both are tested here: it chooses
nothing (the release comes from the album's own tags), and it writes exactly one file.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.retag import plan_cover_art, save_cover_art  # noqa: E402
from tests.test_library import write_flac  # noqa: E402

ART = (b"\xff\xd8\xff\xe0 jpeg bytes", "image/jpeg")


def seed(root: Path, folder: str, mbid: str | None = None, cover: str | None = None) -> Path:
    directory = root / folder
    tags = {"album": "B", "albumartist": "A", "artist": "A", "title": "T", "tracknumber": "1"}
    if mbid:
        tags["musicbrainz_albumid"] = mbid
    write_flac(directory / "01 - T.flac", **tags)
    if cover:
        (directory / cover).write_bytes(b"old cover")
    return directory


# ---------------------------------------------------------------- planning

def test_an_album_with_a_release_and_no_cover_can_have_one(tmp_path):
    seed(tmp_path, "A/B", mbid="mb-1")

    plan = plan_cover_art("A/B", str(tmp_path))

    assert plan["problem"] is None
    assert plan["release_mbid"] == "mb-1", "taken from the album's own tags, not from a caller"
    assert plan["action"] == "download"


def test_an_untagged_album_says_what_to_do_about_it(tmp_path):
    """
    There is nothing to look a cover up BY. Saying so is the useful answer; guessing from the
    folder name would be exactly the kind of judgement this path exists to avoid making.
    """
    seed(tmp_path, "A/B")

    plan = plan_cover_art("A/B", str(tmp_path))

    assert plan["release_mbid"] is None
    assert "match it to a release first" in plan["problem"]


def test_an_existing_cover_is_not_replaced_unless_asked(tmp_path):
    """A sleeve you chose yourself is not ours to overwrite because the Archive has one too."""
    seed(tmp_path, "A/B", mbid="mb-1", cover="cover.jpg")

    plan = plan_cover_art("A/B", str(tmp_path))

    assert plan["action"] == ""
    assert "already has cover.jpg" in plan["problem"]


def test_replacing_is_possible_when_asked_for(tmp_path):
    seed(tmp_path, "A/B", mbid="mb-1", cover="cover.jpg")

    plan = plan_cover_art("A/B", str(tmp_path), replace=True)

    assert plan["problem"] is None
    assert plan["action"] == "replace"
    assert plan["existing"] == "cover.jpg"


def test_an_album_outside_the_library_is_refused(tmp_path):
    """The containment guard every writer here carries. is_within resolves both sides."""
    seed(tmp_path, "A/B", mbid="mb-1")

    assert "not inside the library" in plan_cover_art("../../etc", str(tmp_path))["problem"]
    assert "not inside the library" in plan_cover_art("", str(tmp_path))["problem"]


# ---------------------------------------------------------------- writing

def test_writing_a_cover_touches_nothing_else(tmp_path):
    """
    The whole point. No tags rewritten, no folder renamed, no companion files - one new file
    and everything else byte-for-byte as it was.
    """
    directory = seed(tmp_path, "A/B", mbid="mb-1")
    track = directory / "01 - T.flac"
    before = track.read_bytes()

    result = save_cover_art("A/B", str(tmp_path), ART)

    assert result["written"] == "cover.jpg"
    assert (directory / "cover.jpg").read_bytes() == ART[0]
    assert track.read_bytes() == before, "the audio is untouched"
    assert directory.exists(), "and the folder was not renamed"
    assert sorted(p.name for p in directory.iterdir()) == ["01 - T.flac", "cover.jpg"]


def test_the_extension_follows_the_mime_type(tmp_path):
    seed(tmp_path, "A/B", mbid="mb-1")

    result = save_cover_art("A/B", str(tmp_path), (b"\x89PNG", "image/png"))

    assert result["written"] == "cover.png"


def test_writing_outside_the_library_is_refused(tmp_path):
    """
    Re-checked at the write rather than trusted from the plan, for the reason the retag
    endpoint recomputes its plan: a path that arrived over the wire is not evidence.
    """
    outside = tmp_path / "outside"
    outside.mkdir()

    result = save_cover_art("../outside", str(tmp_path / "library"), ART)

    assert result["written"] is None
    assert "not inside the library" in result["problem"]
    assert not list(outside.iterdir()), "nothing was written out there"


# ---------------------------------------------------------------- the release override

def test_the_release_normally_comes_from_the_albums_own_tags(tmp_path):
    """The plain path makes no choice, which is what lets it run without a preview."""
    seed(tmp_path, "A/B", mbid="mb-from-tags")

    assert plan_cover_art("A/B", str(tmp_path))["release_mbid"] == "mb-from-tags"


def test_an_explicit_release_wins_when_one_is_given(tmp_path):
    """
    Only the editor sends one, and only while showing you that release's cover beside the
    current one - so the choice has already been made deliberately and visibly. Fetching art
    for a release the album is NOT is a reasonable thing to want; doing it silently would not be.
    """
    seed(tmp_path, "A/B", mbid="mb-from-tags")

    plan = plan_cover_art("A/B", str(tmp_path), release_mbid="mb-chosen")

    assert plan["release_mbid"] == "mb-chosen"


def test_an_override_still_needs_a_cover_slot_to_write_into(tmp_path):
    """Choosing a release doesn't override the refusal to clobber - `replace` does that."""
    seed(tmp_path, "A/B", mbid="mb-from-tags", cover="cover.jpg")

    plan = plan_cover_art("A/B", str(tmp_path), release_mbid="mb-chosen")

    assert plan["action"] == ""
    assert "already has cover.jpg" in plan["problem"]


def test_an_override_lets_an_untagged_album_get_art(tmp_path):
    """
    The case the override exists for: the album names no release, so the plain path has nothing
    to ask about - but you have just picked one in the editor and can see its cover.
    """
    seed(tmp_path, "A/B")

    plan = plan_cover_art("A/B", str(tmp_path), release_mbid="mb-chosen")

    assert plan["problem"] is None
    assert plan["release_mbid"] == "mb-chosen"
    assert plan["action"] == "download"
