"""
The settings tab's backend.

WHY THIS IS READ-ONLY, and should stay that way:

Every server-side setting here arrives as an environment variable, from a compose
`environment:` block or from `.env`. Both are read once, at process start. There is nothing
this application could write that would change them - editing `.env` from inside the
container would not affect the running process, and would be silently discarded on the next
`docker compose up` for anyone configuring through compose (which is most people, and all
Unraid users). A settings page with a save button that does nothing until you restart, and
sometimes not even then, is worse than no save button.

So this endpoint's job is DIAGNOSIS, not mutation. It answers the three questions someone
actually has when something isn't working:

  1. what value did the container actually receive?
  2. which file do I go and edit to change it?
  3. is it usable, and if not, precisely what is wrong with it?

Question 2 is the one that is genuinely hard to answer from outside: once load_dotenv() has
run, a value from compose and a value from .env are indistinguishable in os.environ. config.py
captures the difference at import time; this endpoint is what surfaces it.

Client-side preferences (format preference, auto-grab, candidate defaults) are a separate
thing entirely - they live in localStorage, they ARE editable, and the backend never sees
them. See ui/src/state/persisted.ts.
"""

import os
from pathlib import Path

from fastapi import APIRouter

from src import __version__
from src.config import Config, describe_slskd_url, setting_source, shadowed_by_empty_env
from src.logger import logger

router = APIRouter()


#? Modes the organizer understands, with what each one actually does to your filesystem.
#? Ordered least to most destructive, which is the order the tab renders them in.
ORGANIZE_MODES = {
    "off": "never organize - downloads stay where slskd put them",
    "dry_run": "log what would happen, write nothing",
    "copy": "copy into the library, leave slskd's copy alone",
    "move": "move into the library",
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
                        effect="the slskd instance searches and downloads go through",
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
                        effect="authenticates against slskd; downloads fail without it",
                    ),
                    _setting(
                        "MUSICBRAINZ_USERAGENT",
                        Config.MUSICBRAINZ_USERAGENT,
                        required=True,
                        effect=(
                            "identifies this app to MusicBrainz. A malformed one gets you "
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
                        effect="where slskd writes finished downloads, so jimbrainz can find them",
                        status=download_status,
                        detail=download_detail,
                    ),
                    _setting(
                        "LIBRARY_PATH",
                        Config.LIBRARY_PATH,
                        effect="where organized music is filed, and what the library tab reads",
                        status=library_status,
                        detail=library_detail,
                    ),
                    _setting(
                        "SLSKD_INCOMPLETE_PATH",
                        Config.SLSKD_INCOMPLETE_PATH,
                        effect=(
                            "slskd's partial-download folder. Optional: set it and cancelling "
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
                            "the sqlite file holding job state and the metadata queue. Needs "
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
