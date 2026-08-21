"""
The settings tab's backend.

MOST SETTINGS ARE EDITABLE HERE. The ones that aren't, aren't for a stated reason.

Server settings arrive as environment variables from a compose `environment:` block or from
`.env`, read once at process start. Editing that file from inside the container would not
affect the running process, so the writable path does NOT touch it. Overrides are stored in
the sqlite database instead (see the `settings` table in store.py) and laid over the
environment's values at startup by Config.apply_overrides().

The precedence question is the one that matters, and there is only one honest answer:

  A STORED OVERRIDE WINS over the environment.

The alternative - environment wins - would mean an edit made in this tab silently reverted on
the next restart for anybody configuring through compose, which is most people. So the
override wins, and the tab says plainly when a value is overriding what the environment
supplied, and offers to revert it. Reverting DELETES the row rather than writing the
environment's value back, so a setting that has been reverted follows the compose file again
instead of pinning whatever it happened to say that day.

Two settings genuinely cannot be edited here, and the tab renders the reason rather than
hiding them: DB_PATH (it is the database the overrides live in) and PUID/PGID (consumed by
docker-entrypoint.sh, which has already dropped privileges before Python starts).

Editing applies LIVE, without a restart, because Config is read as a class attribute at the
point of use rather than captured at import. The two cached clients are the exception, so a
change to their settings drops the cached client and the next call rebuilds it.

Diagnosis is still half the job. For every setting the tab answers:

  1. what value did the container actually receive?
  2. which file do I go and edit to change it - or is it overridden here?
  3. is it usable, and if not, precisely what is wrong with it?

Question 2 is genuinely hard to answer from outside: once load_dotenv() has run, a value from
compose and a value from .env are indistinguishable in os.environ. config.py captures the
difference at import time; this endpoint is what surfaces it.

Client-side preferences (format preference, auto-grab, candidate defaults) are a separate
thing entirely - they live in localStorage, they ARE editable, and the backend never sees
them. See ui/src/state/persisted.ts.
"""

import os
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from src import __version__
from src.config import Config, describe_slskd_url, setting_source, shadowed_by_empty_env
from src.logger import logger

router = APIRouter()


#? Modes the organizer understands, with what each one actually does to your filesystem.
#? Ordered least to most destructive, which is the order the tab renders them in.
ORGANIZE_MODES = {
    "off": "Never organize - downloads stay where slskd put them",
    "dry_run": "Log what would happen, write nothing",
    "copy": "Copy into the library, leave slskd's copy alone",
    "move": "Move into the library",
}


def _describe_path(value: str | None, *, needs_write: bool) -> tuple[str, str | None]:
    """
    Whether a configured path is actually usable from inside this container.

    Returns (status, detail). This is the single most valuable check in the file: the most
    common first-run failure by a wide margin is a path that is set, looks correct, and
    points somewhere this container cannot see - because the value describes the HOST's
    filesystem rather than the container's. That failure is invisible from the value alone,
    which is exactly why it is worth resolving here rather than trusting the string.
    """
    if not value:
        return "unset", None

    path = Path(value)

    try:
        if not path.exists():
            return "error", (
                f"nothing exists at {value} as seen from inside this container. This is "
                f"usually a volume mapping - the path has to be the CONTAINER's path, not "
                f"the host's."
            )

        if not path.is_dir():
            return "error", f"{value} exists but is a file, not a directory"

        if not os.access(path, os.R_OK):
            return "error", f"{value} exists but this container cannot read it (check PUID/PGID)"

        if needs_write and not os.access(path, os.W_OK):
            return "error", (
                f"{value} is readable but NOT writable, so organizing will fail when it "
                f"tries to file something. Check PUID/PGID against the folder's owner."
            )

    except OSError as e:
        #? A path can raise on stat alone - a broken mount, a permission wall partway up.
        #? Report it rather than letting it 500 the whole settings tab.
        return "error", f"could not check {value}: {e}"

    return "ok", None


def _setting(
    key: str,
    value: str | None,
    *,
    effect: str,
    required: bool = False,
    secret: bool = False,
    status: str | None = None,
    detail: str | None = None,
) -> dict:
    """One row in the settings tab."""
    #? The API key is the only secret here and it never leaves the process. The tab shows
    #? whether one arrived and nothing else - enough to diagnose "downloads don't work",
    #? without putting a credential in a screenshot somebody pastes into an issue.
    reported = ("set" if value else None) if secret else (value or None)

    if status is None:
        status = "ok" if value else ("error" if required else "unset")

    #? An empty compose variable beating a good .env line reads as simply unset, which sends
    #? people to edit the file that was already correct. Always worth calling out by name.
    if shadowed_by_empty_env(key):
        status = "error"
        detail = (
            f"{key} is set to an EMPTY value in the container environment, which overrides "
            f"the value in your .env. Remove the line from your compose file's "
            f"`environment:` block, or give it a literal value - an `{key}=${{{key}}}` entry "
            f"does this whenever the outer variable isn't defined."
        )

    return {
        "key": key,
        "value": reported,
        "source": setting_source(key),
        "status": status,
        "detail": detail,
        "effect": effect,
        "required": required,
        "secret": secret,
        #? Whether the tab may render an input for this, and why not when it may not.
        "editable": key in Config.EDITABLE,
        "locked_reason": Config.NOT_EDITABLE.get(key),
        #? True when this value came from the settings tab rather than the environment. The
        #? tab uses it to say so and to offer "revert to the environment value", which is the
        #? thing that stops an override becoming invisible state nobody remembers setting.
        "overridden": key in Config.OVERRIDDEN,
        #? What reverting would restore. Never sent for secrets.
        "env_value": (
            None if secret else (Config.ENV_VALUES.get(key) if key in Config.OVERRIDDEN else None)
        ),
    }


