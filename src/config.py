import os
from dotenv import load_dotenv
from src.logger import logger


load_dotenv()
class Config:
    MUSICBRAINZ_USERAGENT = os.getenv("MUSICBRAINZ_USERAGENT")

    #? slskd is the download backend now, not optional anymore
    SLSKD_URL = os.getenv("SLSKD_URL")
    SLSKD_APIKEY = os.getenv("SLSKD_APIKEY")

    #? filesystem paths, only needed once the organizer lands (phase 3)
    SLSKD_DOWNLOAD_PATH = os.getenv("SLSKD_DOWNLOAD_PATH")
    LIBRARY_PATH = os.getenv("LIBRARY_PATH")
    DB_PATH = os.getenv("DB_PATH", "/config/jimbrainz.db")

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

        if not cls.SLSKD_URL:
            logger.error("SLSKD_URL not found in environment, downloads will not work", extra={"frontend": True})

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
