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
    transfer_failure,
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

    #? the metadata queue degrades the same way: it stops remembering what you ignored, and
    #? carries on deriving what's wrong with each album from the scan
    assert asyncio.run(store.album_reviews()) == {}
    assert asyncio.run(store.record_albums_seen([{"path": "a/b"}])) == 0
    assert asyncio.run(store.ignore_album_issues("a/b", ["no_art"])) is False
    assert asyncio.run(store.mark_album_reviewed("a/b")) is False
    assert asyncio.run(store.new_import_summary()) == {
        "count": 0, "albums": [], "tracking_enabled": False,
    }


# ---------------------------------------------------------------- album review

def review_store(tmp_path):
    store = JobStore(str(tmp_path / "jobs.db"))
    store.init()
    assert store.available
    return store


def test_first_seen_is_the_first_time_and_import_survives_later_scans(tmp_path):
    """
    The whole reason record_albums_seen uses INSERT OR IGNORE. An album filed by jimbrainz has
    to keep saying 'import' even though every subsequent scan sees it too - otherwise the
    "something new arrived" prompt is erased by the act of looking at the library.
    """
    store = review_store(tmp_path)
    album = {"path": "Tame Impala/Currents (2015)", "artist": "Tame Impala", "album": "Currents"}

    asyncio.run(store.record_albums_seen([album], source="import"))
    first = asyncio.run(store.album_reviews())["Tame Impala/Currents (2015)"]

    asyncio.run(store.record_albums_seen([album], source="scan"))
    second = asyncio.run(store.album_reviews())["Tame Impala/Currents (2015)"]

    assert second["source"] == "import"
    assert second["first_seen"] == first["first_seen"]


def test_new_imports_are_counted_until_they_are_reviewed(tmp_path):
    store = review_store(tmp_path)

    asyncio.run(store.record_albums_seen(
        [{"path": "a/one", "artist": "A", "album": "One"},
         {"path": "a/two", "artist": "A", "album": "Two"}],
        source="import",
    ))
    asyncio.run(store.record_albums_seen([{"path": "a/three"}], source="scan"))

    summary = asyncio.run(store.new_import_summary())
    assert summary["count"] == 2, "a scanned album is not a new import"
    assert {a["album"] for a in summary["albums"]} == {"One", "Two"}

    asyncio.run(store.mark_album_reviewed("a/one"))
    assert asyncio.run(store.new_import_summary())["count"] == 1


def test_ignoring_issues_records_them_and_marks_the_album_reviewed(tmp_path):
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/one"}], source="import"))

    asyncio.run(store.ignore_album_issues("a/one", ["no_art", "no_release", "no_art"]))
    review = asyncio.run(store.album_reviews())["a/one"]

    assert review["ignored_issues"] == ["no_art", "no_release"], "deduplicated and sorted"
    assert review["reviewed_at"], "ignoring an album means you have looked at it"
    assert asyncio.run(store.new_import_summary())["count"] == 0


def test_ignoring_an_album_the_store_has_never_seen_still_works(tmp_path):
    """
    The queue can be acted on before any scan has enrolled the album - the interface holds a
    path, not a row id.
    """
    store = review_store(tmp_path)
    assert asyncio.run(store.ignore_album_issues("never/seen", ["no_art"])) is True
    assert asyncio.run(store.album_reviews())["never/seen"]["ignored_issues"] == ["no_art"]


def test_unignoring_puts_an_album_back_without_losing_its_history(tmp_path):
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/one"}], source="import"))
    asyncio.run(store.ignore_album_issues("a/one", ["no_art"]))

    asyncio.run(store.unignore_album("a/one"))
    review = asyncio.run(store.album_reviews())["a/one"]

    assert review["ignored_issues"] == []
    assert review["ignored_at"] is None
    assert review["reviewed_at"], "un-ignoring doesn't un-see it"
    assert review["source"] == "import"


def test_reviewing_follows_a_folder_that_was_renamed(tmp_path):
    """
    A retag renames the folder, and album_review is keyed on the path. Leaving the row behind
    would orphan the history of an album that is still very much there - and re-enrol it as
    brand new on the next scan.
    """
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen(
        [{"path": "Pink Floyd/wish you were here", "artist": "Pink Floyd"}], source="import",
    ))
    original = asyncio.run(store.album_reviews())["Pink Floyd/wish you were here"]

    asyncio.run(store.mark_album_reviewed(
        "Pink Floyd/wish you were here", "Pink Floyd/Wish You Were Here (1975)",
    ))
    reviews = asyncio.run(store.album_reviews())

    assert "Pink Floyd/wish you were here" not in reviews
    moved = reviews["Pink Floyd/Wish You Were Here (1975)"]
    assert moved["first_seen"] == original["first_seen"], "it is the same album"
    assert moved["source"] == "import"
    assert moved["reviewed_at"]


