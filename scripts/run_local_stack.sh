#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/sync_dotenv_vaults.sh" pull

LIVEKIT_DEV_COMMAND="${LIVEKIT_DEV_COMMAND:-livekit-server --dev --bind 0.0.0.0}"

NGROK_COMMAND="${NGROK_COMMAND:-ngrok http 4000}"

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

launch_services() {
  local -a specs=(
    "LiveKit|$ROOT_DIR|$LIVEKIT_DEV_COMMAND"
    "KasiTek Tenants|$ROOT_DIR/server/kasitek-tenants|cargo run"
    "KasiTek Calls|$ROOT_DIR/server/kasitek-calls|cargo run"
    "KasiTek Core|$ROOT_DIR/server/kasitek-core|cargo run"
    "Call Bridge|$ROOT_DIR/client|pnpm dev:call-bridge"
    "Provider Relay|$ROOT_DIR/client|pnpm --filter call-bridge provider:meta-livekit-relay"
    "Provider Worker|$ROOT_DIR/client|pnpm dev:call-bridge:worker:meta-relay"
    "Client|$ROOT_DIR/client|pnpm run dev"
    "Admin|$ROOT_DIR/client|pnpm dev:admin"
    "Tenant Portal|$ROOT_DIR/client|pnpm --filter tenant-portal dev"
    "ngrok|$ROOT_DIR|$NGROK_COMMAND"
  )

  if [[ "$TERMINAL_BIN" == "gnome-terminal" ]]; then
    local -a args=()
    local first=1
    for spec in "${specs[@]}"; do
      IFS='|' read -r title workdir command <<<"$spec"
      if [[ "$first" -eq 1 ]]; then
        args+=(
          --window
          --title="$title"
          --working-directory="$workdir"
          -- bash -lc "$command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
        )
        first=0
      else
        args+=(
          --tab
          --title="$title"
          --working-directory="$workdir"
          -- bash -lc "$command; printf '\n[%s] exited. Press Enter to close...' '$title'; read -r _"
        )
      fi
    done
    gnome-terminal "${args[@]}"
  else
    for spec in "${specs[@]}"; do
      IFS='|' read -r title workdir command <<<"$spec"
      open_terminal "$title" "$workdir" "$command"
    done
  fi
}

launch_services
