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
ANALYTICS_ENV_SETUP="if [[ -f '$ROOT_DIR/server/kasitek-analytics/.env' ]]; then set -a; source '$ROOT_DIR/server/kasitek-analytics/.env'; set +a; fi"

# The local Agent Platform -> Core boundary uses the development bearer-token
# compatibility path. Keep one value on both processes so read and draft tools
# fail at startup configuration time rather than only when a user invokes one.
# Production deployments must use per-invocation delegation keys instead.
LOCAL_CORE_URL="${KASITEK_CORE_URL:-http://127.0.0.1:4000}"
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
require_command curl
require_command openssl

# Customer reporting is intentionally authenticated even on the local stack. Generate one
# process-local ES256 keypair and resolver credential when local credentials were not supplied;
# the exported values are inherited by both Core and Analytics, but are never written to the repo.
configure_local_analytics_reporting() {
  local missing=()
  [[ -n "${ANALYTICS_REPORTING_PRIVATE_KEY:-}" ]] || missing+=(ANALYTICS_REPORTING_PRIVATE_KEY)
  [[ -n "${ANALYTICS_REPORTING_PUBLIC_KEY:-}" ]] || missing+=(ANALYTICS_REPORTING_PUBLIC_KEY)
  [[ -n "${ANALYTICS_REPORTING_RESOLVER_TOKEN:-}" ]] || missing+=(ANALYTICS_REPORTING_RESOLVER_TOKEN)
  [[ -n "${ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON:-}" ]] || missing+=(ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON)

  if ((${#missing[@]} == 0)); then
    return
  fi

  if ((${#missing[@]} != 4)); then
    echo "Incomplete local Analytics reporting configuration; missing: ${missing[*]}" >&2
    echo "Set all four ANALYTICS_REPORTING_* values or remove the partial local configuration." >&2
    exit 1
  fi

  local private_key public_key resolver_token
  private_key="$(openssl ecparam -name prime256v1 -genkey -noout)"
  public_key="$(printf '%s\n' "$private_key" | openssl ec -pubout 2>/dev/null)"
  resolver_token="$(openssl rand -hex 32)"

  export ANALYTICS_REPORTING_PRIVATE_KEY="$private_key"
  export ANALYTICS_REPORTING_PUBLIC_KEY="$public_key"
  export ANALYTICS_REPORTING_RESOLVER_TOKEN="$resolver_token"
  export ANALYTICS_REPORTING_RESOLVER_CREDENTIALS_JSON="[{\"source_service\":\"core\",\"token\":\"$resolver_token\"}]"
  export ANALYTICS_REPORTING_KEY_ID="${ANALYTICS_REPORTING_KEY_ID:-local-reporting-2026}"
  export ANALYTICS_REPORTING_ISSUER="${ANALYTICS_REPORTING_ISSUER:-kasitek-core}"
  export ANALYTICS_REPORTING_AUDIENCE="${ANALYTICS_REPORTING_AUDIENCE:-kasitek-analytics-reporting}"
}

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
services["core"]="$ROOT_DIR/server/kasitek-core|$ANALYTICS_ENV_SETUP; LOG_COLOR=always KASITEK_AGENTS_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' cargo run"
services["tenants"]="$ROOT_DIR/server/kasitek-tenants|$ANALYTICS_ENV_SETUP; LOG_COLOR=always cargo run"
services["analytics-storage"]="$ROOT_DIR/server/kasitek-analytics|$ANALYTICS_ENV_SETUP; ./scripts/local-storage.sh"
services["analytics-migrate"]="$ROOT_DIR/server/kasitek-analytics|$ANALYTICS_ENV_SETUP; ./scripts/local-migrate.sh"
services["analytics-api"]="$ROOT_DIR/server/kasitek-analytics|$ANALYTICS_ENV_SETUP; ANALYTICS_DATABASE_URL=\"\${ANALYTICS_DATABASE_URL:-postgres://analytics:analytics_dev_password@127.0.0.1:5432/kasitek_analytics}\" ANALYTICS_REDIS_URL=\"\${ANALYTICS_REDIS_URL:-redis://127.0.0.1:6379}\" ANALYTICS_API_PORT=\"\${ANALYTICS_API_PORT:-4300}\" LOG_COLOR=always cargo run --bin analytics-api"
services["analytics-worker"]="$ROOT_DIR/server/kasitek-analytics|$ANALYTICS_ENV_SETUP; ANALYTICS_DATABASE_URL=\"\${ANALYTICS_DATABASE_URL:-postgres://analytics:analytics_dev_password@127.0.0.1:5432/kasitek_analytics}\" ANALYTICS_REDIS_URL=\"\${ANALYTICS_REDIS_URL:-redis://127.0.0.1:6379}\" LOG_COLOR=always cargo run --bin analytics-worker"
services["core-analytics-publisher"]="$ROOT_DIR/server/kasitek-core|$ANALYTICS_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-publisher cargo run"
services["core-analytics-backfill"]="$ROOT_DIR/server/kasitek-core|$ANALYTICS_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-backfill-worker cargo run"
services["tenants-analytics-publisher"]="$ROOT_DIR/server/kasitek-tenants|$ANALYTICS_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-publisher cargo run"
services["agent-analytics-publisher"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; pnpm run dev:analytics-publisher"
services["agents-api"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; KASITEK_CORE_URL='$LOCAL_CORE_URL' KASITEK_CORE_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' $AGENT_TEMPORAL_ENV pnpm run dev:api"
services["agents-worker"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; KASITEK_CORE_URL='$LOCAL_CORE_URL' KASITEK_CORE_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' $AGENT_TEMPORAL_ENV pnpm run dev:worker"
services["agent-gateway"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; pnpm run dev:gateway"
services["client"]="$ROOT_DIR/client|pnpm run dev"
services["admin"]="$ROOT_DIR/client|pnpm dev:admin"
services["labs"]="$ROOT_DIR/client|pnpm --filter labs dev"

if [[ "$TEMPORAL_MODE" == "local" ]]; then
  services["temporal"]="$ROOT_DIR|temporal server start-dev --db-filename '$ROOT_DIR/.local/temporal.sqlite'"
fi

service_port() {
  case "$1" in
    core) echo 4000 ;;
    tenants) echo 8090 ;;
    analytics-api) echo 4300 ;;
    agents-api) echo 4100 ;;
    agent-gateway) echo 4200 ;;
    client) echo 3000 ;;
    admin) echo 3001 ;;
    labs) echo 3007 ;;
    temporal) echo 7233 ;;
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
  echo "Usage: $0 [service1 service2 ...]"
  echo "       $0 restart <service1> [service2 ...]"
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
  echo "  $0 analytics-migrate # Apply Analytics migrations once"
  echo "  $0 analytics-worker  # Run the optional Analytics worker"
  echo "  $0 core-analytics-publisher tenants-analytics-publisher agent-analytics-publisher # Run source publishers"
  echo "  $0 core-analytics-backfill # Run Core source reconstruction separately"
  echo "  $0 restart core       # Restart only the Core API"
  echo "  $0 restart client     # Restart only the direct client app"
  echo ""
}

# Parse command line arguments
if [[ $# -eq 0 ]]; then
  # No arguments - run all services
  services_to_start=(core tenants analytics-api agents-api agents-worker agent-gateway client admin labs)
  if [[ "$TEMPORAL_MODE" == "local" ]]; then
    services_to_start+=(temporal)
  fi
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
  for service in "$@"; do
    if [[ -z "${services[$service]:-}" ]]; then
      echo "Error: Unknown service '$service'" >&2
      echo "Available services: ${!services[*]}" >&2
      exit 1
    fi
    stop_service "$service"
    add_service "$service"
  done
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

configure_local_analytics_reporting

echo "Launching local KasiTek stack..."
gnome-terminal "${tabs[@]}"
