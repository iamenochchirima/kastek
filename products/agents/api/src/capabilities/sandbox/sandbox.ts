import { execFile } from "node:child_process";
import { createHash,randomUUID } from "node:crypto";
import { access,mkdir,readFile,rm,writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute,join,resolve } from "node:path";
import { promisify } from "node:util";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { assertCurrentAuthority,loadExecution } from "../../execution/lifecycle/execution";
import { transaction } from "../../infrastructure/database";
import { guestRunner,hostRunner } from "./sandbox-programs";
const execute = promisify(execFile);
export const SANDBOX_PROFILE = Object.freeze({ id: "python-analysis-v1", cpu: 1, memoryBytes: 536_870_912,
  pids: 64, scratchBytes: 268_435_456, commandSeconds: 120, leaseSeconds: 600,
  inputBytes: 4_194_304, inputFiles: 32, outputFileBytes: 1_048_576, outputBytes: 4_194_304, outputFiles: 4, stdoutBytes: 65_536 });
export interface SandboxScope { organizationId: string; rootTaskId: string; taskId: string; deadlineAt: Date }
export interface SandboxInput { operationId: string; code: string; inputs: { name: string; content: Uint8Array }[] }
export interface SandboxResult { allocationId: string; commandId: string; state: "completed" | "failed" | "uncertain";
  exitCode: number | null; stdout: string; stderr: string; errorCode?: string;
  resourceEvidence?: {pidDenials:number;oomKills:number}; exports: { name: string; contentType: string; content: Uint8Array }[]; artifactRefs?: unknown[] }
