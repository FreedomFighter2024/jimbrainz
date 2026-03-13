import os
from dotenv import load_dotenv
from src.logger import logger


load_dotenv()
class Config: 
    LIDARR_URL = os.getenv("LIDARR_URL")
    LIDARR_APIKEY = os.getenv("LIDARR_APIKEY")
    MUSICBRAINZ_USERAGENT = os.getenv("MUSICBRAINZ_USERAGENT")

    #? Optional includes
    SLSKD_URL = os.getenv("SLSKD_URL")
    SLSKD_APIKEY = os.getenv("SLSKD_APIKEY")

    SLSKD_ENABLED = False
    if SLSKD_URL and SLSKD_APIKEY:
        logger.info("SLSKD configuration found, enabling SLSKD functionality")
        SLSKD_ENABLED = True
    
    

    @classmethod
    def exists(cls, env_var: str):
        value = os.getenv(env_var)
        
        if not value: 
            logger.error(f"{env_var} not set either in .env config file or environment")
        
        return value

    @classmethod
    def check(cls):
        if not cls.LIDARR_URL:
            logger.error("LIDARR_URL not found in environment", extra={"frontend": True})
        
        else: logger.info(f"LIDARR_URL found")
        
        if not cls.LIDARR_APIKEY:
            logger.error("LIDARR_APIKEY not found in environment", extra={"frontend": True})
        
        else: logger.info(f"LIDARR_APIKEY found!")
        
        if not cls.MUSICBRAINZ_USERAGENT:
            logger.error("MUSICBRAINZ_USERAGENT not found in environment", extra={"frontend": True})
        
        else: logger.info(f"MUSICBRAINZ_USERAGENT found!")

        if not cls.SLSKD_URL:
            logger.warning("SLSKD_URL not found in environment, SLSKD functionality will be disabled")

        else: logger.info(f"SLSKD_URL found!")

        if not cls.SLSKD_APIKEY:
            logger.warning("SLSKD_APIKEY not found in environment, SLSKD functionality will be disabled")

        else: logger.info(f"SLSKD_APIKEY found!")

        if cls.SLSKD_ENABLED:
            logger.info("SLSKD functionality enabled")
        
        else: logger.info("SLSKD functionality disabled")





