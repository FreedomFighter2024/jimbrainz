from fastapi import APIRouter, HTTPException, Request
from src.config import Config, describe_slskd_url
from src.logger import logger

router = APIRouter()


@router.get("/config")
async def config():
    """
    Server-side settings the interface needs to render (paths are env configured, not editable).

    slskd_url is reported back deliberately: when configuration doesn't survive the trip into
    the container there's otherwise no way to see what actually arrived, and the resulting
    failure surfaces as an opaque URL error. It's a LAN address, not a secret - the API key is
    never included here.
    """
    url_problem = describe_slskd_url(Config.SLSKD_URL)

    return {
        "library_path": Config.LIBRARY_PATH,
        "download_path": Config.SLSKD_DOWNLOAD_PATH,
        "organizing_enabled": bool(Config.LIBRARY_PATH and Config.SLSKD_DOWNLOAD_PATH),
        "organize_mode": Config.ORGANIZE_MODE,
        "slskd_url": Config.SLSKD_URL or "",
        "slskd_url_problem": url_problem,
        "slskd_apikey_set": bool(Config.SLSKD_APIKEY),
    }

@router.get("/ping")
async def ping(request: Request):
    try:
        slskd_client = request.app.state.slskd_client
        ping_response = await slskd_client.ping()
        return ping_response
    except Exception as e:
        logger.error(f"Exception in /ping endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error pinging slskd: {e}")
