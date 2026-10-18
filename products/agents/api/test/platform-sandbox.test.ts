import { randomUUID } from "node:crypto";
import { readFile, readdir, access, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SandboxManager } from "../src/capabilities/sandbox/sandbox";
import { PlatformStore } from "../src/product/agents/store";
import { defaultFaqConfiguration } from "../src/contracts/contracts";
const exec=promisify(execFile),dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
const suite=dbUrl&&process.env.AGENTS_SANDBOX_VERIFY==="1"?describe:describe.skip;
suite("real gVisor Python analysis and independent resource lifecycle",()=>{
  let admin:Pool,pool:Pool,platform:PlatformStore,manager:SandboxManager;
  const database=`agents_sandbox_${randomUUID().replaceAll("-","")}`,directory=join(homedir(),".cache/kasitek-agents-sandbox",`test-${randomUUID()}`);
  beforeAll(async()=>{
    admin=new Pool({connectionString:dbUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(dbUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});
    for(const file of(await readdir(resolve(__dirname,"../schema"))).filter(file=>file.endsWith(".sql")).sort())await pool.query(await readFile(resolve(__dirname,"../schema",file),"utf8"));
    platform=new PlatformStore(pool);manager=new SandboxManager(pool,{directory,runsc:join(homedir(),".cache/kasitek-agents-sandbox/gvisor/runsc"),rootfs:join(homedir(),".cache/kasitek-agents-sandbox/python-rootfs")});
    expect(await manager.available()).toBe(true);
  });
  afterAll(async()=>{
    if(pool){const rows=(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE state<>'destroyed'")).rows;for(const row of rows)await manager.destroy({organizationId:row.organization_id,rootTaskId:row.root_task_id,taskId:row.task_id,deadlineAt:new Date(row.lease_expires_at)},row.id);await pool.end();}
    if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}
    const {rm}=await import("node:fs/promises");await rm(directory,{recursive:true,force:true});
  });
  async function fixture(){
    const account=await platform.ensureAccount({issuer:"http://localhost:8080/realms/sandbox",subject:randomUUID(),email:"sandbox@example.test",displayName:"Owner"});
    const org=await platform.createOrganization(account.id,"Sandbox tests"),config=defaultFaqConfiguration();config.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};config.tools=["sandbox.analyze"];
    const agent=await platform.createAgent({accountId:account.id,organizationId:org.id,name:"Analyst",configuration:config});
    const version=await platform.createVersion({accountId:account.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});
    const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
    const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply" as const,"knowledge.read" as const,"sandbox.execute" as const,"artifact.read" as const,"artifact.write" as const],maxInputBytes:16384,maxOutputTokens:1024,maxContextTokens:8192,rootTokenLimit:32000,expiresAt:new Date(Date.now()+600_000).toISOString(),revokedAt:null};
    await platform.createGrant({accountId:account.id,grant});const admitted=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Analyze the authorized input"});
    return{organizationId:org.id,rootTaskId:admitted.task.id,taskId:admitted.task.id,deadlineAt:new Date(Date.now()+600_000)};
  }
  it("runs as guest nonroot with no host credentials/network, reads controlled input and exports a report once",async()=>{
    const scope=await fixture(),operationId=randomUUID();
    const input={operationId,inputs:[{name:"numbers.csv",content:Buffer.from("value\n2\n3\n")}],code:`import os,socket,json,csv\nassert os.getuid()==65532\nimport resource\nassert resource.getrlimit(resource.RLIMIT_NPROC)==(64,64)\nassert 'gvisor' in open('/proc/version').read()\nassert 'AGENTS_DATABASE_URL' not in os.environ\nassert not os.path.exists('/var/run/docker.sock')\nassert not os.path.exists('/home/enock')\nassert os.path.isfile('/input/data/numbers.csv')\nfor host in ['127.0.0.1','169.254.169.254','10.0.0.1','1.1.1.1']:\n s=socket.socket();s.settimeout(.1)\n try:s.connect((host,80));raise AssertionError('network unexpectedly allowed')\n except OSError:pass\n finally:s.close()\ntry:open('/etc/guest-write','w').write('bad');raise AssertionError('root writable')\nexcept OSError:pass\nrows=list(csv.DictReader(open('/input/data/numbers.csv')))\nopen('/scratch/output/report.md','w').write('Total: '+str(sum(int(row['value']) for row in rows)))\nprint('analysis complete')`};
    const result=await manager.analyze(scope,input);expect(result.state).toBe("completed");expect(result.stdout).toContain("analysis complete");expect(Buffer.from(result.exports[0]!.content).toString()).toBe("Total: 5");
    const replay=await manager.analyze(scope,input);expect(replay.commandId).toBe(result.commandId);
    expect((await pool.query("SELECT count(*) FROM agents_platform.sandbox_commands")).rows[0].count).toBe("1");
    const refs=[{id:randomUUID(),name:"report.md"}];await manager.finalize(scope,result.allocationId,refs);
    const finalized=await manager.analyze(scope,input);expect(finalized.artifactRefs).toEqual(refs);expect(finalized.exports).toEqual([]);
    await expect(access(join(directory,result.allocationId))).rejects.toBeDefined();
  },30_000);
  it("recovers a real completed receipt published between the initial read and inactive systemd status",async()=>{
    const scope=await fixture(),isolated=new SandboxManager(pool,manager.config),operationId=randomUUID();
    const read=(isolated as any).readReceipt.bind(isolated),unit=(isolated as any).unit.bind(isolated);let suppressed=false,terminalObserved=false;
    (isolated as any).readReceipt=async(id:string)=>{const receipt=await read(id);if(receipt&&!suppressed){suppressed=true;return undefined;}return receipt;};
    (isolated as any).unit=async(name:string)=>{let state=await unit(name);if(suppressed){const deadline=Date.now()+5000;while(!["inactive","failed"].includes(state.ActiveState)&&Date.now()<deadline){await new Promise(done=>setTimeout(done,10));state=await unit(name);}terminalObserved=["inactive","failed"].includes(state.ActiveState);}return state;};
    const result=await isolated.analyze(scope,{operationId,inputs:[],code:"open('/scratch/output/report.md','w').write('Verified total: 60')\nprint('finished')"});
    expect(suppressed).toBe(true);expect(terminalObserved).toBe(true);expect(result.state).toBe("completed");expect(result.exitCode).toBe(0);expect(result.stdout).toContain("finished");expect(Buffer.from(result.exports[0]!.content).toString()).toBe("Verified total: 60");
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.sandbox_commands WHERE allocation_id=$1",[result.allocationId])).rows[0].count).toBe(1);
    await isolated.finalize(scope,result.allocationId,[{id:randomUUID(),name:"report.md"}]);
  },30000);
  it("rejects output symlinks, oversize and stdout floods without exporting content",async()=>{
    for(const code of [`import os;os.symlink('/etc/passwd','/scratch/output/report.md')`,`open('/scratch/output/report.md','w').write('x'*1048577)`,`print('x'*70000)`,`open('/scratch/output/broken.json','w').write('{invalid')`]){
      const scope=await fixture(),result=await manager.analyze(scope,{operationId:randomUUID(),inputs:[],code});expect(result.state).toBe("failed");expect(result.exports).toEqual([]);expect(result.errorCode).toMatch(/^SANDBOX_/);await manager.finalize(scope,result.allocationId);
    }
  },30_000);
  it("enforces virtual pid, memory, scratch and root-deadline limits on real generated code",async()=>{
    for(const code of [
      "import os,time,signal\nchildren=[]\nfor i in range(100):\n try:p=os.fork()\n except OSError:break\n if p==0:time.sleep(1);os._exit(0)\n children.append(p)\nassert 0<len(children)<=62\nfor p in children:os.waitpid(p,0)\nprint('pid limit verified',len(children))",
      "import errno\ntry:\n for i in range(20):\n  with open('/scratch/fill-'+str(i),'wb') as f:f.write(b'x'*16777216)\n raise AssertionError('scratch unexpectedly unbounded')\nexcept OSError as e:assert e.errno==errno.ENOSPC\nprint('scratch limit verified')"
    ]){
      const scope=await fixture(),result=await manager.analyze(scope,{operationId:randomUUID(),inputs:[],code});if(code.startsWith("import os,time")){expect(result.state).toBe("failed");expect(result.errorCode).toBe("SANDBOX_PID_LIMIT");expect(result.resourceEvidence?.pidDenials).toBeGreaterThan(0);}else{expect(result.state,JSON.stringify({error:result.errorCode,stderr:result.stderr})).toBe("completed");expect(result.stdout).toContain("limit verified");}await manager.finalize(scope,result.allocationId);
    }
    const memory=await fixture(),oom=await manager.analyze(memory,{operationId:randomUUID(),inputs:[],code:"x=bytearray(900*1024*1024)\nprint('unexpected memory allowance')"});
    expect(oom.state).not.toBe("completed");expect(oom.exports).toEqual([]);await manager.finalize(memory,oom.allocationId);
    const timeout=await fixture();timeout.deadlineAt=new Date(Date.now()+2000);
    const stopped=await manager.analyze(timeout,{operationId:randomUUID(),inputs:[],code:"import time;time.sleep(20)"});expect(stopped.state).not.toBe("completed");await manager.destroy(timeout,stopped.allocationId);
  },30_000);
  it("serializes delayed launch against cleanup and retains capacity when status is unknown",async()=>{
    const scope=await fixture(), isolated=new SandboxManager(pool,manager.config);
    let release!:()=>void,entered!:()=>void;
    const barrier=new Promise<void>(done=>release=done),ready=new Promise<void>(done=>entered=done);
    const original=(isolated as any).launch.bind(isolated);
    (isolated as any).launch=async(...args:unknown[])=>{entered();await barrier;return original(...args);};
    const running=isolated.analyze(scope,{operationId:randomUUID(),inputs:[],code:"import time;time.sleep(1);print('done')"});
    await ready;
    const row=(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE task_id=$1",[scope.taskId])).rows[0];
    let cleaned=false;const cleanup=manager.destroy(scope,row.id).then(()=>{cleaned=true;});
    await new Promise(done=>setTimeout(done,100));expect(cleaned).toBe(false);
    release();await cleanup;await running;
    expect((await manager.status(scope,row.id)).state).toBe("destroyed");
    const properties=await exec("systemctl",["--user","show",row.unit_name,"--property=ActiveState"]);
    expect(properties.stdout).not.toContain("ActiveState=active");
    const second=await fixture(),result=await manager.analyze(second,{operationId:randomUUID(),inputs:[],code:"print('safe')"});
    const faultDirectory=await mkdtemp(join(tmpdir(),"kasitek-systemctl-fault-")),previousPath=process.env.PATH;
    await writeFile(join(faultDirectory,"systemctl"),"#!/bin/sh\nif [ \"$2\" = show ]; then exit 1; fi\nexec /usr/bin/systemctl \"$@\"\n",{mode:0o700});
    try {
      process.env.PATH=faultDirectory+":"+previousPath;
      await expect(isolated.destroy(second,result.allocationId)).rejects.toMatchObject({code:"SANDBOX_CLEANUP_PENDING"});
      expect((await manager.status(second,result.allocationId)).state).toBe("destroying");
      await expect(access(join(directory,result.allocationId))).resolves.toBeUndefined();
    } finally {process.env.PATH=previousPath;await rm(faultDirectory,{recursive:true,force:true});}
    await isolated.destroy(second,result.allocationId);
    expect((await manager.status(second,result.allocationId)).state).toBe("destroyed");
    const third=await fixture(),late=new SandboxManager(pool,manager.config);
    let allow!:()=>void,seen!:()=>void;
    const paused=new Promise<void>(done=>allow=done),detected=new Promise<void>(done=>seen=done);
    const available=late.available.bind(late);
    late.available=async()=>{const value=await available();seen();await paused;return value;};
    const notLaunched=late.analyze(third,{operationId:randomUUID(),inputs:[],code:"raise Exception('must not start')"});
    await detected;
    const waiting=(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE task_id=$1",[third.taskId])).rows[0];
    await manager.destroy(third,waiting.id);allow();
    await expect(notLaunched).rejects.toMatchObject({code:"SANDBOX_RESOURCE_EXPIRED"});
    expect((await manager.status(third,waiting.id)).state).toBe("destroyed");
    await expect(access(join(directory,waiting.id))).rejects.toBeDefined();
  },30_000);
  it("survives caller SIGKILL and cleans expired resources from an independent reaper process",async()=>{
    const scope=await fixture(),input={operationId:randomUUID(),inputs:[],code:"import time\ntime.sleep(2)\nopen('/scratch/output/recovered.txt','w').write('survived worker loss')"};
    const temporary=await mkdtemp(join(tmpdir(),"kasitek-sandbox-worker-")),path=join(temporary,"input.json");
    await writeFile(path,JSON.stringify({scope,request:input,configuration:manager.config}),{mode:0o600});
    const loader=require.resolve("tsx"),worker=spawn(process.execPath,["--import",loader,resolve(__dirname,"sandbox-worker-fixture.ts"),path],{env:{...process.env,AGENTS_DATABASE_URL:(pool.options as {connectionString:string}).connectionString},stdio:"ignore"});
    let reaper:ReturnType<typeof spawn>|undefined;
    try{
      let row:any;for(let attempt=0;attempt<200;attempt++){
        row=(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE task_id=$1",[scope.taskId])).rows[0];
        if(row?.state==="running"){const state=await exec("systemctl",["--user","show",row.unit_name,"--property=ActiveState"]);if(state.stdout.includes("ActiveState=active"))break;}
        await new Promise(done=>setTimeout(done,20));
      }
      expect(row?.state).toBe("running");worker.kill("SIGKILL");await new Promise<void>(done=>worker.once("exit",()=>done()));
      const recovered=await manager.analyze(scope,input);expect(recovered.state).toBe("completed");expect(Buffer.from(recovered.exports[0]!.content).toString()).toContain("survived worker loss");
      expect((await pool.query("SELECT count(*) FROM agents_platform.sandbox_commands WHERE allocation_id=$1",[row.id])).rows[0].count).toBe("1");
      await pool.query("UPDATE agents_platform.sandbox_allocations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[row.id]);
      reaper=spawn(process.execPath,["--import",loader,resolve(__dirname,"../src/composition/sandbox-reaper.ts")],{env:{...process.env,AGENTS_DATABASE_URL:(pool.options as {connectionString:string}).connectionString,AGENTS_SANDBOX_ENABLED:"1",AGENTS_SANDBOX_DIRECTORY:directory},stdio:"ignore"});
      for(let attempt=0;attempt<100;attempt++){const state=(await pool.query("SELECT state FROM agents_platform.sandbox_allocations WHERE id=$1",[row.id])).rows[0].state;if(state==="destroyed")break;await new Promise(done=>setTimeout(done,30));}
      expect((await pool.query("SELECT state FROM agents_platform.sandbox_allocations WHERE id=$1",[row.id])).rows[0].state).toBe("destroyed");
      await expect(access(join(directory,row.id))).rejects.toBeDefined();
    }finally{worker.kill("SIGKILL");if(reaper&&reaper.exitCode===null&&reaper.signalCode===null){reaper.kill("SIGTERM");await new Promise<void>(done=>reaper!.once("exit",()=>done()));}await rm(temporary,{recursive:true,force:true});}
  },30_000);
  it("reattaches from another manager and enforces cgroups, pid limits and independent reaping",async()=>{
    const scope=await fixture(),input={operationId:randomUUID(),inputs:[],code:"import time\nprint('started',flush=True)\ntime.sleep(2)\nopen('/scratch/output/result.txt','w').write('done')"};
    const running=manager.analyze(scope,input);
    let row:any;for(let attempt=0;attempt<100;attempt++){row=(await pool.query("SELECT * FROM agents_platform.sandbox_allocations WHERE task_id=$1",[scope.taskId])).rows[0];if(row?.state==="running")break;await new Promise(done=>setTimeout(done,20));}
    const properties=await exec("systemctl",["--user","show",row.unit_name,"--property=MemoryMax","--property=TasksMax","--property=CPUQuotaPerSecUSec"]);
    expect(properties.stdout).toContain("MemoryMax=536870912");expect(properties.stdout).toContain("TasksMax=64");expect(properties.stdout).toContain("CPUQuotaPerSecUSec=1s");
    const second=new SandboxManager(pool,manager.config);const attached=await second.analyze(scope,input),first=await running;expect(attached.commandId).toBe(first.commandId);expect(attached.state).toBe("completed");
    await pool.query("UPDATE agents_platform.sandbox_allocations SET lease_expires_at=now()-interval '1 second' WHERE id=$1",[first.allocationId]);expect(await second.reap()).toBe(1);
    expect((await manager.analyze(scope,input)).state).toBe("uncertain");
  },30_000);
});
