#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for Analytics local migrations" >&2
  exit 1
}
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
docker compose -f compose.yaml up -d postgres redis

postgres_user="${ANALYTICS_POSTGRES_USER:-analytics}"
postgres_db="${ANALYTICS_POSTGRES_DB:-kasitek_analytics}"
postgres_password="${ANALYTICS_POSTGRES_PASSWORD:-analytics_dev_password}"
ready=false
for _ in $(seq 1 60); do
  if docker compose -f compose.yaml exec -T postgres pg_isready -U "$postgres_user" -d "$postgres_db" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 1
done

if [[ "$ready" != true ]]; then
  echo "Analytics PostgreSQL did not become ready" >&2
  exit 1
fi

export ANALYTICS_DATABASE_URL="${ANALYTICS_DATABASE_URL:-postgres://${postgres_user}:${postgres_password}@127.0.0.1:55432/${postgres_db}}"
exec cargo run --bin analytics-migrate
