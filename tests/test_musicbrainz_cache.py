"""
Caching MusicBrainz responses, and what must never be cached.

MusicBrainz allows roughly one request a second, and opening the metadata editor asks several
questions per album - so every avoided request is a second of somebody waiting. The data barely
moves, which is what makes caching safe here.

The load-bearing test in this file is the one asserting that FAILURES are not cached.
request_with_retries returns an error dict rather than raising when it gives up, so a cache that
could not tell the two apart would pin a transient outage in place for the whole TTL and turn a
bad minute into a bad hour - and MusicBrainz goes unreachable for minutes at a time from a dev
machine routinely (it did, twice, while this was being written).
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
import pytest  # noqa: E402

from src.api.musicbrainz_endpoint import (  # noqa: E402
    MusicBrainzClient,
    RateLimit,
    ResponseCache,
)


class FakeResponse:
    def __init__(self, payload=None, status_code=200):
        self.payload = payload or {}
        self.status_code = status_code
        self.text = "fake"

    def raise_for_status(self):
        if self.status_code >= 400:
            raise httpx.HTTPStatusError("boom", request=None, response=self)  # type: ignore[arg-type]

    def json(self):
        return self.payload


class FakeClient:
    """Counts what actually leaves the process."""

    def __init__(self, response=None, error=None):
        self.response = response
        self.error = error
        self.calls = []

    async def get(self, endpoint, params=None):
        self.calls.append((endpoint, params))
        if self.error is not None:
            raise self.error
        return self.response


@pytest.fixture
def client(monkeypatch):
    """
    A client whose network and pacing are both stubbed out.

    The cache and the rate limiter are class attributes - shared for the whole process, which is
    right in production and would leak between tests - so both are replaced per test.
    """
    monkeypatch.setattr(MusicBrainzClient, "cache", ResponseCache(ttl_seconds=60, max_entries=8))
    monkeypatch.setattr(MusicBrainzClient, "rate_limit", RateLimit())

    instance = MusicBrainzClient()
    return instance


def use(client, fake):
    """
    Point the client at a fake instead of the network.

    A plain async function rather than `asyncio.sleep(0, result=fake)` as a cheap awaitable -
    that trick made the helper depend on asyncio.sleep, so a test that patches out the retry
    backoff silently got None back instead of the fake and recorded no requests at all.
    """
    async def get_client():
        return fake

    client.get_client = get_client  # type: ignore[method-assign]
    return fake


# ---------------------------------------------------------------- the cache itself

def test_a_repeated_question_is_answered_without_asking_again():
    cache = ResponseCache(ttl_seconds=60)
    cache.put("release/", {"release-group": "abc"}, {"releases": [1, 2]})

    assert cache.get("release/", {"release-group": "abc"}) == {"releases": [1, 2]}
    assert cache.hits == 1


def test_the_same_request_written_two_ways_is_one_entry():
    """Params arrive as a dict, and dict order is not part of the request."""
    assert (ResponseCache.key("release/", {"a": 1, "b": 2})
            == ResponseCache.key("release/", {"b": 2, "a": 1}))


def test_different_params_are_different_entries():
    cache = ResponseCache()
    cache.put("release/", {"release-group": "abc"}, {"n": 1})
    assert cache.get("release/", {"release-group": "xyz"}) is None


def test_entries_expire():
    cache = ResponseCache(ttl_seconds=0)
    cache.put("release/", {"a": 1}, {"n": 1})
    assert cache.get("release/", {"a": 1}) is None


def test_the_cache_is_bounded_and_evicts_the_least_recently_used():
    """
    A release list with recordings is a large payload, and a long-running container asking about
    a big library would otherwise hold every one it had ever seen.
    """
    cache = ResponseCache(ttl_seconds=60, max_entries=3)
    for n in range(3):
        cache.put("e", {"n": n}, {"n": n})

    #? touch the oldest so it is no longer the least recently used
    cache.get("e", {"n": 0})
    cache.put("e", {"n": 3}, {"n": 3})

    assert cache.get("e", {"n": 0}) == {"n": 0}, "the one just used survived"
    assert cache.get("e", {"n": 1}) is None, "the genuinely idle one went"
    assert len(cache.entries) == 3


# ---------------------------------------------------------------- through the client

def test_a_successful_response_is_served_from_cache_the_second_time(client):
    fake = use(client, FakeClient(FakeResponse({"release-groups": [{"id": "x"}]})))

    first = asyncio.run(client.request_with_retries("release-group/", {"query": "metallica"}))
    second = asyncio.run(client.request_with_retries("release-group/", {"query": "metallica"}))

    assert first == second == {"release-groups": [{"id": "x"}]}
    assert len(fake.calls) == 1, "the second answer must not have left the process"


def test_a_failure_is_never_cached(client):
    """
    The one that matters. A 403 breaks out immediately and returns the error dict; if that were
    stored, every later request would be answered with "MusicBrainz is unreachable" long after
    it had come back - and the user's only remedy would be restarting the container.
    """
    fake = use(client, FakeClient(FakeResponse(status_code=403)))

    first = asyncio.run(client.request_with_retries("release-group/", {"query": "metallica"}))
    assert first["status"] == "failed"

    #? it recovers - the next request must go out and be believed
    fake.response = FakeResponse({"release-groups": [{"id": "x"}]})
    fake.error = None
    second = asyncio.run(client.request_with_retries("release-group/", {"query": "metallica"}))

    assert second == {"release-groups": [{"id": "x"}]}
    assert len(fake.calls) == 2, "the failure was retried rather than replayed from cache"


def test_the_metadata_editors_duplicate_fetch_costs_one_request(client):
    """
    fully_search fetches the first group's releases as `best-match-releases`, and the editor then
    asks for the releases of the best few groups - including that same first one. That was a
    guaranteed wasted round trip on every single open, before any user action at all.
    """
    fake = use(client, FakeClient(FakeResponse({"releases": [{"id": "r1"}], "release-count": 1})))

    params = {"release-group": "g1", "inc": "media+recordings+labels+artist-credits",
              "fmt": "json", "limit": 100, "offset": 0}

    asyncio.run(client.request_with_retries("release/", params))
    asyncio.run(client.request_with_retries("release/", params))

    assert len(fake.calls) == 1


def test_pagination_caches_each_page_separately(client):
    """get_releases walks a group in pages; the pages differ only by offset."""
    fake = use(client, FakeClient(FakeResponse({"releases": [{"id": "r"}], "release-count": 1})))

    asyncio.run(client.request_with_retries("release/", {"release-group": "g", "offset": 0}))
    asyncio.run(client.request_with_retries("release/", {"release-group": "g", "offset": 100}))
    asyncio.run(client.request_with_retries("release/", {"release-group": "g", "offset": 0}))

    assert len(fake.calls) == 2, "two distinct pages, the repeat served from cache"


# ---------------------------------------------------------------- pacing

def test_the_rate_limiter_lets_a_short_burst_straight_through():
    """
    Four requests is the window, so opening the editor once shouldn't wait at all. Any wait it
    does take is normal operation and is logged at debug - telling the user their own politeness
    is a problem made a working search look broken.
    """
    limiter = RateLimit()

    async def burst():
        for _ in range(limiter.max_requests):
            await limiter.wait()

    started = asyncio.get_event_loop_policy().new_event_loop()
    try:
        import time
        begin = time.monotonic()
        started.run_until_complete(burst())
        assert time.monotonic() - begin < 0.5
    finally:
        started.close()


# ---------------------------------------------------------------- what gets asked for

def test_the_release_list_can_be_fetched_without_tracklists(client):
    """
    Measured against the live API on Metallica's 1991 album, whose group holds 58 releases:
    carrying recordings for all of them costs 5 requests and 1446 KB, against 1 request and
    101 KB without. MusicBrainz allows about one request a second, so that is four seconds
    spent on the track listings of 57 pressings nobody picked.
    """
    fake = use(client, FakeClient(FakeResponse({"releases": [{"id": "r"}], "release-count": 1})))

    asyncio.run(client.get_releases("g1", log=False, with_tracks=False))

    inc = fake.calls[0][1]["inc"]
    assert "recordings" not in inc
    assert "media" in inc, "the track COUNT and format must survive - that is what picks an edition"


def test_the_release_list_carries_tracklists_by_default(client):
    """
    The download flow matches Soulseek folders against a release's real tracklist, and the
    search view renders it. Losing that by default would gut the matching rather than break it
    loudly, so the saving is opt-in.
    """
    fake = use(client, FakeClient(FakeResponse({"releases": [{"id": "r"}], "release-count": 1})))

    asyncio.run(client.get_releases("g1", log=False))

    assert "recordings" in fake.calls[0][1]["inc"]


def test_one_release_can_be_fetched_with_its_tracklist(client):
    """The other half of the trade: pay for the tracks of the pressing actually chosen."""
    fake = use(client, FakeClient(FakeResponse({"id": "r1", "media": []})))

    asyncio.run(client.get_release("r1"))

    endpoint, params = fake.calls[0]
    assert endpoint == "release/r1"
    assert "recordings" in params["inc"]


def test_a_search_can_skip_the_eager_release_fetch(client):
    """
    fully_search walks the best group's whole release list WITH tracklists. The search view
    wants that; the metadata editor ranks the groups itself and fetches what it wants, so for
    it those requests were spent on a payload it dropped on the floor.
    """
    fake = use(client, FakeClient(FakeResponse({"release-groups": [{"id": "g1"}]})))

    result = asyncio.run(client.fully_search("metallica", 25, include_releases=False))

    assert len(fake.calls) == 1, "only the group search went out"
    assert result["release-groups"] == [{"id": "g1"}]
    assert result["best-match-releases"] == [], "key still present, so callers need no special case"


def test_a_search_still_fetches_releases_by_default(client):
    fake = use(client, FakeClient(FakeResponse(
        {"release-groups": [{"id": "g1"}], "releases": [{"id": "r"}], "release-count": 1})))

    asyncio.run(client.fully_search("metallica", 25))

    assert len(fake.calls) == 2, "the group search, then that group's releases"


# ---------------------------------------------------------------- rejected queries

def test_a_malformed_query_fails_immediately_instead_of_retrying(client):
    """
    A 400 is the server saying the QUERY is wrong, which is deterministic - retrying it ten
    times with rate-limit pacing in between spends about thirty seconds arriving at the same
    answer, and then reports it as "MusicBrainz is unreachable". That sends you to look at your
    network instead of at your search. It matters more now the search view builds type-filter
    clauses into the query, where a syntax mistake is possible.
    """
    fake = use(client, FakeClient(FakeResponse(status_code=400)))

    result = asyncio.run(client.request_with_retries("release-group/", {"query": "primarytype:"}))

    assert result["code"] == 400
    assert "malformed" in result["error"]
    assert len(fake.calls) == 1, "asked once, believed the answer"


def test_a_503_is_still_retried(client, monkeypatch):
    """
    The opposite case: overloaded is transient, and giving up on the first one would be wrong.

    The backoff is patched out - this asserts that it retries, not that it waits, and the real
    sleeps make it a thirty-second test for a one-line behaviour.
    """
    #? the original captured first - patching asyncio.sleep with something that calls
    #? asyncio.sleep is a recursion, and the broad except in request_with_retries swallows it
    real_sleep = asyncio.sleep

    async def instant(*_args, **_kwargs):
        await real_sleep(0)

    monkeypatch.setattr(asyncio, "sleep", instant)
    fake = use(client, FakeClient(FakeResponse(status_code=503)))

    asyncio.run(client.request_with_retries("release-group/", {"query": "metallica"}))

    assert len(fake.calls) > 1, "kept trying"
