#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

TEMPORAL_MODE="${TEMPORAL_MODE:-cloud}"
if [[ "$TEMPORAL_MODE" != "cloud" && "$TEMPORAL_MODE" != "local" ]]; then
  echo "Error: TEMPORAL_MODE must be cloud or local" >&2
  exit 1
fi

if [[ "$TEMPORAL_MODE" == "local" ]]; then
  mkdir -p "$ROOT_DIR/.local"
  AGENT_TEMPORAL_ENV="TEMPORAL_MODE=local TEMPORAL_ENABLED=true TEMPORAL_ADDRESS=localhost:7233 TEMPORAL_NAMESPACE=default TEMPORAL_API_KEY=''"
else
  AGENT_TEMPORAL_ENV="TEMPORAL_MODE=cloud TEMPORAL_ENABLED=true"
fi

AGENT_ENV_SETUP="if [[ -f '$ROOT_DIR/agents/.env' ]]; then set -a; source '$ROOT_DIR/agents/.env'; set +a; fi"

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
require_command ngrok

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
services["tenants"]="$ROOT_DIR/server/kasitek-tenants|cargo run"
services["agents-api"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; $AGENT_TEMPORAL_ENV pnpm run dev:api"
services["agents-worker"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; $AGENT_TEMPORAL_ENV pnpm run dev:worker"
services["client"]="$ROOT_DIR/client|pnpm run dev"
services["admin"]="$ROOT_DIR/client|pnpm dev:admin"
services["labs"]="$ROOT_DIR/client|pnpm --filter labs dev"
services["ngrok"]="$ROOT_DIR|ngrok http http://localhost:4000"
services["ngrok-client"]="$ROOT_DIR|ngrok http --url=curtis-pastureless-sickerly.ngrok-free.dev 3000"

if [[ "$TEMPORAL_MODE" == "local" ]]; then
  services["temporal"]="$ROOT_DIR|temporal server start-dev --db-filename '$ROOT_DIR/.local/temporal.sqlite'"
fi

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
  echo "  $0 core               # Run the Core API, including Calls"
  echo "  $0 core client        # Run the Core API and client"
  echo ""
}

# Parse command line arguments
if [[ $# -eq 0 ]]; then
  # No arguments - run all services
  services_to_start=(core tenants agents-api agents-worker client admin labs ngrok ngrok-client)
  if [[ "$TEMPORAL_MODE" == "local" ]]; then
    services_to_start+=(temporal)
  fi
  for service in "${services_to_start[@]}"; do
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
