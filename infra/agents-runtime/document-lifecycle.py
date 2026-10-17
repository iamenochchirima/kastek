"""Cross-process physical lifecycle fence, with persistent ownership and no host parsing."""
import os,sys,json,pathlib,uuid,fcntl,subprocess,shutil,base64,re,time
cache=pathlib.Path(sys.argv[1]);action=sys.argv[2];allocation=str(uuid.UUID(sys.argv[3]))
for part in ['locks','journals','resources']:(cache/part).mkdir(parents=True,exist_ok=True,mode=0o700)
root=cache/'resources'/allocation;journal=cache/'journals'/(allocation+'.json');lock=(cache/'locks'/(allocation+'.lock')).open('a')
fcntl.flock(lock,fcntl.LOCK_EX)
def write(value):
 temporary=journal.with_suffix('.tmp');temporary.write_text(json.dumps(value,separators=(',',':')));temporary.chmod(0o600);temporary.replace(journal)
def emit(value):print(json.dumps(value,separators=(',',':')))
def inspect(unit):
 try:
  result=subprocess.run(['systemctl','--user','show',unit,'--property=LoadState','--property=ActiveState','--property=Result'],capture_output=True,text=True,timeout=5)
  fields=dict(line.split('=',1) for line in result.stdout.splitlines() if '=' in line)
  if result.returncode==0:return fields
  if result.returncode==1 and fields.get('LoadState')=='not-found' and fields.get('ActiveState')=='inactive':return fields
 except Exception:pass
 return {'LoadState':'unknown','ActiveState':'unknown'}
def stopped(fields):return fields.get('LoadState')=='not-found' or fields.get('ActiveState') in ['inactive','failed']
def status(value):
 if value['state']=='destroyed':return value
 receipt=root/'result.json'
 if receipt.is_file() and receipt.stat().st_size<=8388608:
  try:
   result=json.loads(receipt.read_bytes());value['state']='completed' if result['ok'] else 'failed';value['errorCode']=result.get('errorCode') or result.get('output',{}).get('errorCode');value['durationMs']=result['durationMs'];value['memoryPeakBytes']=result['memoryPeakBytes'];write(value);return value
  except Exception:pass
 fields=inspect(value['unitName'])
 if stopped(fields):value['state']='uncertain';value['errorCode']='DOCUMENT_RUNTIME_UNCERTAIN';write(value)
 return value
