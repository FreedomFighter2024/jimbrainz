"""
Turning a finished slskd download into a tagged, filed album.

This is the only part of jimbrainz that writes to the user's filesystem, so it is built in
two halves that are deliberately kept apart:

  plan_organization()  - pure. Works out what *would* happen. No disk writes, fully testable.
  execute_plan()       - does it, and only what the plan says.

That split is what makes dry-run trustworthy rather than a second code path that might
disagree with the real one: dry-run runs the identical plan and simply declines to execute.

Defaults are cautious on purpose - copy rather than move, never overwrite, and ORGANIZE_MODE
starts at dry_run so a first deploy with a mis-mapped volume reports what it would have done
instead of scattering a music library.
"""

import re
import shutil
from pathlib import Path

from src.logger import logger
from src.matching import file_extension, match_tracks_to_files, split_remote_path


#? off      - never organize, downloads just sit in slskd's folder
#? dry_run  - plan and log, touch nothing (default: safe first deploy)
#? copy     - copy into the library, leave slskd's copy alone
#? move     - move into the library
ORGANIZE_MODES = ("off", "dry_run", "copy", "move")

INVALID_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def sanitize_filename(name: str, fallback: str = "unknown") -> str:
    """Make a string safe as a single path component on any of the usual filesystems."""
    cleaned = INVALID_FILENAME_CHARS.sub("_", name or "").strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    #? 255 is the common per-component limit; leave room for a numeric suffix
    return (cleaned[:200] or fallback)


def build_target_path(library_root: str, release: dict, track: dict | None, extension: str) -> Path:
    """
    {library}/{artist}/{album} ({year})/{NN} - {title}.{ext}

    Tracks that couldn't be matched to the tracklist keep their original filename rather than
    being given a made-up number - a wrong track number is worse than none.
    """
    artist = sanitize_filename(release.get("artist"), "Unknown Artist")
    album = sanitize_filename(release.get("album"), "Unknown Album")
    year = (release.get("year") or "").strip()
    album_dir = f"{album} ({year})" if year else album

    if track and track.get("position") and track.get("title"):
        filename = f"{int(track['position']):02d} - {sanitize_filename(track['title'])}.{extension}"
    else:
        filename = sanitize_filename(track.get("filename") if track else None, "untitled") + f".{extension}"

    return Path(library_root) / artist / sanitize_filename(album_dir) / filename


def find_local_file(download_root: str, remote_filename: str, remote_directory: str = "") -> Path | None:
    """
    Locate what slskd actually wrote to disk for a given remote file.

    slskd's on-disk layout isn't something we control or can rely on staying put (it has
    changed between versions, and sanitizes remote directory names), so rather than
    reconstructing the path we search for the basename under the download root and prefer a
    hit whose parent folder matches the remote folder. Slower, but it survives slskd
    reorganizing its own downloads directory.
    """
    root = Path(download_root)
    if not root.is_dir():
        return None

    _, basename = split_remote_path(remote_filename)
    if not basename:
        return None

    matches = [p for p in root.rglob(basename) if p.is_file()]

    if not matches:
        return None

    if len(matches) > 1 and remote_directory:
        wanted_dir = remote_directory.replace("\\", "/").rstrip("/").rpartition("/")[2]
        preferred = [p for p in matches if p.parent.name == wanted_dir]
        if preferred:
            return preferred[0]

    return matches[0]


def plan_organization(job: dict, download_root: str, library_root: str) -> dict:
    """
    Work out every file operation this job implies. Touches nothing.

    The file->track mapping is recomputed here from the stored release and file list rather
    than having been persisted at match time: match_tracks_to_files is pure and needs only
    filenames, so recomputing keeps one source of truth instead of storing derived data that
    could drift from the code that produced it.
    """
    release = job.get("release") or {}
    tracks = release.get("tracks") or []
    files = job.get("files") or []

    mapping = match_tracks_to_files(tracks, files) if tracks else {}
    track_by_filename = {
        entry["file"]["filename"]: entry["track"] for entry in mapping.values()
    }

    operations = []
    problems = []
    used_targets: set[Path] = set()

    for file_entry in files:
        remote_filename = file_entry.get("filename", "")
        source = find_local_file(download_root, remote_filename, job.get("directory", ""))

        if source is None:
            problems.append(f"not found on disk: {remote_filename}")
            continue

        _, basename = split_remote_path(remote_filename)
        track = track_by_filename.get(remote_filename)
        extension = file_extension(basename) or "bin"

        target = build_target_path(
            library_root,
            release,
            track or {"filename": Path(basename).stem},
            extension,
        )

        #? two source files resolving to one target would silently destroy one of them
        if target in used_targets:
            problems.append(f"two files map to the same destination: {target.name}")
            continue

        used_targets.add(target)
        operations.append({
            "source": str(source),
            "target": str(target),
            "track": track,
            "exists": target.exists(),
        })

    return {
        "job_id": job.get("id"),
        "album_dir": str(Path(operations[0]["target"]).parent) if operations else None,
        "operations": operations,
        "problems": problems,
        "matched_tracks": len(mapping),
        "total_tracks": len(tracks),
    }


