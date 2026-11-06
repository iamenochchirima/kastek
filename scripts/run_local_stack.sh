#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$root/products/growth/scripts/node24.sh"
kasitek_use_node24
exec node "$root/scripts/local-stack.mjs" "$@"
