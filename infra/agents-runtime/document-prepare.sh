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
document_rootfs=$(python3 "$document_repo/infra/agents-runtime/document-rootfs.py" "$document_cache" "$document_image")
document_lock=$(sha256sum "$document_repo/infra/agents-runtime/document-pnpm-lock.yaml" | cut -d' ' -f1)
document_packages="$document_cache/packages/$document_lock"
mkdir -p "$document_packages"
cp "$document_repo/infra/agents-runtime/document-package.json" "$document_packages/package.json"
cp "$document_repo/infra/agents-runtime/document-pnpm-lock.yaml" "$document_packages/pnpm-lock.yaml"
"$document_pnpm" --dir "$document_packages" install --ignore-scripts --frozen-lockfile --ignore-workspace
python3 - "$document_repo" "$document_cache" "$document_packages" "$document_runsc" "$document_image" "$document_rootfs" <<'PY'
import pathlib,urllib.request,hashlib,json,sys,shutil,os,subprocess
repo,cache,packages,runsc=map(pathlib.Path,sys.argv[1:5]);image=sys.argv[5];rootfs=pathlib.Path(sys.argv[6]);infra=repo/'infra/agents-runtime';rootfs_artifact=json.loads((rootfs.parent/'provenance.json').read_text())
def sha(path):
 h=hashlib.sha256()
 with path.open('rb') as file:
  while block:=file.read(1048576):h.update(block)
 return h.hexdigest()
assert 'release-20261012.0' in subprocess.run([str(runsc),'--version'],check=True,capture_output=True,text=True,timeout=5).stdout
runsc_files={'runsc':sha(runsc)}
sidecars=runsc.parent/'gvisor-bin'
if sidecars.is_dir():
 for sidecar in sorted(sidecars.iterdir()):
  if not sidecar.is_file() or sidecar.is_symlink():raise SystemExit('Unsupported gVisor bundle entry')
  runsc_files['gvisor-bin/'+sidecar.name]=sha(sidecar)
runsc_bundle=hashlib.sha256(json.dumps(runsc_files,sort_keys=True,separators=(',',':')).encode()).hexdigest();runsc_directory=cache/'runsc'/runsc_bundle
for name,expected in runsc_files.items():
 source=runsc if name=='runsc' else runsc.parent/name;destination=runsc_directory/name;destination.parent.mkdir(parents=True,exist_ok=True)
 if not destination.exists():
  temporary=destination.with_suffix('.preparing');shutil.copy2(source,temporary);temporary.chmod(0o755);temporary.replace(destination)
 if sha(destination)!=expected:raise SystemExit('Pinned gVisor snapshot checksum mismatch')
runsc=runsc_directory/'runsc'
model=json.loads((infra/'embedding-model.json').read_text());legacy_model=cache/'models/bge-small-en-v1.5';modeldir=legacy_model/model['revision']
for name,meta in model['files'].items():
 path=modeldir/name;path.parent.mkdir(parents=True,exist_ok=True)
 if not path.exists() and (legacy_model/name).exists() and (legacy_model/name).stat().st_size==meta['bytes'] and sha(legacy_model/name)==meta['sha256']:
  temporary=path.with_suffix(path.suffix+'.preparing');shutil.copy2(legacy_model/name,temporary);temporary.replace(path)
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
def tree(root):
 result={}
 for path in sorted(root.rglob('*')):
  name=str(path.relative_to(root))
  if name in ['.pnpm-workspace-state-v1.json','.modules.yaml']:continue
  if path.is_symlink():
   if not path.resolve().is_relative_to(root.resolve()):raise SystemExit('Runtime dependency link escapes pinned package tree')
   result[name]={'symlink':os.readlink(path)}
  elif path.is_file():result[name]={'sha256':sha(path),'bytes':path.stat().st_size}
  elif path.is_dir():result[name]={'directory':True}
  else:raise SystemExit('Unsupported runtime artifact')
 return result
runtime_artifacts=tree(packages/'node_modules')
identity={'name':'document-processing-v1','image':image,'rootfsArtifact':rootfs_artifact,'runscRelease':'20261012.0','runscSHA256':sha(runsc),'runscBundle':runsc_files,'packageLockSHA256':sha(infra/'document-pnpm-lock.yaml'),'runtimeArtifacts':runtime_artifacts,'model':model,'sources':{name:sha(infra/name) for name in sources},'limits':{'cpu':1,'memoryBytes':536870912,'pids':64,'scratchBytes':268435456,'seconds':60,'rawBytes':10485760,'textBytes':1048576,'pages':200,'chunks':1000,'batch':16,'chunkTokens':384,'overlapTokens':48,'modelTokens':512,'outputBytes':8388608},'embedding':{'tokenizer':'@huggingface/tokenizers@0.2.0','runtime':'onnxruntime-node@1.30.0','pooling':'cls','normalization':'l2','dtype':'float32','dimensions':384,'queryPrefix':'Represent this sentence for searching relevant passages: ','threads':1,'graphOptimization':'all'}}
encoded=json.dumps(identity,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode();profilehash=hashlib.sha256(encoded).hexdigest();release='document-processing-v1@'+profilehash;target=cache/'profiles'/profilehash
if not target.exists():
 temporary=cache/'profiles'/(profilehash+'.preparing');temporary.parent.mkdir(parents=True,exist_ok=True);shutil.rmtree(temporary,ignore_errors=True);temporary.mkdir(mode=0o755);runtime=temporary/'runtime';runtime.mkdir(mode=0o755)
 shutil.copytree(packages/'node_modules',runtime/'node_modules',symlinks=True,copy_function=shutil.copy2,ignore=lambda directory,names:[name for name in names if pathlib.Path(directory)==packages/'node_modules' and name in ['.pnpm-workspace-state-v1.json','.modules.yaml']])
 shutil.copy2(infra/'document-worker.mjs',runtime/'document-worker.mjs')
 for name in ['document-host.py','document-lifecycle.py']:shutil.copy2(infra/name,temporary/name)
 manifest={'profileRelease':release,'identity':identity,'rootfs':str(rootfs),'modelDirectory':str(modeldir),'runsc':str(runsc)}
 (temporary/'manifest.json').write_text(json.dumps(manifest,indent=2));temporary.rename(target)
(cache/'current-profile.json').write_text(json.dumps({'profileRelease':release}))
print('Prepared document processing profile '+release)
PY