def test_a_rename_onto_an_existing_row_replaces_it(tmp_path):
    """
    The destination is keyed by the same primary key, so the move would otherwise be rejected.
    Anything already recorded there describes a folder that no longer exists.
    """
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/old"}, {"path": "a/new"}]))
    asyncio.run(store.ignore_album_issues("a/new", ["no_art"]))

    asyncio.run(store.mark_album_reviewed("a/old", "a/new"))
    reviews = asyncio.run(store.album_reviews())

    assert "a/old" not in reviews
    assert reviews["a/new"]["ignored_issues"] == [], "the stale row's ignores went with it"


def test_reviewing_an_unknown_album_records_it_where_it_is_now(tmp_path):
    """
    A retag can move an album the store never enrolled. Recording the source path would leave
    a row pointing at a folder that has just stopped existing.
    """
    store = review_store(tmp_path)

    asyncio.run(store.mark_album_reviewed("a/old", "a/new"))
    reviews = asyncio.run(store.album_reviews())

    assert list(reviews) == ["a/new"]
    assert reviews["a/new"]["reviewed_at"]


def test_a_corrupt_ignore_list_reads_as_nothing_ignored(tmp_path):
    """
    One hand-edited row must not take the whole library view down with it - the view is how you
    would find out something was wrong in the first place.
    """
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/one"}]))

    import sqlite3
    with sqlite3.connect(store.path) as connection:
        connection.execute("UPDATE album_review SET ignored_issues = '{not json'")

    assert asyncio.run(store.album_reviews())["a/one"]["ignored_issues"] == []


# ---------------------------------------------------------------- terminal transfer states

def test_rejected_transfers_are_counted_as_failures():
    """
    The bug this exists to prevent: "Completed, Rejected" was neither "Succeeded" nor one of
    the two failure strings the matching knew about, so a rejected download counted as still
    in flight. The job sat at `queued` forever - slskd was reporting the transfer, so the
    unmatched grace period never applied either - and the interface said it hadn't started yet.
    """
    downloads = make_downloads("bob", [
        make_transfer("share/album/01.flac", state="Completed, Rejected", percent=0),
        make_transfer("share/album/02.flac", state="Completed, Rejected", percent=0),
    ])
    summary = summarize_transfers(JOB, index_transfers_by_user(downloads))

    assert summary["files_failed"] == 2
    assert summary["files_done"] == 0
    assert summary["failure_reason"] == "the peer refused to send it"


def test_every_terminal_substate_is_recognised():
    """
    An unrecognised substate is a permanently stuck job, so this is the list that matters. If
    slskd grows another one it has to be added to TRANSFER_FAILURE_REASONS.
    """
    for substate in ("Rejected", "TimedOut", "Errored", "Cancelled"):
        assert transfer_failure(f"Completed, {substate}"), f"{substate} not recognised"

    assert transfer_failure("Completed, Succeeded") == ""
    assert transfer_failure("InProgress") == ""
    assert transfer_failure("Queued, Remotely") == ""
    assert transfer_failure(None) == ""


def test_a_partial_rejection_is_still_reported():
    downloads = make_downloads("bob", [
        make_transfer("share/album/01.flac", state="Completed, Succeeded", percent=100),
        make_transfer("share/album/02.flac", state="Completed, Rejected", percent=0),
    ])
    summary = summarize_transfers(JOB, index_transfers_by_user(downloads))

    assert summary["files_done"] == 1
    assert summary["files_failed"] == 1


def test_an_unmatched_job_reports_no_failures_rather_than_omitting_them():
    """Every caller reads these fields; absence would be indistinguishable from zero."""
    summary = summarize_transfers(JOB, {})
    assert summary["files_failed"] == 0
    assert summary["failure_reason"] is None


def test_review_rows_for_albums_that_are_gone_are_forgotten(tmp_path):
    """
    A row is keyed on the path, so a folder renamed outside jimbrainz orphans it. The tab badge
    counts an orphaned import row while the album is in no scan - so the interface reports an
    album wanting attention that it can neither name nor clear.
    """
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen(
        [{"path": "a/still here"}, {"path": "a/moved away"}], source="import"))
    assert asyncio.run(store.new_import_summary())["count"] == 2

    removed = asyncio.run(store.forget_missing_albums({"a/still here"}))

    assert removed == 1
    assert list(asyncio.run(store.album_reviews())) == ["a/still here"]
    assert asyncio.run(store.new_import_summary())["count"] == 1


def test_forgetting_nothing_is_not_a_wipe(tmp_path):
    """
    The guard that matters. An empty set means the caller has nothing to compare against -
    an unmounted library rather than a deleted one - and must never be read as "none of these
    exist any more".
    """
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/one"}], source="import"))

    assert asyncio.run(store.forget_missing_albums(set())) == 0
    assert list(asyncio.run(store.album_reviews())) == ["a/one"]


def test_ignores_survive_for_albums_that_are_still_there(tmp_path):
    store = review_store(tmp_path)
    asyncio.run(store.record_albums_seen([{"path": "a/one"}, {"path": "a/two"}]))
    asyncio.run(store.ignore_album_issues("a/one", ["no_art"]))

    asyncio.run(store.forget_missing_albums({"a/one", "a/two"}))

    assert asyncio.run(store.album_reviews())["a/one"]["ignored_issues"] == ["no_art"]
