"""
Tests for the settings tab's backend.

The endpoint exists to answer "why isn't this working" without making somebody read the
container's environment by hand, so what these tests protect is the DIAGNOSIS, not the
plumbing. Three properties matter and each has cost real time when it was missing:

  1. the API key never leaves the process, however the row is rendered
  2. a path that is set but unreachable from inside the container is reported as an ERROR,
     not shown as though it were fine - this is the most common first-run failure and it is
     invisible from the value alone
  3. an optional setting that is simply unset is NOT dressed up as a problem, because a list
     where everything is flagged is a list where nothing stands out
"""

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from src.config import Config  # noqa: E402
from src.routes.settings import ORGANIZE_MODES, _describe_path, settings  # noqa: E402


def call_settings() -> dict:
    return asyncio.run(settings())


def find(payload: dict, key: str) -> dict:
    for group in payload["groups"]:
        for setting in group["settings"]:
            if setting["key"] == key:
                return setting

    raise AssertionError(f"{key} is not in the settings payload")


# ===== the API key must never be reported =====================================


def test_the_api_key_value_is_never_returned(monkeypatch):
    """
    The one hard rule here. This payload is rendered on a page people screenshot into bug
    reports, so the key must not be in it even in part - not the value, not a prefix, not a
    length that narrows it.
    """
    monkeypatch.setattr(Config, "SLSKD_APIKEY", "super-secret-key-value")

    payload = call_settings()
    row = find(payload, "SLSKD_APIKEY")

    assert row["secret"] is True
    assert row["value"] == "set"
    assert "super-secret-key-value" not in str(payload)


def test_a_missing_api_key_is_an_error_not_a_leak(monkeypatch):
    monkeypatch.setattr(Config, "SLSKD_APIKEY", None)

    row = find(call_settings(), "SLSKD_APIKEY")

    assert row["value"] is None
    assert row["status"] == "error"


# ===== paths are resolved, not trusted ========================================


def test_a_path_that_does_not_exist_is_an_error(tmp_path):
    status, detail = _describe_path(str(tmp_path / "nope"), needs_write=False)

    assert status == "error"
    #? Must name the container/host distinction: the value looks correct to the person who
    #? typed it, because it IS correct - on the host. That is the whole confusion.
    assert "inside this container" in detail


def test_a_file_where_a_directory_belongs_is_an_error(tmp_path):
    target = tmp_path / "a-file"
    target.write_text("not a directory")

    status, detail = _describe_path(str(target), needs_write=False)

    assert status == "error"
    assert "not a directory" in detail


def test_a_real_directory_passes(tmp_path):
    assert _describe_path(str(tmp_path), needs_write=False) == ("ok", None)


def test_a_readonly_directory_fails_only_when_writing_is_required(tmp_path):
    """
    LIBRARY_PATH is written to and SLSKD_DOWNLOAD_PATH is only read, so the same folder is
    fine for one and broken for the other. Getting this backwards would either wave through
    a library the organizer cannot write to, or refuse a downloads folder for no reason.
    """
    readonly = tmp_path / "readonly"
    readonly.mkdir()
    readonly.chmod(0o500)

    try:
        assert _describe_path(str(readonly), needs_write=False)[0] == "ok"

        status, detail = _describe_path(str(readonly), needs_write=True)
        assert status == "error"
        assert "PUID" in detail  # the fix, not just the symptom

    finally:
        readonly.chmod(0o700)  # so pytest's tmp_path cleanup can remove it


def test_an_unset_path_is_unset_rather_than_an_error():
    assert _describe_path(None, needs_write=True) == ("unset", None)
    assert _describe_path("", needs_write=True) == ("unset", None)


# ===== optional settings must not look like failures ==========================


def test_an_unset_optional_setting_is_not_flagged(monkeypatch):
    monkeypatch.setattr(Config, "SLSKD_INCOMPLETE_PATH", None)

    row = find(call_settings(), "SLSKD_INCOMPLETE_PATH")

    assert row["required"] is False
    assert row["status"] == "unset"
    assert row["detail"] is None


