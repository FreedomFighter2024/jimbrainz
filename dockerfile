FROM python:3.14-slim

# gosu drops privileges cleanly in the entrypoint. su/sudo both leave the process re-parented
# with a TTY attached, which breaks signal handling - the container then ignores SIGTERM and
# takes the full timeout to stop.
RUN apt-get update \
    && apt-get install -y --no-install-recommends gosu \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY src/ ./src/
COPY interface/ ./interface/
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    PUID=1000 \
    PGID=1000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "src.main"]
