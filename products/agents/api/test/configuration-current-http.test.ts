import { connectFixtureModel } from "./model-fixture";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { settleTask } from "../src/execution/lifecycle/execution";
import { assertBaseAuthority } from "../src/execution/lifecycle/authority";
import { loadExecution } from "../src/execution/lifecycle/state";
import { transaction } from "../src/infrastructure/database";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("current configuration through public HTTP",()=>{
 const database=`agents_current_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool,store:PlatformStore,app:Awaited<ReturnType<typeof buildPlatformApp>>,endpoint:string;
 const origin="http://localhost:3100";
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href,max:12});await setupPlatformSchema(pool);store=new PlatformStore(pool);app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,AGENTS_PUBLIC_URL:origin,AGENTS_OIDC_CLIENT_SECRET:"current-config-fixture-secret",OPENROUTER_API_KEY:"not-sent-to-model"})});endpoint=await app.listen({port:0,host:"127.0.0.1"});});
 afterAll(async()=>{await app?.close();await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}});
 async function request(path:string,payload?:unknown,cookie?:string,token?:string,method=payload===undefined?"GET":"POST"){
  const response=await fetch(endpoint+path,{method,headers:{origin,...(payload!==undefined?{"content-type":"application/json"}:{}),...(cookie?{cookie}:{}),...(token?{authorization:`Bearer ${token}`}:{})},...(payload!==undefined?{body:JSON.stringify(payload)}:{})});return{status:response.status,body:await response.json()};
 }
 async function fixture(){const account=await store.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"current@example.test",displayName:"Owner"});const organization=await store.createOrganization(account.id,"Current settings");await connectFixtureModel(pool,account.id,organization.id);const session=await store.createSession({accountId:account.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+600000)});const cookie=`agents_session=${session.token}`,base=`/api/organizations/${organization.id}`;const created=await request(base+"/agents",{name:"Customer support"},cookie);expect(created.status).toBe(201);return{account,org:organization.id,cookie,base,agent:created.body.agent,snapshot:created.body.snapshot};}
 it("creates ready agents, saves current settings, continues one conversation and replays the original snapshot",async()=>{
  const f=await fixture();expect(f.snapshot.id).toBeTruthy();const payload={agentId:f.agent.id,input:"Hi",requestKey:` ${randomUUID()} `};
  const first=await request(f.base+"/tasks",payload,f.cookie);expect(first.status).toBe(202);expect(first.body.task.versionId).toBe(f.snapshot.id);
  const config={...f.agent.draft,instructions:"Respond with the saved support instructions."};const saved=await request(`${f.base}/agents/${f.agent.id}/configuration`,{configuration:config,expectedRevision:f.agent.draftRevision},f.cookie);expect(saved.status).toBe(200);expect(saved.body.snapshot.id).not.toBe(f.snapshot.id);
  const accepted=await loadExecution(pool,first.body.task.id);expect(accepted.configuration.instructions).toBe(f.agent.draft.instructions);await expect(transaction(pool,db=>assertBaseAuthority(db,accepted))).resolves.toBeUndefined();
  const grantsBefore=(await pool.query("SELECT count(*) FROM agents_platform.execution_grants")).rows[0].count;
  const replay=await request(f.base+"/tasks",payload,f.cookie);expect(replay.status).toBe(200);expect(replay.body.task.id).toBe(first.body.task.id);expect(replay.body.task.versionId).toBe(f.snapshot.id);expect((await pool.query("SELECT count(*) FROM agents_platform.execution_grants")).rows[0].count).toBe(grantsBefore);
  expect((await request(f.base+"/tasks",{...payload,input:"Different input"},f.cookie)).status).toBe(409);
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[first.body.task.id]);
  await settleTask(pool,first.body.task.id,{state:"completed",output:"Hello"});
  const next=await request(f.base+"/tasks",{agentId:f.agent.id,input:"Next message",requestKey:randomUUID(),conversationId:first.body.task.conversationId},f.cookie);expect(next.status).toBe(202);expect(next.body.task.versionId).toBe(saved.body.snapshot.id);expect(next.body.task.conversationId).toBe(first.body.task.conversationId);
  const history=await request(`${f.base}/conversations/${first.body.task.conversationId}`,undefined,f.cookie);expect(history.status).toBe(200);expect(history.body.tasks.map((task:any)=>task.versionId)).toEqual([f.snapshot.id,saved.body.snapshot.id]);
  expect((await request(f.base+"/tasks",{versionId:f.snapshot.id,input:"Explicit old version",requestKey:randomUUID(),conversationId:first.body.task.conversationId},f.cookie)).body.error.code).toBe("CONVERSATION_VERSION_CONFLICT");
  await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[first.body.task.conversationId]);
  const deletedReplay=await request(f.base+"/tasks",payload,f.cookie);expect(deletedReplay.status).toBe(403);expect(deletedReplay.body.error.code).toBe("CONVERSATION_DELETED");
 });
 it("rejects ambiguous agent/snapshot selection and requires explicit snapshots for evaluations",async()=>{const f=await fixture();expect((await request(f.base+"/tasks",{agentId:f.agent.id,versionId:f.snapshot.id,input:"Hi",requestKey:randomUUID()},f.cookie)).status).toBe(400);expect((await request(f.base+"/tasks",{agentId:f.agent.id,evaluationTrialId:randomUUID(),input:"Hi",requestKey:randomUUID()},f.cookie)).status).toBe(400);});
 it("keeps website URLs, sessions, Inbox ownership and per-turn snapshots through confirmed saves",async()=>{
  const f=await fixture();const published=await request(`${f.base}/agents/${f.agent.id}/deployments`,{allowedOrigins:[origin]},f.cookie);expect(published.status).toBe(201);const deployment=published.body.deployment,web=`/api/website/${deployment.id}`;const session=await request(web+"/session",{});expect(session.status).toBe(201);const token=session.body.token;
  const input={input:"Hello support",requestKey:randomUUID()};const first=await request(web+"/tasks",input,undefined,token);expect(first.status).toBe(202);const previous=await loadExecution(pool,first.body.task.id);
  const configuration={...f.agent.draft,instructions:"Use the new support instructions."};const payload={configuration,expectedRevision:f.agent.draftRevision};const denied=await request(`${f.base}/agents/${f.agent.id}/configuration`,payload,f.cookie);expect(denied.status).toBe(409);expect(denied.body.error.code).toBe("CONFIGURATION_CONFIRMATION_REQUIRED");
  const saved=await request(`${f.base}/agents/${f.agent.id}/configuration`,{...payload,confirmImpact:true},f.cookie);expect(saved.status).toBe(200);expect(saved.body.deployments[0].id).toBe(deployment.id);
  await expect(transaction(pool,db=>assertBaseAuthority(db,previous))).resolves.toBeUndefined();
  const next=await request(web+"/tasks",{input:"Follow up",requestKey:randomUUID(),conversationId:first.body.task.conversationId},undefined,token);expect(next.status).toBe(202);expect(next.body.task.versionId).toBe(saved.body.snapshot.id);expect(next.body.task.conversationId).toBe(first.body.task.conversationId);expect(next.body.customerConversationId).toBe(first.body.customerConversationId);
  await expect(transaction(pool,async db=>assertBaseAuthority(db,await loadExecution(db,next.body.task.id)))).resolves.toBeUndefined();
  await expect(transaction(pool,db=>assertBaseAuthority(db,previous))).resolves.toBeUndefined();
  await pool.query("UPDATE agents_platform.tasks SET state='running' WHERE id=$1",[first.body.task.id]);
  await settleTask(pool,first.body.task.id,{state:"completed",output:"Original settings answer"});
  const replay=await request(web+"/tasks",input,undefined,token);expect(replay.status).toBe(200);expect(replay.body.task.id).toBe(first.body.task.id);
  const oldTask=await request(web+"/tasks/"+first.body.task.id,undefined,undefined,token);expect(oldTask.status).toBe(200);expect(oldTask.body.task.versionId).toBe(f.snapshot.id);
 });
});
