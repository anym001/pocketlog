#!/bin/sh
# LinuxServer/Unraid-style permission drop. The container starts as root,
# fixes ownership of the persistent /config mount (which on Unraid is
# typically nobody:users = 99:100), then drops to the requested PUID:PGID
# before running the app. The app image itself is world-readable, so any
# PUID can read /app.
set -e

: "${PUID:=1000}"
: "${PGID:=1000}"

# Both values feed chown and gosu; reject anything that is not a plain
# non-negative integer so a typo fails loudly here instead of with a
# confusing downstream error.
case "$PUID" in
    ''|*[!0-9]*)
        echo "Error: PUID must be a non-negative integer, got: '${PUID}'" >&2
        exit 1
        ;;
esac
case "$PGID" in
    ''|*[!0-9]*)
        echo "Error: PGID must be a non-negative integer, got: '${PGID}'" >&2
        exit 1
        ;;
esac

# /config holds the SQLite database (and logs). Make sure it exists and is
# owned by the runtime user so alembic can create/migrate the DB file.
mkdir -p /config/db
chown -R "${PUID}:${PGID}" /config

exec gosu "${PUID}:${PGID}" "$@"
