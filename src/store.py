"""
Persistence for download jobs.

This exists because slskd has no idea what it's downloading *for*. It knows "user bob is
sending me 12 files"; it does not know those files are MusicBrainz release
f5093c06-... with a specific tracklist. That link is exactly what's needed later to tag and
file the result, and nothing else in the stack remembers it - so we do.

The expected release is stored denormalized rather than as a bare MBID on purpose: by the
time a slow queue finishes, MusicBrainz may be unreachable (it went down twice while this
was being built), and re-fetching to organize a finished download would be a silly
dependency to introduce.
"""

import asyncio
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from src.config import Config
from src.logger import logger


SCHEMA = """
CREATE TABLE IF NOT EXISTS jobs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    release_mbid  TEXT,
    artist        TEXT,
    album         TEXT,
    year          TEXT,
    username      TEXT NOT NULL,
    directory     TEXT,
    release_json  TEXT NOT NULL,
    files_json    TEXT NOT NULL,
    status        TEXT NOT NULL,
    error         TEXT,
    created_at    TEXT NOT NULL,
    updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
"""

#? queued/downloading/complete are phase 2. organizing/organized land with the organizer.
OPEN_STATUSES = ("queued", "downloading")
TERMINAL_STATUSES = ("organized", "failed", "cancelled")
#? what "clear finished" is allowed to delete - anything still moving is excluded
CLEARABLE_STATUSES = ("complete", "organized", "failed", "cancelled")


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class JobStore:
    def __init__(self, path: str | None = None):
        self.path = path or Config.DB_PATH
        self.available = False

    def init(self) -> None:
        """
        Prepare the database. A failure here is logged loudly but does NOT raise: downloads
        are still perfectly usable without job tracking, and taking the whole app down
        because a volume wasn't mounted would be a worse outcome than degrading.
        """
        try:
            Path(self.path).parent.mkdir(parents=True, exist_ok=True)

            with self._connect() as connection:
                connection.executescript(SCHEMA)

            self.available = True
            logger.info(f"job store ready at {self.path}")

        except Exception as e:
            self.available = False
            logger.error(
                f"could not open the job store at {self.path}, downloads will still work "
                f"but wont be tracked ({e})",
                extra={"frontend": True, "src": "slskd"},
            )

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        return connection

    @staticmethod
    def _row_to_job(row: sqlite3.Row) -> dict:
        job = dict(row)
        job["release"] = json.loads(job.pop("release_json"))
        job["files"] = json.loads(job.pop("files_json"))
        return job

    # sqlite3 is blocking, so every call hops to a worker thread to keep the loop free.

    async def create_job(self, username: str, directory: str, files: list[dict], release: dict) -> int | None:
        if not self.available:
            return None

        def write():
            with self._connect() as connection:
                cursor = connection.execute(
                    """
                    INSERT INTO jobs (release_mbid, artist, album, year, username, directory,
                                      release_json, files_json, status, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
                    """,
                    (
                        release.get("release_mbid"),
                        release.get("artist"),
                        release.get("album"),
                        release.get("year"),
                        username,
                        directory,
                        json.dumps(release),
                        json.dumps(files),
                        _now(),
                        _now(),
                    ),
                )
                return cursor.lastrowid

        try:
            return await asyncio.to_thread(write)

        except Exception:
            logger.error("failed to record the download job", extra={"frontend": True, "src": "slskd"})
            return None

    async def list_jobs(self, limit: int = 50) -> list[dict]:
        if not self.available:
            return []

        def read():
            with self._connect() as connection:
                rows = connection.execute(
                    "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
                ).fetchall()
                return [self._row_to_job(r) for r in rows]

        try:
            return await asyncio.to_thread(read)

        except Exception:
            logger.error("failed to read download jobs")
            return []

    async def open_jobs(self) -> list[dict]:
        """Jobs the poller still cares about."""
        if not self.available:
            return []

        def read():
            placeholders = ",".join("?" for _ in OPEN_STATUSES)
            with self._connect() as connection:
                rows = connection.execute(
                    f"SELECT * FROM jobs WHERE status IN ({placeholders}) ORDER BY id",
                    OPEN_STATUSES,
                ).fetchall()
                return [self._row_to_job(r) for r in rows]

        try:
            return await asyncio.to_thread(read)

        except Exception:
            logger.error("failed to read open download jobs")
            return []

    async def update_status(self, job_id: int, status: str, error: str | None = None) -> None:
        if not self.available:
            return

        def write():
            with self._connect() as connection:
                connection.execute(
                    "UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?",
                    (status, error, _now(), job_id),
                )

        try:
            await asyncio.to_thread(write)

        except Exception:
            logger.error(f"failed to update job {job_id} to {status}")


    async def delete_jobs(self, statuses: tuple[str, ...]) -> int:
        """Forget finished jobs. Only ever removes rows in the given terminal states."""
        if not self.available:
            return 0

        def write():
            placeholders = ",".join("?" for _ in statuses)
            with self._connect() as connection:
                cursor = connection.execute(
                    f"DELETE FROM jobs WHERE status IN ({placeholders})", statuses
                )
                return cursor.rowcount

        try:
            return await asyncio.to_thread(write)

        except Exception:
            logger.error("failed to clear finished jobs")
            return 0

    async def get_job(self, job_id: int) -> dict | None:
        if not self.available:
            return None

        def read():
            with self._connect() as connection:
                row = connection.execute("SELECT * FROM jobs WHERE id = ?", (job_id,)).fetchone()
                return self._row_to_job(row) if row else None

        try:
            return await asyncio.to_thread(read)

        except Exception:
            logger.error(f"failed to read job {job_id}")
            return None


