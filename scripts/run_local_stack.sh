#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# Editable local defaults.
LIVEKIT_URL="${LIVEKIT_URL:-ws://127.0.0.1:7880}"
LIVEKIT_API_KEY="${LIVEKIT_API_KEY:-devkey}"
LIVEKIT_API_SECRET="${LIVEKIT_API_SECRET:-secret}"
LIVEKIT_DEV_COMMAND="${LIVEKIT_DEV_COMMAND:-livekit-server --dev --bind 0.0.0.0}"

KASITEK_CALLS_PORT="${KASITEK_CALLS_PORT:-4010}"
KASITEK_CORE_PORT="${KASITEK_CORE_PORT:-4000}"
CALL_BRIDGE_PORT="${CALL_BRIDGE_PORT:-8787}"
PROVIDER_RELAY_PORT="${PROVIDER_RELAY_PORT:-8790}"

WHATSAPP_CALL_BRIDGE_TOKEN="${WHATSAPP_CALL_BRIDGE_TOKEN:-kasitek-call-test}"
META_CLOUD_API_PROVIDER_TOKEN="${META_CLOUD_API_PROVIDER_TOKEN:-}"

NGROK_COMMAND="${NGROK_COMMAND:-ngrok http ${KASITEK_CORE_PORT}}"

if command -v gnome-terminal >/dev/null 2>&1; then
  TERMINAL_BIN="gnome-terminal"
elif command -v x-terminal-emulator >/dev/null 2>&1; then
  TERMINAL_BIN="x-terminal-emulator"
else
  echo "No supported terminal launcher found. Install gnome-terminal or x-terminal-emulator." >&2
  exit 1
fi

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    exit 1
  fi
}

require_command cargo
require_command pnpm
require_command ngrok
require_command bash

if ! command -v livekit-server >/dev/null 2>&1; then
  echo "Warning: livekit-server is not installed. The LiveKit terminal will fail until you install it." >&2
fi

open_terminal() {
  local title="$1"
  local workdir="$2"
  local command="$3"

  if [[ "$TERMINAL_BIN" == "gnome-terminal" ]]; then
    gnome-terminal \
      --title="$title" \
      --working-directory="$workdir" \
      -- bash -lc "$command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
  else
    x-terminal-emulator \
      -T "$title" \
      -e bash -lc "cd '$workdir'; $command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
  fi
}

open_gnome_tabs() {
  local -a args=()
  local first=1

  while [[ "$#" -gt 0 ]]; do
    local title="$1"
    local workdir="$2"
    local command="$3"

    if [[ "$first" -eq 1 ]]; then
      args+=(
        --window
        --title="$title"
        --working-directory="$workdir"
        -- bash -lc "$command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
      )
      first=0
      shift 3
      continue
    fi

    args+=(
      --tab
      --title="$title"
      --working-directory="$workdir"
      -- bash -lc "$command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
    )
    shift 3
  done

  gnome-terminal "${args[@]}"
}

echo "Launching local KasiTek stack from $ROOT_DIR"
echo "LiveKit URL: $LIVEKIT_URL"
echo "KasiTek core: http://127.0.0.1:${KASITEK_CORE_PORT}"
echo "KasiTek calls: http://127.0.0.1:${KASITEK_CALLS_PORT}"
echo "Call bridge: http://127.0.0.1:${CALL_BRIDGE_PORT}"
echo "Provider relay: http://127.0.0.1:${PROVIDER_RELAY_PORT}"

if [[ "$TERMINAL_BIN" == "gnome-terminal" ]]; then
  open_gnome_tabs \
    "LiveKit" \
    "$ROOT_DIR" \
    "$LIVEKIT_DEV_COMMAND" \
    "KasiTek Calls" \
    "$ROOT_DIR/server/kasitek-calls" \
    "PORT=${KASITEK_CALLS_PORT} \
WHATSAPP_CALL_PROVIDER=livekit \
WHATSAPP_CALL_SIGNALING_URL=http://127.0.0.1:${CALL_BRIDGE_PORT} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
LIVEKIT_URL=${LIVEKIT_URL} \
LIVEKIT_API_KEY=${LIVEKIT_API_KEY} \
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET} \
cargo run" \
    "KasiTek Core" \
    "$ROOT_DIR/server/kasitek-core" \
    "PORT=${KASITEK_CORE_PORT} \
KASITEK_CALLS_URL=http://127.0.0.1:${KASITEK_CALLS_PORT} \
cargo run" \
    "Call Bridge" \
    "$ROOT_DIR/client" \
    "KASITEK_API_BASE_URL=http://127.0.0.1:${KASITEK_CORE_PORT} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
