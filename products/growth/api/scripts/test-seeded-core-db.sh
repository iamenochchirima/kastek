#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
source "$SCRIPT_DIR/../../scripts/node24.sh"
kasitek_use_node24
exec node "$SCRIPT_DIR/run-db-fixtures.mjs" connections-inbox
