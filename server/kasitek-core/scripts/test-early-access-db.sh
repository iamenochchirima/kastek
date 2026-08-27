#!/usr/bin/env sh
set -eu

: "${EARLY_ACCESS_TEST_DATABASE_URL:?Set EARLY_ACCESS_TEST_DATABASE_URL to a disposable local PostgreSQL database}"

case "$EARLY_ACCESS_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*|*::1*) ;;
  *) echo "Refusing to run early-access integration tests against a non-local database" >&2; exit 1 ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_ROOT="$SCRIPT_DIR/../.."
cd "$SERVER_ROOT"
DATABASE_URL="$EARLY_ACCESS_TEST_DATABASE_URL" cargo test -p kasitek-core --test early_access -- --ignored