export interface SandboxConfiguration { directory: string; runsc: string; rootfs: string }
const nameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/);
const receiptSchema = z.strictObject({ state: z.enum(["completed", "failed", "uncertain"]), exitCode: z.number().int().nullable(),
  stdout: z.string().max(65_536), stderr: z.string().max(65_536), errorCode: z.string().max(100).nullable().optional(),
  resourceEvidence: z.strictObject({pidDenials:z.number().int().nonnegative(),oomKills:z.number().int().nonnegative()}).optional(),
  exports: z.array(z.strictObject({ name: nameSchema, contentType: z.enum(["text/plain", "text/markdown", "application/json"]), base64: z.string().max(1_398_104) })).max(4) });
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const sleep = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
const fail = (code: string, message: string, status = 503) => new PlatformError(code, status, message);
export function sandboxManagerFromEnvironment(pool: Pool, env: NodeJS.ProcessEnv = process.env): SandboxManager | undefined {
  if (env.AGENTS_SANDBOX_ENABLED !== "1") return;
  const cache = env.AGENTS_SANDBOX_CACHE || join(homedir(), ".cache/kasitek-agents-sandbox");
  return new SandboxManager(pool, { directory: env.AGENTS_SANDBOX_DIRECTORY || join(cache, "allocations"),
    runsc: env.AGENTS_SANDBOX_RUNSC || join(cache, "gvisor/runsc"), rootfs: env.AGENTS_SANDBOX_ROOTFS || join(cache, "python-rootfs") });
}
export class SandboxManager {
  constructor(readonly pool: Pool, readonly config: SandboxConfiguration) {
    if (process.platform !== "linux" || process.arch !== "x64" || ![config.directory, config.runsc, config.rootfs].every(isAbsolute)) throw fail("SANDBOX_UNAVAILABLE", "The isolated sandbox backend is unavailable");
  }
  async available(): Promise<boolean> {
    try {
      const version = await execute(this.config.runsc, ["--version"], { timeout: 5_000, maxBuffer: 8192 });
      if (!version.stdout.includes("release-20261012.0")) return false;
      await access(join(this.config.rootfs, "usr/local/bin/python3.12"));
      const probe = "from pathlib import Path;g=next(x.split('::',1)[1].strip() for x in Path('/proc/self/cgroup').read_text().splitlines() if x.startswith('0::'));p=Path('/sys/fs/cgroup'+g);m=(p/'memory.max').read_text().strip();n=(p/'pids.max').read_text().strip();q,t=(p/'cpu.max').read_text().split();assert m!='max' and 0<int(m)<=536870912;assert n!='max' and 0<int(n)<=64;assert (p/'memory.swap.max').read_text().strip()=='0';assert q!='max' and 0<int(q)<=int(t)";
      await execute("systemd-run", ["--user", `--unit=kasitek-sandbox-probe-${randomUUID()}`, "--wait", "--pipe", "--collect",
        "--property=MemoryMax=536870912", "--property=MemorySwapMax=0", "--property=CPUQuota=100%", "--property=TasksMax=64", "--property=RuntimeMaxSec=5",
        "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "/usr/bin/python3", "-c", probe], { timeout: 10_000, maxBuffer: 8192 }); return true;
    } catch { return false; }
  }
  private directory(id: string) { z.uuid().parse(id); return join(resolve(this.config.directory), id); }
  private async verify(db: import("pg").PoolClient, scope: SandboxScope): Promise<Date> {
    for (const id of [scope.organizationId, scope.rootTaskId, scope.taskId]) z.uuid().parse(id);
    const row = (await db.query(`SELECT t.deadline_at,t.state,g.expires_at,g.revoked_at,v.configuration FROM agents_platform.tasks t
      JOIN agents_platform.execution_grants g ON g.id=t.grant_id JOIN agents_platform.agent_versions v ON v.id=t.version_id
      WHERE t.id=$1 AND t.organization_id=$2 AND t.root_task_id=$3 FOR SHARE OF t,g`, [scope.taskId, scope.organizationId, scope.rootTaskId])).rows[0];
    if (!row || !["accepted", "running"].includes(row.state) || row.revoked_at || new Date(row.expires_at).getTime() <= Date.now() ||
      !row.configuration.capabilities?.sandbox?.enabled || row.configuration.capabilities.sandbox.profileId !== SANDBOX_PROFILE.id) throw fail("SANDBOX_SCOPE_DENIED", "Sandbox access is unavailable", 403);
    await assertCurrentAuthority(db, await loadExecution(db, scope.taskId));
    const deadline = new Date(Math.min(new Date(row.deadline_at).getTime(), scope.deadlineAt.getTime()));
    if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now()) throw fail("SANDBOX_DEADLINE", "Task deadline reached", 409);
    return deadline;
  }
  async analyze(scope: SandboxScope, input: SandboxInput): Promise<SandboxResult> {
    z.string().min(1).max(128).parse(input.operationId); z.string().min(1).max(16_384).parse(input.code);
    if (Buffer.byteLength(input.code) > 16_384 || input.inputs.length > SANDBOX_PROFILE.inputFiles || input.inputs.reduce((sum, value) => sum + value.content.byteLength, 0) > SANDBOX_PROFILE.inputBytes) throw fail("SANDBOX_INPUT_LIMIT", "Sandbox inputs exceed the profile", 400);
    const names = input.inputs.map(item => nameSchema.parse(item.name));
    if (new Set(names).size !== names.length) throw fail("SANDBOX_INPUT_INVALID", "Input names must be unique", 400);
    const digest = hash(JSON.stringify({ code: input.code, inputs: input.inputs.map(item => ({ name: item.name, digest: hash(item.content) })).sort((a,b) => a.name.localeCompare(b.name)), profile: SANDBOX_PROFILE.id }));
    const admitted = await transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [scope.organizationId]);
      const existing = (await db.query(`SELECT a.*,c.id AS command_id,c.export_receipt FROM agents_platform.sandbox_allocations a JOIN agents_platform.sandbox_commands c ON c.allocation_id=a.id WHERE a.task_id=$1 AND a.operation_id=$2 FOR UPDATE OF a`, [scope.taskId, input.operationId])).rows[0];
      if (existing) {
        if (existing.organization_id !== scope.organizationId || existing.root_task_id !== scope.rootTaskId || existing.request_digest !== digest) throw fail("SANDBOX_OPERATION_CONFLICT", "Sandbox operation identity conflict", 409);
        return { row: existing, created: false };
      }
      const deadline = await this.verify(db, scope);
      const busy = (await db.query("SELECT root_task_id FROM agents_platform.sandbox_allocations WHERE organization_id=$1 AND state<>'destroyed'", [scope.organizationId])).rows;
      if (busy.length >= 2 || busy.some(row => row.root_task_id === scope.rootTaskId)) throw fail("SANDBOX_CAPACITY", "Sandbox capacity is busy", 429);
      const id = randomUUID(), commandId = randomUUID(), unit = `kasitek-sandbox-${id}.service`;
      const lease = new Date(Math.min(Date.now() + SANDBOX_PROFILE.leaseSeconds * 1000, deadline.getTime()));
      const row = (await db.query(`INSERT INTO agents_platform.sandbox_allocations(id,organization_id,root_task_id,task_id,operation_id,request_digest,profile_id,state,unit_name,lease_expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'provisioning',$8,$9) RETURNING *`, [id,scope.organizationId,scope.rootTaskId,scope.taskId,input.operationId,digest,SANDBOX_PROFILE.id,unit,lease])).rows[0];
      await db.query("INSERT INTO agents_platform.sandbox_commands(id,allocation_id,operation_id,state) VALUES($1,$2,$3,'prepared')", [commandId,id,input.operationId]);
      return { row: { ...row, command_id: commandId }, created: true };
    });
    const row = admitted.row;
    if (row.export_receipt) return { ...row.export_receipt, allocationId: row.id, commandId: row.command_id, exports: [] };
    if (row.state === "destroyed") return this.unknown(row.id,row.command_id,"SANDBOX_RESOURCE_EXPIRED");
    if (admitted.created) {
      if (!await this.available()) { await this.failStart(row.id,"SANDBOX_UNAVAILABLE"); throw fail("SANDBOX_UNAVAILABLE", "The isolated sandbox backend is unavailable"); }
      try { await this.lifecycle(row.id, async db => {
        const current=await this.status(scope,row.id,db);
        if(current.state!=="provisioning") throw fail("SANDBOX_RESOURCE_EXPIRED","Sandbox allocation is no longer launchable",409);
        await this.verify(db,scope);
        if(new Date(current.lease_expires_at).getTime()<=Date.now()) throw fail("SANDBOX_DEADLINE","Sandbox lease expired",409);
        await this.prepare(current,input,scope);
        await this.verify(db,scope);
        if(new Date(current.lease_expires_at).getTime()<=Date.now()) throw fail("SANDBOX_DEADLINE","Sandbox lease expired",409);
        await this.launch(current,scope,db);
      }); }
      catch (error) { await this.failStart(row.id,"SANDBOX_START_UNCERTAIN"); throw error instanceof PlatformError ? error : fail("SANDBOX_START_UNCERTAIN", "Sandbox start outcome is uncertain"); }
    }
    return this.attach(scope,row.id,row.command_id,row.unit_name,new Date(row.created_at));
  }
  private unknown(allocationId: string, commandId: string, errorCode = "SANDBOX_OUTCOME_UNCERTAIN"): SandboxResult { return { allocationId,commandId,state:"uncertain",exitCode:null,stdout:"",stderr:"",errorCode,exports:[] }; }
  private async failStart(id: string, errorCode: string) {
    await this.pool.query("UPDATE agents_platform.sandbox_allocations SET state='uncertain',updated_at=now() WHERE id=$1 AND state<>'destroyed'",[id]);
    await this.pool.query("UPDATE agents_platform.sandbox_commands c SET state='uncertain',error_code=$2,updated_at=now() FROM agents_platform.sandbox_allocations a WHERE c.allocation_id=a.id AND a.id=$1 AND a.state<>'destroyed'",[id,errorCode]);
  }
  private async prepare(row: Record<string, any>, input: SandboxInput, scope: SandboxScope) {
    const directory=this.directory(row.id), data=join(directory,"input/data");
    await mkdir(data,{recursive:true,mode:0o700});
    await writeFile(join(directory,"input/program.py"),input.code,{mode:0o444,flag:"wx"});
    await writeFile(join(directory,"input/runner.py"),guestRunner,{mode:0o444,flag:"wx"});
    for(const item of input.inputs) await writeFile(join(data,item.name),item.content,{mode:0o444,flag:"wx"});
    // The guest uid needs search permission; the bind remains read-only inside gVisor.
    const {chmod}=await import("node:fs/promises"); await chmod(join(directory,"input"),0o755);await chmod(data,0o755);
    const seconds=Math.max(1,Math.min(SANDBOX_PROFILE.commandSeconds,Math.floor((Math.min(scope.deadlineAt.getTime(),new Date(row.lease_expires_at).getTime())-Date.now())/1000)));
    const spec={ociVersion:"1.0.2",process:{terminal:false,user:{uid:65532,gid:65532},args:["/usr/local/bin/python3","-I","-B","/input/runner.py"],cwd:"/scratch",env:["PATH=/usr/local/bin:/usr/bin:/bin","PYTHONUNBUFFERED=1","PYTHONDONTWRITEBYTECODE=1"],noNewPrivileges:true,
      capabilities:{bounding:[],effective:[],permitted:[],inheritable:[],ambient:[]},rlimits:[{type:"RLIMIT_NPROC",hard:64,soft:64},{type:"RLIMIT_NOFILE",hard:128,soft:128},{type:"RLIMIT_FSIZE",hard:268435456,soft:268435456}]},
      root:{path:this.config.rootfs,readonly:true},hostname:"analysis",mounts:[{destination:"/proc",type:"proc",source:"proc"},{destination:"/scratch",type:"tmpfs",source:"tmpfs",options:["nosuid","nodev","noexec","mode=1777","size=268435456"]},
        {destination:"/input",type:"bind",source:join(directory,"input"),options:["rbind","ro","nosuid","nodev","noexec"]}],
      linux:{namespaces:[{type:"pid"},{type:"ipc"},{type:"uts"},{type:"mount"},{type:"network"}],maskedPaths:["/proc/kcore","/proc/keys","/proc/timer_list","/sys/firmware"],readonlyPaths:["/proc/sys","/proc/sysrq-trigger"]}};
    await writeFile(join(directory,"config.json"),JSON.stringify(spec),{mode:0o600,flag:"wx"});
    await writeFile(join(directory,"host.py"),hostRunner,{mode:0o400,flag:"wx"});
    await writeFile(join(directory,"launch.json"),JSON.stringify({runsc:this.config.runsc,state:join(directory,"state"),bundle:directory,containerId:`analysis-${row.id}`,receipt:join(directory,"receipt.json"),started:join(directory,"started"),seconds}),{mode:0o600,flag:"wx"});
  }
  private async launch(row: Record<string, any>, scope: SandboxScope, db: import("pg").PoolClient) {
    const directory=this.directory(row.id),seconds=Math.max(1,Math.min(120,Math.floor((Math.min(scope.deadlineAt.getTime(),new Date(row.lease_expires_at).getTime())-Date.now())/1000)));
    await db.query("UPDATE agents_platform.sandbox_allocations SET state='running',updated_at=now() WHERE id=$1",[row.id]);
    await db.query("UPDATE agents_platform.sandbox_commands SET state='running',updated_at=now() WHERE allocation_id=$1",[row.id]);
    await execute("systemd-run",["--user",`--unit=${row.unit_name}`,"--property=MemoryMax=536870912","--property=MemorySwapMax=0","--property=CPUQuota=100%","--property=TasksMax=64",`--property=RuntimeMaxSec=${seconds}`,"--property=TimeoutStopSec=2","--property=KillMode=control-group","/usr/bin/env","-i","PATH=/usr/bin:/bin","/usr/bin/python3",join(directory,"host.py"),join(directory,"launch.json")],{timeout:10_000,maxBuffer:8192});
  }
  private async readReceipt(id: string) {
    try {
      const buffer=await readFile(join(this.directory(id),"receipt.json"));
      if(buffer.length>6_291_456) throw fail("SANDBOX_RESULT_LIMIT","Sandbox result exceeds its limit",502);
      const receipt=receiptSchema.parse(JSON.parse(buffer.toString("utf8")));
      if(Buffer.byteLength(receipt.stdout)+Buffer.byteLength(receipt.stderr)>65_536) throw fail("SANDBOX_STDOUT_LIMIT","Sandbox output exceeds its limit",502);
      let total=0;const names=new Set<string>();
      const exports=receipt.exports.map(item=>{const content=Buffer.from(item.base64,"base64");total+=content.length;
        if(content.length>1_048_576||total>4_194_304||names.has(item.name)||content.toString("base64")!==item.base64) throw fail("SANDBOX_EXPORT_INVALID","Sandbox export is invalid",502);
        const decoded=new TextDecoder("utf-8",{fatal:true}).decode(content);
        if(item.contentType==="application/json") JSON.parse(decoded);
        names.add(item.name);return{name:item.name,contentType:item.contentType,content};});
      return {...receipt,exports,errorCode:receipt.errorCode??undefined};
    } catch(error) {if((error as NodeJS.ErrnoException).code==="ENOENT") return;throw fail("SANDBOX_RESULT_INVALID","Sandbox result is invalid",502);}
  }
  private async unit(unit: string): Promise<Record<string,string>> {
    try {const result=await execute("systemctl",["--user","show",unit,"--property=LoadState","--property=ActiveState","--property=Result"],{timeout:5_000,maxBuffer:8192});return Object.fromEntries(result.stdout.trim().split("\n").map(line=>line.split("=",2)));}
    catch(error){
      const failure=error as {code?:unknown;killed?:boolean;signal?:unknown;stdout?:unknown};
      if(failure.code===1 && !failure.killed && !failure.signal && typeof failure.stdout==="string") {
        const properties=Object.fromEntries(failure.stdout.trim().split("\n").map(line=>line.split("=",2)));
        if(properties.LoadState==="not-found" && properties.ActiveState==="inactive")return properties;
      }
      return{LoadState:"unknown",ActiveState:"unknown"};
    }
  }
  private async lifecycle<T>(allocationId:string,work:(db:import("pg").PoolClient)=>Promise<T>):Promise<T> {
    z.uuid().parse(allocationId);
    return transaction(this.pool,async db=>{
      await db.query("SET LOCAL lock_timeout='5s'");
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`sandbox-lifecycle:${allocationId}`]);
      return work(db);
    });
  }
  async status(scope: SandboxScope, allocationId: string, db: Pool | import("pg").PoolClient = this.pool) {
    z.uuid().parse(allocationId);
    const row=(await db.query("SELECT * FROM agents_platform.sandbox_allocations WHERE id=$1 AND organization_id=$2 AND root_task_id=$3 AND task_id=$4",[allocationId,scope.organizationId,scope.rootTaskId,scope.taskId])).rows[0];
    if(!row) throw fail("SANDBOX_NOT_FOUND","Sandbox not found",404);return row;
  }
  private async attach(scope: SandboxScope,id: string,commandId: string,unit: string,createdAt: Date): Promise<SandboxResult> {
    while(true) {
      const row=await this.status(scope,id);
      const saved=(await this.pool.query("SELECT export_receipt FROM agents_platform.sandbox_commands WHERE id=$1",[commandId])).rows[0]?.export_receipt;
      if(saved) return{...saved,allocationId:id,commandId,exports:[]};
      if(row.state==="destroyed"||row.state==="destroying") return this.unknown(id,commandId,"SANDBOX_RESOURCE_EXPIRED");
      let receipt=await this.readReceipt(id);
      if(!receipt) {
        const state=await this.unit(unit);
        const terminal=state.LoadState==="not-found" ? Date.now()-createdAt.getTime()>10_000 : ["failed","inactive"].includes(state.ActiveState??"");
        if(terminal) {
          // The host publishes its atomic receipt before exit; it may appear between the first read and systemd status.
          receipt=await this.readReceipt(id);
          if(!receipt) {
            const errorCode=state.Result==="timeout"?"SANDBOX_TIMEOUT":state.Result==="oom-kill"?"SANDBOX_MEMORY_LIMIT":"SANDBOX_OUTCOME_UNCERTAIN";
            await this.failStart(id,errorCode);
            return this.unknown(id,commandId,errorCode);
          }
        }
      }
      if(receipt) {
        await this.pool.query("UPDATE agents_platform.sandbox_commands SET state=$2,exit_code=$3,error_code=$4,updated_at=now() WHERE id=$1",[commandId,receipt.state,receipt.exitCode,receipt.errorCode??null]);
        await this.pool.query("UPDATE agents_platform.sandbox_allocations SET state='awaiting_export',updated_at=now() WHERE id=$1 AND state IN ('running','provisioning','uncertain')",[id]);
        return{allocationId:id,commandId,...receipt};
      }
      if(new Date(row.lease_expires_at).getTime()<=Date.now()) {await this.destroy(scope,id);return this.unknown(id,commandId,"SANDBOX_RESOURCE_EXPIRED");}
      await sleep(100);
    }
  }
  async finalize(scope: SandboxScope, allocationId: string, artifactRefs: unknown[]=[]): Promise<void> {
    if(artifactRefs.length>4||Buffer.byteLength(JSON.stringify(artifactRefs))>16_384) throw fail("SANDBOX_EXPORT_INVALID","Artifact references exceed the profile",400);
    const row=await this.status(scope,allocationId),receipt=await this.readReceipt(allocationId);
    if(receipt) {
      const safe={state:receipt.state,exitCode:receipt.exitCode,stdout:receipt.stdout,stderr:receipt.stderr,errorCode:receipt.errorCode,resourceEvidence:receipt.resourceEvidence,artifactRefs};
      await this.pool.query("UPDATE agents_platform.sandbox_commands SET export_receipt=coalesce(export_receipt,$2::jsonb),updated_at=now() WHERE allocation_id=$1",[allocationId,JSON.stringify(safe)]);
    } else if(row.state!=="destroyed") {
      const safe=this.unknown(allocationId,(await this.pool.query("SELECT id FROM agents_platform.sandbox_commands WHERE allocation_id=$1",[allocationId])).rows[0].id);
      await this.pool.query("UPDATE agents_platform.sandbox_commands SET export_receipt=coalesce(export_receipt,$2::jsonb) WHERE allocation_id=$1",[allocationId,JSON.stringify({...safe,exports:undefined})]);
    }
    await this.destroy(scope,allocationId);
  }
  async destroy(scope: SandboxScope, allocationId: string): Promise<void> {
    const stopped=await this.lifecycle(allocationId,async db=>{
      const row=await this.status(scope,allocationId,db);if(row.state==="destroyed") return true;
      await db.query("UPDATE agents_platform.sandbox_allocations SET state='destroying',updated_at=now() WHERE id=$1",[allocationId]);
      try{await execute("systemctl",["--user","stop",row.unit_name],{timeout:10_000,maxBuffer:8192});}catch{/* A failed stop requires independent confirmation below. */}
      const state=await this.unit(row.unit_name);
      if(state.LoadState!=="not-found" && !["inactive","failed"].includes(state.ActiveState??"")) return false;
      await rm(this.directory(allocationId),{recursive:true,force:true});
      await db.query("UPDATE agents_platform.sandbox_allocations SET state='destroyed',updated_at=now() WHERE id=$1",[allocationId]);
      return true;
    });
    if(!stopped) throw fail("SANDBOX_CLEANUP_PENDING","Sandbox cleanup is pending");
  }
  async reap(): Promise<number> {
    const expired=(await this.pool.query(`SELECT a.* FROM agents_platform.sandbox_allocations a JOIN agents_platform.tasks t ON t.id=a.root_task_id JOIN agents_platform.tasks owner ON owner.id=a.task_id
      WHERE a.state<>'destroyed' AND (a.lease_expires_at<=now() OR t.state IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested') OR owner.state IN ('completed','incomplete','refused','failed','cancelled','uncertain','cancel_requested')) ORDER BY a.created_at LIMIT 100`)).rows;
    let count=0,pending=false;
    for(const row of expired){try{await this.destroy({organizationId:row.organization_id,rootTaskId:row.root_task_id,taskId:row.task_id,deadlineAt:new Date(row.lease_expires_at)},row.id);count++;}catch{pending=true;}}
    if(pending)throw fail("SANDBOX_CLEANUP_PENDING","Sandbox cleanup is pending");
    return count;
  }
}
