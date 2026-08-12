#!/bin/sh
set -e

# Run as a normal user rather than root.
#
# This matters more here than in most containers: the organizer writes into your music
# library, and anything it creates as root is a nuisance to fix afterwards from the host.
# PUID/PGID follow the linuxserver.io convention so they line up with what slskd and the
# *arr containers are already using - set all of them to the same values and the files
# everything produces stay consistently owned.

PUID=${PUID:-1000}
PGID=${PGID:-1000}
APP_USER=jimbrainz

if [ "$(id -u)" != "0" ]; then
    # Already unprivileged (docker run --user, or a platform that enforces it). Nothing to
    # drop, and no permission to create users - just run.
    echo "[entrypoint] running as uid $(id -u), skipping PUID/PGID setup"
    exec "$@"
fi

if ! getent group "$PGID" >/dev/null 2>&1; then
    groupadd -g "$PGID" "$APP_USER"
fi
GROUP_NAME=$(getent group "$PGID" | cut -d: -f1)

if ! getent passwd "$PUID" >/dev/null 2>&1; then
    useradd -u "$PUID" -g "$PGID" -M -s /usr/sbin/nologin "$APP_USER"
fi
USER_NAME=$(getent passwd "$PUID" | cut -d: -f1)

# Only ever chown /config. The library and downloads mounts are the user's own data, often
# large and often shared with other containers - recursively rewriting their ownership on
# every start would be slow and presumptuous.
if [ -d /config ]; then
    chown -R "$PUID:$PGID" /config 2>/dev/null || \
        echo "[entrypoint] warning: could not chown /config, the database may be unwritable"
fi

echo "[entrypoint] starting as ${USER_NAME}:${GROUP_NAME} (${PUID}:${PGID})"
exec gosu "$PUID:$PGID" "$@"
