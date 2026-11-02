"""Prepare a digest-specific rootfs; never relabel an existing unverified cache."""
import hashlib,json,os,pathlib,re,shutil,subprocess,sys,tarfile,uuid

cache=pathlib.Path(sys.argv[1]);image=sys.argv[2]
match=re.search(r'@sha256:([a-f0-9]{64})$',image)
if not match:raise SystemExit('A pinned document runtime image is required')
digest=match[1];target=cache/'rootfs'/digest/'canonical-tar-v1'

def sha(path):
 value=hashlib.sha256()
 with path.open('rb') as file:
  while block:=file.read(1048576):value.update(block)
 return value.hexdigest()

def checked(directory):
 try:
  stamp=json.loads((directory/'provenance.json').read_text())
  assert stamp['image']==image and stamp['manifestDigest']=='sha256:'+digest
  assert stamp['archiveFormat']=='canonical-tar-v1'
  assert re.fullmatch(r'sha256:[a-f0-9]{64}',stamp['imageID'])
  assert sha(directory/'rootfs/usr/local/bin/node')==stamp['nodeSHA256']
  assert sha(directory/'rootfs.tar')==stamp['archiveSHA256']
  return stamp
 except Exception:raise SystemExit('Document rootfs cache provenance mismatch; preserve accepted profiles and prepare a clean digest directory')

if target.exists():checked(target);print(target/'rootfs');sys.exit(0)
target.parent.mkdir(parents=True,exist_ok=True)
temporary=target.parent/(digest+'.preparing-'+uuid.uuid4().hex);temporary.mkdir(mode=0o700)
container='kasitek-document-image-'+uuid.uuid4().hex[:12]
try:
 inspected=subprocess.run(['docker','image','inspect',image],capture_output=True,timeout=20)
 if inspected.returncode:
  subprocess.run(['docker','pull',image],check=True,stdout=sys.stderr,timeout=300)
  inspected=subprocess.run(['docker','image','inspect',image],capture_output=True,check=True,timeout=20)
 info=json.loads(inspected.stdout)[0]
 assert any(value.endswith('@sha256:'+digest) for value in info['RepoDigests'])
 subprocess.run(['docker','create','--name',container,image],check=True,stdout=subprocess.DEVNULL,timeout=20)
 actual=subprocess.run(['docker','inspect','--format={{.Image}}',container],check=True,capture_output=True,text=True,timeout=20).stdout.strip()
 assert actual==info['Id']
 exported=temporary/'docker-export.tar'
 subprocess.run(['docker','export',container,'--output',str(exported)],check=True,timeout=60)
 # Docker adds empty files with creation timestamps; do not turn those into host-specific releases.
 with tarfile.open(exported) as source,tarfile.open(temporary/'rootfs.tar','w',format=tarfile.PAX_FORMAT) as archive:
  for member in sorted(source.getmembers(),key=lambda item:item.name):
   if not(member.isfile() or member.isdir() or member.issym() or member.islnk()):continue
   member=member.replace(mtime=0,uname='',gname='');member.pax_headers={}
   archive.addfile(member,source.extractfile(member) if member.isfile() else None)
 exported.unlink()
 root=temporary/'rootfs';root.mkdir(mode=0o755)
 def safe(member,destination):
  if member.issym() and member.linkname.startswith('/'):member=member.replace(linkname=os.path.relpath(member.linkname.lstrip('/'),os.path.dirname(member.name) or '.'))
  if member.islnk() and member.linkname.startswith('/'):member=member.replace(linkname=member.linkname.lstrip('/'))
  if not(member.isfile() or member.isdir() or member.issym() or member.islnk()):return None
  return tarfile.data_filter(member,destination)
 with tarfile.open(temporary/'rootfs.tar') as archive:archive.extractall(root,filter=safe)
 stamp={'image':image,'manifestDigest':'sha256:'+digest,'imageID':actual,'nodeSHA256':sha(root/'usr/local/bin/node'),'archiveSHA256':sha(temporary/'rootfs.tar'),'archiveFormat':'canonical-tar-v1'}
 (temporary/'provenance.json').write_text(json.dumps(stamp,sort_keys=True,separators=(',',':')))
 checked(temporary);temporary.rename(target);print(target/'rootfs')
finally:
 subprocess.run(['docker','rm','-f',container],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=20)
 shutil.rmtree(temporary,ignore_errors=True)
