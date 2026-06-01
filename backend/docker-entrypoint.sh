#!/bin/sh
# LinuxServer/Unraid-style permission drop. The container starts as root,
# fixes ownership of the persistent /config mount (which on Unraid is
# typically nobody:users = 99:100), then drops to the requested PUID:PGID
# before running the app. The app image itself is world-readable, so any
# PUID can read /app.
set -e

: "${PUID:=1000}"
: "${PGID:=1000}"

# /config holds the SQLite database (and logs). Make sure it exists and is
# owned by the runtime user so alembic can create/migrate the DB file.
mkdir -p /config/db
chown -R "${PUID}:${PGID}" /config

exec gosu "${PUID}:${PGID}" "$@"
