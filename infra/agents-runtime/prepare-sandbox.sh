#!/usr/bin/env bash
set -euo pipefail
sandbox_cache=${AGENTS_SANDBOX_CACHE:-"$HOME/.cache/kasitek-agents-sandbox"}
mkdir -p "$sandbox_cache"
chmod 700 "$sandbox_cache"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'This sandbox profile requires Linux x86_64.' >&2; exit 1; }
sandbox_release=20261012.0
sandbox_sha=9606445eed5aedfcf05310e7ccef61d994089914c6622fc82624c24d2b18db1b2210f40e40a7be27b8b7772859de7d95c501b4eba66423053c960bf671377c5e
if [[ ! -f "$sandbox_cache/gvisor.tar.bz2" ]]; then
  curl --fail --silent --show-error --location --max-time 180 "https://storage.googleapis.com/gvisor/releases/release/$sandbox_release/x86_64/gvisor.tar.bz2" -o "$sandbox_cache/gvisor.tar.bz2"
fi
python3 - "$sandbox_cache" "$sandbox_sha" <<'PY'
import pathlib,sys,hashlib,tarfile
root=pathlib.Path(sys.argv[1]);archive=root/'gvisor.tar.bz2'
if hashlib.sha512(archive.read_bytes()).hexdigest()!=sys.argv[2]:raise SystemExit('gVisor checksum mismatch')
with tarfile.open(archive) as tar:tar.extractall(root/'gvisor',filter='data')
PY
sandbox_image=python:3.12.12-slim-bookworm@sha256:593bd06efe90efa80dc4eee3948be7c0fde4134606dd40d8dd8dbcade98e669c
docker image inspect "$sandbox_image" >/dev/null 2>&1 || docker pull "$sandbox_image"
sandbox_container="kasitek-sandbox-image-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:12])')"
cleanup() { docker rm -f "$sandbox_container" >/dev/null 2>&1 || true; }
trap cleanup EXIT
docker create --name "$sandbox_container" "$sandbox_image" >/dev/null
docker export "$sandbox_container" --output "$sandbox_cache/python-rootfs.tar"
python3 - "$sandbox_cache" "$sandbox_release" "$sandbox_image" <<'PY'
import pathlib,sys,tarfile,os,json,shutil
root=pathlib.Path(sys.argv[1]);temporary=root/'python-rootfs.preparing'
if temporary.exists():shutil.rmtree(temporary)
temporary.mkdir(mode=0o700)
def oci_filter(member,destination):
    # Image symlinks refer to the guest root. Convert them before safe host extraction.
    if member.issym() and member.linkname.startswith('/'):
        member=member.replace(linkname=os.path.relpath(member.linkname.lstrip('/'),os.path.dirname(member.name) or '.'))
    if member.islnk() and member.linkname.startswith('/'):member=member.replace(linkname=member.linkname.lstrip('/'))
    if not(member.isfile() or member.isdir() or member.issym() or member.islnk()):return None
    return tarfile.data_filter(member,destination)
with tarfile.open(root/'python-rootfs.tar') as tar:tar.extractall(temporary,filter=oci_filter)
temporary.chmod(0o755)
if (root/'python-rootfs').exists():shutil.rmtree(root/'python-rootfs')
temporary.rename(root/'python-rootfs')
(root/'runtime.json').write_text(json.dumps({'runscRelease':sys.argv[2],'image':sys.argv[3],'network':'none','platform':'systrap','resourceOwner':'transient systemd user cgroup'}))
PY
"$sandbox_cache/gvisor/runsc" --version
printf 'Prepared private sandbox runtime in %s\n' "$sandbox_cache"