def summarize_transfers(job: dict, transfers_by_user: dict[str, list[dict]]) -> dict:
    """
    Work out how a job is doing from slskd's live transfer list.

    Progress is derived on read rather than stored, because it changes constantly and
    writing every tick to sqlite would be pure churn for data that slskd already owns.
    Matching is on (username, filename) since that's the only identity slskd exposes.
    """
    wanted = {f["filename"] for f in job["files"]}
    transfers = [t for t in transfers_by_user.get(job["username"], []) if t.get("filename") in wanted]

    if not transfers:
        return {
            "progress": 0.0,
            "state": None,
            "speed": 0,
            "bytes_transferred": 0,
            "files_done": 0,
            "files_total": len(wanted),
            "matched": False,
        }

    done = sum(1 for t in transfers if "Completed, Succeeded" in (t.get("state") or ""))
    failed = [t for t in transfers if "Errored" in (t.get("state") or "")
              or "Cancelled" in (t.get("state") or "")]

    return {
        # average over everything we asked for, not just what slskd currently reports, so a
        # job whose files haven't been picked up yet doesn't read as further along than it is
        "progress": sum(t.get("percentComplete", 0) or 0 for t in transfers) / max(len(wanted), 1),
        "state": transfers[0].get("state"),
        # slskd's averageSpeed is cumulative (bytes moved / elapsed), so it only ever climbs
        # and never reflects what's happening right now. Report the raw byte count instead and
        # let the caller derive a real rate from the change between two samples.
        "speed": sum(t.get("averageSpeed", 0) or 0 for t in transfers),
        "bytes_transferred": sum(t.get("bytesTransferred", 0) or 0 for t in transfers),
        "files_done": done,
        "files_total": len(wanted),
        "files_failed": len(failed),
        "matched": True,
    }


def index_transfers_by_user(downloads: list[dict]) -> dict[str, list[dict]]:
    """Flatten slskd's user -> directories -> files shape into user -> files."""
    by_user: dict[str, list[dict]] = {}

    for entry in downloads or []:
        username = entry.get("username", "")
        files = []

        for directory in entry.get("directories", []) or []:
            files.extend(directory.get("files", []) or [])

        by_user.setdefault(username, []).extend(files)

    return by_user
