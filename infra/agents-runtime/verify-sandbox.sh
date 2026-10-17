#!/usr/bin/env bash
set -euo pipefail
sandbox_root=$(cd "$(dirname "$0")/../.." && pwd)
sandbox_container=""
cleanup(){ if [[ -n "$sandbox_container" ]];then docker rm -f "$sandbox_container" >/dev/null 2>&1 || true;fi; }
trap cleanup EXIT
if [[ ! -x "$HOME/.cache/kasitek-agents-sandbox/gvisor/runsc" || ! -f "$HOME/.cache/kasitek-agents-sandbox/python-rootfs/usr/local/bin/python3.12" ]];then bash "$sandbox_root/infra/agents-runtime/prepare-sandbox.sh";fi
if [[ -z "${AGENTS_TEST_DATABASE_URL:-}" ]];then
  sandbox_container="kasitek-sandbox-check-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:12])')"
  sandbox_password=$(python3 -c 'import secrets;print(secrets.token_hex(24))')
  docker run --detach --name "$sandbox_container" --publish 127.0.0.1::5432 --env "POSTGRES_PASSWORD=$sandbox_password" postgres:17.6 >/dev/null
  sandbox_port=$(docker port "$sandbox_container" 5432/tcp|sed 's/.*://')
  export AGENTS_TEST_DATABASE_URL="postgresql://postgres:$sandbox_password@127.0.0.1:$sandbox_port/postgres"
  for sandbox_attempt in {1..100};do if docker exec "$sandbox_container" pg_isready -U postgres >/dev/null 2>&1;then break;fi;sleep .1;done
fi
cd "$sandbox_root/products/agents/api"
AGENTS_SANDBOX_VERIFY=1 "${NODE_BINARY:-node}" node_modules/vitest/vitest.mjs run test/platform-sandbox.test.ts
