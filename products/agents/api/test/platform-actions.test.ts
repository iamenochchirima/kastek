import {randomBytes,randomUUID} from "node:crypto";
import {Pool} from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {defaultFaqConfiguration,executionGrantSchema} from "../src/contracts/contracts";
import {beginOperation} from "../src/execution/lifecycle/execution";
import {TaskArtifactStore} from "../src/execution/artifacts/task-artifacts";
import {ConnectionVault} from "../src/infrastructure/vault";
import {ConnectionStore} from "../src/product/connections/connections";
import {ActionService} from "../src/workflows/report-delivery/actions";
import {ReportDeliveryHTTP,deliveryTargetsFromEnvironment} from "../src/adapters/providers/report-delivery";
import {initializeReportReceiver,createReportReceiver} from "../src/acceptance/report-receiver";
const dbUrl=process.env.AGENTS_TEST_DATABASE_URL;
(dbUrl?describe:describe.skip)("exact reviewed report delivery with real PostgreSQL and HTTP receiver",()=>{
 let admin:Pool,pool:Pool,platform:PlatformStore,artifacts:TaskArtifactStore,connections:ConnectionStore,actions:ActionService,receiver:ReturnType<typeof createReportReceiver>;
 const database=`agents_actions_${randomUUID().replaceAll("-","")}`,key="receiver-scoped-acceptance-key",bodies=new Map<string,Uint8Array>();
 let target:{id:string;label:string;url:string;resource:string},loseResponse=false;
 const vault=new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")});
 beforeAll(async()=>{
  admin=new Pool({connectionString:dbUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(dbUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);await initializeReportReceiver(pool);
  receiver=createReportReceiver({pool,keys:[{apiKey:key,resource:"reports:test"}],afterAccept:async()=>{if(loseResponse)throw Error("Injected lost acceptance response");}});
  const address=await receiver.listen({host:"127.0.0.1",port:0});target={id:"local-report",label:"Acceptance report receiver",url:address+"/deliveries",resource:"reports:test"};
  platform=new PlatformStore(pool);artifacts=new TaskArtifactStore(pool,{async put(k,b){bodies.set(k,Buffer.from(b));},async get(k){const b=bodies.get(k);if(!b)throw Error();return b;},async delete(k){bodies.delete(k);}});
  connections=new ConnectionStore(pool,vault,[target]);actions=new ActionService(pool,{vault,targets:[target],artifacts});
 });
 afterAll(async()=>{await receiver?.close();await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);await admin.end();}});
 async function fixture(){
  const account=await platform.ensureAccount({issuer:"http://localhost/actions",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"}),organization=await platform.createOrganization(account.id,"Reports");
  const scope={accountId:account.id,organizationId:organization.id},connection=await connections.create(scope,{operationId:randomUUID(),name:"Reports",targetId:target.id,apiKey:key});
  const config=defaultFaqConfiguration();config.capabilities.sandbox={enabled:true,profileId:"python-analysis-v1"};config.capabilities.workflows={enabled:true,profileId:"report-delivery-v1",connectionId:connection.id,reportArtifactName:"report.json",title:"Analysis"};config.tools=["sandbox.analyze"];
  const agent=await platform.createAgent({accountId:account.id,organizationId:organization.id,name:"Reporter",configuration:config}),version=await platform.createVersion({accountId:account.id,organizationId:organization.id,agentId:agent.id,expectedRevision:1});
  const authority={product:"agents" as const,organizationId:organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:account.issuer,subject:account.subject}};
  const grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","knowledge.read","sandbox.execute","artifact.read","artifact.write","effect.deliver"],maxInputBytes:16384,maxOutputTokens:1024,expiresAt:new Date(Date.now()+60_000).toISOString(),revokedAt:null});await platform.createGrant({accountId:account.id,grant});
  const {task}=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Prepare a report"}),operationId=`analysis:${task.id}`;
  await beginOperation(pool,task.id,{id:operationId,kind:"resource",name:"sandbox.analyze",request:{code:"analysis"},reservedTokens:0,reservedMs:240000});
  const artifact=await artifacts.put(task.id,operationId,{name:"report.json",contentType:"application/json",content:Buffer.from('{"total":42}')});
  const action=await actions.prepare(task.id,`report:${task.id}:deliver`,{connectionId:connection.id,artifactId:artifact.id,title:"Analysis"});return{scope,task,connection,artifact,action,grant};
 }
 async function approve(f:Awaited<ReturnType<typeof fixture>>){return actions.decide(f.scope,f.task.id,f.action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:f.action.reviewDigest});}
 it("encrypts credentials with authenticated tenant/revision binding and fails closed on tamper",async()=>{
  const envelope=vault.seal(randomUUID(),randomUUID(),1,key);expect(JSON.stringify(envelope)).not.toContain(key);
  expect(()=>vault.open(randomUUID(),randomUUID(),1,envelope)).toThrow();
  const f=await fixture();const stored=(await pool.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1",[f.connection.id])).rows[0].envelope;
  expect(JSON.stringify(stored)).not.toContain(key);expect(JSON.stringify(await connections.list(f.scope))).not.toContain(key);
  expect(vault.open(f.scope.organizationId,f.connection.id,1,stored)).toBe(key);
  expect(()=>vault.open(f.scope.organizationId,f.connection.id,2,stored)).toThrow();
 });
 it("requires exact review, consumes one claim and accepts one persistent idempotent delivery",async()=>{
  const f=await fixture();expect(f.action.preview.content).toBe('{"total":42}');expect((await actions.deliver(f.task.id,f.action.id)).state).toBe("pending_review");
  expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("0");
  await expect(actions.decide(f.scope,f.task.id,f.action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:"a".repeat(64)})).rejects.toMatchObject({code:"REVIEW_DIGEST_CONFLICT"});
  await approve(f);const [a,b]=await Promise.all([actions.deliver(f.task.id,f.action.id),actions.deliver(f.task.id,f.action.id)]);expect([a.state,b.state]).toContain("delivered");
  const recovered=await actions.reconcile(f.action.id);expect(recovered.state).toBe("delivered");expect(recovered.receipt?.payloadDigest).toBe(f.action.payloadDigest);
  expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("1");
  const serialized=JSON.stringify(recovered);expect(serialized).not.toContain(key);
 });
 it("reconciles accepted delivery after lost response and root revocation without another POST",async()=>{
  const f=await fixture();await approve(f);loseResponse=true;
  try{expect((await actions.deliver(f.task.id,f.action.id)).state).toBe("uncertain");}finally{loseResponse=false;}
  await platform.revokeGrant(f.scope.accountId,f.scope.organizationId,f.grant.id);
  await pool.query("UPDATE agents_platform.tasks SET deadline_at=now()-interval '1 second',state='cancel_requested' WHERE id=$1",[f.task.id]);
  expect((await new ActionService(pool,{vault,targets:[target],artifacts}).reconcile(f.action.id)).state).toBe("delivered");
  expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("1");
 });
 it("rotation/revocation, cancelled authority, expired approval and changed destination prevent delivery",async()=>{
  for(const mode of ["rotate","revoke","cancel","expire","destination","connection-expiry","grant","source"]){const f=await fixture();await approve(f);
   if(mode==="rotate"||mode==="revoke")await connections.mutate(f.scope,f.connection.id,{operationId:randomUUID(),expectedRevision:1,...(mode==="rotate"?{apiKey:"different-valid-api-key"}:{})},mode);
   if(mode==="connection-expiry")await pool.query("UPDATE agents_platform.connections SET expires_at=now()-interval '1 second' WHERE id=$1",[f.connection.id]);
   if(mode==="grant")await platform.revokeGrant(f.scope.accountId,f.scope.organizationId,f.grant.id);
   if(mode==="source")await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[f.task.conversation_id]);
   if(mode==="cancel")await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1",[f.task.id]);
   if(mode==="expire")await pool.query("UPDATE agents_platform.actions SET expires_at=now()-interval '1 second' WHERE id=$1",[f.action.id]);
   const service=mode==="destination"?new ActionService(pool,{vault,artifacts,targets:[{...target,url:target.url+"-changed"}]}):actions;
   try{const result=await service.deliver(f.task.id,f.action.id);expect(result.state).not.toBe("delivered");}catch(error){expect(error).toBeDefined();}
   expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("0");
  }
 });
 it("renewed approval copies exact expired grant scope and rejects concurrent or unauthorized decisions",async()=>{
  const f=await fixture();await pool.query("UPDATE agents_platform.execution_grants SET created_at=now()-interval '1 hour',expires_at=now()-interval '1 minute' WHERE id=$1",[f.grant.id]);
  const account=await platform.ensureAccount({issuer:"http://localhost/actions",subject:randomUUID(),email:"other@example.test",displayName:"Other"});
  await expect(actions.decide({...f.scope,accountId:account.id},f.task.id,f.action.id,{operationId:randomUUID(),decision:"approve",expectedDigest:f.action.reviewDigest})).rejects.toMatchObject({code:"ACCESS_DENIED"});
  const results=await Promise.allSettled([approve(f),actions.decide(f.scope,f.task.id,f.action.id,{operationId:randomUUID(),decision:"reject",expectedDigest:f.action.reviewDigest})]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
  const state=await actions.get(f.task.id,f.action.id);
  if(state.state==="approved"){
   const current=(await pool.query("SELECT g.* FROM agents_platform.tasks t JOIN agents_platform.execution_grants g ON g.id=t.grant_id WHERE t.id=$1",[f.task.id])).rows[0];expect(current.id).not.toBe(f.grant.id);expect(current.operations).toEqual(f.grant.operations);expect(current.source_revision_ids).toEqual(f.grant.sourceRevisionIds);
  }
 });
 it("memory source changes invalidate reviewed artifacts through recursive provenance",async()=>{
  for(const expiry of [false,true]){
   const f=await fixture(),scopeId=randomUUID();
   await pool.query("INSERT INTO agents_platform.memory_scopes(id,organization_id,agent_id,account_id,generation) VALUES($1,$2,$3,$4,1)",[scopeId,f.scope.organizationId,f.task.resource_id,f.scope.accountId]);
   const ancestor=await artifacts.put(f.task.id,`analysis:${f.task.id}`,{name:"ancestor.json",contentType:"application/json",content:Buffer.from('{"source":1}'),sourceReferences:[{kind:"memory_scope",id:scopeId,generation:1,...(expiry?{expiresAt:Date.now()+60000}:{})}]});
   await pool.query("UPDATE agents_platform.artifacts SET source_references=$2 WHERE id=$1",[f.artifact.id,JSON.stringify([{kind:"artifact",id:ancestor.id}])]);
   await approve(f);
   if(expiry)await pool.query("UPDATE agents_platform.memory_scopes SET next_expiry_at=now()-interval '1 second' WHERE id=$1",[scopeId]);
   else await pool.query("UPDATE agents_platform.memory_scopes SET generation=2 WHERE id=$1",[scopeId]);
   await expect(actions.deliver(f.task.id,f.action.id)).rejects.toBeDefined();
   expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("0");
   expect((await actions.listForTask(f.scope,f.task.id))[0]!.preview.content).toBe("[Report source unavailable]");
  }
 });
 it("a cancellation after committed claim preserves and reconciles the external acceptance",async()=>{
  const f=await fixture();await approve(f);
  let start!:()=>void,release!:()=>void;const entered=new Promise<void>(done=>start=done),barrier=new Promise<void>(done=>release=done);
  const adapter=new ReportDeliveryHTTP(async(url,init)=>{if(init?.method==="POST"){start();await barrier;}return fetch(url,init);});
  const sender=new ActionService(pool,{vault,targets:[target],artifacts,adapter});
  const pending=sender.deliver(f.task.id,f.action.id);await entered;
  expect((await actions.get(f.task.id,f.action.id)).state).toBe("claimed");
  await pool.query("UPDATE agents_platform.tasks SET state='cancel_requested' WHERE id=$1",[f.task.id]);release();
  expect((await pending).state).toBe("delivered");
  expect((await pool.query("SELECT count(*) FROM report_delivery_receiver.deliveries WHERE id=$1",[f.action.id])).rows[0].count).toBe("1");
 });
 it("receiver enforces resource keys and same-key payload conflicts across receiver restart",async()=>{
  const f=await fixture();await approve(f);expect((await actions.deliver(f.task.id,f.action.id)).state).toBe("delivered");
  const row=(await pool.query("SELECT payload FROM agents_platform.actions WHERE id=$1",[f.action.id])).rows[0];
  const adapter=new ReportDeliveryHTTP();expect((await adapter.request(target,"wrong-resource-key",f.action.id,undefined,f.action.payloadDigest)).state).toBe("uncertain");
  const changed={...row.payload,title:"Altered"};const {requestDigest}=await import("../src/contracts/contracts");
  expect((await adapter.request(target,key,f.action.id,changed,requestDigest(changed))).state).toBe("failed");
  const port=new URL(target.url).port;await receiver.close();receiver=createReportReceiver({pool,keys:[{apiKey:key,resource:target.resource}]});await receiver.listen({host:"127.0.0.1",port:Number(port)});
  // A pooled connection may close during restart; a second status GET is safe reconciliation.
  let persisted=await adapter.request(target,key,f.action.id,undefined,f.action.payloadDigest);
  if(persisted.state==="uncertain")persisted=await adapter.request(target,key,f.action.id,undefined,f.action.payloadDigest);
  expect(persisted.state).toBe("delivered");
  expect((await actions.reconcile(f.action.id)).receipt?.id).toBe(f.action.id);
  expect(()=>deliveryTargetsFromEnvironment({NODE_ENV:"production",AGENTS_REPORT_DELIVERY_TARGETS:JSON.stringify([target])})).toThrow();
 });
});
