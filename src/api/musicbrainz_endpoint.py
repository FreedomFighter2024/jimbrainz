import asyncio 
import time
import httpx
from collections import deque
from src.config import Config
from src.logger import logger
class RateLimit:
    max_requests = 4
    time_window = 5.0 

    def __init__(self):
        self.request_times = deque(maxlen=self.max_requests)
    
    async def wait(self) -> None: 
        curr_time = time.monotonic()
        
        if len(self.request_times) >= self.max_requests:
            oldest_time = self.request_times[0]
            time_since_oldest = curr_time - oldest_time
            
            if time_since_oldest < self.time_window:
                wait_time = self.time_window - time_since_oldest
                logger.warning(f"rate limit hit on musicbrainz requests", extra={"frontend": True, "src":"musicbrainz"})
                await asyncio.sleep(wait_time)
                curr_time = time.monotonic()

        self.request_times.append(curr_time)

class MusicBrainzClient:
    RETRIES = 10
    rate_limit = RateLimit()

    def __init__(self):
        self.client: httpx.AsyncClient | None = None
    
    async def get_client(self) -> httpx.AsyncClient:
        logger.info("getting MusicBrainz httpx AsyncClient")

        if not self.client or self.client.is_closed:
            if not Config.MUSICBRAINZ_USERAGENT:
                logger.error("MUSICBRAINZ_USERAGENT is not configured", extra={"frontend": True, "src":"musicbrainz"})
                raise ValueError("MUSICBRAINZ_USERAGENT is not configured")
            logger.info(f" user agent is {Config.MUSICBRAINZ_USERAGENT}")
            self.client = httpx.AsyncClient(
                base_url="https://musicbrainz.org/ws/2",
                headers={
                    "User-Agent": Config.MUSICBRAINZ_USERAGENT,
                    "Accept": "application/json"
                },
                timeout=httpx.Timeout(
                    connect=10.0, #init connection
                    write=10.0,  #request send
                    read=30.0, #request answer
                    pool=10.0   #connection from pool
                ),
                limits=httpx.Limits(
                    max_connections=1,
                    max_keepalive_connections=1,
                    keepalive_expiry=60.0
                ),
                http2=True #saw mb supported it ans given it all seems to struggle i figure its better
            )

        return self.client
    

    async def close_client(self) -> None:
        if self.client is not None:
            try:
                await self.client.aclose()

            except Exception:
                pass  

            self.client = None


    async def request_with_retries(self, endpoint: str, params: dict, retry: bool = True) -> dict: #TODO turning retry on and off to be implemented
        logger.info(f"requesting MusicBrainz")
        attempt = 0

        ping_error_obj = {
            "error": "Failed to get valid response from MusicBrainz after retries",
            "status": "failed",
            "code": "MAX_RETRIES_EXCEEDED"
        }

        while attempt < self.RETRIES:
            attempt += 1

            try:
                await self.rate_limit.wait()
                client = await self.get_client()
                response = await client.get(
                    endpoint,
                    params=params
                )
                response.raise_for_status()
                return response.json()
            
            except (httpx.ConnectError, httpx.ConnectTimeout, httpx.ReadTimeout) as exc:
                delay = 2.0 + (attempt * 0.5)

                if attempt < self.RETRIES:
                    logger.warning(f"Network error on attempt {attempt}. Retrying in {delay:.2f} seconds...", extra={"frontend": True, "src":"musicbrainz"})
                    logger.warning(f"Network error on attempt {attempt} Retrying in {delay:.2f} seconds...")
                    logger.warning(f"Error details: {type(exc).__name__}: {exc}")
                    
                    ping_error_obj["error"] =  "musicbrainz ping failed with connection error"
                    ping_error_obj["status"] =  "failed"
                    ping_error_obj["code"] =  "CONNECTION_ERROR"
                    

                await self.close_client()
                await asyncio.sleep(delay)

            except httpx.HTTPStatusError as exc:
                status = exc.response.status_code

                if status == 503:  
                    logger.warning(f"MusicBrainz returned 503 (overloaded), retrying...")
                    logger.warning(f"Response text: {exc.response.text[:200]}")
                    ping_error_obj["error"] =  "musicbrainz ping failed with 503 overloaded error, responded to ping but server currenty busy"
                    ping_error_obj["status"] =  "failed"
                    ping_error_obj["code"] = 503 # type: ignore
                    await asyncio.sleep(3.0) #shrugs
                    continue

                if status == 403: 
                    logger.error(f"MusicBrainz forbid your request, this is likely because of missing/invalid User-Agent header", extra={"frontend": True, "src":"musicbrainz"})
                    logger.error(f"Response text: {exc.response.text}")
                    ping_error_obj["error"] =  "musicbrainz ping failed with 403 forbidden error, connection was made but user agent / ip not accepted"
                    ping_error_obj["status"] =  "failed"
                    ping_error_obj["code"] = 403 # type: ignore
                    break
                    
                if status == 429:  
                    logger.warning(f"Rate limited by server (429), waiting 10s...")
                    logger.warning(f"Response text: {exc.response.text[:200]}")
                    ping_error_obj["error"] =  "musicbrainz ping failed with 429 rate limit error, responded to ping but server is rate limiting"
                    ping_error_obj["status"] =  "failed"
                    ping_error_obj["code"] = 429 # type: ignore
                    await asyncio.sleep(6) #? this is just a fallback if the rate limit class is a little zesty 
                    continue

                else:
                    ping_error_obj["error"] =  f"musicbrainz ping failed with uncaught HTTP error {status}, unknown"
                    ping_error_obj["status"] =  "failed"
                    ping_error_obj["code"] = "UNKNOWN_HTTP_ERROR" # type: ignore
                
                logger.error(f"HTTP {status}: {exc.response.text[:200]}")
            
            except ValueError as exc: 
                ping_error_obj["error"] =  f"MUSICBRAINZ_USERAGENT is not configured!!"
                ping_error_obj["status"] =  "failed"
                ping_error_obj["code"] = "VALUE_ERROR"
                break
            
            except Exception as e:
                ping_error_obj["error"] =  f"musicbrainz ping failed unexpectedly"
                ping_error_obj["status"] =  "failed"
                ping_error_obj["code"] = "UNKNOWN_ERROR"

        logger.error("exceeded maximum retries for MusicBrainz request without getting valid response")
        logger.error("failed to get valid response from MusicBrainz after retries", extra={"frontend": True, "src":"musicbrainz"})
        return ping_error_obj
        

    async def get_release_groups(self, query: str, limit: int = 5) -> dict:
        params = {
            "query": query,
            "fmt": "json",
            "limit": limit
        }
        return await self.request_with_retries("release-group/", params)


    async def get_releases(self, release_group_id: str, log=True) -> dict:
        if log: logger.info("getting specific releases from musicbrainz", extra={"frontend": True, "src":"musicbrainz"})
        params = {
            "release-group": release_group_id,
            "inc": "media+recordings",
            "fmt": "json"
        }
        return await self.request_with_retries("release/", params)                
    

    async def fully_search(self, query: str, limit: int = 5) -> dict:
        logger.info(f"searching musicbrainz...", extra={"frontend": True, "src":"musicbrainz"})
        params = {
            "query": query,
            "fmt": "json",
            "limit": limit
        }
        release_groups =  await self.request_with_retries("release-group/", params)

        if not release_groups["release-groups"]:
            logger.info(f"no release groups found for query: ({query})", extra={"frontend": True, "src":"musicbrainz"})
            return {}


        logger.info(f"release groups parsed", extra={"frontend": True, "src":"musicbrainz"})
        first_release_group = release_groups["release-groups"][0] 
        first_release_group_releases = await self.get_releases(first_release_group["id"], log=False)
        
        
        return {
            "release-groups": release_groups["release-groups"],
            "best-match-releases": first_release_group_releases["releases"]
        }
    
    async def ping(self) -> dict:
        logger.info("pinging MusicBrainz to check connectivity")
        try: 
            test_release = await self.request_with_retries("release-group/f6b1b900-6108-32f0-abbd-2855af9151eb", {})
            if test_release.get("status") == "failed":
                logger.error(test_release.get("error"))
                return test_release #? {"status":"failed"}
            else: 
                logger.info(f"talking heads!")
                logger.info(f"Connection successful", extra={"frontend": True, "src":"musicbrainz"})
                return {"status": "ok"}
        except Exception as e:
            logger.error(f"musicbrainz ping failed unexpectedly")
            return {"status": "failed", "error": f"musicbrainz ping failed unexpectedly", "code": "UNKNOWN_ERROR"}





