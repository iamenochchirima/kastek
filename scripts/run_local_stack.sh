#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# "$ROOT_DIR/scripts/sync_dotenv_vaults.sh" pull

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Required command not found: $1" >&2
    exit 1
  fi
}

require_command cargo
require_command pnpm
require_command gnome-terminal

if ! command -v livekit-server >/dev/null 2>&1; then
  echo "Warning: livekit-server not found — the LiveKit tab will fail to start." >&2
fi

# Write a temp launcher script for each service to avoid gnome-terminal's
# argument parsing bug where '--' stops processing subsequent '--tab' flags.
make_launcher() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local script="/tmp/kasitek_${name}.sh"
  cat > "$script" <<SCRIPT
#!/usr/bin/env bash
cd '$dir'
$cmd
echo
echo "[$name] process exited. Press Enter to close."
read -r _
SCRIPT
  chmod +x "$script"
  echo "$script"
}

declare -a tabs=()

add_tab() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local script
  script="$(make_launcher "$name" "$dir" "$cmd")"
  tabs+=(--tab --title="$name" -e "bash $script")
}

add_tab "livekit"        "$ROOT_DIR"                        "livekit-server --dev --bind 0.0.0.0"
add_tab "core"           "$ROOT_DIR/server/kasitek-core"    "cargo run"
add_tab "calls"          "$ROOT_DIR/server/kasitek-calls"   "cargo run"
add_tab "tenants"        "$ROOT_DIR/server/kasitek-tenants" "cargo run"
add_tab "call-bridge"    "$ROOT_DIR/client"                 "pnpm dev:call-bridge"
add_tab "provider-relay" "$ROOT_DIR/client"                 "pnpm --filter call-bridge provider:meta-livekit-relay"
add_tab "client"         "$ROOT_DIR/client"                 "pnpm run dev"
add_tab "admin"          "$ROOT_DIR/client"                 "pnpm dev:admin"

echo "Launching local KasiTek stack..."
gnome-terminal "${tabs[@]}"
