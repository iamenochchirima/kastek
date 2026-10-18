import { randomUUID } from "node:crypto";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { setupPlatformSchema } from "../src/platform/setup";
import { PlatformStore } from "../src/platform/store";
import { defaultFaqConfiguration, executionGrantSchema } from "../src/platform/contracts";
import { beginOperation, finishOperation, settleTask } from "../src/platform/execution";
import { TaskArtifactStore } from "../src/platform/task-artifacts";
import { ArtifactStore, type PrivateObjectStore } from "../src/platform/artifacts";
import { createSandboxExecutor } from "../src/platform/sandbox-executor";
import type { SandboxManager } from "../src/platform/sandbox";

const dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl?describe:describe.skip)("task artifact authorization with real PostgreSQL and controlled object transport",()=>{
  let admin:Pool,pool:Pool,platform:PlatformStore,artifacts:TaskArtifactStore;
  const database=`agents_task_artifacts_${randomUUID().replaceAll("-","")}`;
  const bodies=new Map<string,Uint8Array>();
  const objects:PrivateObjectStore={async put(k,b){bodies.set(k,Buffer.from(b));},async get(k){const b=bodies.get(k);if(!b)throw Error("Missing object");return b;},async delete(k){bodies.delete(k);}};
  beforeAll(async()=>{admin=new Pool({connectionString:dbUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(dbUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);
    platform=new PlatformStore(pool);artifacts=new TaskArtifactStore(pool,objects);});
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function fixture(){
    const account=await platform.ensureAccount({issuer:"http://localhost/task-artifact-test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const organization=await platform.createOrganization(account.id,"Private reports"),config=defaultFaqConfiguration();
    config.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};config.tools=["sandbox.analyze"];
    const agent=await platform.createAgent({accountId:account.id,organizationId:organization.id,name:"Analyst",configuration:config});
    const version=await platform.createVersion({accountId:account.id,organizationId:organization.id,agentId:agent.id,expectedRevision:1});
    const authority={product:"agents" as const,organizationId:organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
    const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","sandbox.execute","artifact.read","artifact.write"],maxInputBytes:16384,maxOutputTokens:1024,expiresAt:new Date(Date.now()+60_000).toISOString(),revokedAt:null});
    await platform.createGrant({accountId:account.id,grant});
    const {task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,input:"Analyze authorized data",requestKey:randomUUID()});
    const operationId=`analysis:${task.id}`;
    await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"sandbox.analyze",request:{code:"sum([10,20,30])"},reservedTokens:0,reservedMs:120000});
    return {account,organization,task,operationId};
  }
  const input={name:"report.json",contentType:"application/json",content:Buffer.from('{"total":60}'),sourceReferences:[]};
  it("deduplicates immutable output and retains authorized download after task completion",async()=>{
    const f=await fixture(),a=await artifacts.put(f.task.id,f.operationId,input);
    expect((await artifacts.put(f.task.id,f.operationId,input)).id).toBe(a.id);
    await expect(artifacts.put(f.task.id,f.operationId,{...input,content:Buffer.from("changed")})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
    expect(a.rootTaskId).toBe(f.task.id);expect((await artifacts.listForRoot(f.task.id)).map(x=>x.id)).toEqual([a.id]);
    const managed=new ArtifactStore(pool,objects),scope={accountId:f.account.id,organizationId:f.organization.id,agentId:f.task.resource_id};
    expect(await managed.list(scope)).toEqual([]);
    await expect(managed.get(scope,a.id)).rejects.toMatchObject({code:"NOT_FOUND"});
    await expect(managed.forget(scope,a.id)).rejects.toMatchObject({code:"NOT_FOUND"});
    await finishOperation(pool,f.task.id,f.operationId,"completed",{artifactIds:[a.id]},null,0);
    await settleTask(pool,f.task.id,{state:"completed",output:"Report generated"});
    const result=await artifacts.download(f.account.id,f.organization.id,f.task.id,a.id);
    expect(Buffer.from(result.content).toString()).toBe('{"total":60}');
  });
  it("denies another user and another root, including the same user in another task",async()=>{
    const f=await fixture(),other=await fixture(),a=await artifacts.put(f.task.id,f.operationId,input);
    await expect(artifacts.download(other.account.id,f.organization.id,f.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
    await expect(artifacts.readForTask(other.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
    await expect(artifacts.download(f.account.id,other.organization.id,f.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
  });
  it("rejects unsafe names, unknown producing operations and oversized content",async()=>{
    const f=await fixture();
    await expect(artifacts.put(f.task.id,f.operationId,{...input,name:"../secret"})).rejects.toThrow();
    await expect(artifacts.put(f.task.id,"not-admitted",input)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
    await expect(artifacts.put(f.task.id,f.operationId,{...input,content:Buffer.alloc(1048577)})).rejects.toMatchObject({code:"ARTIFACT_TOO_LARGE"});
  });
  it("source deletion, membership and root grant revocation block future downloads",async()=>{
    for(const mode of ["source","membership","grant"]){const f=await fixture(),a=await artifacts.put(f.task.id,f.operationId,input);
      if(mode==="source")await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[f.task.conversation_id]);
      if(mode==="membership")await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE account_id=$1",[f.account.id]);
      if(mode==="grant")await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.task.grant_id]);
      await expect(artifacts.download(f.account.id,f.organization.id,f.task.id,a.id)).rejects.toMatchObject({code:"ARTIFACT_NOT_FOUND"});
    }
  });
  it("never launches analysis after the outer operation deadline expires during an input read",async()=>{
    const f=await fixture(),artifact=await artifacts.put(f.task.id,f.operationId,input);
    let entered!:()=>void,release!:(value:any)=>void;
    const reading=new Promise<void>(resolve=>{entered=resolve;}),blocked=new Promise<any>(resolve=>{release=resolve;});
    const read=vi.spyOn(TaskArtifactStore.prototype,"readForTask").mockImplementation(async()=>{entered();return blocked;});
    const manager={analyze:vi.fn(),finalize:vi.fn()} as unknown as SandboxManager;
    vi.useFakeTimers();
    try {
      const execution=createSandboxExecutor(pool,manager,objects)(f.task.id,f.operationId,{code:"print(60)",inputArtifactIds:[artifact.id]});
      const outcome=expect(execution).rejects.toMatchObject({code:"SANDBOX_OPERATION_TIMEOUT",outcome:"uncertain"});
      await reading;await vi.advanceTimersByTimeAsync(240000);await outcome;
      release({artifact,content:input.content});await Promise.resolve();await Promise.resolve();
      expect(manager.analyze).not.toHaveBeenCalled();expect(manager.finalize).not.toHaveBeenCalled();
    } finally {read.mockRestore();vi.useRealTimers();}
  });
});
