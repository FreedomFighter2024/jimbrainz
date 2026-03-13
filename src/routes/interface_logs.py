from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from src.logger import logger, register_sse_client, unregister_sse_client
import asyncio

router = APIRouter()

@router.get("/interface_logs")
async def interface_logs():
    try:
        async def event_generator():
            logger.info("interface connecting to event stream")
            client_queue = register_sse_client()

            try:
                while True:
                    try: 
                        event = await asyncio.wait_for(client_queue.get(), timeout=15)
                        yield f"data: {event}\n\n"
                    except asyncio.TimeoutError:
                        yield ":\n\n" #keepalive
            finally:
                unregister_sse_client(client_queue)

        return StreamingResponse(
            event_generator(), 
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
            },
        )
    
    except Exception as e:
        logger.error(f"Exception in /interface_logs endpoint: {e}")
        raise HTTPException(status_code=500, detail=f"Error in interface logs stream: {e}")