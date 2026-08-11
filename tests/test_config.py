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
