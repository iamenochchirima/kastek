#!/usr/bin/env bash
set -euo pipefail
identity_repo=$(cd "$(dirname "$0")/../.." && pwd)
identity_node=${NODE_BINARY:-node}
if ! command -v "$identity_node" >/dev/null 2>&1; then
  echo 'Node 24 is required. Set NODE_BINARY to its executable path.' >&2
  exit 1
fi
if [[ $("$identity_node" -p 'process.versions.node.split(".")[0]') != 24 ]]; then
  echo 'Identity verification requires Node 24.' >&2
  exit 1
fi
command -v docker >/dev/null
cd "$identity_repo/products/agents/api"
if [[ -z ${AGENTS_PLAYWRIGHT_MODULE:-} ]]; then
  AGENTS_PLAYWRIGHT_MODULE=$("$identity_node" - <<'JS'
const path = require("node:path");
for (const candidate of ["playwright", path.resolve(path.dirname(process.execPath), "../node_modules/playwright")]) {
  try { process.stdout.write(require.resolve(candidate)); process.exit(0); } catch {}
}
process.stderr.write("Playwright is required. Set AGENTS_PLAYWRIGHT_MODULE to an installed module.\n");
process.exit(1);
JS
  )
  export AGENTS_PLAYWRIGHT_MODULE
fi
# AGENTS_TEST_DATABASE_URL may point to a disposable PostgreSQL instance. Otherwise the smoke starts its own.
exec "$identity_node" --import tsx test/platform-identity-smoke.ts
