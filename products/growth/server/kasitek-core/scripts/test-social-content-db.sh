#!/usr/bin/env sh
set -eu

: "${SOCIAL_CONTENT_TEST_DATABASE_URL:?Set SOCIAL_CONTENT_TEST_DATABASE_URL to a disposable local PostgreSQL database}"

case "$SOCIAL_CONTENT_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Refusing to run social content integration tests against a non-local database" >&2; exit 1 ;;
esac

psql "$SOCIAL_CONTENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f "$(dirname "$0")/../tests/social_content_integration.sql"
