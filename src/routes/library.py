import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response

from src.config import Config
from src.library import load_album_art, scan_library
from src.logger import logger
from src.organizer import is_within

router = APIRouter()


@router.get("/albums")
async def albums():
    """
    Everything currently in LIBRARY_PATH.

    Scanning touches the filesystem and reads tags, so it runs in a thread rather than
    blocking the event loop - a first scan of a large library takes seconds, and the download
    poller must keep running while it does.

    A missing or unset LIBRARY_PATH is reported in `problem` rather than raised: the library
    view is perfectly capable of rendering "you haven't configured this yet", and a 500 here
    would look like a broken app instead of an unfinished setup.
    """
    try:
        result = await asyncio.to_thread(scan_library, Config.LIBRARY_PATH or "")

        if result["problem"]:
            logger.warning(f"library scan: {result['problem']}", extra={"frontend": True})
        else:
            logger.info(
                f"library: {result['album_count']} album(s) by {result['artist_count']} "
                f"artist(s) in {result['scan_seconds']}s "
                f"({result['cached']} unchanged)",
                extra={"frontend": True},
            )

        return result

    except Exception as e:
        logger.error(f"Exception in /albums endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error scanning library: {e}")


@router.post("/rescan")
async def rescan():
    """
    Drop the per-folder cache and read everything again.

    The cache keys on directory mtime, which catches tracks being added or removed but not a
    file being re-tagged in place on some filesystems. This is the manual escape hatch for
    that, and for when you simply don't trust what you're looking at.
    """
    try:
        return await asyncio.to_thread(scan_library, Config.LIBRARY_PATH or "", True)

    except Exception as e:
        logger.error(f"Exception in /rescan endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error rescanning library: {e}")


@router.get("/art")
async def art(album: str):
    """
    An album's cover, from a file beside the tracks or from inside the audio itself.

    `album` is a path RELATIVE to LIBRARY_PATH, exactly as the scan reports it. That makes
    this the only endpoint in jimbrainz that turns user input into a filesystem read, so it
    is checked before it is used:

      - the resolved directory must sit inside LIBRARY_PATH. `is_within` resolves both sides
        first, so neither a "../.." nor a symlink pointing out of the library gets through.
      - an empty path is refused rather than quietly resolving to the library root.

    Without that, `?album=../../../../etc` would happily read anything the container user
    can. The check is the point of the endpoint existing at all rather than serving
    LIBRARY_PATH as static files.
    """
    root_path = Config.LIBRARY_PATH or ""

    if not root_path or not album:
        raise HTTPException(status_code=404, detail="no such album")

    root = Path(root_path)
    directory = root / album

    if not is_within(directory, root) or not directory.is_dir():
        #? deliberately the same 404 as a missing album: a traversal attempt learns nothing
        #? about what does or doesn't exist outside the library
        logger.warning(f"refused library art request outside the library: {album!r}")
        raise HTTPException(status_code=404, detail="no such album")

    result = await asyncio.to_thread(load_album_art, directory)

    if result is None:
        raise HTTPException(status_code=404, detail="no art for this album")

    data, mime = result

    return Response(
        content=data,
        media_type=mime,
        #? Art changes rarely but not never - replacing cover.jpg should show up without a
        #? hard refresh. Five minutes keeps scrolling a large library cheap while still
        #? letting an edit appear on its own.
        headers={"Cache-Control": "private, max-age=300"},
    )
