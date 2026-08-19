import os
from dotenv import dotenv_values, load_dotenv
from src.logger import logger

#? Which names the environment already held before .env was read.
#?
#? python-dotenv does not override existing variables, so anything in here won the tie - which
#? is precisely what makes configuring jimbrainz from a compose `environment:` block work at
#? all. Captured rather than inferred afterwards, because once load_dotenv() has run the two
#? sources are indistinguishable in os.environ, and "check your .env" is unhelpful advice to
#? somebody who configured everything in their compose file.
_ENV_BEFORE_DOTENV = frozenset(os.environ)

#? What the .env file holds, whether or not it won. Only used to explain where a setting came
#? from - and to catch an empty environment variable quietly hiding a real value in here.
_DOTENV_VALUES = dotenv_values()


def _env(name: str, default: str | None = None) -> str | None:
    """
    Read a setting, treating whitespace-only as unset.

    Docker and .env files hand over stray whitespace surprisingly often, and a value like
    "  " is truthy in python - so without the strip it sails past every `if not value` guard
    and only fails much later somewhere far less informative.
    """
    value = os.getenv(name, default)
    return value.strip() if isinstance(value, str) else value


def setting_source(name: str) -> str | None:
    """
    Where a setting actually came from, or None if nothing supplied it.

    Worth reporting rather than inferring. A setting can arrive from a compose
    `environment:` block, from `env_file`/.env, or from the host shell, and when the value is
    wrong the first question is always which of those you need to go and edit.
    """
    if name in _ENV_BEFORE_DOTENV and (os.getenv(name) or "").strip():
        return "the container environment"

    if ((_DOTENV_VALUES.get(name) or "") or "").strip():
        return ".env"

    return None


def shadowed_by_empty_env(name: str) -> bool:
    """
    True when an EMPTY environment variable is hiding a real value in .env.

    The sharp edge of supporting both sources, and one this project has already been cut by:
    an `environment:` entry with nothing after the `=` still counts as set, still wins over
    .env, and leaves you with a blank setting plus a perfectly good .env line that appears to
    be ignored for no reason. Compose produces exactly this from `SLSKD_URL=${SLSKD_URL}` when
    the outer variable isn't defined - which is why the example file uses literal values.
    """
    return (
        name in _ENV_BEFORE_DOTENV
        and not (os.getenv(name) or "").strip()
        and bool(((_DOTENV_VALUES.get(name) or "") or "").strip())
    )


def describe_slskd_url(url: str | None) -> str | None:
    """Return a human explanation of why this URL is unusable, or None if it's fine."""
    if not url:
        return "not set"

    if "://" not in url:
        return f"missing the scheme - use http://{url} rather than {url}"

    scheme, _, rest = url.partition("://")

    if scheme not in ("http", "https"):
        return f"unsupported scheme '{scheme}', expected http or https"

    if not rest.strip("/"):
        return "has a scheme but no host"

    return None


