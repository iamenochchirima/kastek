#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

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
require_command cargo

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

echo ""
echo "==> Done. Run ./scripts/run_local_stack.sh to start all services."
echo ""
