#!/usr/bin/env sh
set -eu

: "${CONNECTIONS_TEST_DATABASE_URL:?Set CONNECTIONS_TEST_DATABASE_URL to a disposable local PostgreSQL database}"

case "$CONNECTIONS_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Refusing to run connection integration tests against a non-local database" >&2; exit 1 ;;
esac

psql "$CONNECTIONS_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../tests/connections_integration.sql"