def write_tags(path: Path, release: dict, track: dict | None) -> None:
    """
    Tag the file from the MusicBrainz release it came from.

    Writes the MusicBrainz IDs too, so the resulting library stays legible to Picard/beets
    later instead of being a jimbrainz-only artifact. Tagging failures are logged and
    tolerated: a filed-but-untagged file is a far better outcome than a half-organized album.
    """
    import mutagen

    try:
        audio = mutagen.File(str(path), easy=True)
    except Exception as e:
        logger.warning(f"could not read tags on {path.name}: {e}")
        return

    if audio is None:
        logger.warning(f"unsupported audio format for tagging: {path.name}")
        return

    values = {
        "album": release.get("album"),
        "albumartist": release.get("artist"),
        "artist": release.get("artist"),
        "date": release.get("year"),
        "musicbrainz_albumid": release.get("release_mbid"),
    }

    if track:
        values["title"] = track.get("title")
        if track.get("position"):
            values["tracknumber"] = str(track["position"])

    for key, value in values.items():
        if not value:
            continue

        try:
            audio[key] = str(value)
        except Exception:
            #? not every container supports every key (easy mp4 is picky); skip rather than abort
            continue

    try:
        audio.save()
    except Exception as e:
        logger.warning(f"could not write tags to {path.name}: {e}")


def execute_plan(plan: dict, release: dict, mode: str = "dry_run") -> dict:
    """
    Carry out a plan. `mode` decides how far it goes; dry_run stops before touching anything.
    """
    if mode not in ORGANIZE_MODES:
        mode = "dry_run"

    results = {"organized": 0, "skipped": 0, "failed": 0, "dry_run": mode == "dry_run", "mode": mode}

    if mode == "off":
        return results

    for operation in plan["operations"]:
        source = Path(operation["source"])
        target = Path(operation["target"])

        if mode == "dry_run":
            logger.info(f"[dry run] would place {source.name} -> {target}")
            results["organized"] += 1
            continue

        #? never clobber. An existing destination is far more likely to be a real album the
        #? user already has than something safe to overwrite.
        if target.exists():
            logger.warning(f"already exists, leaving it alone: {target}")
            results["skipped"] += 1
            continue

        try:
            target.parent.mkdir(parents=True, exist_ok=True)

            if mode == "move":
                shutil.move(str(source), str(target))
            else:
                shutil.copy2(str(source), str(target))

            write_tags(target, release, operation.get("track"))
            results["organized"] += 1

        except Exception as e:
            logger.error(f"failed to place {source.name}: {e}")
            results["failed"] += 1

    return results


async def organize_job(job: dict, download_root: str, library_root: str, mode: str) -> dict:
    """Plan then execute, with the logging the UI's event log surfaces."""
    import asyncio

    label = f"{job.get('artist')} - {job.get('album')}"
    plan = await asyncio.to_thread(plan_organization, job, download_root, library_root)

    for problem in plan["problems"]:
        logger.warning(f"{label}: {problem}", extra={"frontend": True, "src": "slskd"})

    if not plan["operations"]:
        logger.error(f"nothing to organize for {label}", extra={"frontend": True, "src": "slskd"})
        return {"organized": 0, "skipped": 0, "failed": 0,
                "dry_run": mode == "dry_run", "mode": mode, "plan": plan}

    results = await asyncio.to_thread(execute_plan, plan, job.get("release") or {}, mode)

    verb = "would organize" if results.get("dry_run") else "organized"
    logger.info(
        f"{verb} {results['organized']} file(s) for {label} into {plan['album_dir']}",
        extra={"frontend": True, "src": "slskd"},
    )

    results["plan"] = plan
    return results
