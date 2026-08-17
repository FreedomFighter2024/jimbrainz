from src.api.musicbrainz_endpoint import MusicBrainzClient, MusicBrainzUnavailable
from fastapi import APIRouter, HTTPException, Query, Request
from src.logger import logger

router = APIRouter()

@router.get("/fully_search")
async def fully_search(
    request: Request,
    query: str,
    limit: int = 5,
    #? Defaults True so the search view is unaffected - it renders the best group's releases
    #? straight away and would break without them. The metadata editor passes False: it ranks
    #? the groups itself and fetches the ones it wants, so eagerly walking the first group's
    #? full release list (five requests and 1.4 MB for a big album) was spent on a payload it
    #? never looked at.
    releases: bool = True,
):
    try:
        mb_client = request.app.state.musicbrainz_client
        search_result = await mb_client.fully_search(query, limit, include_releases=releases)
        return search_result

    except MusicBrainzUnavailable as e:
        #? 503 not 500: nothing is wrong with the request, the upstream is just down
        raise HTTPException(
            status_code=503,
            detail=f"MusicBrainz is unreachable right now, so this search couldn't run. "
                   f"This isn't a problem with your search terms - try again shortly. ({e})",
        )

    except Exception as e:
        logger.error(f"Exception in /fully_search endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error searching MusicBrainz: {e}")


@router.get("/releases")
async def get_releases(
    request: Request,
    release_group_mbid: str,
    #? Defaults True: the download flow matches Soulseek folders against a release's real
    #? tracklist, and losing that quietly would gut the matching rather than break it loudly.
    #? False is for choosing BETWEEN pressings, which needs format, country, catalogue number
    #? and track count - all of which survive - but not 58 tracklists. See get_release.
    tracks: bool = True,
):
    try:
        mb_client = request.app.state.musicbrainz_client
        releases = await mb_client.get_releases(release_group_mbid, with_tracks=tracks)
        return {"id": release_group_mbid, "releases": releases["releases"]}

    except Exception as e:
        logger.error(f"Exception in /releases endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving releases from MusicBrainz: {e}")


@router.get("/release")
async def get_release(
    request: Request,
    release_mbid: str,
):
    """
    One release, with its tracklist. The other half of `/releases?tracks=false`.

    Costs one request for the pressing actually chosen, rather than carrying the contents of
    every pressing in the group on the chance that one of them gets picked.
    """
    try:
        mb_client = request.app.state.musicbrainz_client
        release = await mb_client.get_release(release_mbid)

        #? request_with_retries answers with an error dict rather than raising, and handing that
        #? back as a release would produce an apply with no tracklist at all - which writes
        #? nothing and looks like the edit silently did nothing
        if release.get("status") == "failed" or not release.get("id"):
            raise MusicBrainzUnavailable(release.get("error", "unknown error"))

        return release

    except MusicBrainzUnavailable as e:
        raise HTTPException(
            status_code=503,
            detail=f"MusicBrainz is unreachable right now, so that release couldn't be "
                   f"loaded. This isn't a problem with your search terms. ({e})",
        )

    except Exception as e:
        logger.error(f"Exception in /release endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error retrieving that release from MusicBrainz: {e}")


@router.get("/ping")
async def ping(request: Request):
    try:
        mb_client = request.app.state.musicbrainz_client
        ping_response = await mb_client.ping()
        return ping_response
    except Exception as e:
        logger.error(f"Exception in /ping endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error pinging MusicBrainz: {e}")

