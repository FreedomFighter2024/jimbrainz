import asyncio

from fastapi import APIRouter, HTTPException

from src.config import Config
from src.library import scan_library
from src.logger import logger

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
