"""
Reading what's already on disk.

The library view answers a different question from the search view: not "what exists" but
"what do I have, and which version of it". That second half is the whole point - the reason
for leaving Lidarr was that a chosen edition couldn't survive the round trip, and a library
that can't show you the deluxe next to the standard has the same blind spot.

Two rules shape everything here:

  Identity comes from tags, not folder names. Two folders are the same edition when they
  share a musicbrainz_albumid, however they happen to be named, so renaming a folder by hand
  doesn't split an album in two.

  A folder we can't identify is its own album, not a match. Libraries that predate jimbrainz
  have no MBIDs at all, and guessing that two untagged folders are "really" the same release
  would merge things the user deliberately keeps apart.

Scanning is per-directory and cached on the folder's mtime, because reading tags is the
expensive part and most of a library doesn't change between two visits to the page.
"""

import os
import time
from pathlib import Path

from src.logger import logger
from src.matching import AUDIO_EXTENSIONS, file_extension

#? path -> (mtime, album dict). Reading tags costs milliseconds per file and a real library
#? is thousands of files, so a rescan re-reads only the folders that actually changed. The
#? walk itself is cheap; opening files is not.
_album_cache: dict[str, tuple[float, dict]] = {}


def _first(audio, key: str) -> str:
    """mutagen's easy interface returns lists. Take the first value, or ''."""
    try:
        values = audio.get(key) or []
    except Exception:
        return ""
    return str(values[0]).strip() if values else ""


def _track_number(raw: str) -> int | None:
    """Track numbers arrive as '4', '04' or '4/12' depending on who tagged the file."""
    if not raw:
        return None
    head = raw.split("/")[0].strip()
    try:
        return int(head)
    except ValueError:
        return None


def read_track(path: Path) -> dict | None:
    """One audio file's tags, or None if it isn't readable audio."""
    import mutagen

    try:
        audio = mutagen.File(str(path), easy=True)
    except Exception as e:
        logger.debug(f"could not read {path.name}: {e}")
        return None

    if audio is None:
        return None

    try:
        length = float(getattr(audio.info, "length", 0) or 0)
    except Exception:
        length = 0.0

    try:
        size = path.stat().st_size
    except OSError:
        size = 0

    return {
        "filename": path.name,
        "title": _first(audio, "title") or path.stem,
        "position": _track_number(_first(audio, "tracknumber")),
        "length": round(length, 1),
        "size": size,
        "format": file_extension(path.name),
        #? kept per-track because a folder can disagree with itself - a mis-tagged file is
        #? exactly the kind of thing this view should make visible rather than average away
        "artist": _first(audio, "artist"),
        "album": _first(audio, "album"),
        "albumartist": _first(audio, "albumartist"),
        "date": _first(audio, "date"),
        "release_mbid": _first(audio, "musicbrainz_albumid"),
    }


def _commonest(values: list[str], fallback: str = "") -> str:
    """The most frequent non-empty value. Ties break toward the first seen, which is fine."""
    counts: dict[str, int] = {}
    for value in values:
        if value:
            counts[value] = counts.get(value, 0) + 1
    if not counts:
        return fallback
    return max(counts, key=lambda k: counts[k])


def _edition_from_dirname(name: str) -> str:
    """
    Pull the `[...]` suffix back out of a folder the organizer created.

    build_album_dirname() writes the edition there, so for anything jimbrainz filed this is
    the label the user already sees on disk, and reusing it keeps the UI and the filesystem
    telling the same story. Folders from elsewhere simply have no suffix.
    """
    if name.endswith("]") and "[" in name:
        return name[name.rindex("[") + 1:-1].strip()
    return ""


def read_album_dir(directory: Path, library_root: Path) -> dict | None:
    """Everything in one folder, treated as a single album. None if it holds no audio."""
    try:
        entries = sorted(p for p in directory.iterdir() if p.is_file())
    except OSError as e:
        logger.warning(f"could not list {directory}: {e}")
        return None

    tracks = []
    for entry in entries:
        if file_extension(entry.name) not in AUDIO_EXTENSIONS:
            continue
        track = read_track(entry)
        if track:
            tracks.append(track)

    if not tracks:
        return None

    tracks.sort(key=lambda t: (t["position"] is None, t["position"] or 0, t["filename"]))

    #? the album artist is what groups a library; falling back to the track artist keeps
    #? compilations and badly-tagged folders visible instead of dropping them
    artist = (_commonest([t["albumartist"] for t in tracks])
              or _commonest([t["artist"] for t in tracks])
              or directory.parent.name
              or "Unknown Artist")

    album = _commonest([t["album"] for t in tracks]) or directory.name
    date = _commonest([t["date"] for t in tracks])
    release_mbid = _commonest([t["release_mbid"] for t in tracks])

    try:
        relative = str(directory.relative_to(library_root))
    except ValueError:
        relative = str(directory)

    return {
        #? identity first, path second. Two folders sharing an MBID are one edition even if
        #? someone renamed one of them; a folder without an MBID can only be itself.
        "key": release_mbid or f"path:{relative}",
        "artist": artist,
        "album": album,
        "year": date[:4] if date else "",
        "edition": _edition_from_dirname(directory.name),
        "release_mbid": release_mbid,
        "path": relative,
        "track_count": len(tracks),
        "total_size": sum(t["size"] for t in tracks),
        "duration": round(sum(t["length"] for t in tracks), 1),
        "formats": sorted({t["format"] for t in tracks if t["format"]}),
        "tracks": tracks,
        "modified_at": directory.stat().st_mtime if directory.exists() else 0,
        #? surfaced rather than hidden: a folder whose files disagree about the album name is
        #? usually a real tagging problem the user wants to know about
        "mixed_tags": len({t["album"] for t in tracks if t["album"]}) > 1,
    }


