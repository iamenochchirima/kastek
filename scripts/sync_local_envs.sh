#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT_DIR="$ROOT_DIR/local-envs"

declare -a SOURCE_DEST_PAIRS=(
  "$VAULT_DIR/kasitek-core.env:$ROOT_DIR/server/kasitek-core/.env"
  "$VAULT_DIR/kasitek-calls.env:$ROOT_DIR/server/kasitek-calls/.env"
  "$VAULT_DIR/call-bridge.env.local:$ROOT_DIR/client/apps/call-bridge/.env.local"
  "$VAULT_DIR/client.env.local:$ROOT_DIR/client/apps/client/.env.local"
)

usage() {
  cat <<'EOF'
Usage:
  scripts/sync_local_envs.sh pull
  scripts/sync_local_envs.sh push
  scripts/sync_local_envs.sh status

pull   Copy tracked local-envs files into the service-specific env files
push   Copy service-specific env files back into local-envs
status Show whether the tracked vault and working env files differ
EOF
}

require_vault() {
  if [[ ! -d "$VAULT_DIR" ]]; then
    echo "Missing vault directory: $VAULT_DIR" >&2
    exit 1
  fi
}

copy_file() {
  local src="$1"
  local dest="$2"
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
}

sync_pull() {
  require_vault
  for pair in "${SOURCE_DEST_PAIRS[@]}"; do
    local src="${pair%%:*}"
    local dest="${pair#*:}"
    copy_file "$src" "$dest"
    echo "pulled $(basename "$src") -> ${dest#"$ROOT_DIR"/}"
  done
}

sync_push() {
  require_vault
  for pair in "${SOURCE_DEST_PAIRS[@]}"; do
    local src="${pair%%:*}"
    local dest="${pair#*:}"
    if [[ ! -f "$dest" ]]; then
      echo "skipping missing working file: ${dest#"$ROOT_DIR"/}"
      continue
    fi
    copy_file "$dest" "$src"
    echo "pushed ${dest#"$ROOT_DIR"/} -> $(basename "$src")"
  done
}

sync_status() {
  require_vault
  local dirty=0
  for pair in "${SOURCE_DEST_PAIRS[@]}"; do
    local src="${pair%%:*}"
    local dest="${pair#*:}"
    if [[ ! -f "$src" || ! -f "$dest" ]]; then
      echo "missing: $(basename "$src") <-> ${dest#"$ROOT_DIR"/}"
      dirty=1
      continue
    fi
    if cmp -s "$src" "$dest"; then
      echo "ok: $(basename "$src")"
    else
      echo "diff: $(basename "$src")"
      dirty=1
    fi
  done
  return "$dirty"
}

main() {
  local command="${1:-pull}"
  case "$command" in
    pull)
      sync_pull
      ;;
    push)
      sync_push
      ;;
    status)
      sync_status
      ;;
    *)
      usage
      exit 1
      ;;
  esac
}

main "$@"
