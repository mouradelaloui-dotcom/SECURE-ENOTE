#!/bin/sh
# Création du compte applicatif à privilèges minimaux (les droits sont attribués par les migrations).
set -e
APP_PWD="$(cat "$APP_DB_PASSWORD_FILE")"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-EOSQL
  CREATE ROLE enote_app LOGIN PASSWORD '${APP_PWD}' NOSUPERUSER NOCREATEDB NOCREATEROLE;
  REVOKE ALL ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
  GRANT CONNECT ON DATABASE ${POSTGRES_DB} TO enote_app;
  REVOKE CREATE ON SCHEMA public FROM PUBLIC;
EOSQL