try:
 value=json.loads(journal.read_text()) if journal.is_file() else None
 if action=='start':
  raw=sys.stdin.buffer.read(15000001)
  if len(raw)>15000000:raise ValueError('DOCUMENT_INPUT_LIMIT')
  request=json.loads(raw);job=str(uuid.UUID(request['jobId']));release=request['profileRelease']
  if not re.fullmatch(r'document-processing-v1@[a-f0-9]{64}',release):raise ValueError('DOCUMENT_PROFILE_UNAVAILABLE')
  profile=cache/'profiles'/release.split('@')[1];manifest=json.loads((profile/'manifest.json').read_text())
  if manifest['profileRelease']!=release:raise ValueError('DOCUMENT_PROFILE_UNAVAILABLE')
  if value:
   if value['state']=='destroyed':raise ValueError('DOCUMENT_RESOURCE_EXPIRED')
   if value['jobId']!=job or value['profileRelease']!=release or value['inputDigest']!=request['inputDigest']:raise ValueError('DOCUMENT_RESOURCE_CONFLICT')
   emit(status(value));sys.exit(0)
  root.mkdir(mode=0o700);incoming=root/'input';incoming.mkdir(mode=0o755)
  inp=request['input'];kind=inp.get('kind')
  if kind not in ['parse','chunk','embed']:raise ValueError('DOCUMENT_INPUT_INVALID')
  if kind=='parse':
   data=base64.b64decode(inp.pop('contentBase64'),validate=True)
   if len(data)>10485760 or not data:raise ValueError('DOCUMENT_INPUT_LIMIT')
   path=incoming/'document.bin';path.write_bytes(data);path.chmod(0o444)
  encoded=json.dumps(inp,separators=(',',':'),ensure_ascii=True).encode()
  if len(encoded)>15000000:raise ValueError('DOCUMENT_INPUT_LIMIT')
  (incoming/'request.json').write_bytes(encoded);(incoming/'request.json').chmod(0o444)
  unit='kasitek-document-'+allocation+'.service'
  value={'allocationId':allocation,'jobId':job,'profileRelease':release,'inputDigest':request['inputDigest'],'unitName':unit,'state':'prepared','createdAt':time.time()}
  write(value)
  spec={'ociVersion':'1.0.2','process':{'terminal':False,'user':{'uid':65532,'gid':65532},'args':['/usr/local/bin/node','--max-old-space-size=192','/runtime/document-worker.mjs'],'cwd':'/scratch','env':['PATH=/usr/local/bin:/usr/bin:/bin','HOME=/scratch'],'noNewPrivileges':True,'capabilities':{x:[] for x in ['bounding','effective','permitted','inheritable','ambient']},'rlimits':[{'type':'RLIMIT_NPROC','hard':64,'soft':64},{'type':'RLIMIT_NOFILE','hard':128,'soft':128},{'type':'RLIMIT_FSIZE','hard':268435456,'soft':268435456}]},'root':{'path':manifest['rootfs'],'readonly':True},'mounts':[{'destination':'/proc','type':'proc','source':'proc'},{'destination':'/scratch','type':'tmpfs','source':'tmpfs','options':['nosuid','nodev','noexec','mode=1777','size=268435456']},{'destination':'/runtime','type':'bind','source':str(profile/'runtime'),'options':['rbind','ro','nosuid','nodev']},{'destination':'/model','type':'bind','source':manifest['modelDirectory'],'options':['rbind','ro','nosuid','nodev']},{'destination':'/input','type':'bind','source':str(incoming),'options':['rbind','ro','nosuid','nodev','noexec']}],'linux':{'namespaces':[{'type':kind} for kind in ['pid','ipc','uts','mount','network']]}}
  (root/'config.json').write_text(json.dumps(spec));(root/'config.json').chmod(0o600)
  (root/'launch.json').write_text(json.dumps({'runsc':manifest['runsc'],'containerId':'document-'+allocation}));(root/'launch.json').chmod(0o600)
  # Persist launch intent before the one physical dispatch. Replay only observes.
  value['state']='running';write(value)
  try:subprocess.run(['systemd-run','--user','--unit='+unit,'--property=MemoryMax=536870912','--property=MemorySwapMax=0','--property=CPUQuota=100%','--property=TasksMax=64','--property=RuntimeMaxSec=62','--property=TimeoutStopSec=2','--property=KillMode=control-group','/usr/bin/env','-i','PATH=/usr/bin:/bin','/usr/bin/python3',str(profile/'document-host.py'),str(root)],capture_output=True,timeout=10,check=True)
  except Exception:value['state']='uncertain';value['errorCode']='DOCUMENT_LAUNCH_UNCERTAIN';write(value)
  emit(value)
 elif action=='status':
  if not value:raise ValueError('DOCUMENT_RESOURCE_NOT_FOUND')
  emit(status(value))
 elif action=='destroy':
  # A tombstone also fences a delayed start that has not staged inputs yet.
  if not value:
   shutil.rmtree(root,ignore_errors=False) if root.exists() else None
   value={'allocationId':allocation,'state':'destroyed'};write(value);emit(value);sys.exit(0)
  if value['state']!='destroyed':
   value['state']='destroying';write(value)
   try:subprocess.run(['systemctl','--user','stop',value['unitName']],capture_output=True,timeout=10)
   except Exception:pass
   if not stopped(inspect(value['unitName'])):emit(value);sys.exit(0)
  shutil.rmtree(root,ignore_errors=False) if root.exists() else None
  value['state']='destroyed';write(value);emit(value)
 else:raise ValueError('DOCUMENT_INPUT_INVALID')
except Exception as error:
 code=str(error) if re.fullmatch(r'DOCUMENT_[A-Z_]+',str(error)) else 'DOCUMENT_RUNTIME_UNAVAILABLE'
 emit({'errorCode':code});sys.exit(1)