load_dotenv()
class Config:
    MUSICBRAINZ_USERAGENT = _env("MUSICBRAINZ_USERAGENT")

    #? slskd is the download backend now, not optional anymore
    SLSKD_URL = _env("SLSKD_URL")
    SLSKD_APIKEY = _env("SLSKD_APIKEY")

    #? filesystem paths for organizing finished downloads
    SLSKD_DOWNLOAD_PATH = _env("SLSKD_DOWNLOAD_PATH")

    #? Optional, and cleanup is off without it. slskd's INCOMPLETE folder as seen from this
    #? container, which is a different mount from the completed downloads above. Setting it
    #? lets a cancelled download take its half-finished file with it; leaving it unset keeps
    #? slskd's own behaviour, where a partial file is retained so a retry can resume from it.
    SLSKD_INCOMPLETE_PATH = _env("SLSKD_INCOMPLETE_PATH")
    LIBRARY_PATH = _env("LIBRARY_PATH")
    DB_PATH = _env("DB_PATH", "/config/jimbrainz.db")

    #? off | dry_run | copy | move. Defaults to dry_run deliberately: organizing is the only
    #? thing here that writes to your filesystem, so a fresh install reports what it would
    #? have done rather than acting on a possibly mis-mapped volume.
    ORGANIZE_MODE = _env("ORGANIZE_MODE", "dry_run")

    @classmethod
    def exists(cls, env_var: str):
        value = os.getenv(env_var)

        if not value:
            logger.error(f"{env_var} not set either in .env config file or environment")

        return value

    @classmethod
    def check(cls):
        if not cls.MUSICBRAINZ_USERAGENT:
            logger.error("MUSICBRAINZ_USERAGENT not found in environment", extra={"frontend": True})

        else: logger.info(f"MUSICBRAINZ_USERAGENT found!")

        #? Named before anything else, because an empty environment variable beating a good
        #? .env line is invisible from the value alone - the setting simply reads as unset
        #? while the .env line sits there looking correct.
        for name in ("SLSKD_URL", "SLSKD_APIKEY", "MUSICBRAINZ_USERAGENT", "ORGANIZE_MODE"):
            if shadowed_by_empty_env(name):
                logger.error(
                    f"{name} is set to an EMPTY value in the container environment, which "
                    f"overrides the value in your .env. Either give it a value in your compose "
                    f"file's `environment:` block or remove the line entirely - an "
                    f"`{name}=${{{name}}}` entry does this whenever the outer variable is unset.",
                    extra={"frontend": True},
                )

        url_problem = describe_slskd_url(cls.SLSKD_URL)
        if url_problem:
            logger.error(
                f"SLSKD_URL is unusable ({url_problem}) - searching and downloading will fail. "
                f"Set it in your compose file's `environment:` block, or in the .env named by "
                f"`env_file:`; a value in `environment:` wins if you use both.",
                extra={"frontend": True},
            )

        else: logger.info(f"SLSKD_URL found! (from {setting_source('SLSKD_URL')})")

        if not cls.SLSKD_APIKEY:
            logger.error("SLSKD_APIKEY not found in environment, downloads will not work", extra={"frontend": True})

        else: logger.info(f"SLSKD_APIKEY found! (from {setting_source('SLSKD_APIKEY')})")

        if not cls.SLSKD_DOWNLOAD_PATH:
            logger.warning("SLSKD_DOWNLOAD_PATH not found in environment, organizing downloaded files will be disabled")

        else: logger.info(f"SLSKD_DOWNLOAD_PATH found!")

        if cls.SLSKD_INCOMPLETE_PATH:
            logger.info("SLSKD_INCOMPLETE_PATH found! cancelled downloads will take their partial files with them")

        else:
            logger.info(
                "SLSKD_INCOMPLETE_PATH not set, so cancelling a download leaves its partial "
                "file in slskd's incomplete folder (which is what lets slskd resume it)"
            )

        if not cls.LIBRARY_PATH:
            logger.warning("LIBRARY_PATH not found in environment, organizing downloaded files will be disabled")

        else: logger.info(f"LIBRARY_PATH found!")

        if cls.ORGANIZE_MODE not in ("off", "dry_run", "copy", "move"):
            logger.error(
                f"ORGANIZE_MODE is '{cls.ORGANIZE_MODE}', expected one of off/dry_run/copy/move. "
                f"Falling back to dry_run.",
                extra={"frontend": True},
            )
            cls.ORGANIZE_MODE = "dry_run"

        if cls.organizing_enabled():
            logger.info(f"organizing enabled in '{cls.ORGANIZE_MODE}' mode")

        else: logger.info("organizing disabled (needs SLSKD_DOWNLOAD_PATH + LIBRARY_PATH, and ORGANIZE_MODE not 'off')")

    @classmethod
    def organizing_enabled(cls) -> bool:
        return bool(cls.SLSKD_DOWNLOAD_PATH and cls.LIBRARY_PATH and cls.ORGANIZE_MODE != "off")
