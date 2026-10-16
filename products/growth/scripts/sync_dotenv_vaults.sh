#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ROOT_VAULT_ENV="$ROOT_DIR/.env"
ROOT_LOCAL_ENV="$ROOT_DIR/.env.local"

declare -a SOURCE_ENV_FILES=(
  ".env.local"
  "api/.env"
  "web/.env.local"
)

declare -a GENERATED_ENV_FILES=(
  ".env.local"
  "api/.env"
  "web/.env"
  "web/.env.local"
)

usage() {
  cat <<'EOF'
Usage:
  ./scripts/sync_dotenv_vaults.sh login
  ./scripts/sync_dotenv_vaults.sh pull
  ./scripts/sync_dotenv_vaults.sh push
  ./scripts/sync_dotenv_vaults.sh status

The root .env is the vault-backed merged source of truth.
`push` merges all local env files into the root .env, then pushes that file to
dotenv-vault.
`pull` downloads the merged root .env from dotenv-vault, then fans it back out
into the local service env files.
EOF
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    exit 1
  fi
}

require_command npx
require_command node

assert_root_vault_ready() {
  if [[ ! -f "$ROOT_DIR/.env.vault" ]]; then
    echo "Missing root .env.vault. Run the dotenv-vault bootstrap first." >&2
    exit 1
  fi
  if [[ ! -f "$ROOT_DIR/.env.me" ]]; then
    echo "Missing root .env.me. Run dotenv-vault login first." >&2
    exit 1
  fi
}

merge_sources_into_root_env() {
  local tmp_file
  tmp_file="$(mktemp)"

  node - "$ROOT_DIR" "$tmp_file" "${SOURCE_ENV_FILES[@]}" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');

const rootDir = process.argv[2];
const outFile = process.argv[3];
const sourceFiles = process.argv.slice(4);

const orderedKeys = [];
const values = new Map();
const owners = new Map();

for (const rel of sourceFiles) {
  const file = path.join(rootDir, rel);
  if (!fs.existsSync(file)) continue;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;

    const eq = line.indexOf('=');
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1);

    if (!values.has(key)) orderedKeys.push(key);
    values.set(key, value);
    owners.set(key, rel);
  }
}

const output = [
  '# merged by scripts/sync_dotenv_vaults.sh',
  '# source files:',
  ...sourceFiles.map((file) => `# - ${file}`),
  '',
];

for (const key of orderedKeys) {
  output.push(`${key}=${values.get(key)}`);
}

output.push('');
fs.writeFileSync(outFile, output.join('\n'));
NODE

  mv "$tmp_file" "$ROOT_VAULT_ENV"
}

copy_root_env_to_targets() {
  for rel in "${GENERATED_ENV_FILES[@]}"; do
    local dest="$ROOT_DIR/$rel"
    mkdir -p "$(dirname "$dest")"
    cp "$ROOT_VAULT_ENV" "$dest"
  done
}

ensure_root_env_present() {
  if [[ ! -f "$ROOT_VAULT_ENV" ]]; then
    echo "Missing root .env. Run dotenv-vault pull first." >&2
    exit 1
  fi
}

status_file() {
  local rel="$1"
  local full="$ROOT_DIR/$rel"
  if [[ -f "$full" ]]; then
    echo "$rel=present"
  else
    echo "$rel=missing"
  fi
}

case "${1:-}" in
  login)
    assert_root_vault_ready
    (cd "$ROOT_DIR" && npx -y dotenv-vault@latest login -y)
    ;;
  pull)
    assert_root_vault_ready
    (cd "$ROOT_DIR" && npx -y dotenv-vault@latest pull -y development .env)
    copy_root_env_to_targets
    ;;
  push)
    assert_root_vault_ready
    merge_sources_into_root_env
    (cd "$ROOT_DIR" && npx -y dotenv-vault@latest push -y development .env)
    ;;
  status)
    echo "root .env.vault: $([[ -f "$ROOT_DIR/.env.vault" ]] && echo present || echo missing)"
    echo "root .env.me: $([[ -f "$ROOT_DIR/.env.me" ]] && echo present || echo missing)"
    echo "root .env: $([[ -f "$ROOT_VAULT_ENV" ]] && echo present || echo missing)"
    for rel in "${SOURCE_ENV_FILES[@]}"; do
      status_file "$rel"
    done
    for rel in "${GENERATED_ENV_FILES[@]}"; do
      status_file "$rel"
    done
    ;;
  *)
    usage
    exit 1
    ;;
esac
