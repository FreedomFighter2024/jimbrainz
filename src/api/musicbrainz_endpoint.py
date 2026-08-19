import asyncio
import time
import httpx
from collections import deque, OrderedDict
from src.config import Config
from src.logger import logger
class MusicBrainzUnavailable(Exception):
    """
    Raised when MusicBrainz couldn't be reached at all, as opposed to returning no matches.

    The distinction matters to whoever is staring at the screen: "no results" means try a
    different search, "unreachable" means wait and try the same one again.
    """


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
                #? Deliberately NOT a frontend warning. This is the throttle doing its job -
                #? MusicBrainz asks for about a request a second and we hold ourselves to it -
                #? so it fires constantly during any normal burst, and telling the user their
                #? own politeness is a problem made a working search look broken. The interface
                #? already says "asking MusicBrainz..." while this waits.
                logger.debug(f"holding off {wait_time:.1f}s to stay inside the MusicBrainz rate limit")
                await asyncio.sleep(wait_time)
                curr_time = time.monotonic()

        self.request_times.append(curr_time)


class ResponseCache:
    """
    Recently fetched MusicBrainz responses, keyed on the request that produced them.

    Worth having because the questions repeat far more than they change. Opening the metadata
    editor asks for a release-group search and then the releases of the best few groups; the
    first group's releases are ALSO fetched by fully_search as `best-match-releases`, so that
    one was fetched twice every single time. Stepping through the review queue and back asks the
    same questions again, and MusicBrainz is rate limited to roughly one request a second - so
    every avoided request is a second of someone waiting.

    The data is nearly static. A release group's pressings do not change while you are looking
    at them, so a stale answer is not a real risk on this timescale.

    Bounded rather than unbounded: a release list with recordings included is a large payload
    (the Black Album's group runs to hundreds of releases), and a long-running container asking
    about a big library would otherwise hold every one it had ever seen.

    **Only successful responses are ever stored** - see request_with_retries. It returns an
    error dict rather than raising when it gives up, and caching that would pin a transient
    MusicBrainz outage in place for the whole TTL, turning a bad minute into a bad hour.
    """

    def __init__(self, ttl_seconds: float = 3600.0, max_entries: int = 64):
        self.ttl = ttl_seconds
        self.max_entries = max_entries
        self.entries: OrderedDict[tuple, tuple[float, dict]] = OrderedDict()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key(endpoint: str, params: dict) -> tuple:
        #? sorted so the same request written two ways is the same key
        return (endpoint, tuple(sorted((str(k), str(v)) for k, v in (params or {}).items())))

    def get(self, endpoint: str, params: dict) -> dict | None:
        key = self.key(endpoint, params)
        entry = self.entries.get(key)

        if entry is None:
            self.misses += 1
            return None

        stored_at, value = entry

        if time.monotonic() - stored_at > self.ttl:
            del self.entries[key]
            self.misses += 1
            return None

        #? touch, so the entries actually being used are the ones that survive eviction
        self.entries.move_to_end(key)
        self.hits += 1
        return value

    def put(self, endpoint: str, params: dict, value: dict) -> None:
        key = self.key(endpoint, params)
        self.entries[key] = (time.monotonic(), value)
        self.entries.move_to_end(key)

        while len(self.entries) > self.max_entries:
            self.entries.popitem(last=False)

    def clear(self) -> None:
        self.entries.clear()
        self.hits = 0
        self.misses = 0


