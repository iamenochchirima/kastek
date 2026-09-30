#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v cargo >/dev/null 2>&1 || {
  echo "cargo is required for Analytics local migrations" >&2
  exit 1
}

if [[ -f "$SERVICE_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SERVICE_DIR/.env"
  set +a
fi

cd "$SERVICE_DIR"
export ANALYTICS_DATABASE_URL="${ANALYTICS_DATABASE_URL:-postgres://analytics:analytics_dev_password@127.0.0.1:5432/kasitek_analytics}"
exec cargo run --bin analytics-migrate
