#!/usr/bin/env bash
set -euo pipefail

storage_root=$(cd "$(dirname "$0")/../.." && pwd)
storage_temp=$(mktemp -d /tmp/kasitek-storage-check.XXXXXX)
storage_container=""
storage_pid=""
cleanup() {
  if [[ -n "$storage_pid" ]]; then kill "$storage_pid" 2>/dev/null || true; wait "$storage_pid" 2>/dev/null || true; fi
  if [[ -n "$storage_container" ]]; then docker rm -f "$storage_container" >/dev/null 2>&1 || true; fi
  rm -rf "$storage_temp"
}
trap cleanup EXIT
storage_node=${NODE_BINARY:-node}
command -v "$storage_node" >/dev/null || { echo 'Node 24 is required; set NODE_BINARY.' >&2; exit 1; }
if [[ -n "${AGENTS_TEST_MINIO_BINARY:-}" ]]; then
  storage_binary=$AGENTS_TEST_MINIO_BINARY
else
  curl --fail --silent --show-error --location --max-time 120 https://go.dev/dl/go1.26.9.linux-amd64.tar.gz -o "$storage_temp/go.tar.gz"
  curl --fail --silent --show-error --location --max-time 120 https://github.com/minio/minio/archive/refs/tags/RELEASE.2025-09-07T16-13-09Z.tar.gz -o "$storage_temp/minio.tar.gz"
  python3 - "$storage_temp" <<'PY'
import hashlib,pathlib,sys,tarfile
root=pathlib.Path(sys.argv[1])
for name,checksum in [('go.tar.gz','42d158b4d8f7b61ac0a830567c940a86098fb7aac52e467a5ebec03ef5cc2f8d'),('minio.tar.gz','c9598dcce3440977e79f787f2ba0e7e4d92c8d556bd51e7cef3785bafd6635f3')]:
    data=root/name
    if hashlib.sha256(data.read_bytes()).hexdigest()!=checksum: raise SystemExit(f'Checksum mismatch: {name}')
    with tarfile.open(data) as archive: archive.extractall(root,filter='data')
PY
  (cd "$storage_temp/minio-RELEASE.2025-09-07T16-13-09Z" && GOTOOLCHAIN=local GOMAXPROCS=4 "$storage_temp/go/bin/go" build -p 4 -o "$storage_temp/minio" .)
  storage_binary="$storage_temp/minio"
fi
storage_port=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(('127.0.0.1',0));print(sock.getsockname()[1])
PY
)
export AGENTS_TEST_S3_ACCESS_KEY_ID=storage-verification
AGENTS_TEST_S3_SECRET_ACCESS_KEY=$(python3 -c 'import secrets;print(secrets.token_hex(24))')
export AGENTS_TEST_S3_SECRET_ACCESS_KEY
export AGENTS_TEST_S3_ENDPOINT="http://127.0.0.1:$storage_port"
MINIO_ROOT_USER=$AGENTS_TEST_S3_ACCESS_KEY_ID MINIO_ROOT_PASSWORD=$AGENTS_TEST_S3_SECRET_ACCESS_KEY MINIO_BROWSER=off \
  "$storage_binary" server "$storage_temp/data" --address "127.0.0.1:$storage_port" --console-address 127.0.0.1:0 >"$storage_temp/minio.log" 2>&1 &
storage_pid=$!
python3 - "$AGENTS_TEST_S3_ENDPOINT" <<'PY'
import sys,time,urllib.request
for attempt in range(100):
    try:
        urllib.request.urlopen(sys.argv[1]+'/minio/health/ready',timeout=1).close();break
    except Exception:time.sleep(.1)
else:raise SystemExit('MinIO did not become ready')
PY
if [[ -z "${AGENTS_TEST_DATABASE_URL:-}" ]]; then
  storage_container="kasitek-storage-pg-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:12])')"
  storage_db_password=$(python3 -c 'import secrets;print(secrets.token_hex(24))')
  docker run --detach --name "$storage_container" --publish 127.0.0.1::5432 --env "POSTGRES_PASSWORD=$storage_db_password" postgres:17.6 >/dev/null
  storage_db_port=$(docker port "$storage_container" 5432/tcp | sed 's/.*://')
  export AGENTS_TEST_DATABASE_URL="postgresql://postgres:$storage_db_password@127.0.0.1:$storage_db_port/postgres"
  for storage_attempt in {1..100}; do
    if docker exec "$storage_container" pg_isready -U postgres >/dev/null 2>&1; then break; fi
    sleep .1
  done
fi
cd "$storage_root/products/agents/api"
"$storage_node" node_modules/vitest/vitest.mjs run test/platform-memory.test.ts test/platform-artifacts.test.ts
