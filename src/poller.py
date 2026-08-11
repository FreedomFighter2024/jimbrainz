"""
Background reconciliation of slskd transfers against tracked download jobs.

slskd never tells us anything; it only answers when asked. So a loop polls its transfer
list and watches for jobs crossing a boundary - first bytes moving, everything finished,
the peer giving up - and records the transition. Progress itself is deliberately not
persisted (see store.summarize_transfers); this only cares about state changes worth
reacting to.

Phase 3 hooks the organizer onto the queued -> complete transition.
"""

import asyncio

from src.config import Config
from src.logger import logger
from src.organizer import organize_job
from src.store import index_transfers_by_user, summarize_transfers


POLL_INTERVAL_SECONDS = 5.0

#? a job whose files slskd has never heard of is usually a peer that went offline between
#? queueing and transferring. Give it a while before calling it, since a long queue can
#? legitimately sit unreported for a bit.
UNMATCHED_GRACE_POLLS = 24


async def poll_downloads_once(slskd_client, store, missing_counts: dict[int, int]) -> None:
    open_jobs = await store.open_jobs()

    if not open_jobs:
        missing_counts.clear()
        return

    downloads = await slskd_client.get_downloads()
    transfers_by_user = index_transfers_by_user(downloads)

    for job in open_jobs:
        job_id = job["id"]
        summary = summarize_transfers(job, transfers_by_user)
        label = f"{job['artist']} - {job['album']}"

        if not summary["matched"]:
            missing_counts[job_id] = missing_counts.get(job_id, 0) + 1

            if missing_counts[job_id] >= UNMATCHED_GRACE_POLLS:
                logger.error(
                    f"gave up on {label}: slskd never reported these transfers, "
                    f"the peer is probably gone",
                    extra={"frontend": True, "src": "slskd"},
                )
                await store.update_status(job_id, "failed", "no transfers reported by slskd")
                missing_counts.pop(job_id, None)

            continue

        missing_counts.pop(job_id, None)

        if summary["files_done"] >= summary["files_total"]:
            logger.info(f"finished downloading {label}", extra={"frontend": True, "src": "slskd"})
            await store.update_status(job_id, "complete")
            await _organize_if_enabled(job, store)
            continue

        if summary.get("files_failed") and summary["files_done"] + summary["files_failed"] >= summary["files_total"]:
            logger.error(
                f"download of {label} ended with {summary['files_failed']} failed file(s)",
                extra={"frontend": True, "src": "slskd"},
            )
            await store.update_status(job_id, "failed", "one or more transfers errored")
            continue

        if job["status"] == "queued" and summary["progress"] > 0:
            logger.info(f"downloading {label}", extra={"frontend": True, "src": "slskd"})
            await store.update_status(job_id, "downloading")


async def _organize_if_enabled(job: dict, store) -> None:
    """
    Hand a finished download to the organizer.

    Kept off the critical path deliberately: a job that downloaded fine but failed to file
    itself is recorded as such and left on disk in slskd's folder, rather than being marked
    failed as though the download itself had gone wrong. Those are different problems and
    want different fixes.
    """
    if not Config.organizing_enabled():
        return

    await store.update_status(job["id"], "organizing")

    try:
        results = await organize_job(
            job, Config.SLSKD_DOWNLOAD_PATH, Config.LIBRARY_PATH, Config.ORGANIZE_MODE
        )

        if results.get("dry_run"):
            #? nothing actually moved, so don't claim it did
            await store.update_status(job["id"], "complete", "dry run - not organized")

        elif results["failed"]:
            await store.update_status(
                job["id"], "complete", f"{results['failed']} file(s) failed to organize"
            )

        elif not results["organized"] and not results.get("skipped"):
            #? nothing was placed and nothing was already there - usually the download path
            #? doesn't actually point at slskd's files. Saying "organized" here would send
            #? the user looking for an album that was never filed.
            await store.update_status(
                job["id"], "complete", "nothing could be organized, check SLSKD_DOWNLOAD_PATH"
            )

        else:
            await store.update_status(job["id"], "organized")

    except Exception as e:
        logger.error(
            f"organizing {job['artist']} - {job['album']} failed: {e}",
            extra={"frontend": True, "src": "slskd"},
        )
        await store.update_status(job["id"], "complete", f"organize failed: {e}")


async def run_download_poller(slskd_client, store) -> None:
    logger.info("download poller started")
    missing_counts: dict[int, int] = {}

    while True:
        try:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            await poll_downloads_once(slskd_client, store, missing_counts)

        except asyncio.CancelledError:
            logger.info("download poller stopped")
            raise

        except Exception as e:
            # a transient slskd outage must not kill the loop for the rest of the process
            logger.error(f"download poller iteration failed, continuing: {e}")
