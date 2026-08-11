from fastapi import APIRouter, HTTPException, Request
from src.config import Config
from src.logger import logger

router = APIRouter()


@router.get("/config")
async def config():
    """Server-side settings the interface needs to render (paths are env configured, not editable)."""
    return {
        "library_path": Config.LIBRARY_PATH,
        "download_path": Config.SLSKD_DOWNLOAD_PATH,
        "organizing_enabled": bool(Config.LIBRARY_PATH and Config.SLSKD_DOWNLOAD_PATH),
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
