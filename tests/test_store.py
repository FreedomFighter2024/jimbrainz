"""
Tests for the download job store and its transfer reconciliation.

Same reasoning as test_matching.py: slskd lives on the user's server, so the logic that
interprets its responses is tested against fixtures shaped like the real API
(slskd_api.apis._types.Transfer / TransferedDirectory / TransferedFile).
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.store import (  # noqa: E402
    JobStore,
    index_transfers_by_user,
    summarize_transfers,
)


def make_transfer(filename, state="InProgress", percent=50.0, speed=100000):
    return {
        "id": "t-" + filename, "username": "bob", "direction": "Download",
        "filename": filename, "size": 30000000, "state": state,
        "percentComplete": percent, "averageSpeed": speed, "bytesTransferred": 15000000,
    }


def make_downloads(username, files):
    """slskd shape: a list of per-user entries, each holding directories, each holding files."""
    return [{
        "username": username,
        "directories": [{"directory": "share/album", "fileCount": len(files), "files": files}],
    }]


JOB = {
    "username": "bob",
    "files": [{"filename": "share/album/01.flac", "size": 30000000},
              {"filename": "share/album/02.flac", "size": 30000000}],
}


# ---------------------------------------------------------------- indexing

def test_index_transfers_flattens_directories():
    downloads = make_downloads("bob", [make_transfer("a.flac"), make_transfer("b.flac")])
    indexed = index_transfers_by_user(downloads)
    assert list(indexed) == ["bob"]
    assert len(indexed["bob"]) == 2


def test_index_transfers_handles_empty_and_missing_keys():
    assert index_transfers_by_user([]) == {}
    assert index_transfers_by_user([{"username": "bob"}]) == {"bob": []}


def test_index_transfers_merges_multiple_directories_for_one_user():
    downloads = [{
        "username": "bob",
        "directories": [
            {"directory": "d1", "files": [make_transfer("a.flac")]},
            {"directory": "d2", "files": [make_transfer("b.flac")]},
        ],
    }]
    assert len(index_transfers_by_user(downloads)["bob"]) == 2


# ---------------------------------------------------------------- summarizing

def test_summarize_reports_unmatched_when_slskd_knows_nothing_yet():
    summary = summarize_transfers(JOB, {})
    assert summary["matched"] is False
    assert summary["progress"] == 0.0
    assert summary["files_total"] == 2


def test_summarize_averages_progress_across_files():
    transfers = [make_transfer("share/album/01.flac", percent=100.0),
                 make_transfer("share/album/02.flac", percent=50.0)]
    summary = summarize_transfers(JOB, {"bob": transfers})
    assert summary["matched"] is True
    assert summary["progress"] == 75.0


def test_summarize_ignores_transfers_for_other_files():
    """The peer may be sending us unrelated things; only this job's files count."""
    transfers = [make_transfer("share/album/01.flac", percent=100.0),
                 make_transfer("share/other/99.flac", percent=100.0)]
    summary = summarize_transfers(JOB, {"bob": transfers})
    # one of two wanted files at 100% => 50% overall, the stray file is not counted
    assert summary["progress"] == 50.0


def test_summarize_divides_by_wanted_not_reported():
    """
    A job whose second file hasn't been picked up yet must not read as 100% done just
    because the one file slskd knows about is finished.
    """
    transfers = [make_transfer("share/album/01.flac", percent=100.0)]
    summary = summarize_transfers(JOB, {"bob": transfers})
    assert summary["progress"] == 50.0


def test_summarize_counts_completed_files():
    transfers = [make_transfer("share/album/01.flac", state="Completed, Succeeded", percent=100.0),
                 make_transfer("share/album/02.flac", state="InProgress", percent=20.0)]
    summary = summarize_transfers(JOB, {"bob": transfers})
    assert summary["files_done"] == 1
    assert summary["files_total"] == 2


def test_summarize_counts_failures():
    transfers = [make_transfer("share/album/01.flac", state="Completed, Errored"),
                 make_transfer("share/album/02.flac", state="Completed, Cancelled")]
    summary = summarize_transfers(JOB, {"bob": transfers})
    assert summary["files_failed"] == 2


def test_summarize_sums_speed():
    transfers = [make_transfer("share/album/01.flac", speed=100000),
                 make_transfer("share/album/02.flac", speed=250000)]
    assert summarize_transfers(JOB, {"bob": transfers})["speed"] == 350000


def test_summarize_ignores_a_different_users_transfers():
    transfers = [make_transfer("share/album/01.flac", percent=100.0)]
    assert summarize_transfers(JOB, {"carol": transfers})["matched"] is False


# ---------------------------------------------------------------- the store itself

def test_store_roundtrip(tmp_path):
    store = JobStore(str(tmp_path / "jobs.db"))
    store.init()
    assert store.available

    release = {"artist": "Boards of Canada", "album": "Music Has the Right to Children",
               "year": "1998", "release_mbid": "mb-1", "tracks": [{"position": 1, "title": "x"}]}

    job_id = asyncio.run(store.create_job("bob", "share/album", JOB["files"], release))
    assert job_id

    jobs = asyncio.run(store.list_jobs())
    assert len(jobs) == 1
    assert jobs[0]["status"] == "queued"
    assert jobs[0]["username"] == "bob"
    # the release is stored denormalized so organizing never needs MusicBrainz again
    assert jobs[0]["release"]["tracks"][0]["title"] == "x"
    assert jobs[0]["files"][0]["filename"] == "share/album/01.flac"


def test_store_status_transitions(tmp_path):
    store = JobStore(str(tmp_path / "jobs.db"))
    store.init()
    release = {"artist": "a", "album": "b", "year": "1998", "release_mbid": "m", "tracks": []}

    job_id = asyncio.run(store.create_job("bob", "d", JOB["files"], release))
    assert len(asyncio.run(store.open_jobs())) == 1

    asyncio.run(store.update_status(job_id, "complete"))
    assert asyncio.run(store.open_jobs()) == []
    assert asyncio.run(store.list_jobs())[0]["status"] == "complete"

    asyncio.run(store.update_status(job_id, "failed", "peer vanished"))
    assert asyncio.run(store.list_jobs())[0]["error"] == "peer vanished"


def test_store_degrades_instead_of_raising_when_path_is_unusable(tmp_path):
    """
    A missing volume mount shouldn't take the app down - downloads still work without
    tracking, which is a far better outcome than refusing to start.
    """
    blocker = tmp_path / "not-a-dir"
    blocker.write_text("i am a file")

    store = JobStore(str(blocker / "nested" / "jobs.db"))
    store.init()

    assert store.available is False
    assert asyncio.run(store.create_job("bob", "d", [], {})) is None
    assert asyncio.run(store.list_jobs()) == []
    assert asyncio.run(store.open_jobs()) == []
    asyncio.run(store.update_status(1, "complete"))  # must not raise
