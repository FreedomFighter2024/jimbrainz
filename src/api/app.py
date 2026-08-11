import asyncio
from pathlib import Path
from fastapi import FastAPI
from contextlib import asynccontextmanager
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse

from src.routes import search_musicbrainz, interface_logs, monitor_slskd, download
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

    logger.info("adding routers")
    app.include_router(interface_logs.router, prefix="/lidbrainz/interface_logs", tags=["interface_logs"])
    app.include_router(search_musicbrainz.router, prefix="/lidbrainz/search_musicbrainz", tags=["search_musicbrainz"])
    app.include_router(monitor_slskd.router, prefix="/lidbrainz/monitor_slskd", tags=["monitor_slskd"])
    app.include_router(download.router, prefix="/lidbrainz/download", tags=["download"])

    logger.info("mounting static interface files")
    interface_path = Path(__file__).parent.parent.parent / "interface"
    app.mount("/", StaticFiles(directory=interface_path, html=True), name="interface")
    logger.info("adding root endpoint to serve index.html")
    @app.get("/")
    async def serve_index():
        return FileResponse(interface_path / "index.html")

    logger.info("API server started")
    return app
