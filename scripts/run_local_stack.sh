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
require_command curl

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
declare -A services

# Define all available services
services["core"]="$ROOT_DIR/server/kasitek-core|cargo run"
services["calls"]="$ROOT_DIR/server/kasitek-calls|cargo run"
services["tenants"]="$ROOT_DIR/server/kasitek-tenants|cargo run"
services["client"]="$ROOT_DIR/client|pnpm run dev"
services["admin"]="$ROOT_DIR/client|pnpm dev:admin"
services["labs"]="$ROOT_DIR/client|pnpm --filter labs dev"
services["ngrok"]="$ROOT_DIR|ngrok http http://localhost:4000"

add_tab() {
  local name="$1"
  local dir="$2"
  local cmd="$3"
  local script
  script="$(make_launcher "$name" "$dir" "$cmd")"
  tabs+=(--tab --title="$name" -e "bash $script")
}

add_service() {
  local name="$1"

  # Special handling for ngrok
  if [[ "$name" == "ngrok" ]]; then
    if pgrep -x ngrok > /dev/null; then
      echo "ngrok is already running, skipping..."
      return
    fi
  fi

  if [[ -z "${services[$name]:-}" ]]; then
    echo "Error: Unknown service '$name'" >&2
    echo "Available services: ${!services[*]}" >&2
    exit 1
  fi

  local service_def="${services[$name]}"
  local dir="${service_def%%|*}"
  local cmd="${service_def#*|}"

  add_tab "$name" "$dir" "$cmd"
}

show_usage() {
  echo "Usage: $0 [service1 service2 ...]"
  echo ""
  echo "Available services:"
  for service in "${!services[@]}"; do
    echo "  - $service"
  done | sort
  echo ""
  echo "Examples:"
  echo "  $0                    # Run all services"
  echo "  $0 calls              # Run only the calls service"
  echo "  $0 core calls client  # Run core, calls, and client"
  echo ""
}

# Parse command line arguments
if [[ $# -eq 0 ]]; then
  # No arguments - run all services
  for service in core calls tenants client admin labs ngrok; do
    add_service "$service"
  done
elif [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
  show_usage
  exit 0
else
  # Run specified services
  for service in "$@"; do
    add_service "$service"
  done
fi

if [[ ${#tabs[@]} -eq 0 ]]; then
  echo "Error: No services to launch" >&2
  exit 1
fi

echo "Launching local KasiTek stack..."
gnome-terminal "${tabs[@]}"
