#!/bin/sh
# Container entry point.
#
# With Supabase Storage configured (docs/persistent-storage.md), the database is restored from the bucket
# before the server starts, and Litestream keeps streaming every change back while the server runs. The free
# Render plan has no disk, so this is what lets accounts survive restarts and redeploys.
#
# Without it, the server starts on its own, as before: data lasts only as long as the container's disk.
set -eu

SERVER="node server/dist/index.js"

if [ -z "${SUPABASE_S3_ACCESS_KEY_ID:-}" ]; then
  echo "[start] Supabase Storage is not configured: the database is NOT backed up and resets when the container is replaced."
  export DATA_REPLICATION=none
  exec $SERVER
fi

missing=""
for name in SUPABASE_PROJECT_REF SUPABASE_S3_REGION SUPABASE_S3_SECRET_ACCESS_KEY; do
  eval "value=\${$name:-}"
  [ -n "$value" ] || missing="$missing $name"
done
if [ -n "$missing" ]; then
  # Refuse to start rather than run without the backup the operator asked for.
  echo "[start] SUPABASE_S3_ACCESS_KEY_ID is set but these are missing:$missing. See docs/persistent-storage.md." >&2
  exit 1
fi

export SUPABASE_S3_BUCKET="${SUPABASE_S3_BUCKET:-mahilasathi-db}"
export DATA_REPLICATION=litestream
echo "[start] Restoring the database from Supabase Storage (bucket ${SUPABASE_S3_BUCKET}) if a backup exists, then replicating."

# -restore-if-db-not-exists: on a fresh container, download the latest copy first; with no backup yet (the very
# first start), begin with an empty database. If the bucket can't be reached, Litestream exits with an error and
# the server does not start, so it never runs on an empty database by mistake and overwrites nothing.
# Litestream runs the server as its child, stops it on SIGTERM and sends the last changes before exiting.
exec litestream replicate -config /app/docker/litestream.yml -restore-if-db-not-exists -exec "$SERVER"
