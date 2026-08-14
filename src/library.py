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
import re
import time
from pathlib import Path

from src.logger import logger
from src.matching import AUDIO_EXTENSIONS, file_extension

#? path -> (mtime, album dict). Reading tags costs milliseconds per file and a real library
#? is thousands of files, so a rescan re-reads only the folders that actually changed. The
#? walk itself is cheap; opening files is not.
_album_cache: dict[str, tuple[float, dict]] = {}

#? Conventional cover filenames, in preference order. These are what the organizer carries
#? across as companion files and what every other music tool writes.
COVER_BASENAMES = ("cover", "folder", "front", "album", "albumart", "albumartsmall", "thumb")

IMAGE_EXTENSIONS = {"jpg", "jpeg", "png", "webp", "gif", "bmp"}

#? Filenames that say outright "this is not the front cover". Anchored and optionally
#? numbered ("disc", "disc2", "cd 1"), NOT substring-matched - "Discovery.jpg" is a real
#? cover and a substring check would throw it away.
#? Deliberately NOT including "scan": a lone "scan001.jpg" is usually the front, because
#? that's the sheet people scan first. Everything listed here names a specific part of the
#? packaging that is definitively not the front.
NON_COVER_PATTERN = re.compile(
    r"(disc|disk|cd|dvd|vinyl|back|rear|inlay|booklet|matrix|label|media|tray|obi|insert|"
    r"inside|sleeve\s*back)[\s._-]*\d*"
)

MIME_BY_EXTENSION = {
    "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png",
    "webp": "image/webp", "gif": "image/gif", "bmp": "image/bmp",
}


def _looks_like_a_non_cover(stem: str) -> bool:
    """
    True for images that are demonstrably NOT the front cover.

    Matched as whole names rather than substrings, optionally numbered, so "disc2.jpg" is
    caught while "Discovery.jpg" and "Cdiscover.png" are left alone - a substring check here
    would reject real covers.
    """
    return bool(NON_COVER_PATTERN.fullmatch(stem.strip().lower()))


def find_cover_file(entries: list[Path]) -> Path | None:
    """
    A cover image sitting beside the tracks.

    Preferred over embedded art because it's free to serve - no audio file to open and no
    picture block to decode - and because it's what the organizer already copies across when
    it files a download.
    """
    images = [e for e in entries if file_extension(e.name) in IMAGE_EXTENSIONS]
    if not images:
        return None

    for wanted in COVER_BASENAMES:
        for image in images:
            if image.stem.lower() == wanted:
                return image

    #? No conventionally-named file. A folder holding exactly one image is almost certainly
    #? holding its cover - unless that image is plainly a disc or a back scan, which is how
    #? albums ended up illustrated with a picture of a CD.
    if len(images) == 1 and not _looks_like_a_non_cover(images[0].stem):
        return images[0]

    return None


#? Embedded pictures carry a type, and a file very often holds several. Rips from EAC and
#? dBpoweramp routinely embed the front cover AND a scan of the disc, in no guaranteed order,
#? so taking whichever came first showed people a picture of a CD instead of their album.
#? Lower is better; anything unlisted sits in the middle.
PICTURE_TYPE_PREFERENCE = {
    3: 0,   # COVER_FRONT  - the album art, what we're actually after
    0: 1,   # OTHER        - untyped. Very common, and usually the front in practice.
    5: 3,   # LEAFLET_PAGE
    4: 4,   # COVER_BACK
    6: 5,   # MEDIA        - the label side of the disc. Legible, but not the cover.
    1: 9,   # FILE_ICON    - 32x32 PNGs; never what anyone wants to look at
    2: 9,   # OTHER_FILE_ICON
}
UNRANKED_PICTURE_PREFERENCE = 2


def _best_picture(pictures: list) -> object | None:
    """The most cover-like picture in the list, by its declared type."""
    if not pictures:
        return None

    return min(
        pictures,
        key=lambda p: PICTURE_TYPE_PREFERENCE.get(getattr(p, "type", 0), UNRANKED_PICTURE_PREFERENCE),
    )