def scan_library(library_root: str, force: bool = False) -> dict:
    """
    Walk the library and return every album found, grouped for display.

    Any directory containing audio is an album, which handles both the organizer's
    `Artist/Album (Year) [Edition]` layout and whatever shape an existing library is in
    without needing to know the difference.
    """
    started = time.perf_counter()

    if not library_root:
        return {"albums": [], "artists": [], "library_path": "",
                "problem": "LIBRARY_PATH is not set", "scanned_at": time.time(),
                "album_count": 0, "artist_count": 0, "scan_seconds": 0.0, "cached": 0}

    root = Path(library_root)
    if not root.is_dir():
        return {"albums": [], "artists": [], "library_path": library_root,
                "problem": f"LIBRARY_PATH does not exist or is not a directory: {library_root}",
                "scanned_at": time.time(), "album_count": 0, "artist_count": 0,
                "scan_seconds": 0.0, "cached": 0}

    if force:
        _album_cache.clear()

    albums = []
    reused = 0

    for current, subdirs, files in os.walk(root):
        subdirs.sort()
        if not any(file_extension(f) in AUDIO_EXTENSIONS for f in files):
            continue

        directory = Path(current)
        try:
            mtime = directory.stat().st_mtime
        except OSError:
            continue

        cached = _album_cache.get(current)
        if cached and cached[0] == mtime:
            albums.append(cached[1])
            reused += 1
            continue

        album = read_album_dir(directory, root)
        if album is None:
            continue

        _album_cache[current] = (mtime, album)
        albums.append(album)

    #? drop cache entries for folders that no longer exist, so a long-running container
    #? doesn't hold a growing map of albums the user deleted months ago
    live = {a["path"] for a in albums}
    for path in [p for p in _album_cache if str(Path(p).relative_to(root)) not in live]:
        _album_cache.pop(path, None)

    _mark_multi_edition(albums)
    albums.sort(key=lambda a: (a["artist"].lower(), a["album"].lower(), a["edition"].lower()))

    return {
        "albums": albums,
        "artists": _summarize_artists(albums),
        "library_path": library_root,
        "problem": None,
        "scanned_at": time.time(),
        "album_count": len(albums),
        "artist_count": len({a["artist"] for a in albums}),
        "scan_seconds": round(time.perf_counter() - started, 3),
        "cached": reused,
    }


def _mark_multi_edition(albums: list[dict]) -> None:
    """
    Flag albums the user holds more than one version of.

    The headline feature of this view. Grouping is on (artist, album) rather than MBID
    precisely because different editions have *different* MBIDs - that's what makes them
    different editions - so the id that separates them can't also be what gathers them.
    """
    groups: dict[tuple[str, str], list[dict]] = {}
    for album in albums:
        groups.setdefault((album["artist"].lower(), album["album"].lower()), []).append(album)

    for group in groups.values():
        for album in group:
            album["edition_count"] = len(group)
            #? an unlabelled folder sitting beside a labelled one is the standard press, and
            #? saying so beats leaving a blank column next to "Deluxe edition"
            if len(group) > 1 and not album["edition"]:
                album["edition"] = "Standard"


def _summarize_artists(albums: list[dict]) -> list[dict]:
    """Artist-level rollup for the filter column."""
    by_artist: dict[str, dict] = {}

    for album in albums:
        entry = by_artist.setdefault(album["artist"], {
            "artist": album["artist"], "album_count": 0, "track_count": 0, "total_size": 0,
        })
        entry["album_count"] += 1
        entry["track_count"] += album["track_count"]
        entry["total_size"] += album["total_size"]

    return sorted(by_artist.values(), key=lambda a: a["artist"].lower())
