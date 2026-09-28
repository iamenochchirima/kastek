#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The local stack is intentionally self-contained. Cloud Temporal remains an
# explicit opt-in for environments that set TEMPORAL_MODE=cloud.
TEMPORAL_MODE="${TEMPORAL_MODE:-local}"
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
CORE_ENV_SETUP="if [[ -f '$ROOT_DIR/server/kasitek-core/.env' ]]; then set -a; source '$ROOT_DIR/server/kasitek-core/.env'; set +a; fi"
# Tenants has its own local environment file. The local launcher must not use
# the generic DATABASE_URL fallback: the merged env file can contain Core or
# hosted credentials. A process-local override is resolved below instead.
TENANT_LOCAL_ENV_FILE="/tmp/kasitek-tenant-database-${UID}.env"
TENANT_LOCAL_ENV_SETUP="if [[ -f '$TENANT_LOCAL_ENV_FILE' ]]; then set -a; source '$TENANT_LOCAL_ENV_FILE'; set +a; fi"
TENANTS_ENV_SETUP="if [[ -f '$ROOT_DIR/server/kasitek-tenants/.env' ]]; then set -a; source '$ROOT_DIR/server/kasitek-tenants/.env'; set +a; fi; $TENANT_LOCAL_ENV_SETUP"
TENANT_PORTAL_ENV_SETUP="if [[ -f '$ROOT_DIR/client/apps/tenant-portal/.env' ]]; then set -a; source '$ROOT_DIR/client/apps/tenant-portal/.env'; set +a; fi; if [[ -f '$ROOT_DIR/client/apps/tenant-portal/.env.local' ]]; then set -a; source '$ROOT_DIR/client/apps/tenant-portal/.env.local'; set +a; fi"

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
declare -a tenant_services=(tenant-api tenant-portal)
tenant_database_required=false

# Define all available services
services["core"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_AGENTS_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' cargo run"
services["tenant-api"]="$ROOT_DIR/server/kasitek-tenants|$TENANTS_ENV_SETUP; LOG_COLOR=always cargo run"
services["tenant-portal"]="$ROOT_DIR/client/apps/tenant-portal|$TENANT_PORTAL_ENV_SETUP; TENANT_BACKEND_URL=\"\${TENANT_BACKEND_URL:-http://127.0.0.1:8090}\" pnpm dev"
services["core-analytics-publisher"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-publisher cargo run"
services["core-analytics-backfill"]="$ROOT_DIR/server/kasitek-core|$CORE_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-backfill-worker cargo run"
services["tenants-analytics-publisher"]="$ROOT_DIR/server/kasitek-tenants|$TENANTS_ENV_SETUP; LOG_COLOR=always KASITEK_PROCESS=analytics-publisher cargo run"
services["agent-analytics-publisher"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; pnpm run dev:analytics-publisher"
services["agents-api"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; KASITEK_CORE_URL='$LOCAL_CORE_URL' KASITEK_CORE_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' $AGENT_TEMPORAL_ENV pnpm run dev:api"
services["agents-worker"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; KASITEK_CORE_URL='$LOCAL_CORE_URL' KASITEK_CORE_INTERNAL_TOKEN='$LOCAL_CORE_AGENT_TOKEN' $AGENT_TEMPORAL_ENV pnpm run dev:worker"
services["agent-gateway"]="$ROOT_DIR/agents|$AGENT_ENV_SETUP; pnpm run dev:gateway"
services["client"]="$ROOT_DIR/client|pnpm run dev"
services["admin"]="$ROOT_DIR/client|pnpm dev:admin"
services["labs"]="$ROOT_DIR/client|pnpm --filter labs dev"
services["internal-docs"]="$ROOT_DIR/docs/internal-site|pnpm dev"

if [[ "$TEMPORAL_MODE" == "local" ]]; then
  services["temporal"]="$ROOT_DIR|temporal server start-dev --db-filename '$ROOT_DIR/.local/temporal.sqlite'"
fi

service_port() {
  case "$1" in
    core) echo 4000 ;;
    tenant-api) echo 8090 ;;
    tenant-portal) echo 3010 ;;
    agents-api) echo 4100 ;;
    agent-gateway) echo 4200 ;;
    client) echo 3000 ;;
    admin) echo 3001 ;;
    labs) echo 3007 ;;
    internal-docs) echo 3006 ;;
    temporal) echo 7233 ;;
  esac
}