@router.get("")
@router.get("/")
async def settings():
    """
    Everything the settings tab renders: the server configuration as this process actually
    received it, grouped the way someone troubleshooting would look for it.
    """
    download_status, download_detail = _describe_path(Config.SLSKD_DOWNLOAD_PATH, needs_write=False)
    library_status, library_detail = _describe_path(Config.LIBRARY_PATH, needs_write=True)
    incomplete_status, incomplete_detail = _describe_path(
        Config.SLSKD_INCOMPLETE_PATH, needs_write=True
    )

    url_problem = describe_slskd_url(Config.SLSKD_URL)
    organize_mode = Config.ORGANIZE_MODE
    organize_known = organize_mode in ORGANIZE_MODES

    #? Organizing needs BOTH paths and a mode that acts. Stated as one derived fact because
    #? "why did nothing get filed" has four possible causes and checking them one at a time
    #? is how people end up convinced the feature is broken.
    organizing_blockers = []
    if not Config.SLSKD_DOWNLOAD_PATH:
        organizing_blockers.append("SLSKD_DOWNLOAD_PATH is not set")
    elif download_status == "error":
        organizing_blockers.append("SLSKD_DOWNLOAD_PATH does not resolve inside this container")
    if not Config.LIBRARY_PATH:
        organizing_blockers.append("LIBRARY_PATH is not set")
    elif library_status == "error":
        organizing_blockers.append("LIBRARY_PATH is not usable")
    if organize_mode == "off":
        organizing_blockers.append("ORGANIZE_MODE is 'off'")
    elif organize_mode == "dry_run":
        organizing_blockers.append(
            "ORGANIZE_MODE is 'dry_run', so organizing reports what it would do and writes nothing"
        )

    return {
        #? Rendered in the tab's footer. "What version are you running" is the first question
        #? asked about any bug report, and until now the only way to answer it was to check
        #? which image tag you happened to pull.
        "version": __version__,
        #? Read-only, and the tab says so prominently. See this module's docstring.
        "editable": False,
        "groups": [
            {
                "id": "connections",
                "label": "Connections",
                "note": "Where jimbrainz fetches metadata and downloads from.",
                "settings": [
                    _setting(
                        "SLSKD_URL",
                        Config.SLSKD_URL,
                        required=True,
                        effect="The slskd instance searches and downloads go through",
                        status="error" if url_problem else "ok",
                        detail=(
                            f"unusable: {url_problem}. It has to be reachable from inside "
                            f"THIS container - if slskd is another container on the same "
                            f"docker network use its service name and internal port "
                            f"(http://slskd:5030), not your host's IP and published port."
                            if url_problem
                            else None
                        ),
                    ),
                    _setting(
                        "SLSKD_APIKEY",
                        Config.SLSKD_APIKEY,
                        required=True,
                        secret=True,
                        effect="Authenticates against slskd; downloads fail without it",
                    ),
                    _setting(
                        "MUSICBRAINZ_USERAGENT",
                        Config.MUSICBRAINZ_USERAGENT,
                        required=True,
                        effect=(
                            "Identifies this app to MusicBrainz. A malformed one gets you "
                            "rate limited no matter how politely you ask"
                        ),
                    ),
                ],
            },
            {
                "id": "paths",
                "label": "Paths",
                "note": (
                    "All of these are paths as seen from INSIDE this container, which is not "
                    "always the path you'd type on the host."
                ),
                "settings": [
                    _setting(
                        "SLSKD_DOWNLOAD_PATH",
                        Config.SLSKD_DOWNLOAD_PATH,
                        effect="Where slskd writes finished downloads, so jimbrainz can find them",
                        status=download_status,
                        detail=download_detail,
                    ),
                    _setting(
                        "LIBRARY_PATH",
                        Config.LIBRARY_PATH,
                        effect="Where organized music is filed, and what the library tab reads",
                        status=library_status,
                        detail=library_detail,
                    ),
                    _setting(
                        "SLSKD_INCOMPLETE_PATH",
                        Config.SLSKD_INCOMPLETE_PATH,
                        effect=(
                            "The slskd partial-download folder. Optional: set it and cancelling "
                            "a download also deletes its half-finished file, leave it unset "
                            "and slskd keeps the partial so a retry can resume from it"
                        ),
                        status=incomplete_status,
                        detail=incomplete_detail,
                    ),
                    _setting(
                        "DB_PATH",
                        Config.DB_PATH,
                        effect=(
                            "The sqlite file holding job state and the metadata queue. Needs "
                            "to be on a persistent volume or you lose it on every restart"
                        ),
                    ),
                ],
            },
            {
                "id": "organizing",
                "label": "Organizing",
                "note": (
                    "Organizing is the only thing here that writes to your filesystem, which "
                    "is why it starts in dry_run."
                ),
                "settings": [
                    _setting(
                        "ORGANIZE_MODE",
                        organize_mode,
                        effect=ORGANIZE_MODES.get(
                            organize_mode, "unrecognised - the organizer falls back to dry_run"
                        ),
                        status="ok" if organize_known else "error",
                        detail=(
                            None
                            if organize_known
                            else f"expected one of {', '.join(ORGANIZE_MODES)}"
                        ),
                    ),
                ],
            },
        ],
        "organize_modes": ORGANIZE_MODES,
        "organizing": {
            "enabled": not organizing_blockers,
            "blockers": organizing_blockers,
        },
    }


