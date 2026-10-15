#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=node24.sh
source "$ROOT_DIR/scripts/node24.sh"
kasitek_use_node24

echo ""
echo "==> KasiTek local setup"
echo ""

# --- check required tools ---

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "ERROR: required command not found: $1" >&2
    echo "       Install it and re-run this script." >&2
    exit 1
  fi
}

require_command node
require_command npx
require_command pnpm

if ! command -v ngrok >/dev/null 2>&1; then
  echo "WARNING: ngrok not found — WhatsApp webhooks won't reach your machine."
  echo "         Install from https://ngrok.com/download"
  echo ""
fi

# --- dotenv vault login ---

if [[ ! -f "$ROOT_DIR/.env.me" ]]; then
  echo "==> No .env.me found — logging in to dotenv vault..."
  (cd "$ROOT_DIR" && npx -y dotenv-vault@latest login -y)
else
  echo "==> dotenv vault already authenticated"
fi

# --- pull envs ---

echo ""
echo "==> Pulling envs from vault..."
"$ROOT_DIR/scripts/sync_dotenv_vaults.sh" pull

# --- install js dependencies ---

echo ""
echo "==> Installing JS dependencies..."
(cd "$ROOT_DIR/client" && pnpm install)
labs_source="${LABS_SOURCE_DIR:-$ROOT_DIR/../kasitek-labs}"
pnpm --dir "$ROOT_DIR/server/kasitek-core" prepare:shared "$labs_source"
pnpm --dir "$ROOT_DIR/server/kasitek-core" install --frozen-lockfile

echo ""
echo "==> Done. Run ./scripts/run_local_stack.sh to start Growth Core, client, and internal docs."
echo ""
