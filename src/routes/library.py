import asyncio
from pathlib import Path

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from src.config import Config
from src.library import forget_cached_album, load_album_art, scan_library
from src.logger import logger
from src.organizer import is_within
from src.retag import execute_retag, plan_retag

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


class RetagRelease(BaseModel):
    """
    The release to apply. Same shape the download path stores with a job, so an album
    corrected by hand ends up carrying exactly the tags one downloaded fresh would have.
    """
    artist: str = ""
    album: str = ""
    year: str | None = None
    release_mbid: str | None = None
    release_group_mbid: str | None = None
    disambiguation: str | None = None
    media_format: str | None = None
    country: str | None = None
    catalog_number: str | None = None
    edition_label: str | None = None
    edition_tags: list[str] = Field(default_factory=list)
    tracks: list[dict] = Field(default_factory=list)


class RetagRequest(BaseModel):
    #? relative to LIBRARY_PATH, as the scan reports it
    album_path: str
    release: RetagRelease


@router.post("/retag/preview")
async def retag_preview(request: RetagRequest):
    """
    What applying this release would change. Writes nothing.

    Separate from apply on purpose rather than an `apply=false` flag: this is the endpoint
    the interface calls while you're still choosing, so it must be impossible for it to
    modify anything by accident.
    """
    if not Config.LIBRARY_PATH:
        raise HTTPException(status_code=400, detail="LIBRARY_PATH is not set")

    try:
        return await asyncio.to_thread(
            plan_retag, request.album_path, request.release.model_dump(), Config.LIBRARY_PATH
        )

    except Exception as e:
        logger.error(f"Exception in /retag/preview endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error planning the retag: {e}")


@router.post("/retag/apply")
async def retag_apply(request: RetagRequest):
    """
    Write the tags and re-file the folder.

    The plan is recomputed here rather than accepted from the client: a plan is a list of
    file operations, and taking one over the wire would let anyone hand us arbitrary paths
    to write to. Recomputing costs a directory read and keeps every guard in plan_retag on
    the only path that can actually write.
    """
    if not Config.LIBRARY_PATH:
        raise HTTPException(status_code=400, detail="LIBRARY_PATH is not set")

    release = request.release.model_dump()

    try:
        plan = await asyncio.to_thread(
            plan_retag, request.album_path, release, Config.LIBRARY_PATH
        )

        if plan["source"] is None:
            raise HTTPException(status_code=400, detail="; ".join(plan["problems"]))

        results = await asyncio.to_thread(execute_retag, plan, release, "apply")

        #? The cache keys on the folder's mtime, which a retag does not move - so without
        #? this the interface would keep showing the old tags and the edit would look like
        #? it had failed. Both the old and new locations go, since a move leaves the source
        #? key pointing at a folder that no longer exists.
        forget_cached_album(plan["source"])
        if results.get("moved_to"):
            forget_cached_album(results["moved_to"])

        logger.info(
            f"retagged {results['tagged']} file(s) in {request.album_path}"
            + (f", re-filed as {Path(results['moved_to']).name}" if results.get("moved_to") else ""),
            extra={"frontend": True},
        )

        return {"plan": plan, "results": results}

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Exception in /retag/apply endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error applying the retag: {e}")
