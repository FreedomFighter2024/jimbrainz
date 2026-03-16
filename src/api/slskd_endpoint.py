import asyncio
import traceback
import slskd_api
from requests.exceptions import HTTPError, ConnectionError
from src.config import Config
from src.logger import logger


class SlskdClient:
    def __init__(self):
        self.client: slskd_api.SlskdClient | None = None
    
    async def get_client(self) -> slskd_api.SlskdClient:
        logger.info("getting slskd SlskdClient")

        try:
            if self.client is None:
                if not Config.SLSKD_URL:
                    logger.warning("SLSKD_URL is not configured", extra={"frontend": True, "src":"slskd"})
                    raise ValueError("SLSKD_URL is not configured")
                
                if not Config.SLSKD_APIKEY:
                    logger.warning("SLSKD_APIKEY is not configured", extra={"frontend": True, "src":"slskd"})
                    raise ValueError("SLSKD_APIKEY is not configured")

                self.client = slskd_api.SlskdClient(
                    host=Config.SLSKD_URL,
                    api_key=Config.SLSKD_APIKEY
                )
        except Exception as e:
            logger.error(f"failed to create slskd client, traceback in logs", extra={"frontend": True, "src":"slskd"})
            logger.error(traceback.format_exc())
            raise e
        
        return self.client


    async def close_client(self) -> None:
        logger.info("closing slskd client")
        self.client = None


    async def ping(self) -> dict:
        logger.info("pinging slskd to check connectivity")

        try:
            client = await self.get_client()
            state = await asyncio.to_thread(client.application.state)
            if state:
                logger.info("slskd functionality enabled, auth correct, and connection successful")
                logger.info(f"Connection successful", extra={"frontend": True, "src":"slskd"})
                return {"status": "ok"}
            else:
                logger.error("slskd ping didnt return a state")
                return {"status": "failed", "error": "slskd ping didnt return a state", "code": "NO_STATE"}
            

        except HTTPError as exc:
            status = exc.response.status_code
            logger.error(f"slskd ping replied but failed with HTTP error, status code: {status}")

            if status == 401:
                logger.error("slskd http 401, slskd functionality enabled, connection possible, but auth invalid")
                return {"status": "failed", "error": "slskd http 401, slskd functionality enabled, connection possible, but auth invalid", "code": 401}

            if status == 502:
                logger.error("slskd http 502, slskd functionality enabled, connection not made cause backend is down")
                return {"status": "failed", "error": "slskd http 502, slskd functionality enabled, connection not made cause backend is down", "code": 502}

            else:
                logger.error(f"slskd uncaught HTTP error {status}, unknown")
                return {"status": "failed", "error": f"slskd uncaught HTTP error {status}, unknown", "code": "UNKNOWN_HTTP_ERROR"}
    

        except ConnectionError as exc:
            logger.error(f"slskd ping failed with connection error, functionality enabled, but couldnt connect to the url provided (no auth checked)")
            return {"status": "failed", "error": f"slskd ping failed with connection error, functionality enabled, but couldnt connect to the url provided (no auth checked)", "code": "CONNECTION_ERROR"}

        except Exception as e:
            logger.error(f"slskd ping failed unexpectedly")
            logger.error(traceback.format_exc())
            return {"status": "failed", "error": f"slskd ping failed unexpectedly", "code": "UNKNOWN_ERROR"}



