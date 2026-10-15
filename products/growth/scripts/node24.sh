#!/usr/bin/env bash

# Select the project's installed runtime in this shell only. Never change nvm's default.
kasitek_use_node24() {
  local major=""
  if command -v node >/dev/null 2>&1; then
    major="$(node -p 'process.versions.node.split(".")[0]')"
  fi
  if [[ "$major" != 24 && -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]]; then
    # shellcheck source=/dev/null
    source "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
    nvm use --silent 24 >/dev/null 2>&1 || true
  fi
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'process.versions.node.split(".")[0]')" != 24 ]]; then
    echo "Node.js 24 is required. Install/select the version in .nvmrc, then retry." >&2
    return 1
  fi
}
