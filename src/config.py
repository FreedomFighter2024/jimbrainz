import os
from dotenv import load_dotenv
from src.logger import logger


def _env(name: str, default: str | None = None) -> str | None:
    """
    Read a setting, treating whitespace-only as unset.

    Docker and .env files hand over stray whitespace surprisingly often, and a value like
    "  " is truthy in python - so without the strip it sails past every `if not value` guard
    and only fails much later somewhere far less informative.
    """
    value = os.getenv(name, default)
    return value.strip() if isinstance(value, str) else value


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

        url_problem = describe_slskd_url(cls.SLSKD_URL)
        if url_problem:
            logger.error(
                f"SLSKD_URL is unusable ({url_problem}) - searching and downloading will fail. "
                f"If you use docker-compose, check that .env is actually reaching the container.",
                extra={"frontend": True},
            )

        else: logger.info(f"SLSKD_URL found!")

        if not cls.SLSKD_APIKEY:
            logger.error("SLSKD_APIKEY not found in environment, downloads will not work", extra={"frontend": True})

        else: logger.info(f"SLSKD_APIKEY found!")

        if not cls.SLSKD_DOWNLOAD_PATH:
            logger.warning("SLSKD_DOWNLOAD_PATH not found in environment, organizing downloaded files will be disabled")

        else: logger.info(f"SLSKD_DOWNLOAD_PATH found!")

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