def read_embedded_art(path: Path) -> tuple[bytes, str] | None:
    """
    Cover art stored inside the audio file itself.

    Every container does this differently, and mutagen's `easy` interface deliberately
    doesn't expose any of it, so this opens the file again without it. Worth the second open:
    a lot of libraries have no separate cover file and would otherwise show nothing.

    Picks by picture TYPE rather than by order - see PICTURE_TYPE_PREFERENCE.
    """
    import mutagen

    try:
        audio = mutagen.File(str(path))
    except Exception:
        return None

    if audio is None:
        return None

    #? FLAC and Ogg: a list of picture blocks
    picture = _best_picture(list(getattr(audio, "pictures", None) or []))
    if picture is not None:
        return bytes(picture.data), (picture.mime or "image/jpeg")

    tags = getattr(audio, "tags", None)
    if tags is None:
        return None

    #? MP3: APIC frames, keyed as APIC:description so an exact lookup misses them - and a
    #? file with both a cover and a disc scan has two of them
    try:
        frames = [tags[key] for key in tags.keys() if key.startswith("APIC")]
        frame = _best_picture(frames)
        if frame is not None:
            return bytes(frame.data), (getattr(frame, "mime", None) or "image/jpeg")
    except Exception:
        pass

    #? MP4/M4A: a 'covr' atom, whose format is a flag on the value rather than a mime type
    try:
        covers = tags.get("covr")
        if covers:
            cover = covers[0]
            fmt = getattr(cover, "imageformat", None)
            mime = "image/png" if fmt == 14 else "image/jpeg"
            return bytes(cover), mime
    except Exception:
        pass

    return None


def load_album_art(directory: Path) -> tuple[bytes, str] | None:
    """
    The album's cover, from wherever it actually lives. Cheapest source first.

    Used by the art endpoint. Kept separate from the scan so a scan never has to hold image
    bytes for the whole library in memory at once.
    """
    try:
        entries = sorted(p for p in directory.iterdir() if p.is_file())
    except OSError:
        return None

    cover = find_cover_file(entries)
    if cover is not None:
        try:
            mime = MIME_BY_EXTENSION.get(file_extension(cover.name), "image/jpeg")
            return cover.read_bytes(), mime
        except OSError:
            pass

    for entry in entries:
        if file_extension(entry.name) in AUDIO_EXTENSIONS:
            return read_embedded_art(entry)

    return None


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
        "originaldate": _first(audio, "originaldate"),
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

    #? Recorded during the scan so the interface knows whether asking for art is worth a
    #? request at all. The embedded check costs one extra file open per album, which is
    #? cheap beside the per-track opens above and is cached with the rest of the album.
    if find_cover_file(entries) is not None:
        art = "file"
    else:
        first_audio = next(
            (e for e in entries if file_extension(e.name) in AUDIO_EXTENSIONS), None
        )
        art = "embedded" if first_audio and read_embedded_art(first_audio) else ""

    #? the album artist is what groups a library; falling back to the track artist keeps
    #? compilations and badly-tagged folders visible instead of dropping them
    artist = (_commonest([t["albumartist"] for t in tracks])
              or _commonest([t["artist"] for t in tracks])
              or directory.parent.name
              or "Unknown Artist")

    album = _commonest([t["album"] for t in tracks]) or directory.name
    date = _commonest([t["date"] for t in tracks])
    original_date = _commonest([t["originaldate"] for t in tracks])
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
        #? empty for anything not tagged with one, which is most libraries
        "original_year": original_date[:4] if original_date else "",
        "edition": _edition_from_dirname(directory.name),
        "release_mbid": release_mbid,
        #? '' means no art on disk. The interface falls back to the Cover Art Archive when
        #? there's a release MBID, exactly as the search view already does.
        "art": art,
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