is_tenant_group() {
  [[ "$1" == "tenant" || "$1" == "tenants" ]]
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

  if [[ "$name" == "tenant-api" ]]; then
    tenant_database_required=true
  fi

  add_tab "$name" "$dir" "$cmd"
}

add_tenant_services() {
  local service
  for service in "${tenant_services[@]}"; do
    add_service "$service"
  done
}

read_env_value() {
  local env_file="$1"
  local variable_name="$2"

  [[ -f "$env_file" ]] || return 0
  (
    set -a
    source "$env_file"
    set +a
    printf '%s' "${!variable_name:-}"
  )
}

url_is_loopback() {
  local url="$1"
  local rest authority hostport host

  [[ "$url" == *://* ]] || return 1
  rest="${url#*://}"
  authority="${rest%%/*}"
  hostport="${authority##*@}"
  if [[ "$hostport" == \[*\]* ]]; then
    host="${hostport%%]*}]"
  else
    host="${hostport%%:*}"
  fi

  case "$host" in
    localhost|127.*|::1|\[::1\]) return 0 ;;
    *) return 1 ;;
  esac
}

replace_database_name() {
  local url="$1"
  local query=""
  local base="${url%%\?*}"

  if [[ "$url" == *\?* ]]; then
    query="?${url#*\?}"
  fi

  printf '%s/postgres%s' "${base%/*}" "$query"
}

derive_database_name() {
  local url="${1%%\?*}"
  local database_name="${url##*/}"
  printf '%s' "$database_name"
}

derive_local_tenant_database_url() {
  local url="$1"
  local query=""
  local base="${url%%\?*}"

  if [[ "$url" == *\?* ]]; then
    query="?${url#*\?}"
  fi

  printf '%s/kasitek_tenants%s' "${base%/*}" "$query"
}

write_local_tenant_database_env() {
  local database_url="$1"

  umask 077
  {
    printf 'export KASITEK_TENANTS_DATABASE_URL=%q\n' "$database_url"
    printf 'export TENANT_DATABASE_URL=%q\n' "$database_url"
  } > "$TENANT_LOCAL_ENV_FILE"
  chmod 600 "$TENANT_LOCAL_ENV_FILE"
}

prepare_local_tenant_database() {
  local database_url="${KASITEK_LOCAL_TENANT_DATABASE_URL:-}"
  local explicit_database_url=false
  local tenant_env_file="$ROOT_DIR/server/kasitek-tenants/.env"
  local agents_env_file="$ROOT_DIR/agents/.env"
  local agent_database_url
  local maintenance_url
  local database_name
  local database_exists

  if [[ -z "$database_url" ]]; then
    database_url="${KASITEK_TENANTS_DATABASE_URL:-${TENANT_DATABASE_URL:-}}"
  fi
  if [[ -z "$database_url" ]]; then
    database_url="$(read_env_value "$tenant_env_file" KASITEK_TENANTS_DATABASE_URL)"
  fi
  if [[ -z "$database_url" ]]; then
    database_url="$(read_env_value "$tenant_env_file" TENANT_DATABASE_URL)"
  fi

  if [[ -n "$database_url" ]]; then
    explicit_database_url=true
  else
    agent_database_url="${AGENTS_DATABASE_URL:-}"
    if [[ -z "$agent_database_url" ]]; then
      agent_database_url="$(read_env_value "$agents_env_file" AGENTS_DATABASE_URL)"
    fi
    if [[ -z "$agent_database_url" ]]; then
      echo "Tenant local database is not configured." >&2
      echo "Set KASITEK_LOCAL_TENANT_DATABASE_URL or provide a local AGENTS_DATABASE_URL." >&2
      exit 1
    fi
    if ! url_is_loopback "$agent_database_url"; then
      echo "Refusing to derive the Tenant database from a non-local AGENTS_DATABASE_URL." >&2
      echo "Set KASITEK_LOCAL_TENANT_DATABASE_URL to a loopback PostgreSQL URL." >&2
      exit 1
    fi
    database_url="$(derive_local_tenant_database_url "$agent_database_url")"
  fi

  if ! url_is_loopback "$database_url"; then
    echo "Refusing non-local Tenant database URL for the local stack." >&2
    if [[ "$explicit_database_url" == true ]]; then
      echo "Set KASITEK_LOCAL_TENANT_DATABASE_URL to a loopback PostgreSQL URL." >&2
    fi
    exit 1
  fi

  require_command psql
  maintenance_url="$(replace_database_name "$database_url")"
  database_name="$(derive_database_name "$database_url")"

  if ! PGCONNECT_TIMEOUT=5 psql "$database_url" -X -w -Atqc 'select 1' >/dev/null 2>&1; then
    if ! PGCONNECT_TIMEOUT=5 psql "$maintenance_url" -X -w -Atqc 'select 1' >/dev/null 2>&1; then
      echo "Local PostgreSQL is not accepting the Tenant database connection." >&2
      echo "Checked loopback PostgreSQL for database '$database_name'." >&2
      exit 1
    fi

    if [[ "$database_name" != "kasitek_tenants" ]]; then
      echo "Local Tenant database '$database_name' is not accepting connections." >&2
      echo "Create it or set KASITEK_LOCAL_TENANT_DATABASE_URL to kasitek_tenants." >&2
      exit 1
    fi

    database_exists="$(psql "$maintenance_url" -X -w -Atqc "select 1 from pg_database where datname = 'kasitek_tenants'" 2>/dev/null || true)"
    if [[ "$database_exists" != "1" ]]; then
      if ! psql "$maintenance_url" -X -w -q -c 'create database kasitek_tenants' >/dev/null 2>&1; then
        echo "Unable to create local Tenant database 'kasitek_tenants'." >&2
        echo "Create it with the configured local PostgreSQL role, then rerun this command." >&2
        exit 1
      fi
      echo "Created local Tenant database 'kasitek_tenants'."
    fi

    if ! PGCONNECT_TIMEOUT=5 psql "$database_url" -X -w -Atqc 'select 1' >/dev/null 2>&1; then
      echo "Local Tenant database '$database_name' is not accepting connections." >&2
      exit 1
    fi
  fi

  write_local_tenant_database_env "$database_url"
  echo "Using local Tenant database '$database_name'."
}

