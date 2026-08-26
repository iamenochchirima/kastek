#!/usr/bin/env sh
set -eu

: "$REFERRALS_TEST_DATABASE_URL"

case "$REFERRALS_TEST_DATABASE_URL" in
  *localhost*|*127.0.0.1*) ;;
  *) echo "Refusing to run referral integration tests against a non-local database" >&2; exit 1 ;;
esac

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SERVER_ROOT="$SCRIPT_DIR/../.."
cd "$SERVER_ROOT"
DATABASE_URL="$REFERRALS_TEST_DATABASE_URL" cargo test -p kasitek-core --test referrals -- --ignored