# ===== the organizing verdict =================================================


def test_dry_run_is_reported_as_a_blocker_even_when_everything_else_is_right(
    monkeypatch, tmp_path
):
    """
    dry_run is the DEFAULT, so "I set everything up and nothing was filed" is the expected
    first experience rather than an edge case. It has to be named as the reason.
    """
    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "dry_run")

    organizing = call_settings()["organizing"]

    assert organizing["enabled"] is False
    assert any("dry_run" in blocker for blocker in organizing["blockers"])


def test_every_missing_prerequisite_is_listed_not_just_the_first(monkeypatch):
    """
    Reported as a list on purpose. Fixing one cause and finding the next one only then is how
    people conclude the feature is broken rather than misconfigured.
    """
    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", None)
    monkeypatch.setattr(Config, "LIBRARY_PATH", None)
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "off")

    blockers = call_settings()["organizing"]["blockers"]

    assert len(blockers) == 3
    assert any("SLSKD_DOWNLOAD_PATH" in b for b in blockers)
    assert any("LIBRARY_PATH" in b for b in blockers)
    assert any("off" in b for b in blockers)


def test_a_fully_configured_move_setup_reports_organizing_as_active(monkeypatch, tmp_path):
    monkeypatch.setattr(Config, "SLSKD_DOWNLOAD_PATH", str(tmp_path))
    monkeypatch.setattr(Config, "LIBRARY_PATH", str(tmp_path))
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "move")

    organizing = call_settings()["organizing"]

    assert organizing["enabled"] is True
    assert organizing["blockers"] == []


def test_an_unrecognised_organize_mode_is_an_error(monkeypatch):
    monkeypatch.setattr(Config, "ORGANIZE_MODE", "sideways")

    row = find(call_settings(), "ORGANIZE_MODE")

    assert row["status"] == "error"
    assert "off" in row["detail"] and "dry_run" in row["detail"]


def test_the_documented_modes_match_what_the_organizer_accepts():
    """
    These are rendered to the user as the valid values, so they must not drift from the set
    config.py validates against.
    """
    assert set(ORGANIZE_MODES) == {"off", "dry_run", "copy", "move"}


# ===== url problems reach the row =============================================


def test_a_scheme_less_slskd_url_is_reported_on_the_row(monkeypatch):
    monkeypatch.setattr(Config, "SLSKD_URL", "slskd:5030")

    row = find(call_settings(), "SLSKD_URL")

    assert row["status"] == "error"
    assert "missing the scheme" in row["detail"]
    #? The fix people actually need: the address has to work from inside the container.
    assert "inside THIS container" in row["detail"]


def test_a_good_slskd_url_has_no_detail(monkeypatch):
    monkeypatch.setattr(Config, "SLSKD_URL", "http://slskd:5030")

    row = find(call_settings(), "SLSKD_URL")

    assert row["status"] == "ok"
    assert row["detail"] is None


# ===== the payload's shape ====================================================


def test_the_payload_states_that_it_is_read_only():
    """
    Not decoration. The tab renders controls from this, and a client that assumed editable
    would build inputs that silently discard what you type.
    """
    assert call_settings()["editable"] is False


def test_every_setting_row_carries_what_the_tab_needs_to_render_it():
    required_fields = {"key", "value", "source", "status", "detail", "effect", "required", "secret"}

    payload = call_settings()
    assert payload["groups"], "no groups at all"

    for group in payload["groups"]:
        assert group["settings"], f"{group['id']} has no settings"

        for setting in group["settings"]:
            assert required_fields <= set(setting), f"{setting.get('key')} is missing fields"
            assert setting["status"] in {"ok", "unset", "error"}
            assert setting["effect"], f"{setting['key']} does not say what it does"
