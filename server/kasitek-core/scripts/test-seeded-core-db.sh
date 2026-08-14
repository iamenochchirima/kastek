#!/usr/bin/env sh
set -eu

: "${SEEDED_CORE_TEST_DATABASE_URL:?Set SEEDED_CORE_TEST_DATABASE_URL to a disposable local PostgreSQL database}"

case "$SEEDED_CORE_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Refusing to run seeded Core tests against a non-local database" >&2; exit 1 ;;
esac

psql "$SEEDED_CORE_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f "$(dirname "$0")/../tests/seeded_core_integration.sql"

(
  cd "$(dirname "$0")/../.."
  DATABASE_URL="$SEEDED_CORE_TEST_DATABASE_URL" cargo test -p kasitek-core --lib \
    services::connections::tests::database_sync_preserves_organization_ownership -- --ignored
  DATABASE_URL="$SEEDED_CORE_TEST_DATABASE_URL" cargo test -p kasitek-core --lib \
    services::inbox::tests::conversation_reads_are_isolated_by_organization -- --ignored
)
