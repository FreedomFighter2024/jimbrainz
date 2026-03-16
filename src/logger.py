import logging
import asyncio
import json
import os
from zoneinfo import ZoneInfo
from datetime import datetime

if os.getenv("TZ") is not None:
    try: 
        tz_name = os.getenv("TZ", "UTC")
        current_time = datetime.now(ZoneInfo(tz_name))
    except:
        pass

sse_clients = set()

def register_sse_client():
    q = asyncio.Queue()
    sse_clients.add(q)
    return q

def unregister_sse_client(q):
    sse_clients.discard(q)

def publish_sse_event(event_json):
    for q in list(sse_clients):
        try:
            q.put_nowait(event_json)
        except asyncio.QueueFull:
            pass


class SSEHandler(logging.Handler):
    def emit(self, record):
        if not getattr(record, "frontend", False):
            return

        event_json = self.format(record)
        event_json = {
            "event_time": datetime.fromtimestamp(record.created).strftime("%H:%M:%S"),
            "event_type": record.levelname,
            "event_content": record.getMessage()
        }

        src = getattr(record, "src", None)

        if src is not None:
            event_json["src"] = src

        try:
            event_json = json.dumps(event_json)
            try:
                loop = asyncio.get_running_loop()
            except RuntimeError:
                loop = asyncio.get_event_loop()
            loop.call_soon_threadsafe(publish_sse_event, event_json)
        
        except RuntimeError:
            pass

def setup_logging(): 
    logger = logging.getLogger()
    logger.setLevel(logging.INFO)

    StreamHandler = SSEHandler()
    StreamHandler.setFormatter(logging.Formatter('%(asctime)s - %(levelname)s - %(message)s'))

    ConsoleHandler = logging.StreamHandler()
    ConsoleHandler.setFormatter(logging.Formatter('%(levelname)s: %(message)s'))

    logger.handlers = []
    logger.addHandler(StreamHandler)
    logger.addHandler(ConsoleHandler)
    return logging.getLogger()

def cleanup_logging():
    logger = logging.getLogger()
    handlers = logger.handlers[:]
    
    for handler in handlers:
        logger.removeHandler(handler)
        handler.close()

    logging.shutdown()

if not logging.getLogger().handlers:
    logger = setup_logging()
else:
    logger = logging.getLogger()
    