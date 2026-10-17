#!/usr/bin/env bash
set -euo pipefail
document_repo=$(cd "$(dirname "$0")/../.." && pwd)
document_cache=${AGENTS_DOCUMENT_RUNTIME_CACHE:-"$HOME/.cache/kasitek-documents"}
mkdir -p "$document_cache"
chmod 700 "$document_cache"
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Document processing requires Linux x86_64.' >&2;exit 1; }
document_pnpm=${PNPM_BINARY:-$(command -v pnpm || true)}
[[ -n "$document_pnpm" ]] || { echo 'Set PNPM_BINARY to the configured pnpm executable.' >&2;exit 1; }
document_runsc=${AGENTS_SANDBOX_RUNSC:-"$HOME/.cache/kasitek-agents-sandbox/gvisor/runsc"}
[[ -x "$document_runsc" ]] || { echo 'Prepare the pinned gVisor sandbox runtime first.' >&2;exit 1; }
document_image=node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
if [[ ! -x "$document_cache/node-rootfs/usr/local/bin/node" ]];then
 docker image inspect "$document_image" >/dev/null 2>&1 || docker pull "$document_image"
 document_container="kasitek-document-image-$(python3 -c 'import uuid;print(uuid.uuid4().hex[:12])')"
 trap 'docker rm -f "$document_container" >/dev/null 2>&1 || true' EXIT
 docker create --name "$document_container" "$document_image" >/dev/null
 docker export "$document_container" --output "$document_cache/node-rootfs.tar"
 docker rm "$document_container" >/dev/null
 python3 - "$document_cache" <<'PY'
import pathlib,tarfile,os
root=pathlib.Path(__import__('sys').argv[1]);target=root/'node-rootfs';target.mkdir(mode=0o755)
def safe(member,destination):
 if member.issym() and member.linkname.startswith('/'):member=member.replace(linkname=os.path.relpath(member.linkname.lstrip('/'),os.path.dirname(member.name) or '.'))
 if member.islnk() and member.linkname.startswith('/'):member=member.replace(linkname=member.linkname.lstrip('/'))
 if not(member.isfile() or member.isdir() or member.issym() or member.islnk()):return None
 return tarfile.data_filter(member,destination)
with tarfile.open(root/'node-rootfs.tar') as archive:archive.extractall(target,filter=safe)
PY
fi
document_lock=$(sha256sum "$document_repo/infra/agents-runtime/document-pnpm-lock.yaml" | cut -d' ' -f1)
document_packages="$document_cache/packages/$document_lock"
mkdir -p "$document_packages"
cp "$document_repo/infra/agents-runtime/document-package.json" "$document_packages/package.json"
cp "$document_repo/infra/agents-runtime/document-pnpm-lock.yaml" "$document_packages/pnpm-lock.yaml"
"$document_pnpm" --dir "$document_packages" install --ignore-scripts --frozen-lockfile --ignore-workspace
python3 - "$document_repo" "$document_cache" "$document_packages" "$document_runsc" "$document_image" <<'PY'
import pathlib,urllib.request,hashlib,json,sys,shutil,os
repo,cache,packages,runsc=map(pathlib.Path,sys.argv[1:5]);image=sys.argv[5];infra=repo/'infra/agents-runtime'
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as file:
  while block:=file.read(1048576):h.update(block)
 return h.hexdigest()
model=json.loads((infra/'embedding-model.json').read_text());modeldir=cache/'models/bge-small-en-v1.5'
for name,meta in model['files'].items():
 path=modeldir/name;path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists():
  temporary=path.with_suffix(path.suffix+'.download');total=0
  try:
   with urllib.request.urlopen('https://huggingface.co/'+model['repository']+'/resolve/'+model['revision']+'/'+name,timeout=60) as source,temporary.open('wb') as target:
    while block:=source.read(1048576):
     total+=len(block)
     if total>meta['bytes']:raise RuntimeError('Model artifact exceeds pinned size')
     target.write(block)
   temporary.rename(path)
  finally:temporary.unlink(missing_ok=True)
 if path.stat().st_size!=meta['bytes'] or sha(path)!=meta['sha256']:raise SystemExit('Model artifact checksum mismatch: '+name)
sources=['document-worker.mjs','document-host.py','document-lifecycle.py']
identity={'name':'document-processing-v1','image':image,'runscRelease':'20261012.0','runscSHA256':sha(runsc),'packageLockSHA256':sha(infra/'document-pnpm-lock.yaml'),'model':model,'sources':{name:sha(infra/name) for name in sources},'limits':{'cpu':1,'memoryBytes':536870912,'pids':64,'scratchBytes':268435456,'seconds':60,'rawBytes':10485760,'textBytes':1048576,'pages':200,'chunks':1000,'batch':16,'chunkTokens':384,'overlapTokens':48,'modelTokens':512,'outputBytes':8388608},'embedding':{'tokenizer':'@huggingface/tokenizers@0.2.0','runtime':'onnxruntime-node@1.30.0','pooling':'cls','normalization':'l2','dtype':'float32','dimensions':384,'queryPrefix':'Represent this sentence for searching relevant passages: ','threads':1,'graphOptimization':'all'}}
encoded=json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode();profilehash=hashlib.sha256(encoded).hexdigest();release='document-processing-v1@'+profilehash;target=cache/'profiles'/profilehash
if not target.exists():
 temporary=cache/'profiles'/(profilehash+'.preparing');temporary.parent.mkdir(parents=True,exist_ok=True);shutil.rmtree(temporary,ignore_errors=True);temporary.mkdir(mode=0o755);runtime=temporary/'runtime';runtime.mkdir(mode=0o755)
 def link(source,dest):
  try:os.link(source,dest)
  except OSError:shutil.copy2(source,dest)
 shutil.copytree(packages/'node_modules',runtime/'node_modules',symlinks=True,copy_function=link)
 shutil.copy2(infra/'document-worker.mjs',runtime/'document-worker.mjs')
 for name in ['document-host.py','document-lifecycle.py']:shutil.copy2(infra/name,temporary/name)
 manifest={'profileRelease':release,'identity':identity,'rootfs':str(cache/'node-rootfs'),'modelDirectory':str(modeldir),'runsc':str(runsc)}
 (temporary/'manifest.json').write_text(json.dumps(manifest,indent=2));temporary.rename(target)
(cache/'current-profile.json').write_text(json.dumps({'profileRelease':release}))
print('Prepared document processing profile '+release)
PY
