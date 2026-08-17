"""
Which albums still need their metadata seen to, and why.

The library view could tell you what you have. It could not tell you what was *wrong* with
what you have - so finding the album that arrived with no MusicBrainz id, or the one still
filed under its pressing's year rather than the album's, meant opening the editor on every
album in turn and reading its current-state line. That is the same "open it and check"
busywork that made Lidarr's release picker useless, reproduced inside jimbrainz.

Everything here is a pure function over the album dicts library.py already produces. No
filesystem, no MusicBrainz, so the whole rule set is testable from fixtures - the same reason
matching.py and editions.py are pure.

Three rules keep this honest:

  **An issue names something a human can fix, and says how.** `no_release` is actionable:
  open the editor, pick the release. A vague "this looks wrong" is not, and a queue full of
  those is a queue you learn to ignore.

  **An issue is derived, never stored.** The only thing persisted about an album is that you
  chose to IGNORE it (store.py::album_review). A fixed album therefore leaves the queue on
  its own the next time it is scanned, rather than waiting for something to remember to
  unmark it - which is the failure mode of every "needs attention" flag that is written down.

  **Severity orders the queue, it does not hide anything.** An album with no release id has
  five other issues downstream of that one fact; they are all reported, because suppressing
  them would mean the count changes as you fix things in a way that looks like new problems
  appearing.
"""

from pathlib import Path

from src.library import edition_from_dirname
from src.organizer import build_album_dirname, sanitize_filename

#? Severities. Only used to sort - the queue shows everything it finds.
#?   3  the album is not identified. Nothing else about it can be checked against anything.
#?   2  identified but wrong or incomplete, in a way that changes where it is filed.
#?   1  cosmetic or recoverable. Worth fixing, never worth blocking on.
BLOCKING, WRONG, COSMETIC = 3, 2, 1

#? code -> what it means and how bad it is. The interface renders `label` and `hint` straight
#? out of the /albums response rather than keeping its own copy - three places already share
#? the edition vocabulary and that has been a recurring source of silent drift, so this one
#? stays server-side and travels with the data.
ISSUE_TYPES: dict[str, dict] = {
    "no_release": {
        "label": "no release id",
        "hint": "these files were never matched to a MusicBrainz release, so nothing else "
                "about them can be checked against anything. Pick a release in the editor.",
        "severity": BLOCKING,
    },
    "no_artist_tag": {
        "label": "no artist tag",
        "hint": "not one file names an artist, so the name shown here came from the folder. "
                "Renaming the folder would rename the album.",
        "severity": BLOCKING,
    },
    "mixed_tags": {
        "label": "mixed tags",
        "hint": "the files in this folder disagree about which album they belong to, which "
                "usually means two albums are sharing a folder.",
        "severity": BLOCKING,
    },
    "misfiled": {
        "label": "folder off-convention",
        "hint": "the folder is not named the way these tags say it should be, so its name "
                "and its contents tell different stories. Applying a release re-files it.",
        "severity": WRONG,
    },
    "no_original_year": {
        "label": "no original year",
        "hint": "no originaldate tag, so there is nothing recording the album's own year as "
                "distinct from this pressing's - which is what the folder is named after.",
        "severity": WRONG,
    },
    "no_year": {
        "label": "no year",
        "hint": "no date tag on any file, so this album has no year at all.",
        "severity": WRONG,
    },
    "untitled_tracks": {
        "label": "untitled tracks",
        "hint": "some files carry no title tag, so the titles shown are their filenames. "
                "Applying a release writes the real ones.",
        "severity": WRONG,
    },
    "unnumbered_tracks": {
        "label": "unnumbered tracks",
        "hint": "some files carry no track number, so the running order here is alphabetical "
                "rather than the album's.",
        "severity": COSMETIC,
    },
    "no_art": {
        "label": "no cover art",
        "hint": "no cover beside the tracks and none embedded in them. The editor can fetch "
                "one from the Cover Art Archive.",
        "severity": COSMETIC,
    },
}


def expected_dirname(album: dict) -> str:
    """
    What the organizer would call this folder, given the tags the files actually carry.

    Built through the organizer's own `build_album_dirname` rather than by string-formatting
    the same convention a second time. Two copies of the folder rule would drift, and the
    whole point of the check below is to notice when a folder and its contents disagree - a
    check that quietly used a different convention would be worse than none.

    The edition comes from the folder's own `[...]` suffix rather than from `album["edition"]`,
    because the scanner rewrites that field to "Standard" for an unlabelled folder that has
    labelled siblings. Reading the suffix keeps this comparing the folder against the tags
    instead of against a display decision made downstream of it.
    """
    return build_album_dirname({
        "album": album.get("album") or "",
        "year": album.get("year") or "",
        "original_year": album.get("original_year") or "",
        "edition_label": edition_from_dirname(Path(album.get("path") or "").name),
    })


