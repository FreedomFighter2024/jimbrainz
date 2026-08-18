"""
Tests for configuration validation.

These exist because of a real deployment failure: SLSKD_URL didn't survive the trip into the
container, and instead of saying so the app failed deep inside requests with
"Invalid URL '///api/v0/searches': No scheme supplied" - which names neither the setting at
fault nor where to fix it. Bad config should be caught at the edge, with the reason attached.
"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import _env, describe_slskd_url  # noqa: E402


def test_missing_url_is_reported(monkeypatch):
    assert describe_slskd_url(None) == "not set"
    assert describe_slskd_url("") == "not set"


def test_scheme_less_url_is_reported_with_the_fix_spelled_out():
    problem = describe_slskd_url("slskd:5030")
    assert "missing the scheme" in problem
    assert "http://slskd:5030" in problem


def test_scheme_without_a_host_is_reported():
    assert "no host" in describe_slskd_url("http://")


def test_unsupported_scheme_is_reported():
    assert "unsupported scheme" in describe_slskd_url("ftp://slskd:5030")


def test_valid_urls_pass():
    for url in ["http://slskd:5030", "https://slskd.example.com",
                "http://192.168.1.10:5030", "http://slskd:5030/"]:
        assert describe_slskd_url(url) is None, url


def test_whitespace_only_env_counts_as_unset(monkeypatch):
    """
    The failure that started this: "  " is truthy in python, so it slips past every
    `if not value` guard and only breaks much later somewhere unhelpful.
    """
    monkeypatch.setenv("JB_TEST_VALUE", "   ")
    assert _env("JB_TEST_VALUE") == ""
    assert describe_slskd_url(_env("JB_TEST_VALUE")) == "not set"


def test_env_strips_surrounding_whitespace(monkeypatch):
    monkeypatch.setenv("JB_TEST_VALUE", "  http://slskd:5030\n")
    assert _env("JB_TEST_VALUE") == "http://slskd:5030"
    assert describe_slskd_url(_env("JB_TEST_VALUE")) is None


def test_env_default_is_used_when_absent(monkeypatch):
    monkeypatch.delenv("JB_TEST_ABSENT", raising=False)
    assert _env("JB_TEST_ABSENT", "fallback") == "fallback"


# --------------------------------------------------------- musicbrainz availability

def test_unreachable_musicbrainz_is_distinguished_from_no_results():
    """
    Regression: fully_search reached straight for "release-groups", but request_with_retries
    returns an error dict when it gives up. The resulting KeyError surfaced as
    "Error searching MusicBrainz: 'release-groups'", which reads like a bad query - so an
    outage looked like a user mistake, and people blamed their search terms (including their
    capitalisation) for it.
    """
    import asyncio

    from src.api.musicbrainz_endpoint import MusicBrainzClient, MusicBrainzUnavailable

    client = MusicBrainzClient()

    async def failing(endpoint, params, retry=True):
        return {"error": "musicbrainz ping failed with connection error",
                "status": "failed", "code": "CONNECTION_ERROR"}

    client.request_with_retries = failing

    try:
        asyncio.run(client.fully_search("artist:\"tame impala\""))
    except MusicBrainzUnavailable as e:
        assert "connection error" in str(e)
    else:
        raise AssertionError("expected MusicBrainzUnavailable")


def test_genuinely_empty_results_are_not_treated_as_an_outage():
    import asyncio

    from src.api.musicbrainz_endpoint import MusicBrainzClient

    client = MusicBrainzClient()

    async def empty(endpoint, params, retry=True):
        return {"release-groups": [], "count": 0}

    client.request_with_retries = empty
    assert asyncio.run(client.fully_search("artist:\"nonexistent band\"")) == {}


# ---------------------------------------------------------------- where a setting came from

#? Run in a subprocess with a real .env on disk, because the precedence being tested is
#? established at IMPORT time - src/config.py calls load_dotenv() at module level, and the
#? snapshot of "what the environment already held" has to be taken before it. Reloading the
#? module in-process would test a different thing than what actually happens on startup.
PROBE = """
import json, sys
sys.path.insert(0, {repo!r})
from src.config import Config, setting_source, shadowed_by_empty_env
print(json.dumps({{
    "url": Config.SLSKD_URL,
    "key": Config.SLSKD_APIKEY,
    "url_source": setting_source("SLSKD_URL"),
    "key_source": setting_source("SLSKD_APIKEY"),
    "url_shadowed": shadowed_by_empty_env("SLSKD_URL"),
}}))
"""


def run_with_config(tmp_path, dotenv: str, **env):
    """Start the app's config the way a container does: a .env on disk plus real env vars."""
    import json
    import os
    import subprocess

    (tmp_path / ".env").write_text(dotenv)

    repo = str(Path(__file__).resolve().parent.parent)
    environment = {k: v for k, v in os.environ.items() if not k.startswith("SLSKD_")}
    environment.update(env)

    result = subprocess.run(
        [sys.executable, "-c", PROBE.format(repo=repo)],
        cwd=tmp_path, env=environment, capture_output=True, text=True,
    )
    assert result.returncode == 0, result.stderr
    return json.loads(result.stdout.strip().splitlines()[-1])


DOTENV = "SLSKD_URL=http://from-dotenv:5030\nSLSKD_APIKEY=dotenv-key\n"


def test_the_environment_beats_dotenv(tmp_path):
    """
    The whole basis for configuring jimbrainz from a compose `environment:` block. python-dotenv
    does not override variables that already exist, and switching it to `override=True` would
    silently invert this - the .env would start winning and a compose file would stop working
    with nothing to indicate why.
    """
    result = run_with_config(tmp_path, DOTENV, SLSKD_URL="http://from-compose:5030")

    assert result["url"] == "http://from-compose:5030"
    assert result["url_source"] == "the container environment"


def test_dotenv_still_supplies_what_the_environment_does_not(tmp_path):
    """Mixing the two is explicitly supported - the API key in .env, the address in compose."""
    result = run_with_config(tmp_path, DOTENV, SLSKD_URL="http://from-compose:5030")

    assert result["key"] == "dotenv-key"
    assert result["key_source"] == ".env"


def test_dotenv_alone_still_works(tmp_path):
    """The original arrangement, unchanged."""
    result = run_with_config(tmp_path, DOTENV)

    assert result["url"] == "http://from-dotenv:5030"
    assert result["url_source"] == ".env"


def test_an_empty_environment_variable_shadowing_dotenv_is_detected(tmp_path):
    """
    The sharp edge of supporting both. `SLSKD_URL=${SLSKD_URL}` in a compose file produces an
    empty variable whenever the outer one is unset - and empty still counts as set, so it beats
    .env and leaves slskd unconfigured beside a .env line that looks perfectly correct. This is
    a real failure this project has already had; it must be named rather than merely survived.
    """
    result = run_with_config(tmp_path, DOTENV, SLSKD_URL="")

    assert result["url"] is None or result["url"] == ""
    assert result["url_shadowed"] is True


def test_a_populated_environment_variable_is_not_reported_as_shadowing(tmp_path):
    result = run_with_config(tmp_path, DOTENV, SLSKD_URL="http://from-compose:5030")
    assert result["url_shadowed"] is False


def test_nothing_configured_reports_no_source(tmp_path):
    """None means "nobody supplied this", which is a different message from "it's wrong"."""
    result = run_with_config(tmp_path, "")
    assert result["url_source"] is None
