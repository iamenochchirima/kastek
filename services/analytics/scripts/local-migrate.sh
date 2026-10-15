#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVICE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$SERVICE_DIR/../.." && pwd)"

command -v node >/dev/null 2>&1 || {
  echo "Node.js 24 is required for Analytics local migrations" >&2
  exit 1
}
cd "$REPO_ROOT"
corepack pnpm build:shared
corepack pnpm --filter @kasitek/analytics build
exec corepack pnpm --filter @kasitek/analytics migrate
