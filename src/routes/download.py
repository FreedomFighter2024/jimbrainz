from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from src.api.slskd_endpoint import build_search_query
from src.logger import logger
from src.matching import rank_candidates
from src.store import OPEN_STATUSES, index_transfers_by_user, summarize_transfers

router = APIRouter()


class Track(BaseModel):
    position: int | None = None
    title: str = ""
    length_ms: int | None = None


class FindCandidatesRequest(BaseModel):
    artist: str
    album: str
    year: str | None = None
    release_mbid: str | None = None
    edition_tags: list[str] = Field(default_factory=list)
    tracks: list[Track] = Field(default_factory=list)
    format_preference: str = "prefer_lossless"
    #? lets the UI re-run a tweaked query when the generated one finds nothing
    query_override: str | None = None


class EnqueueFile(BaseModel):
    filename: str
    size: int


class EnqueueRelease(BaseModel):
    """What the download is *for*. Persisted with the job so organizing it later needs no network."""
    artist: str = ""
    album: str = ""
    year: str | None = None
    release_mbid: str | None = None
    edition_tags: list[str] = Field(default_factory=list)
    tracks: list[Track] = Field(default_factory=list)


class EnqueueRequest(BaseModel):
    username: str
    files: list[EnqueueFile]
    directory: str = ""
    release: EnqueueRelease = Field(default_factory=EnqueueRelease)


@router.post("/find_candidates")
async def find_candidates(request: Request, body: FindCandidatesRequest):
    """
    Search Soulseek for the release the user picked and rank what comes back against it.

    The ranking is the whole point - see src/matching.py. Candidates that don't match the
    requested edition are ranked down but deliberately still returned, since Soulseek folder
    names often omit edition text entirely and filtering would hide real results.
    """
    try:
        slskd_client = request.app.state.slskd_client
        query = body.query_override or build_search_query(body.artist, body.album)

        if not query:
            raise HTTPException(status_code=400, detail="Could not build a search query")

        responses = await slskd_client.search(query)

        expected = {
            "artist": body.artist,
            "album": body.album,
            "year": body.year,
            "edition_tags": body.edition_tags,
            "tracks": [t.model_dump() for t in body.tracks],
        }

        candidates = rank_candidates(responses, expected, body.format_preference)

        if not candidates:
            logger.warning(
                f"no usable candidates for: {query}",
                extra={"frontend": True, "src": "slskd"},
            )

        else:
            logger.info(
                f"ranked {len(candidates)} candidates, best score {candidates[0]['score']}",
                extra={"frontend": True, "src": "slskd"},
            )

        return {
            "query": query,
            "response_count": len(responses),
            "candidates": [_serialize_candidate(c) for c in candidates],
        }

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Exception in /find_candidates endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error searching slskd: {e}")


def _serialize_candidate(candidate: dict) -> dict:
    """
    Strip the bits the UI doesn't need. `track_mapping` in particular holds whole file dicts
    and gets big; it's recomputed server-side when the organizer needs it (phase 3).
    """
    return {
        "username": candidate["username"],
        "directory": candidate["directory"],
        "directory_name": candidate["directory_name"],
        "score": candidate["score"],
        "signals": candidate["signals"],
        "matched_tracks": candidate["matched_tracks"],
        "expected_tracks": candidate["expected_tracks"],
        "audio_file_count": candidate["audio_file_count"],
        "detected_edition_tags": candidate["detected_edition_tags"],
        "formats": candidate["formats"],
        "upload_speed": candidate["upload_speed"],
        "queue_length": candidate["queue_length"],
        "has_free_slot": candidate["has_free_slot"],
        "total_size": candidate["total_size"],
        "bitrates": candidate["bitrates"],
        "files": [
            {"filename": f["filename"], "size": f.get("size", 0)}
            for f in candidate["files"]
        ],
    }


@router.post("/enqueue")
async def enqueue(request: Request, body: EnqueueRequest):
    try:
        slskd_client = request.app.state.slskd_client
        files = [f.model_dump() for f in body.files]

        ok = await slskd_client.enqueue(body.username, files)

        if not ok:
            raise HTTPException(status_code=502, detail="slskd refused the download")

        #? record only after slskd accepts, so a rejected download never leaves a phantom job
        job_id = await request.app.state.store.create_job(
            username=body.username,
            directory=body.directory,
            files=files,
            release=body.release.model_dump(),
        )

        return {"status": "ok", "queued": len(files), "job_id": job_id}

    except HTTPException:
        raise

    except Exception as e:
        logger.error(f"Exception in /enqueue endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error queueing download: {e}")


@router.get("/jobs")
async def jobs(request: Request):
    """
    Tracked download jobs, merged with live progress from slskd.

    Progress is computed per request rather than stored - slskd is the source of truth for
    it and it changes every second, so persisting it would be churn for no benefit.
    """
    try:
        store = request.app.state.store
        stored = await store.list_jobs()

        if not stored:
            return {"jobs": [], "tracking_enabled": store.available}

        transfers_by_user = {}
        if any(j["status"] in OPEN_STATUSES for j in stored):
            downloads = await request.app.state.slskd_client.get_downloads()
            transfers_by_user = index_transfers_by_user(downloads)

        merged = []
        for job in stored:
            summary = (summarize_transfers(job, transfers_by_user)
                       if job["status"] in OPEN_STATUSES
                       else {"progress": 100.0 if job["status"] != "failed" else 0.0,
                             "state": None, "speed": 0, "bytes_transferred": 0,
                             "files_done": len(job["files"]) if job["status"] != "failed" else 0,
                             "files_total": len(job["files"]), "matched": False})

            merged.append({
                "id": job["id"],
                "artist": job["artist"],
                "album": job["album"],
                "year": job["year"],
                "username": job["username"],
                "directory": job["directory"],
                "status": job["status"],
                "error": job["error"],
                "created_at": job["created_at"],
                **summary,
            })

        return {"jobs": merged, "tracking_enabled": store.available}

    except Exception as e:
        logger.error(f"Exception in /jobs endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error fetching download jobs: {e}")


@router.get("/downloads")
async def downloads(request: Request):
    """Raw slskd transfer list, untouched. Handy for debugging what the poller is seeing."""
    try:
        slskd_client = request.app.state.slskd_client
        return {"downloads": await slskd_client.get_downloads()}

    except Exception as e:
        logger.error(f"Exception in /downloads endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error fetching downloads: {e}")
