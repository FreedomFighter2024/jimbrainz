import asyncio
import re
import traceback
import slskd_api
from requests.exceptions import HTTPError, ConnectionError
from src.config import Config, describe_slskd_url
from src.logger import logger


def build_search_query(artist: str, album: str) -> str:
    """
    Soulseek search is a plain substring match over shared filenames, not a metadata index.
    Punctuation and edition text are actively harmful here - the Tubifarry maintainer's own
    guidance is that over-specific queries return nothing, because "deluxe edition" almost
    never appears in the folder names people actually share.

    So the query stays deliberately dumb: artist + album. Edition preference is applied later
    when ranking what comes back (src/matching.py), which is where it can help instead of hurt.
    """
    combined = f"{artist or ''} {album or ''}"
    combined = re.sub(r"[\[\](){}_\-.,'\"!?/\\:;&+]", " ", combined)
    combined = re.sub(r"\s+", " ", combined)
    return combined.strip()


class SlskdClient:
    def __init__(self):
        self.client: slskd_api.SlskdClient | None = None
    
    async def get_client(self) -> slskd_api.SlskdClient:
        logger.info("getting slskd SlskdClient")

        try:
            if self.client is None:
                # Check the URL is actually usable before handing it over. slskd_api builds its
                # base URL by urljoin-ing the host, so a blank or scheme-less value doesn't fail
                # here - it fails much later inside requests as
                # "Invalid URL '///api/v0/searches': No scheme supplied", which says nothing
                # about which setting is wrong or where to fix it.
                url_problem = describe_slskd_url(Config.SLSKD_URL)
                if url_problem:
                    message = f"SLSKD_URL is unusable ({url_problem})"
                    logger.error(message, extra={"frontend": True, "src": "slskd"})
                    raise ValueError(message)

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


    async def search(
        self,
        query: str,
        search_timeout_ms: int = 8000,
        poll_interval: float = 0.5,
        max_wait: float = 25.0,
    ) -> list[dict]:
        """
        Run a Soulseek search and wait for it to settle.

        slskd searches are asynchronous: you POST one, peers trickle in responses, and it
        flips isComplete when the timeout expires. slskd_api is synchronous so every call goes
        through asyncio.to_thread, same as ping() already does.
        """
        logger.info(f"searching slskd for: {query}", extra={"frontend": True, "src": "slskd"})
        client = await self.get_client()

        state = await asyncio.to_thread(
            client.searches.search_text,
            searchText=query,
            searchTimeout=search_timeout_ms,
        )
        search_id = state.get("id")

        if not search_id:
            logger.error("slskd did not return a search id", extra={"frontend": True, "src": "slskd"})
            return []

        elapsed = 0.0
        while elapsed < max_wait:
            await asyncio.sleep(poll_interval)
            elapsed += poll_interval

            state = await asyncio.to_thread(client.searches.state, search_id)
            if state.get("isComplete"):
                break

        else:
            logger.warning(
                f"slskd search didnt complete within {max_wait}s, using whatever came back",
                extra={"frontend": True, "src": "slskd"},
            )

        responses = await asyncio.to_thread(client.searches.search_responses, search_id)
        logger.info(
            f"slskd returned {len(responses)} responses for: {query}",
            extra={"frontend": True, "src": "slskd"},
        )

        #? don't let one-shot searches pile up in slskd's UI forever
        try:
            await asyncio.to_thread(client.searches.delete, search_id)
        except Exception:
            logger.warning(f"couldnt clean up slskd search {search_id}, harmless")

        return responses


    async def enqueue(self, username: str, files: list[dict]) -> bool:
        """
        Queue a download. `files` must be [{'filename': ..., 'size': ...}] exactly as returned
        by search_responses - slskd matches on those two fields.
        """
        logger.info(
            f"queueing {len(files)} files from {username}",
            extra={"frontend": True, "src": "slskd"},
        )
        client = await self.get_client()

        payload = [{"filename": f["filename"], "size": f["size"]} for f in files]

        try:
            ok = await asyncio.to_thread(client.transfers.enqueue, username=username, files=payload)

            if ok:
                logger.info(f"queued {len(files)} files from {username}", extra={"frontend": True, "src": "slskd"})
            else:
                logger.error(f"slskd refused the download from {username}", extra={"frontend": True, "src": "slskd"})

            return bool(ok)

        except Exception:
            logger.error(f"failed to queue download from {username}", extra={"frontend": True, "src": "slskd"})
            logger.error(traceback.format_exc())
            return False


    async def cancel_download(self, username: str, transfer_id: str, remove: bool = True) -> bool:
        """Cancel one in-flight transfer. `remove` also drops it from slskd's own list."""
        try:
            client = await self.get_client()
            return bool(await asyncio.to_thread(
                client.transfers.cancel_download, username=username, id=transfer_id, remove=remove
            ))

        except Exception:
            logger.error(f"failed to cancel transfer {transfer_id} from {username}")
            logger.error(traceback.format_exc())
            return False


    async def queue_position(self, username: str, transfer_id: str) -> int | None:
        """
        Where we sit in a peer's upload queue.

        slskd only answers this per transfer, so it's asked for sparingly - a queued job
        rather than every file on every poll.
        """
        try:
            client = await self.get_client()
            position = await asyncio.to_thread(
                client.transfers.get_queue_position, username=username, id=transfer_id
            )
            return int(position) if isinstance(position, (int, str)) and str(position).isdigit() else None

        except Exception:
            #? peers drop out constantly; a missing position isn't worth logging loudly
            return None


    async def get_downloads(self) -> list[dict]:
        """
        All current downloads, grouped by user then directory.

        Never raises: this is read on every downloads-panel refresh and by the poller, and a
        misconfigured or briefly unreachable slskd should degrade to "no live progress"
        rather than breaking the whole panel. get_client() is inside the try for that reason
        - it throws on missing config.
        """
        try:
            client = await self.get_client()
            return await asyncio.to_thread(client.transfers.get_all_downloads, includeRemoved=False)

        except Exception:
            logger.error("failed to fetch downloads from slskd", extra={"frontend": True, "src": "slskd"})
            logger.error(traceback.format_exc())
            return []


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