show_usage() {
  echo "Usage: $0 [service|group ...]"
  echo "       $0 restart <service|group> [service|group ...]"
  echo ""
  echo "Available services:"
  for service in "${!services[@]}"; do
    echo "  - $service"
  done | sort
  echo ""
  echo "Service groups:"
  echo "  - tenants (alias: tenant)  Tenant API and tenant portal"
  echo ""
  echo "Examples:"
  echo "  $0                    # Run all services"
  echo "  $0 tenants            # Run only the Tenant API and tenant portal"
  echo "  $0 tenant-api         # Run only the Tenant API"
  echo "  $0 tenant-portal      # Run only the tenant portal"
  echo "  $0 core               # Run the Core API, including Calls"
  echo "  $0 core client        # Run the Core API and client"
  echo "  $0 internal-docs      # Run the internal documentation site"
  echo "  $0 core-analytics-publisher tenants-analytics-publisher agent-analytics-publisher # Run source publishers"
  echo "  $0 core-analytics-backfill # Run Core source reconstruction separately"
  echo "  $0 restart core       # Restart only the Core API"
  echo "  $0 restart client     # Restart only the direct client app"
  echo ""
}

# Parse command line arguments
if [[ $# -eq 0 ]]; then
  # No arguments - run all services
  services_to_start=(core tenant-api agents-api agents-worker agent-gateway client admin labs internal-docs)
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
  for requested in "$@"; do
    if is_tenant_group "$requested"; then
      for service in "${tenant_services[@]}"; do
        stop_service "$service"
        add_service "$service"
      done
    else
      if [[ -z "${services[$requested]:-}" ]]; then
        echo "Error: Unknown service '$requested'" >&2
        echo "Available services: ${!services[*]}" >&2
        exit 1
      fi
      stop_service "$requested"
      add_service "$requested"
    fi
  done
else
  # Run specified services or groups
  for requested in "$@"; do
    if is_tenant_group "$requested"; then
      add_tenant_services
    else
      add_service "$requested"
    fi
  done
fi

if [[ ${#tabs[@]} -eq 0 ]]; then
  echo "Error: No services to launch" >&2
  exit 1
fi

if [[ "$tenant_database_required" == true ]]; then
  prepare_local_tenant_database
fi

echo "Launching local KasiTek stack..."
gnome-terminal "${tabs[@]}"