def forget_cached_album(directory: str) -> None:
    """
    Drop a folder from the scan cache so the next scan re-reads it.

    Necessary because the cache keys on the DIRECTORY's mtime, and rewriting a file's tags
    does not change that - only adding, removing or renaming entries does. Measured, not
    assumed. Without this, retagging an album in place is invisible to the scanner and the
    interface keeps showing the old values until someone forces a full rescan, which reads
    exactly like the edit silently failed.
    """
    _album_cache.pop(directory, None)


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


def summarize_for_deletion(directory: Path) -> dict:
    """
    Exactly what removing this folder would take with it.

    Read separately from the scan so the confirmation is describing the folder as it is right
    now, not as it was when the library was last scanned - and so it can count the things the
    scan ignores. A folder holding files that aren't audio or artwork is worth saying out
    loud before it goes: it might be a rip log, or it might be the only copy of something.
    """
    audio = 0
    other: list[str] = []
    total = 0

    for entry in sorted(directory.rglob("*")):
        if not entry.is_file():
            continue

        try:
            total += entry.stat().st_size
        except OSError:
            pass

        extension = file_extension(entry.name)
        if extension in AUDIO_EXTENSIONS:
            audio += 1
        elif extension not in IMAGE_EXTENSIONS:
            other.append(entry.name)

    return {
        "audio_files": audio,
        "total_bytes": total,
        #? capped: the point is "there is other stuff in here", not a full manifest
        "other_files": other[:12],
        "other_file_count": len(other),
    }


def delete_album(library_root: str, album_path: str) -> dict:
    """
    Remove an album folder and everything in it. There is no undo.

    This is the only code in jimbrainz that deletes anything the user did not just download,
    so every guard is deliberate:

      - LIBRARY_PATH must be configured, and the path must be non-empty.
      - It must resolve INSIDE the library. `is_within` resolves both sides, so neither
        "../.." nor a symlink pointing elsewhere gets through.
      - It must not BE the library root. `rmtree` on that would take the whole collection.
      - It must contain audio. That is what makes it an album rather than an artist folder
        or something the user keeps in there, and it means a mistyped path deletes nothing.

    Returns what was removed so the interface can say so rather than just going quiet.
    """
    from src.organizer import is_within

    if not library_root or not album_path:
        return {"deleted": False, "problem": "no album given"}

    root = Path(library_root)
    directory = root / album_path

    if not is_within(directory, root) or directory.resolve() == root.resolve():
        logger.warning(f"refused to delete outside the library: {album_path!r}")
        return {"deleted": False, "problem": "that album is not inside the library"}

    if not directory.is_dir():
        return {"deleted": False, "problem": "that folder is not there any more"}

    summary = summarize_for_deletion(directory)

    #? Audio sitting DIRECTLY in this folder, not anywhere beneath it. That distinction is
    #? the whole guard: an artist folder contains plenty of audio further down, so a
    #? recursive check happily accepts "Tame Impala" and takes the entire discography with
    #? it. It is also how the scanner decides what an album is, so the two agree on what can
    #? be deleted.
    direct_audio = any(
        entry.is_file() and file_extension(entry.name) in AUDIO_EXTENSIONS
        for entry in directory.iterdir()
    )

    if not direct_audio:
        return {"deleted": False, "problem": "that folder holds no audio, so it isn't an album"}

    import shutil

    try:
        shutil.rmtree(directory)
    except OSError as e:
        logger.error(f"could not delete {directory}: {e}")
        return {"deleted": False, "problem": f"could not delete it: {e}"}

    forget_cached_album(str(directory))

    #? tidy the artist folder if that was their last album, but only with rmdir, which
    #? refuses a non-empty directory by construction - anything left is something we didn't
    #? put there and isn't ours to remove
    try:
        parent = directory.parent
        if parent != root and is_within(parent, root):
            parent.rmdir()
            logger.info(f"removed the now-empty {parent.name}")
    except OSError:
        pass

    logger.info(
        f"deleted {album_path} ({summary['audio_files']} track(s), "
        f"{summary['total_bytes'] // (1024 * 1024)} MB)",
        extra={"frontend": True},
    )

    return {"deleted": True, "problem": None, **summary}
