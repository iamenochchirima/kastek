import { connectFixtureModel } from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {PlatformStore} from "../src/product/agents/store";
import {defaultBusinessConfiguration} from "../src/contracts/contracts";
import {setupPlatformSchema} from "../src/composition/setup";
import {beginOperation,finishOperation,settleTask,reconcilePendingRoots} from "../src/execution/lifecycle/execution";
import {cleanupQueryEmbeddingAllocation} from "../src/capabilities/knowledge/query-embedding";
import {writeExecutionObject,reapExecutionObjects} from "../src/execution/artifacts/execution-objects";
import {PrivateObjectStore} from "../src/infrastructure/object-store";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("execution object ownership before private storage writes",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore;
 const database=`agents_execution_objects_${randomUUID().replaceAll("-","")}`,bodies=new Map<string,Uint8Array>();
 const storage:PrivateObjectStore={async put(key,bytes){bodies.set(key,Buffer.from(bytes));},async get(key){return bodies.get(key)!;},async delete(key){bodies.delete(key);}};
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);const target=new URL(url!);target.pathname=`/${database}`;pool=new Pool({connectionString:target.href,max:10});await setupPlatformSchema(pool);platform=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function fixture(){
  const account=await platform.ensureAccount({issuer:"http://execution-objects.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),org=await platform.createOrganization(account.id,"Object ownership"),scope={accountId:account.id,organizationId:org.id};
  await connectFixtureModel(pool,account.id,org.id);
  const config=defaultBusinessConfiguration(),agent=await platform.createAgent({...scope,name:"Agent",configuration:config}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply" as const,"knowledge.read" as const],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};
  await platform.createGrant({accountId:account.id,grant});const{task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Read"});
  const operationId=`tool:${task.id}:read`;await beginOperation(pool,task.id,{id:operationId,kind:"tool",name:"knowledge.search",request:{query:"guide"},reservedTokens:0,reservedMs:30000,retrySafe:true});
  return{task,operationId,key:`knowledge-query/${org.id}/${task.id}/${randomUUID()}/body`,bytes:Buffer.from("Private bounded receipt"),contentType:"application/json"};
 }
 it("records intent before PUT, joins duplicates and rejects key/content scope changes",async()=>{
  const f=await fixture();let puts=0;
  const checked={...storage,async put(key:string,bytes:Uint8Array,type:string){puts++;const row=(await pool.query("SELECT state FROM agents_platform.execution_objects WHERE object_key=$1",[key])).rows[0];expect(row.state).toBe("writing");await storage.put(key,bytes,type);}};
  await Promise.all([writeExecutionObject(pool,checked,{...f,taskId:f.task.id}),writeExecutionObject(pool,checked,{...f,taskId:f.task.id})]);expect(puts).toBe(1);
  await expect(writeExecutionObject(pool,checked,{...f,taskId:f.task.id,bytes:Buffer.from("changed")})).rejects.toMatchObject({code:"EXECUTION_OBJECT_CONFLICT"});
  await expect(writeExecutionObject(pool,checked,{...f,taskId:f.task.id,key:"other-tenant/body"})).rejects.toMatchObject({code:"EXECUTION_OBJECT_SCOPE_DENIED"});
 });
 it("tracks late writes through cancellation, retries DELETE and removes a late replica with its tombstone",async()=>{
  const f=await fixture();let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(done=>entered=done),barrier=new Promise<void>(done=>release=done);
  const pending=writeExecutionObject(pool,{...storage,async put(key,bytes,type){entered();await barrier;await storage.put(key,bytes,type);}},{...f,taskId:f.task.id});await ready;
  await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1",[f.task.id]);release();await pending;
  await settleTask(pool,f.task.id,{state:"cancelled"});const future=new Date(Date.now()+31000);
  await expect(reapExecutionObjects(pool,{...storage,async delete(){throw Error("Injected DELETE outage");}},future)).rejects.toThrow("DELETE outage");expect(bodies.has(f.key)).toBe(true);
  await reapExecutionObjects(pool,storage,future);expect(bodies.has(f.key)).toBe(false);
  bodies.set(f.key,f.bytes);await reapExecutionObjects(pool,storage,new Date(future.getTime()+61000));expect(bodies.has(f.key)).toBe(false);
 });
 it("keeps root settlement and usage ownership until query compute is confirmed destroyed",async()=>{
  const f=await fixture(),id=randomUUID();
  await pool.query(`INSERT INTO agents_platform.query_embedding_allocations(id,organization_id,task_id,operation_id,profile_release,input_digest,state,lease_expires_at)
   VALUES($1,$2,$3,$4,'fixture-profile',$5,'running',now()+interval '1 minute')`,[id,f.task.organization_id,f.task.id,f.operationId,"b".repeat(64)]);
  await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);await settleTask(pool,f.task.id,{state:"completed",output:"Confirmed answer"});
  expect((await pool.query("SELECT state,disposition FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toMatchObject({state:"cancel_requested",disposition:"pending_resources"});
  expect((await pool.query("SELECT settled_at FROM agents_platform.execution_roots WHERE root_task_id=$1",[f.task.id])).rows[0].settled_at).toBeNull();
  await expect(cleanupQueryEmbeddingAllocation(pool,{async destroy(){return{allocationId:id,state:"destroying"};}},id)).rejects.toMatchObject({code:"DOCUMENT_CLEANUP_PENDING"});await reconcilePendingRoots(pool);
  expect((await pool.query("SELECT state FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0].state).toBe("cancel_requested");
  await cleanupQueryEmbeddingAllocation(pool,{async destroy(){return{allocationId:id,state:"destroyed"};}},id);await reconcilePendingRoots(pool);
  expect((await pool.query("SELECT state,output FROM agents_platform.tasks WHERE id=$1",[f.task.id])).rows[0]).toMatchObject({state:"completed",output:"Confirmed answer"});
 });
 it("retains a linked durable query receipt after physical cleanup and task completion",async()=>{
  const f=await fixture();await writeExecutionObject(pool,storage,{...f,taskId:f.task.id});
  await pool.query(`INSERT INTO agents_platform.query_embedding_allocations(id,organization_id,task_id,operation_id,profile_release,input_digest,state,lease_expires_at,result_key,result_digest)
   VALUES($1,$2,$3,$4,'fixture-profile',$5,'destroyed',now(),$6,$5)`,[randomUUID(),f.task.organization_id,f.task.id,f.operationId,"a".repeat(64),f.key]);
  await finishOperation(pool,f.task.id,f.operationId,"completed",{},null,0);await settleTask(pool,f.task.id,{state:"completed"});
  await reapExecutionObjects(pool,storage,new Date(Date.now()+86400000));expect(bodies.has(f.key)).toBe(true);
 });
});
