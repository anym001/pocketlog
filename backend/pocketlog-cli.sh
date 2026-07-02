#!/bin/sh
# Console launcher for the operator CLI, installed as /usr/local/bin/pocketlog
# so operator commands read naturally:
#
#     docker exec pocketlog pocketlog backup
#     docker exec -it pocketlog pocketlog reset-admin-password
#
# `docker exec` starts as the image's default user (root) — NOT as the
# runtime user the entrypoint dropped to. Without the same gosu drop here,
# every file the CLI creates (backup snapshots under /config/db/backups)
# would be root-owned and unreadable for the PUID that owns /config. PUID/
# PGID come from the container environment, exactly like in
# docker-entrypoint.sh; outside Docker (bare `python -m app.cli`) this
# script is simply not involved.
set -e

cd /app

if [ "$(id -u)" = "0" ]; then
    : "${PUID:=1000}"
    : "${PGID:=1000}"
    exec gosu "${PUID}:${PGID}" python -m app.cli "$@"
fi
exec python -m app.cli "$@"
