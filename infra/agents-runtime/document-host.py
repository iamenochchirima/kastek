"""Trusted bounded host supervisor; document/model execution remains inside gVisor."""
import os,sys,json,time,subprocess,selectors,hashlib,pathlib
root=pathlib.Path(sys.argv[1]);launch=json.loads((root/'launch.json').read_text());started=time.monotonic()
def save(value):
 value.update(durationMs=round((time.monotonic()-started)*1000),memoryPeakBytes=int((group/'memory.peak').read_text()))
 encoded=json.dumps(value,separators=(',',':'),ensure_ascii=True).encode();temporary=root/'result.tmp'
 temporary.write_bytes(encoded);temporary.chmod(0o600);temporary.replace(root/'result.json')
try:
 group=pathlib.Path('/sys/fs/cgroup'+next(x.strip().split('::',1)[1] for x in open('/proc/self/cgroup') if x.startswith('0::')))
 assert (group/'memory.max').read_text().strip()=='536870912'
 assert (group/'memory.swap.max').read_text().strip()=='0' and (group/'pids.max').read_text().strip()=='64'
 quota,period=(group/'cpu.max').read_text().split();assert quota!='max' and 0<int(quota)<=int(period)
except Exception:sys.exit(2)
runsc=[launch['runsc'],'--root='+str(root/'state'),'--rootless','--network=none','--platform=systrap']
try:
 child=subprocess.Popen(runsc+['run','--bundle',str(root),launch['containerId']],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
 selected=selectors.DefaultSelector();selected.register(child.stdout,selectors.EVENT_READ,'stdout');selected.register(child.stderr,selectors.EVENT_READ,'stderr')
 output=bytearray();diagnostics=0;error=None
 while selected.get_map():
  if time.monotonic()-started>60:error='DOCUMENT_RUNTIME_TIMEOUT';break
  for key,_ in selected.select(.1):
   block=os.read(key.fileobj.fileno(),65536)
   if not block:selected.unregister(key.fileobj);continue
   if key.data=='stdout':
    if len(output)+len(block)>8388608:error='DOCUMENT_OUTPUT_LIMIT';break
    output.extend(block)
   else:
    diagnostics+=len(block)
    if diagnostics>65536:error='DOCUMENT_DIAGNOSTIC_LIMIT';break
  if error:break
 if error:child.kill()
 code=child.wait(timeout=3)
 if error or code:save({'ok':False,'errorCode':error or 'DOCUMENT_RUNTIME_FAILED'})
 else:
  value=json.loads(output);assert isinstance(value,dict) and type(value.get('ok')) is bool
  body=root/'output.json';body.write_bytes(output);body.chmod(0o600)
  save({'ok':value['ok'],'errorCode':value.get('errorCode'),'outputDigest':hashlib.sha256(output).hexdigest()})
except Exception:
 try:save({'ok':False,'errorCode':'DOCUMENT_RUNTIME_UNCERTAIN'})
 except Exception:pass
finally:
 try:subprocess.run(runsc+['delete','--force',launch['containerId']],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=3)
 except Exception:pass
