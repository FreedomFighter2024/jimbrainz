"""
Tests for the background download poller.

The poller is what actually moves a job through its lifecycle, and it only ever runs against
a live slskd - which doesn't exist on a dev machine. So it's driven here with a fake client
returning slskd-shaped payloads and a real (temp-file) store, which is the closest thing to
observing it for real that's available without deploying.
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.poller import UNMATCHED_GRACE_POLLS, poll_downloads_once  # noqa: E402
from src.store import JobStore  # noqa: E402


class FakeSlskd:
    """Stands in for SlskdClient, returning whatever transfer list a test needs."""

    def __init__(self, downloads=None):
        self.downloads = downloads or []
        self.calls = 0

    async def get_downloads(self):
        self.calls += 1
        return self.downloads


FILES = [{"filename": "share/album/01.flac", "size": 30000000},
         {"filename": "share/album/02.flac", "size": 30000000}]

RELEASE = {"artist": "Boards of Canada", "album": "Music Has the Right to Children",
           "year": "1998", "release_mbid": "mb-1", "tracks": []}


def transfers(*specs):
    """specs are (filename, state, percent) tuples."""
    return [{
        "username": "bob",
        "directories": [{
            "directory": "share/album",
            "files": [{"filename": f, "state": s, "percentComplete": p,
                       "averageSpeed": 100000, "size": 30000000} for f, s, p in specs],
        }],
    }]


def make_store(tmp_path):
    store = JobStore(str(tmp_path / "jobs.db"))
    store.init()
    return store


def seed_job(store):
    return asyncio.run(store.create_job("bob", "share/album", FILES, RELEASE))


def status_of(store, job_id):
    return next(j for j in asyncio.run(store.list_jobs()) if j["id"] == job_id)["status"]


def test_job_moves_to_downloading_once_bytes_start_flowing(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)

    slskd = FakeSlskd(transfers(("share/album/01.flac", "InProgress", 30.0),
                                ("share/album/02.flac", "InProgress", 10.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "downloading"


def test_job_stays_queued_while_nothing_has_transferred(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)

    slskd = FakeSlskd(transfers(("share/album/01.flac", "Queued, Remotely", 0.0),
                                ("share/album/02.flac", "Queued, Remotely", 0.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "queued"


def test_job_completes_when_every_file_succeeds(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)

    slskd = FakeSlskd(transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                                ("share/album/02.flac", "Completed, Succeeded", 100.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "complete"


def test_partial_completion_does_not_finish_the_job(tmp_path):
    """One file done out of two is still in progress, not complete."""
    store = make_store(tmp_path)
    job_id = seed_job(store)

    slskd = FakeSlskd(transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                                ("share/album/02.flac", "InProgress", 40.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "downloading"


def test_job_fails_when_transfers_error_out(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)

    slskd = FakeSlskd(transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                                ("share/album/02.flac", "Completed, Errored", 12.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "failed"


def test_unmatched_job_is_given_a_grace_period_before_failing(tmp_path):
    """
    A peer with a deep queue can legitimately go unreported for a while, so a job that slskd
    doesn't know about yet must not fail on the first poll.
    """
    store = make_store(tmp_path)
    job_id = seed_job(store)
    slskd = FakeSlskd([])
    missing = {}

    for _ in range(UNMATCHED_GRACE_POLLS - 1):
        asyncio.run(poll_downloads_once(slskd, store, missing))
        assert status_of(store, job_id) == "queued"

    asyncio.run(poll_downloads_once(slskd, store, missing))
    assert status_of(store, job_id) == "failed"


def test_grace_counter_resets_when_the_job_reappears(tmp_path):
    """A blip in slskd's reporting shouldn't accumulate toward giving up."""
    store = make_store(tmp_path)
    job_id = seed_job(store)
    missing = {}

    asyncio.run(poll_downloads_once(FakeSlskd([]), store, missing))
    assert missing.get(job_id) == 1

    asyncio.run(poll_downloads_once(
        FakeSlskd(transfers(("share/album/01.flac", "InProgress", 10.0))), store, missing))
    assert job_id not in missing


def test_poller_skips_slskd_entirely_when_no_jobs_are_open(tmp_path):
    """Don't hammer slskd on an idle instance."""
    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(store.update_status(job_id, "complete"))

    slskd = FakeSlskd([])
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert slskd.calls == 0


def test_terminal_jobs_are_left_alone(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(store.update_status(job_id, "failed", "gave up"))

    slskd = FakeSlskd(transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                                ("share/album/02.flac", "Completed, Succeeded", 100.0)))
    asyncio.run(poll_downloads_once(slskd, store, {}))

    assert status_of(store, job_id) == "failed"


def test_another_users_identical_filenames_do_not_complete_our_job(tmp_path):
    """Matching is on (username, filename); a different peer sharing the same paths is not us."""
    store = make_store(tmp_path)
    job_id = seed_job(store)

    downloads = transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                          ("share/album/02.flac", "Completed, Succeeded", 100.0))
    downloads[0]["username"] = "someone-else"

    asyncio.run(poll_downloads_once(FakeSlskd(downloads), store, {}))
    assert status_of(store, job_id) == "queued"
