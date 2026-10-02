#!/usr/bin/env bash
set -euo pipefail

root_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root_dir"

if matches=$(rg -n '(/api/bots|BotConfiguration|BotDeployment|BotEvent|N8N_API_URL|N8N_API_KEY|N8N_CALLBACK_TOKEN)' \
  server/kasitek-core/src-ts \
  client/apps/client/src \
  client/packages/database/prisma/schema.prisma \
  client/packages/database/src/generated 2>/dev/null); then
  printf '%s\n' "$matches" >&2
  echo "legacy bot references found in live source" >&2
  exit 1
fi

echo "no legacy bot references found in live source"