class MusicBrainzClient:
    RETRIES = 10
    rate_limit = RateLimit()
    #? shared for the process, like the rate limiter and for the same reason: both are about
    #? how much this application as a whole asks of MusicBrainz, not any one client object
    cache = ResponseCache()

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
        #? Before the rate limiter, not after: the whole point is to not spend a turn of the
        #? budget - and therefore up to a second of somebody's time - on a question already
        #? answered. See ResponseCache for what does and does not get stored.
        cached = self.cache.get(endpoint, params)
        if cached is not None:
            logger.debug(f"MusicBrainz cache hit for {endpoint}")
            return cached

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

                #? The only place anything is cached, deliberately. Every other exit from this
                #? function is a failure that returns ping_error_obj, and storing one of those
                #? would keep serving "MusicBrainz is unreachable" for the whole TTL after it
                #? had come back - turning a bad minute into a bad hour.
                payload = response.json()
                self.cache.put(endpoint, params, payload)
                return payload
            
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
      
     
    #? Everything needed to TELL releases apart: format, labels, country, disambiguation, and
    #? media[].track-count. Note the track COUNT is here - only the track list itself is not.
    RELEASE_LIST_INC = "media+labels+artist-credits"

    #? The above plus every track of every disc. Needed to actually apply a release, and to
    #? match a Soulseek folder against its real tracklist, which is the whole point of the
    #? download flow - so this is still the default.
    RELEASE_FULL_INC = "media+recordings+labels+artist-credits"

    async def get_release(self, release_mbid: str) -> dict:
        """
        One release, with its tracklist.

        The companion to `get_releases(with_tracks=False)`: list them cheaply, then pay for the
        tracks of the one that was actually chosen. Measured on Metallica's 1991 album, whose
        group holds 58 releases: **carrying recordings for all of them costs 5 requests and
        1.4 MB, against 1 request and 101 KB without.** MusicBrainz allows about one request a
        second, so those four extra round trips are four seconds of somebody waiting for track
        listings of 57 pressings they did not pick.
        """
        return await self.request_with_retries(
            f"release/{release_mbid}", {"inc": self.RELEASE_FULL_INC, "fmt": "json"}
        )

    async def get_releases(self, release_group_id: str, log=True, with_tracks: bool = True) -> dict:
        """
        Every release in a group.

        `with_tracks` defaults to True because the download flow needs real tracklists to match
        Soulseek folders against, and the search view renders them. The metadata editor asks for
        False: it is choosing BETWEEN pressings, which needs their format, country, catalogue
        number and track count but not their contents - and then fetches the tracklist of the one
        you pick. See get_release for what that saves.
        """
        if log:
            logger.info(
                "getting specific releases from musicbrainz",
                extra={"frontend": True, "src": "musicbrainz"}
            )

        all_releases = []
        offset = 0
        limit = 100

        while True:
            params = {
                "release-group": release_group_id,
                "inc": self.RELEASE_FULL_INC if with_tracks else self.RELEASE_LIST_INC,
                "fmt": "json",
                "limit": limit,
                "offset": offset,
            }

            data = await self.request_with_retries("release/", params)

            #? A FAILED request and a group with no releases are not the same thing, and this
            #? is the one place they were indistinguishable: request_with_retries answers with
            #? an error dict rather than raising, so `data.get("releases", [])` quietly turned
            #? an outage into "this album has no pressings". The interface believed it, showed
            #? the top result with nothing to expand, and built its filter facets from the
            #? grids that never mounted - so a MusicBrainz blip read as a search with no
            #? releases and no filters, with nothing on screen suggesting a retry.
            if data.get("status") == "failed":
                problem = data.get("error") or "the request failed"
                logger.warning(
                    f"couldn't load the releases for that album ({problem}) - "
                    f"expand it to try again",
                    extra={"frontend": True, "src": "musicbrainz"},
                )
                return {"release-count": len(all_releases), "releases": all_releases,
                        "problem": problem}

            releases = data.get("releases", [])

            if not releases:
                break

            all_releases.extend(releases)

            if len(all_releases) >= data.get("release-count", 0):
                break

            offset += len(releases)

        return {
            "release-count": len(all_releases),
            "releases": all_releases,
            #? None means the answer is complete and an empty list really does mean empty
            "problem": None,
        }

    

    async def fully_search(self, query: str, limit: int = 5, include_releases: bool = True) -> dict:
        """
        Release groups matching the query, and by default the releases of the best one.

        `include_releases=False` exists because that second half is expensive and not everyone
        wants it. It walks the best group's full release list WITH tracklists - five requests
        and 1.4 MB for an album like Metallica's 1991 one. The search view needs it, since it
        renders those releases immediately. The metadata editor does not: it ranks the groups
        itself and then asks for the ones it actually wants, so the eager fetch was five round
        trips spent on a payload it dropped on the floor.
        """
        logger.info(f"searching musicbrainz...", extra={"frontend": True, "src":"musicbrainz"})
        params = {
            "query": query,
            "fmt": "json",
            "limit": limit
        }
        release_groups =  await self.request_with_retries("release-group/", params)

        #? request_with_retries returns an error dict rather than raising when it gives up, so
        #? reaching straight for "release-groups" threw a KeyError that surfaced as
        #? "Error searching MusicBrainz: 'release-groups'" - a message that reads like a bad
        #? query rather than "the service is down". MusicBrainz goes unreachable often enough
        #? that people reasonably blamed their own search terms for it.
        if release_groups.get("status") == "failed" or "release-groups" not in release_groups:
            reason = release_groups.get("error", "unknown error")
            logger.error(
                f"MusicBrainz is unreachable, this is not a problem with your search ({reason})",
                extra={"frontend": True, "src": "musicbrainz"},
            )
            raise MusicBrainzUnavailable(reason)

        if not release_groups["release-groups"]:
            logger.info(f"no release groups found for query: ({query})", extra={"frontend": True, "src":"musicbrainz"})
            return {}


        logger.info(f"release groups parsed", extra={"frontend": True, "src":"musicbrainz"})

        if not include_releases:
            #? the key is still present, so callers reading it don't have to special-case this
            return {"release-groups": release_groups["release-groups"], "best-match-releases": []}

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





