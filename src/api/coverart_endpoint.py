"""
Fetching cover art from the Cover Art Archive.

The interface already loads CAA thumbnails straight from the browser for albums that have
no local art. This is the other half: when you tell the metadata manager which release an
album is, it can put that release's cover in the folder so the album has real art on disk -
visible to every other music tool, and no longer dependent on the Archive being up.

Kept to its own client rather than reusing MusicBrainzClient. CAA is a different host with
different rules: no rate limit to respect, but it redirects to archive.org, so redirects
must be followed and the timeouts want to be generous - it can be slow, and an image is
bigger than a JSON document.
"""

import httpx

from src.config import Config
from src.logger import logger

BASE_URL = "https://coverartarchive.org"

#? 500px: sharp enough to be worth keeping and to survive being displayed larger later,
#? without pulling a multi-megabyte scan for something the library shows at 44px.
DEFAULT_SIZE = 500

MIME_EXTENSIONS = {
    "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp",
}


class CoverArtClient:
    def __init__(self):
        self.client: httpx.AsyncClient | None = None

    async def get_client(self) -> httpx.AsyncClient:
        if not self.client or self.client.is_closed:
            self.client = httpx.AsyncClient(
                base_url=BASE_URL,
                #? CAA asks for the same identifying user agent MusicBrainz does. Falling
                #? back rather than refusing: art is a nicety, and failing the whole retag
                #? because a user agent wasn't set would be out of proportion.
                headers={"User-Agent": Config.MUSICBRAINZ_USERAGENT or "jimbrainz/0.3"},
                #? CAA answers with a redirect to archive.org, so this is not optional
                follow_redirects=True,
                timeout=httpx.Timeout(connect=10.0, write=10.0, read=45.0, pool=10.0),
            )

        return self.client

    async def close_client(self) -> None:
        if self.client and not self.client.is_closed:
            await self.client.aclose()
            self.client = None

    async def fetch_front(self, release_mbid: str, size: int = DEFAULT_SIZE) -> tuple[bytes, str] | None:
        """
        The front cover for a release, or None.

        None covers every ordinary way this doesn't work out - the release has no art, the
        Archive is down, the download is truncated - because none of them are errors worth
        failing a retag over. The tags are the point; the art is a bonus.
        """
        if not release_mbid:
            return None

        try:
            client = await self.get_client()
            response = await client.get(f"/release/{release_mbid}/front-{size}")

        except Exception as e:
            logger.warning(f"could not reach the Cover Art Archive: {e}")
            return None

        if response.status_code == 404:
            #? extremely common and not a problem: plenty of releases simply have no art
            logger.info(f"no cover art on file for release {release_mbid}")
            return None

        if response.status_code != 200:
            logger.warning(f"cover art request returned {response.status_code} for {release_mbid}")
            return None

        content_type = (response.headers.get("content-type") or "").split(";")[0].strip().lower()

        if content_type not in MIME_EXTENSIONS:
            logger.warning(f"cover art came back as {content_type!r}, which isn't an image")
            return None

        data = response.content

        #? a few hundred bytes is an error page or a truncated download, not a cover
        if len(data) < 1024:
            logger.warning(f"cover art for {release_mbid} was only {len(data)} bytes, ignoring it")
            return None

        logger.info(
            f"fetched {len(data) // 1024} KB of cover art for {release_mbid}",
            extra={"frontend": True, "src": "musicbrainz"},
        )
        return data, content_type


def extension_for(mime: str) -> str:
    return MIME_EXTENSIONS.get(mime, "jpg")
