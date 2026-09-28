#!/usr/bin/env bash

set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
SERVICE_DIR="$ROOT_DIR/services/analytics"
KEEP=false
FULL=false
CI_MODE=false

usage() {
  cat <<'EOF'
Usage: ./services/analytics/scripts/test-e2e.sh [--ci] [--keep] [--full]

Runs the bounded Analytics foundation smoke test against an explicitly supplied
loopback PostgreSQL database. The test migrates the database, starts a local
Analytics API, and verifies liveness, migration-gated readiness, and the
authenticated metrics boundary.

Required:
  ANALYTICS_E2E_DATABASE_URL    Disposable loopback PostgreSQL database URL

Optional:
  ANALYTICS_E2E_REDIS_URL       Loopback Redis URL to verify with redis-cli
  ANALYTICS_E2E_API_PORT        API port (default: 4430)
  ANALYTICS_E2E_METRICS_TOKEN   Metrics bearer token (default: generated local value)

--keep leaves the API and temporary logs running for debugging.
--full is reserved for product end-to-end checks and remains deferred while
the source publishers are disconnected from the Labs-owned service.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --ci) CI_MODE=true ;;
    --keep) KEEP=true ;;
    --full) FULL=true ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

if [[ "$FULL" == true ]]; then
  echo "Analytics product end-to-end checks remain deferred until the source publishers are connected." >&2
  exit 2
fi

for command_name in cargo curl; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

: "${ANALYTICS_E2E_DATABASE_URL:?Set ANALYTICS_E2E_DATABASE_URL to a disposable local PostgreSQL database}"
case "$ANALYTICS_E2E_DATABASE_URL" in
  *localhost*|*127.0.0.1*|*\[::1\]*) ;;
  *)
    echo "Refusing Analytics E2E against a non-loopback database. Set ANALYTICS_E2E_DATABASE_URL to localhost, 127.0.0.1, or ::1." >&2
    exit 1
    ;;
esac

if [[ -n "${ANALYTICS_E2E_REDIS_URL:-}" ]]; then
  if ! command -v redis-cli >/dev/null 2>&1; then
    echo "ANALYTICS_E2E_REDIS_URL was supplied but redis-cli is not installed." >&2
    exit 1
  fi
  case "$ANALYTICS_E2E_REDIS_URL" in
    *localhost*|*127.0.0.1*|*\[::1\]*) ;;
    *) echo "Refusing Analytics E2E against a non-loopback Redis URL." >&2; exit 1 ;;
  esac
fi

api_port="${ANALYTICS_E2E_API_PORT:-4430}"
metrics_token="${ANALYTICS_E2E_METRICS_TOKEN:-analytics-e2e-metrics-token}"
mode="local"
if [[ "$CI_MODE" == true ]]; then
  mode="ci"
fi
correlation_id="analytics-e2e-$(date -u +%Y%m%dT%H%M%SZ)-$$"
work_dir="$(mktemp -d "${TMPDIR:-/tmp}/kasitek-analytics-e2e.XXXXXX")"
api_log="$work_dir/analytics-api.log"
api_pid=""
stage="initializing"

cleanup() {
  local status=$?
  if [[ "$status" -ne 0 ]]; then
    echo "Analytics E2E failed at stage=$stage correlation_id=$correlation_id" >&2
    if [[ -f "$api_log" ]]; then
      echo "--- Analytics API log ---" >&2
      tail -n 120 "$api_log" >&2 || true
    fi
  fi

  if [[ "$KEEP" != true && -n "$api_pid" ]]; then
    kill "$api_pid" 2>/dev/null || true
    wait "$api_pid" 2>/dev/null || true
  fi
  if [[ "$KEEP" != true ]]; then
    rm -rf "$work_dir"
  else
    echo "Analytics E2E kept API/logs at $work_dir (pid=$api_pid)"
  fi
  exit "$status"
}
trap cleanup EXIT

run_migration() {
  stage="migration"
  echo "[$stage] mode=$mode correlation_id=$correlation_id"
  ANALYTICS_DATABASE_URL="$ANALYTICS_E2E_DATABASE_URL" \
    ANALYTICS_METRICS_TOKEN="$metrics_token" \
    ANALYTICS_LOG_FILTER="warn" \
    cargo run --quiet --manifest-path "$SERVICE_DIR/Cargo.toml" --bin analytics-migrate
}

verify_redis() {
  [[ -n "${ANALYTICS_E2E_REDIS_URL:-}" ]] || return 0
  stage="redis"
  echo "[$stage] mode=$mode correlation_id=$correlation_id"
  [[ "$(redis-cli -u "$ANALYTICS_E2E_REDIS_URL" ping)" == "PONG" ]]
}

start_api() {
  stage="api-build"
  echo "[$stage] mode=$mode correlation_id=$correlation_id"
  cargo build --quiet --manifest-path "$SERVICE_DIR/Cargo.toml" --bin analytics-api
  stage="api-start"
  echo "[$stage] mode=$mode correlation_id=$correlation_id"
  ANALYTICS_DATABASE_URL="$ANALYTICS_E2E_DATABASE_URL" \
    ANALYTICS_REDIS_URL="${ANALYTICS_E2E_REDIS_URL:-}" \
    ANALYTICS_METRICS_TOKEN="$metrics_token" \
    ANALYTICS_API_HOST="127.0.0.1" \
    ANALYTICS_API_PORT="$api_port" \
    ANALYTICS_LOG_FILTER="info" \
    "$ROOT_DIR/target/debug/analytics-api" >"$api_log" 2>&1 &
  api_pid=$!
}

wait_for_status() {
  local path="$1"
  local expected="$2"
  local deadline=$((SECONDS + 60))
  local status
  while (( SECONDS < deadline )); do
    status="$(curl -sS --max-time 2 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$api_port$path" || true)"
    if [[ "$status" == "$expected" ]]; then
      return 0
    fi
    sleep 1
  done
  echo "Timed out waiting for $path to return HTTP $expected (last status: ${status:-none})" >&2
  return 1
}

verify_api() {
  stage="api-health"
  echo "[$stage] mode=$mode correlation_id=$correlation_id"
  wait_for_status "/health/live" 200
  wait_for_status "/health/ready" 200

  local live_body ready_body metrics_body unauthorized_status
  live_body="$(curl -fsS "http://127.0.0.1:$api_port/health/live")"
  ready_body="$(curl -fsS "http://127.0.0.1:$api_port/health/ready")"
  metrics_body="$(curl -fsS -H "Authorization: Bearer $metrics_token" "http://127.0.0.1:$api_port/internal/metrics")"
  unauthorized_status="$(curl -sS -o /dev/null -w '%{http_code}' "http://127.0.0.1:$api_port/internal/metrics")"

  grep -Eq '"status"[[:space:]]*:[[:space:]]*"ok"' <<<"$live_body"
  grep -Eq '"status"[[:space:]]*:[[:space:]]*"ready"' <<<"$ready_body"
  [[ "$unauthorized_status" == "401" ]]
  grep -q 'kasitek_analytics_process_info' <<<"$metrics_body"
  grep -q 'kasitek_analytics_readiness_checks_total' <<<"$metrics_body"
  grep -q 'process="analytics-api"' <<<"$metrics_body"
}

run_migration
verify_redis
start_api
verify_api

stage="complete"
echo "Analytics foundation E2E passed: correlation_id=$correlation_id"
