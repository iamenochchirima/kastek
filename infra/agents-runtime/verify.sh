#!/usr/bin/env bash
set -euo pipefail

runtime_root=$(cd "$(dirname "$0")/../.." && pwd)
runtime_tmp=$(mktemp -d -t kasitek-restate-contract-XXXXXX)
trap 'rm -rf "$runtime_tmp"' EXIT

runtime_node=${NODE_BINARY:-node}
if ! command -v "$runtime_node" >/dev/null 2>&1; then
  echo 'Node 24 is required. Set NODE_BINARY to its executable path.' >&2
  exit 1
fi
"$runtime_node" --version

# Install only the two exact SDK artifacts in an isolated temporary directory.
python3 - "$runtime_tmp" <<'PY'
import base64, hashlib, io, json, pathlib, sys, tarfile, urllib.request

root = pathlib.Path(sys.argv[1]) / 'node_modules' / '@restatedev'
for package in ('restate-sdk', 'restate-sdk-core'):
    metadata_url = 'https://registry.npmjs.org/@restatedev%2f' + package + '/1.17.3'
    metadata = json.load(urllib.request.urlopen(metadata_url, timeout=30))
    archive = urllib.request.urlopen(metadata['dist']['tarball'], timeout=60).read()
    integrity = 'sha512-' + base64.b64encode(hashlib.sha512(archive).digest()).decode()
    if integrity != metadata['dist']['integrity']:
        raise RuntimeError('Package integrity failed: ' + package)
    destination = root / package
    destination.mkdir(parents=True)
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        for member in bundle.getmembers():
            if not member.name.startswith('package/'):
                raise RuntimeError('Unexpected package archive path')
            member.name = member.name[len('package/'):]
            if member.name:
                bundle.extract(member, destination, filter='data')
PY

NODE_PATH="$runtime_tmp/node_modules" RUNTIME_CONTRACT_TMP="$runtime_tmp" \
  "$runtime_node" "$runtime_root/products/agents/api/test/runtime-contract-smoke.ts" &
runtime_pid=$!
trap 'kill -TERM "$runtime_pid" 2>/dev/null || true; wait "$runtime_pid" || true; exit 130' INT TERM
wait "$runtime_pid"
