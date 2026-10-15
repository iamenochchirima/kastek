#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repo_root/scripts/node24.sh"
kasitek_use_node24
workspace_root="$(cd "$repo_root/../.." && pwd)"
core_root="$repo_root/server/kasitek-core"
cd "$core_root"
# Runtime bundles can put a newer pnpm before the project's installed tooling.
# A temporary shim pins workspace commands without changing global tools.
if [[ "$(pnpm --version)" != 10.30.1 ]]; then
  command -v corepack >/dev/null || { echo "pnpm 10.30.1 or Corepack is required" >&2; exit 1; }
  shim_dir="$(mktemp -d)"
  trap 'rm -rf "$shim_dir"' EXIT
  printf '%s\n' '#!/usr/bin/env bash' 'exec corepack pnpm "$@"' > "$shim_dir/pnpm"
  chmod +x "$shim_dir/pnpm"
  export PATH="$shim_dir:$PATH"
fi
[[ "$(pnpm --version)" == 10.30.1 ]] || { echo "Use pnpm 10.30.1" >&2; exit 1; }
if [[ $# -gt 0 ]]; then
  echo "Usage: $0. Shared packages now come from this workspace." >&2
  exit 1
fi
pnpm --dir "$workspace_root" install --frozen-lockfile
pnpm --dir "$workspace_root" build:shared
cd "$core_root"
pnpm build
# These checks need no database, customer accounts or live providers.
pnpm exec tsx --test tests/foundation.test.ts tests/agent-platform-client.test.ts tests/observability.test.ts