def _is_misfiled(album: dict) -> bool:
    """True when the folder's name disagrees with what its tags say it should be."""
    path = Path(album.get("path") or "")

    #? An album sitting directly in the library root has no artist folder at all, which is
    #? off-convention by definition - and `.parent.name` is "" there, so this also stops the
    #? comparison below from reading as a match by accident.
    if path.parent.name != sanitize_filename(album.get("artist"), "Unknown Artist"):
        return True

    return path.name != expected_dirname(album)


def _has_no_artist_tag(album: dict) -> bool:
    """
    True when no file names an artist, so the displayed name came from the folder.

    read_album_dir falls back to the parent directory's name in that case, which is a
    reasonable guess and completely indistinguishable from a real tag once it has been made -
    hence checking the tracks rather than the album's resolved artist.
    """
    tracks = album.get("tracks") or []

    if not tracks:
        return False

    return not any(
        (track.get("artist") or "").strip() or (track.get("albumartist") or "").strip()
        for track in tracks
    )


def inspect_album(album: dict) -> list[str]:
    """
    Every issue this album has, worst first.

    Takes one album dict as `library.scan_library` reports it, including its tracks. Order is
    by severity so the interface can show the most useful two or three without deciding for
    itself which those are.
    """
    tracks = album.get("tracks") or []
    found: list[str] = []

    if not (album.get("release_mbid") or "").strip():
        found.append("no_release")

    if _has_no_artist_tag(album):
        found.append("no_artist_tag")

    if album.get("mixed_tags"):
        found.append("mixed_tags")

    if _is_misfiled(album):
        found.append("misfiled")

    if not (album.get("original_year") or "").strip():
        found.append("no_original_year")

    if not (album.get("year") or "").strip():
        found.append("no_year")

    #? counted during the scan, because a missing title tag is invisible afterwards - it falls
    #? back to the filename stem, which is frequently the same string a real title would be
    if album.get("untitled_tracks"):
        found.append("untitled_tracks")

    if any(track.get("position") is None for track in tracks):
        found.append("unnumbered_tracks")

    if not album.get("art"):
        found.append("no_art")

    found.sort(key=lambda code: -ISSUE_TYPES[code]["severity"])
    return found


def worst_severity(issues: list[str]) -> int:
    """The severity of the most serious issue in the list. 0 for none, which sorts last."""
    return max((ISSUE_TYPES[code]["severity"] for code in issues if code in ISSUE_TYPES),
               default=0)


def outstanding(issues: list[str], ignored: list[str]) -> list[str]:
    """
    The issues that still want attention, given what has been ignored on this album.

    Ignoring is per issue rather than per album on purpose: saying "yes, this bootleg will
    never be in MusicBrainz" should not also silence the day its cover art goes missing. An
    album with a new kind of problem comes back into the queue on its own.
    """
    muted = set(ignored or [])
    return [code for code in issues if code not in muted]


def attach_issues(albums: list[dict], reviews: dict[str, dict] | None = None) -> dict:
    """
    Give every album its issue list and review state, and summarise what the queue holds.

    Mutates the album dicts in place, which is safe for the same reason
    `library._mark_multi_edition` does it: the caller runs this over the *whole* list on every
    response, so a cached album can never carry a stale verdict. It is also the only way the
    interface can put a chip on a row without a second lookup table keyed on a path.

    `reviews` is what store.album_reviews() returned, keyed on the album's relative path. It
    is optional and an absent entry means "never seen, nothing ignored", so this works
    unchanged when the SQLite store could not be opened - the queue simply stops remembering
    what you ignored, exactly like downloads stop being tracked.
    """
    reviews = reviews or {}

    by_issue: dict[str, int] = {}
    needing = 0
    new_imports = 0

    for album in albums:
        review = reviews.get(album["path"]) or {}
        ignored = review.get("ignored_issues") or []

        issues = inspect_album(album)
        remaining = outstanding(issues, ignored)

        album["issues"] = issues
        album["ignored_issues"] = ignored
        album["needs_attention"] = bool(remaining)
        album["severity"] = worst_severity(remaining)
        album["first_seen"] = review.get("first_seen")
        #? filed by jimbrainz rather than found sitting there, and not yet looked at. This is
        #? what the tab badge counts, and the only reason the import source is recorded.
        album["imported"] = review.get("source") == "import"
        album["reviewed"] = bool(review.get("reviewed_at"))

        if remaining:
            needing += 1
            for code in remaining:
                by_issue[code] = by_issue.get(code, 0) + 1

        if album["imported"] and not album["reviewed"]:
            new_imports += 1

    return {
        "total": needing,
        "by_issue": by_issue,
        "new_imports": new_imports,
        "ignored_albums": sum(1 for a in albums if a["ignored_issues"]),
    }
