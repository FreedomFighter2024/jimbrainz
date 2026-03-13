from fastapi import APIRouter, HTTPException, Request
from src.logger import logger

router = APIRouter()

@router.get("/ping")
async def ping(request: Request):
    try:
        slskd_client = request.app.state.slskd_client
        ping_response = await slskd_client.ping()
        return ping_response
    except Exception as e:
        logger.error(f"Exception in /ping endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error pinging slskd: {e}")
