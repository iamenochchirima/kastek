#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=node24.sh
source "$repo_root/scripts/node24.sh"
kasitek_use_node24
cd "$repo_root/server/kasitek-core"

exec pnpm dev
