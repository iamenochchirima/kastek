#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

CORE_ENV_SETUP="if [[ -f '$ROOT_DIR/server/kasitek-core/.env' ]]; then set -a; source '$ROOT_DIR/server/kasitek-core/.env'; set +a; fi"
# Core's local authenticated Agent bridge uses this development-only token.
# Production deployments must use per-invocation delegation keys instead.
LOCAL_CORE_AGENT_TOKEN="${KASITEK_LOCAL_CORE_AGENT_TOKEN:-kasitek-local-agent-boundary-dev-2026}"

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
services["core"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_AGENTS_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' cargo run"
services["core-analytics-publisher"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-publisher cargo run"
services["core-analytics-backfill"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-backfill-worker cargo run"
services["client"]="$ROOT_DIR/client|pnpm run dev"
services["internal-docs"]="$ROOT_DIR/docs/internal-site|pnpm dev"

service_port() {
  case "$1" in
    core) echo 4000 ;;
    client) echo 3000 ;;
    internal-docs) echo 3006 ;;
  esac
}

stop_process_tree() {
  local process_id="$1"
  local child_id

  while IFS= read -r child_id; do
    [[ -n "$child_id" ]] && stop_process_tree "$child_id"
  done < <(pgrep -P "$process_id" 2>/dev/null || true)

  kill -TERM "$process_id" 2>/dev/null || true
}

stop_service() {
  local name="$1"
  local launcher="/tmp/kasitek_${name}.sh"
  local found=false
  local process_id

  # Services started by this script have a dedicated launcher. Stop its
  # descendants first so a restart never terminates another local service.
  while IFS= read -r process_id; do
    [[ -z "$process_id" ]] && continue
    stop_process_tree "$process_id"
    found=true
  done < <(pgrep -f "^bash ${launcher}$" 2>/dev/null || true)

  local port
  port="$(service_port "$name")"
  if [[ -n "$port" ]]; then
    require_command lsof
    while IFS= read -r process_id; do
      [[ -z "$process_id" ]] && continue
      stop_process_tree "$process_id"
      found=true
    done < <(lsof -tiTCP:"$port" -sTCP:LISTEN 2>/dev/null || true)
  fi

  if [[ "$found" == true ]]; then
    echo "Stopped $name."
  else
    echo "No running $name service found; starting it."
  fi
}

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
  echo "Usage: $0 [service ...]"
  echo "       $0 restart <service ...>"
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
  echo "  $0 internal-docs      # Run the internal documentation site"
  echo "  $0 core-analytics-publisher # Run the Core source publisher"
  echo "  $0 core-analytics-backfill # Run Core source reconstruction separately"
  echo "  $0 restart core       # Restart only the Core API"
  echo "  $0 restart client     # Restart only the direct client app"
  echo ""
}

# Parse command line arguments
if [[ $# -eq 0 ]]; then
  # No arguments - run all services
  services_to_start=(core client internal-docs)
  for service in "${services_to_start[@]}"; do
    add_service "$service"
  done
elif [[ "$1" == "-h" ]] || [[ "$1" == "--help" ]]; then
  show_usage
  exit 0
elif [[ "$1" == "restart" ]]; then
  shift
  if [[ $# -eq 0 ]]; then
    echo "Error: Specify at least one service to restart." >&2
    exit 1
  fi
  for requested in "$@"; do
    if [[ -z "${services[$requested]:-}" ]]; then
      echo "Error: Unknown service '$requested'" >&2
      echo "Available services: ${!services[*]}" >&2
      exit 1
    fi
    stop_service "$requested"
    add_service "$requested"
  done
else
  # Run specified services
  for requested in "$@"; do
    add_service "$requested"
  done
fi

if [[ ${#tabs[@]} -eq 0 ]]; then
  echo "Error: No services to launch" >&2
  exit 1
fi

echo "Launching local KasiTek stack..."
gnome-terminal "${tabs[@]}"
