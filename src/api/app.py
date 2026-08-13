import asyncio
from pathlib import Path
from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from src.routes import search_musicbrainz, interface_logs, monitor_slskd, download, library
from src.logger import logger, cleanup_logging
from src.poller import run_download_poller
from src.store import JobStore

from src.api.musicbrainz_endpoint import MusicBrainzClient
from src.api.slskd_endpoint import SlskdClient

@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.musicbrainz_client = MusicBrainzClient()
    app.state.slskd_client = SlskdClient()
    logger.info("slskd client initialized")

    app.state.store = JobStore()
    app.state.store.init()

    poller_task = asyncio.create_task(
        run_download_poller(app.state.slskd_client, app.state.store)
    )

    yield
    logger.info("Shutting down API server...")

    poller_task.cancel()
    try:
        await poller_task
    except asyncio.CancelledError:
        pass

    await app.state.musicbrainz_client.close_client()
    await app.state.slskd_client.close_client()

    cleanup_logging()


def start() -> FastAPI:
    logger.info("Starting API server")
    app = FastAPI(
        title="jimbrainz",
        summary="Search MusicBrainz, download through slskd",
        lifespan=lifespan
    )

    #? Vite writes these with a content hash in the filename, so a given URL's contents can
    #? never change. Revalidating them would be pure waste, and caching them hard is what
    #? makes the hashing worth doing at all.
    IMMUTABLE_PREFIXES = ("/dist/assets/",)

    #? Everything whose URL stays the same while its contents change: the hand-written
    #? interface files, and the Vite entry bundle - deliberately unhashed so the static
    #? index.html can name it (see ui/vite.config.ts), which is exactly what makes it mutable.
    REVALIDATE_PREFIXES = ("/scripts/", "/styles/", "/assets/", "/dist/")

    @app.middleware("http")
    async def revalidate_interface_assets(request, call_next):
        """
        Make the browser revalidate the interface files instead of trusting its cache.

        Without this, updating the container leaves people staring at the old CSS and JS
        until they think to hard-refresh - the failure mode being "I upgraded and nothing
        changed", which is miserable to diagnose. `no-cache` still allows a conditional
        request, so with StaticFiles' ETags the normal case is a cheap 304 rather than a
        re-download. It cost real time during development before being noticed here.

        The hashed-asset carve-out matters as the Preact migration lands: matching only
        /scripts/ and /styles/ would have left the new bundle uncovered and reintroduced that
        exact bug for the half of the interface that had been ported.
        """
        response = await call_next(request)

        path = request.url.path

        #? checked first - /dist/assets/x-HASH.js matches both tuples
        if path.startswith(IMMUTABLE_PREFIXES):
            response.headers["Cache-Control"] = "public, max-age=31536000, immutable"

        elif path == "/" or path.startswith(REVALIDATE_PREFIXES):
            response.headers["Cache-Control"] = "no-cache"

        return response

    logger.info("adding routers")
    app.include_router(interface_logs.router, prefix="/jimbrainz/interface_logs", tags=["interface_logs"])
    app.include_router(search_musicbrainz.router, prefix="/jimbrainz/search_musicbrainz", tags=["search_musicbrainz"])
    app.include_router(monitor_slskd.router, prefix="/jimbrainz/monitor_slskd", tags=["monitor_slskd"])
    app.include_router(download.router, prefix="/jimbrainz/download", tags=["download"])
    app.include_router(library.router, prefix="/jimbrainz/library", tags=["library"])

    logger.info("mounting static interface files")
    interface_path = Path(__file__).parent.parent.parent / "interface"
    app.mount("/", StaticFiles(directory=interface_path, html=True), name="interface")
    logger.info("adding root endpoint to serve index.html")
    @app.get("/")
    async def serve_index():
        return FileResponse(interface_path / "index.html")

    logger.info("API server started")
    return app
