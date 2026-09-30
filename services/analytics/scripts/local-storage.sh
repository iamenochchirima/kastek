#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

command -v docker >/dev/null 2>&1 || {
  echo "docker is required for Analytics local storage" >&2
  exit 1
}

cd "$SERVICE_DIR"
exec docker compose -f compose.yaml up postgres redis
