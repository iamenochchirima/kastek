#!/usr/bin/env sh
set -eu

: "${BILLING_TEST_DATABASE_URL:?Set BILLING_TEST_DATABASE_URL to a disposable local PostgreSQL database}"

case "$BILLING_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Refusing to run billing integration tests against a non-local database" >&2; exit 1 ;;
esac

psql "$BILLING_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../tests/billing_integration.sql"