WHATSAPP_CALL_BRIDGE_MODE=production \
WHATSAPP_CALL_PROVIDER=meta-cloud-api \
PORT=${CALL_BRIDGE_PORT} \
pnpm dev:call-bridge" \
    "Provider Relay" \
    "$ROOT_DIR/client" \
    "META_CLOUD_API_PROVIDER_TOKEN=${META_CLOUD_API_PROVIDER_TOKEN} \
PORT=${PROVIDER_RELAY_PORT} \
pnpm --filter call-bridge provider:meta-livekit-relay" \
    "Provider Worker" \
    "$ROOT_DIR/client" \
    "META_CLOUD_API_WORKER_MODE=relay \
META_CLOUD_API_PROVIDER_BASE_URL=http://127.0.0.1:${PROVIDER_RELAY_PORT} \
META_CLOUD_API_PROVIDER_TOKEN=${META_CLOUD_API_PROVIDER_TOKEN} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
pnpm dev:call-bridge:worker:meta-relay" \
    "Client" \
    "$ROOT_DIR/client" \
    "pnpm run dev" \
    "ngrok" \
    "$ROOT_DIR" \
    "$NGROK_COMMAND"
else
  open_terminal \
    "LiveKit" \
    "$ROOT_DIR" \
    "$LIVEKIT_DEV_COMMAND"

  open_terminal \
    "KasiTek Calls" \
    "$ROOT_DIR/server/kasitek-calls" \
    "PORT=${KASITEK_CALLS_PORT} \
WHATSAPP_CALL_PROVIDER=livekit \
WHATSAPP_CALL_SIGNALING_URL=http://127.0.0.1:${CALL_BRIDGE_PORT} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
LIVEKIT_URL=${LIVEKIT_URL} \
LIVEKIT_API_KEY=${LIVEKIT_API_KEY} \
LIVEKIT_API_SECRET=${LIVEKIT_API_SECRET} \
cargo run"

  open_terminal \
    "KasiTek Core" \
    "$ROOT_DIR/server/kasitek-core" \
    "PORT=${KASITEK_CORE_PORT} \
KASITEK_CALLS_URL=http://127.0.0.1:${KASITEK_CALLS_PORT} \
cargo run"

  open_terminal \
    "Call Bridge" \
    "$ROOT_DIR/client" \
    "KASITEK_API_BASE_URL=http://127.0.0.1:${KASITEK_CORE_PORT} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
WHATSAPP_CALL_BRIDGE_MODE=production \
WHATSAPP_CALL_PROVIDER=meta-cloud-api \
PORT=${CALL_BRIDGE_PORT} \
pnpm dev:call-bridge"

  open_terminal \
    "Provider Relay" \
    "$ROOT_DIR/client" \
    "META_CLOUD_API_PROVIDER_TOKEN=${META_CLOUD_API_PROVIDER_TOKEN} \
PORT=${PROVIDER_RELAY_PORT} \
pnpm --filter call-bridge provider:meta-livekit-relay"

  open_terminal \
    "Provider Worker" \
    "$ROOT_DIR/client" \
    "META_CLOUD_API_WORKER_MODE=relay \
META_CLOUD_API_PROVIDER_BASE_URL=http://127.0.0.1:${PROVIDER_RELAY_PORT} \
META_CLOUD_API_PROVIDER_TOKEN=${META_CLOUD_API_PROVIDER_TOKEN} \
WHATSAPP_CALL_BRIDGE_TOKEN=${WHATSAPP_CALL_BRIDGE_TOKEN} \
pnpm dev:call-bridge:worker:meta-relay"

  open_terminal \
    "Client" \
    "$ROOT_DIR/client" \
    "pnpm run dev"

  open_terminal \
    "ngrok" \
    "$ROOT_DIR" \
    "$NGROK_COMMAND"
fi

cat <<EOF

Local KasiTek stack launched.

Included:
- LiveKit
- kasitek-calls
- kasitek-core
- call bridge
- provider relay
- provider worker
- client
- ngrok

Excluded by design:
- tenant services
- admin client

Expected local endpoints:
- LiveKit: ${LIVEKIT_URL}
- KasiTek Core: http://127.0.0.1:${KASITEK_CORE_PORT}
- KasiTek Calls: http://127.0.0.1:${KASITEK_CALLS_PORT}
- Call Bridge: http://127.0.0.1:${CALL_BRIDGE_PORT}
- Provider Relay: http://127.0.0.1:${PROVIDER_RELAY_PORT}

If you need different ports or secrets, export them before running this script.
EOF
