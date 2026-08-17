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


# ---------------------------------------------------------------- organize hook

def _all_done():
    return transfers(("share/album/01.flac", "Completed, Succeeded", 100.0),
                     ("share/album/02.flac", "Completed, Succeeded", 100.0))


def test_completed_job_is_left_alone_when_organizing_is_disabled(tmp_path, monkeypatch):
    from src.config import Config
    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", None)
    monkeypatch.setattr(Config, "LIBRARY_PATH", None)

    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    assert status_of(store, job_id) == "complete"


def test_dry_run_does_not_claim_the_job_was_organized(tmp_path, monkeypatch):
    """
    The status has to stay honest: nothing moved, so 'organized' would be a lie the user
    would only discover by going and looking at their library.
    """
    from src.config import Config
    downloads = tmp_path / "downloads" / "album"
    downloads.mkdir(parents=True)
    (downloads / "01.flac").write_bytes(b"x")
    (downloads / "02.flac").write_bytes(b"x")

    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "downloads"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "dry_run")

    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    job = next(j for j in asyncio.run(store.list_jobs()) if j["id"] == job_id)
    assert job["status"] == "complete"
    assert "dry run" in job["error"]
    assert not (tmp_path / "music").exists()


def test_successful_organize_marks_the_job_organized(tmp_path, monkeypatch):
    from src.config import Config
    downloads = tmp_path / "downloads" / "album"
    downloads.mkdir(parents=True)
    (downloads / "01.flac").write_bytes(b"x")
    (downloads / "02.flac").write_bytes(b"x")

    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "downloads"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "copy")

    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    assert status_of(store, job_id) == "organized"
    assert (tmp_path / "music" / "Boards of Canada").exists()


def test_organize_failure_does_not_mark_the_download_failed(tmp_path, monkeypatch):
    """
    Downloading and filing are different problems. A download that arrived fine but couldn't
    be filed must not look like a failed download - the files are on disk and fine.
    """
    from src.config import Config
    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "nonexistent"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "copy")

    store = make_store(tmp_path)
    job_id = seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    assert status_of(store, job_id) == "complete"


def test_job_whose_files_all_already_existed_is_not_reported_as_organized(tmp_path, monkeypatch):
    """
    The silent failure that made a second edition of an album look like it had been filed.

    Every file is skipped because something already occupies its destination, so nothing from
    THIS download reached the library - but `organized` was the fall-through status, so the UI
    showed a green, finished job for an album that never arrived.
    """
    from src.config import Config
    downloads = tmp_path / "downloads" / "album"
    downloads.mkdir(parents=True)
    (downloads / "01.flac").write_bytes(b"x")
    (downloads / "02.flac").write_bytes(b"x")

    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "downloads"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "copy")

    store = make_store(tmp_path)
    job_id = seed_job(store)

    #? file it once, so the second attempt finds every destination taken
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))
    assert status_of(store, job_id) == "organized"

    second = seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    job = next(j for j in asyncio.run(store.list_jobs()) if j["id"] == second)
    assert job["status"] == "complete"
    assert "already existed" in job["error"]


def test_a_filed_album_is_enrolled_in_the_metadata_queue(tmp_path, monkeypatch):
    """
    The "something new arrived" prompt, recorded at the one moment it is free.

    The library is deliberately not scanned until its tab is opened, so a badge that had to
    diff two scans would need a scan to exist. The organizer already knows where it put the
    album, so the poller writes one row keyed on that - relative to LIBRARY_PATH, because that
    is the form every library endpoint takes.
    """
    from src.config import Config
    downloads = tmp_path / "downloads" / "album"
    downloads.mkdir(parents=True)
    (downloads / "01.flac").write_bytes(b"x")
    (downloads / "02.flac").write_bytes(b"x")

    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "downloads"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "copy")

    store = make_store(tmp_path)
    seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    summary = asyncio.run(store.new_import_summary())
    assert summary["count"] == 1
    assert summary["albums"][0]["album"] == "Music Has the Right to Children"
    #? relative, and matching what the scan will report for the same folder
    assert summary["albums"][0]["album_path"] == (
        "Boards of Canada/Music Has the Right to Children (1998)"
    )


def test_a_dry_run_enrols_nothing(tmp_path, monkeypatch):
    """Nothing was filed, so there is nothing new to prompt about."""
    from src.config import Config
    downloads = tmp_path / "downloads" / "album"
    downloads.mkdir(parents=True)
    (downloads / "01.flac").write_bytes(b"x")

    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path / "downloads"))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path / "music"))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "dry_run")

    store = make_store(tmp_path)
    seed_job(store)
    asyncio.run(poll_downloads_once(FakeSlskd(_all_done()), store, {}))

    assert asyncio.run(store.new_import_summary())["count"] == 0


def test_a_rejected_download_fails_instead_of_sitting_in_the_queue(tmp_path):
    """
    The reported bug. slskd answers "Completed, Rejected" for a peer that won't send the file,
    and that state never changes again - so a job which treats it as neither done nor failed
    waits forever. It stayed `queued`, which the interface renders as "hasn't started yet",
    with nothing anywhere saying it had been refused.

    The unmatched grace period is no help here either: slskd IS reporting these transfers, so
    the job never looks abandoned. Nothing else could have rescued it.
    """
    store = make_store(tmp_path)
    job_id = seed_job(store)

    rejected = transfers(
        ("share/album/01.flac", "Completed, Rejected", 0),
        ("share/album/02.flac", "Completed, Rejected", 0),
    )
    asyncio.run(poll_downloads_once(FakeSlskd(rejected), store, {}))

    job = next(j for j in asyncio.run(store.list_jobs()) if j["id"] == job_id)
    assert job["status"] == "failed"
    assert "refused" in job["error"]


def test_a_timed_out_download_also_reaches_a_terminal_status(tmp_path):
    store = make_store(tmp_path)
    job_id = seed_job(store)

    asyncio.run(poll_downloads_once(FakeSlskd(transfers(
        ("share/album/01.flac", "Completed, TimedOut", 0),
        ("share/album/02.flac", "Completed, TimedOut", 0),
    )), store, {}))

    assert status_of(store, job_id) == "failed"


def test_a_partly_rejected_download_says_what_did_arrive(tmp_path):
    """
    The files that landed are still in slskd's folder, so "nothing happened" would be wrong -
    and knowing one of two arrived is what tells you to go looking for the other.
    """
    store = make_store(tmp_path)
    job_id = seed_job(store)

    asyncio.run(poll_downloads_once(FakeSlskd(transfers(
        ("share/album/01.flac", "Completed, Succeeded", 100),
        ("share/album/02.flac", "Completed, Rejected", 0),
    )), store, {}))

    job = next(j for j in asyncio.run(store.list_jobs()) if j["id"] == job_id)
    assert job["status"] == "failed"
    assert "1 of 2" in job["error"]


def test_a_download_still_in_progress_is_not_failed_by_one_rejection(tmp_path):
    """One refused file while another is still moving is not a finished job."""
    store = make_store(tmp_path)
    job_id = seed_job(store)

    asyncio.run(poll_downloads_once(FakeSlskd(transfers(
        ("share/album/01.flac", "InProgress", 40),
        ("share/album/02.flac", "Completed, Rejected", 0),
    )), store, {}))

    assert status_of(store, job_id) == "downloading"
