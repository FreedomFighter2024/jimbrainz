# The interface is built here rather than committed, so a checkout never carries generated
# output and the image can't drift from the source it was built from.
FROM node:22-alpine AS ui

WORKDIR /ui

# lockfile first: this layer only busts when dependencies actually change, so ordinary
# frontend edits reuse the cached npm ci
COPY ui/package.json ui/package-lock.json ./
RUN npm ci

COPY ui/ ./
# vite.config.ts sets outDir to ../interface/dist, so this lands at /interface/dist. The
# build also runs tsc --noEmit first, which makes a type error fail the image build rather
# than ship.
RUN npm run build


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
# after the interface copy, so a stale dist/ left behind by a local build is overwritten
# rather than shipped
COPY --from=ui /interface/dist ./interface/dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV PYTHONUNBUFFERED=1 \
    PUID=1000 \
    PGID=1000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["python", "-m", "src.main"]
