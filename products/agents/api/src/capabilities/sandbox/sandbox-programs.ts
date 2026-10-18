// Trusted code outside the generated program. Only the guest program runs under gVisor.
export const guestRunner = String.raw`import os,sys,json,subprocess,selectors,signal,stat,base64,time
os.makedirs('/scratch/output',exist_ok=True)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','PYTHONUNBUFFERED':'1','PYTHONDONTWRITEBYTECODE':'1','TMPDIR':'/scratch','INPUT_DIR':'/input/data','OUTPUT_DIR':'/scratch/output'}
p=subprocess.Popen(['/usr/local/bin/python3','-I','-B','/input/program.py'],cwd='/scratch',env=env,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True)
streams=selectors.DefaultSelector()
streams.register(p.stdout,selectors.EVENT_READ,'stdout');streams.register(p.stderr,selectors.EVENT_READ,'stderr')
parts={'stdout':bytearray(),'stderr':bytearray()};count=0;error=None;deadline=time.monotonic()+118
while streams.get_map():
    if time.monotonic()>deadline:
        error='SANDBOX_TIMEOUT';os.killpg(p.pid,signal.SIGKILL);break
    for key,_ in streams.select(.1):
        data=os.read(key.fd,8192)
        if not data:streams.unregister(key.fileobj);continue
        count+=len(data)
        if count>65536:
            error='SANDBOX_STDOUT_LIMIT';os.killpg(p.pid,signal.SIGKILL);break
        parts[key.data].extend(data)
    if error:break
code=p.wait();exports=[]
try:
    if not error and code==0:
        entries=list(os.scandir('/scratch/output'))
        if len(entries)>4:raise ValueError('SANDBOX_EXPORT_LIMIT')
        total=0
        for entry in sorted(entries,key=lambda x:x.name):
            import re
            if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._-]{0,79}',entry.name):raise ValueError('SANDBOX_EXPORT_PATH')
            info=entry.stat(follow_symlinks=False)
            if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:raise ValueError('SANDBOX_EXPORT_PATH')
            if info.st_size>1048576:raise ValueError('SANDBOX_EXPORT_LIMIT')
            flags=os.O_RDONLY|os.O_NOFOLLOW
            fd=os.open(entry.path,flags)
            with os.fdopen(fd,'rb') as source:data=source.read(1048577)
            if len(data)>1048576:raise ValueError('SANDBOX_EXPORT_LIMIT')
            data.decode('utf-8');total+=len(data)
            if total>4194304:raise ValueError('SANDBOX_EXPORT_LIMIT')
            extension=os.path.splitext(entry.name)[1].lower()
            if extension not in ['.txt','.md','.json','.csv']:raise ValueError('SANDBOX_EXPORT_TYPE')
            if extension=='.json':json.loads(data.decode('utf-8'))
            content_type='application/json' if extension=='.json' else 'text/markdown' if extension=='.md' else 'text/plain'
            exports.append({'name':entry.name,'contentType':content_type,'base64':base64.b64encode(data).decode('ascii')})
except (ValueError,OSError,UnicodeDecodeError) as exc:
    error=str(exc) if str(exc).startswith('SANDBOX_') else 'SANDBOX_EXPORT_INVALID';exports=[]
stdout=parts['stdout'].decode('utf-8','replace').encode('utf-8')[:65536].decode('utf-8','ignore')
stderr=parts['stderr'].decode('utf-8','replace').encode('utf-8')[:65536-len(stdout.encode('utf-8'))].decode('utf-8','ignore')
print(json.dumps({'exitCode':code,'stdout':stdout,'stderr':stderr,'errorCode':error,'exports':exports},separators=(',',':')))
`;

export const hostRunner = String.raw`import os,sys,json,subprocess,selectors,time,signal
manifest=json.load(open(sys.argv[1]))
def evidence():
    try:
        pids=dict(line.split() for line in open(directory+'/pids.events'))
        memory=dict(line.split() for line in open(directory+'/memory.events'))
        return {'pidDenials':int(pids.get('max',0)),'oomKills':int(memory.get('oom_kill',0))}
    except Exception:return {'pidDenials':0,'oomKills':0}
def save(receipt):
    receipt['resourceEvidence']=evidence()
    path=manifest['receipt']+'.tmp'
    with open(path,'w') as target:json.dump(receipt,target,separators=(',',':'))
    os.chmod(path,0o600);os.replace(path,manifest['receipt'])
# Verify the kernel's limits before any generated code can start.
try:
    group=[line.strip().split('::',1)[1] for line in open('/proc/self/cgroup') if line.startswith('0::')][0]
    directory='/sys/fs/cgroup'+group
    memory=open(directory+'/memory.max').read().strip();pids=open(directory+'/pids.max').read().strip()
    swap=open(directory+'/memory.swap.max').read().strip();quota,period=open(directory+'/cpu.max').read().split()
    assert memory!='max' and 0<int(memory)<=536870912
    assert pids!='max' and 0<int(pids)<=64 and swap=='0'
    assert quota!='max' and 0<int(quota)<=int(period)
except Exception:
    save({'state':'failed','exitCode':None,'stdout':'','stderr':'','errorCode':'SANDBOX_ISOLATION_UNAVAILABLE','exports':[]})
    sys.exit(0)
# This marker is written before the one physical launch. A missing outcome is not permission to rerun.
with open(manifest['started'],'x') as marker:marker.write('started')
args=[manifest['runsc'],'--root='+manifest['state'],'--rootless','--network=none','--platform=systrap','run','--bundle',manifest['bundle'],manifest['containerId']]
try:
    proc=subprocess.Popen(args,stdin=subprocess.DEVNULL,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env={'PATH':'/usr/bin:/bin'},start_new_session=True)
    streams=selectors.DefaultSelector();streams.register(proc.stdout,selectors.EVENT_READ,'stdout');streams.register(proc.stderr,selectors.EVENT_READ,'stderr')
    parts={'stdout':bytearray(),'stderr':bytearray()};total=0;error=None;deadline=time.monotonic()+manifest['seconds']
    while streams.get_map():
        if time.monotonic()>deadline:error='SANDBOX_TIMEOUT';proc.kill();break
        for key,_ in streams.select(.1):
            data=os.read(key.fd,65536)
            if not data:streams.unregister(key.fileobj);continue
            total+=len(data)
            if total>6291456 or (key.data=='stderr' and len(parts['stderr'])+len(data)>65536):
                error='SANDBOX_RESULT_LIMIT';proc.kill();break
            parts[key.data].extend(data)
        if error:break
    status=proc.wait()
    if error or status!=0:
        limits=evidence()
        cause='SANDBOX_PID_LIMIT' if limits['pidDenials'] else 'SANDBOX_MEMORY_LIMIT' if limits['oomKills'] else 'SANDBOX_RUNTIME_FAILED'
        save({'state':'failed','exitCode':status,'stdout':'','stderr':'','errorCode':error or cause,'exports':[]})
    else:
        result=json.loads(parts['stdout'])
        save({'state':'completed' if result['exitCode']==0 and not result['errorCode'] else 'failed',**result})
except Exception:
    save({'state':'uncertain','exitCode':None,'stdout':'','stderr':'','errorCode':'SANDBOX_OUTCOME_UNCERTAIN','exports':[]})
`;