# ==============================================================================
# Writing
# ==============================================================================


class SettingUpdate(BaseModel):
    """One setting to change. `value` of null means 'revert to the environment'."""
    key: str
    value: str | None = None


def _validate(key: str, value: str) -> str | None:
    """
    Why this value cannot be stored, or None if it can.

    The line drawn here is between DEFINITIONALLY wrong and ENVIRONMENTALLY wrong, and it
    matters:

      Definitionally wrong is rejected. An ORGANIZE_MODE of "sideways" or a URL with no
      scheme can never work, whatever else changes, so storing it would only produce a
      confusing failure later somewhere less informative.

      Environmentally wrong is STORED and reported. A path that doesn't resolve today may be
      a volume the user is about to mount, and refusing it would mean the only way to fix a
      broken setup is to edit the compose file - which is exactly what this tab exists to
      avoid. The row renders its own validation state, so nothing is hidden by allowing it.
    """
    if key == "ORGANIZE_MODE" and value not in ORGANIZE_MODES:
        return f"expected one of {', '.join(ORGANIZE_MODES)}"

    if key == "SLSKD_URL":
        problem = describe_slskd_url(value)
        if problem:
            return problem

    return None


@router.put("")
@router.put("/")
async def update_settings(updates: list[SettingUpdate], request: Request):
    """
    Save a batch of settings, apply them live, and report the result.

    A BATCH rather than one call per setting, because the tab has a single save button and a
    half-applied save is the worst outcome available: some settings changed, some not, and no
    way to tell which from looking. Everything is validated first and the whole batch is
    refused if anything in it is invalid.
    """
    store = request.app.state.store

    if not store.available:
        raise HTTPException(
            status_code=503,
            detail=(
                "the database isn't available, so settings can't be saved. Check DB_PATH "
                "points at a writable volume."
            ),
        )

    #? Validate the whole batch before writing any of it.
    problems = {}
    for update in updates:
        if update.key in Config.NOT_EDITABLE:
            problems[update.key] = Config.NOT_EDITABLE[update.key]
        elif update.key not in Config.EDITABLE:
            problems[update.key] = "not a setting that can be changed here"
        elif update.value is not None:
            problem = _validate(update.key, update.value)
            if problem:
                problems[update.key] = problem

    if problems:
        raise HTTPException(
            status_code=400,
            detail="; ".join(f"{key}: {reason}" for key, reason in problems.items()),
        )

    #? Which cached clients this batch invalidates. Collected as a set so changing both the
    #? slskd URL and its API key rebuilds that client once rather than twice.
    invalidate = set()
    changed = []

    for update in updates:
        if update.value is None:
            await store.clear_setting(update.key)
        else:
            await store.set_setting(update.key, update.value)

        changed.append(update.key)
        target = Config.EDITABLE.get(update.key)
        if target:
            invalidate.add(target)

    #? Re-read everything from the store rather than mutating Config per key, so the in-memory
    #? state is exactly what the next restart would produce. A "saved" that leaves the process
    #? in a state the database wouldn't reproduce is a lie that only shows up on restart.
    Config.apply_overrides(store.stored_settings())

    #? Config is read at the point of use, so most settings are already live. These two are
    #? the exception: their clients are built once and cached, so drop them and let the next
    #? call rebuild against the new values.
    if "slskd" in invalidate:
        await request.app.state.slskd_client.close_client()
        logger.info("slskd client dropped, it will rebuild with the new settings")

    if "musicbrainz" in invalidate:
        await request.app.state.musicbrainz_client.close_client()
        logger.info("musicbrainz client dropped, it will rebuild with the new user agent")

    if "library" in invalidate:
        #? The scan cache keys on folder mtime under the OLD root, so it is meaningless now.
        from src.library import clear_scan_cache

        clear_scan_cache()
        logger.info("library scan cache cleared, the new path will be read fresh")

    logger.info(
        f"settings updated from the interface: {', '.join(changed)}",
        extra={"frontend": True},
    )

    return await settings()
