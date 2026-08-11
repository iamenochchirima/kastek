#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root/server/kasitek-core"

# cargo-watch restarts the API when Rust sources, shared crates, or its .env change.
exec cargo watch \
  --watch src \
  --watch .env \
  --watch ../crates \
  --exec run
