#!/bin/sh
# docker-entrypoint-initdb.d hook for the postgres service (P0.md §4).
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner_password="$GEM_OWNER_PASSWORD" \
  -v app_password="$GEM_APP_PASSWORD" \
  -v dbname="$POSTGRES_DB" \
  -f /docker-entrypoint-initdb.d/init.sql.tpl
