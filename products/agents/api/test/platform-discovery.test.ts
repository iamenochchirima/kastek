import { connectFixtureModel } from "./model-fixture";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {buildPlatformApp} from "../src/composition/app";
import {loadPlatformConfig} from "../src/infrastructure/config";
import {setupPlatformSchema} from "../src/composition/setup";
import {PlatformStore} from "../src/product/agents/store";
import {defaultBusinessConfiguration} from "../src/contracts/contracts";
import {transaction} from "../src/infrastructure/database";
import {resolveAcceptedModelRoutes} from "../src/execution/models/resolution";
import {saveTaskModelRoutes} from "../src/execution/models/persistence";
import {executionModelLayers} from "../src/execution/models/settings";
import type {InitiatingPrincipal} from "../src/contracts/contracts";
import type {Account} from "../src/contracts/records";
import {dropClosedTestDatabase} from "./support/database-cleanup";

const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("authorized server discovery and cursor pages",()=>{
  let admin:Pool,pool:Pool,store:PlatformStore,app:Awaited<ReturnType<typeof buildPlatformApp>>,endpoint:string;
  const database=`agents_discovery_${randomUUID().replaceAll("-","")}`,origin="http://localhost:3100";
  beforeAll(async()=>{
    admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);
    const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new PlatformStore(pool);
    app=await buildPlatformApp({pool,logging:false,config:loadPlatformConfig({NODE_ENV:"test",AGENTS_DATABASE_URL:url.href,AGENTS_PUBLIC_URL:origin,AGENTS_OIDC_CLIENT_SECRET:"discovery-offline-fixture-secret-only",OPENROUTER_API_KEY:"offline-never-sent"})});
    endpoint=await app.listen({port:0,host:"127.0.0.1"});
  });
  afterAll(async()=>{await app?.close();await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  async function actor(){const user=await store.ensureAccount({issuer:"http://localhost:8080/realms/kasitek",subject:randomUUID(),email:"test@example.test",displayName:"Test"});const session=await store.createSession({accountId:user.id,providerSessionId:randomUUID(),expiresAt:new Date(Date.now()+3600000)});return {user,cookie:`agents_session=${session.token}`};}
  async function get(path:string,cookie:string){const response=await fetch(endpoint+path,{headers:{cookie}});return {status:response.status,body:await response.json() as any};}
  async function fixture(){const f=await actor(),org=await store.createOrganization(f.user.id,"Read fixtures");await connectFixtureModel(pool,f.user.id,org.id);const agent=await store.createAgent({accountId:f.user.id,organizationId:org.id,name:"Research"}),version=await store.createVersion({accountId:f.user.id,organizationId:org.id,agentId:agent.id,expectedRevision:1});return {...f,org:org.id,agent:agent.id,version:version.id,base:`/api/organizations/${org.id}`};}
  async function seed(f:Awaited<ReturnType<typeof fixture>>,user:Account=f.user,conversationId?:string,count=1,options:{principal?:InitiatingPrincipal;callerClientId?:string;resourceId?:string;parentTaskId?:string}={}){
    const principal=options.principal??{kind:"human",issuer:user.issuer,subject:user.subject},conversation=conversationId??randomUUID(),grant=randomUUID(),callerClientId=options.callerClientId??"agents-execution",resourceId=options.resourceId??f.agent;
    if(!conversationId)await pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)",[conversation,f.org,f.agent,principal]);
    const configuration=defaultBusinessConfiguration();
    // Deterministic already-completed fixture tasks do not invoke a worker or consume a model budget.
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,source_revision_ids,max_input_bytes,max_output_tokens,expires_at)
      VALUES($1,'agents',$2,$3,$6,$4,$5,'["model.reply"]'::jsonb,ARRAY[]::uuid[],$7,$8,now()+interval '1 hour')`,[grant,f.org,resourceId,principal,f.version,callerClientId,configuration.model.maxInputBytes,configuration.model.maxOutputTokens]);
    const models=await transaction(pool,db=>resolveAcceptedModelRoutes(db,{organizationId:f.org,agentId:f.agent,product:"agents",selection:configuration.model.selection,layers:executionModelLayers(configuration,{id:grant,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000}),requiresTools:false}));
    const ids:string[]=[];for(let i=0;i<count;i++){const id=randomUUID();ids.push(id);await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,output,turn_sequence,effective_composition,caller_client_id,root_task_id,parent_task_id,depth)
      VALUES($1::uuid,'agents',$2,$3,$4,$5,$6,$7,$1::text,repeat('0',64),$8,'completed','SECRET OUTPUT',$9,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),$10,coalesce($11::uuid,$1::uuid),$11::uuid,$12)`,[id,f.org,resourceId,principal,f.version,grant,conversation,i===0?"First <script> input\ntext":"Follow up",i+1,callerClientId,options.parentTaskId??null,options.parentTaskId?1:0]);await transaction(pool,db=>saveTaskModelRoutes(db,id,f.org,models));}
    return {conversation,ids};
  }
  it("paginates compact agent summaries without draft/configuration bodies",async()=>{
    const f=await fixture();for(let i=0;i<4;i++)await store.createAgent({accountId:f.user.id,organizationId:f.org,name:`Agent ${i}`});
    await pool.query("UPDATE agents_platform.agents SET created_at=timestamp '2025-01-01' WHERE organization_id=$1",[f.org]);
    const first=await get(`${f.base}/agents/summaries?limit=2`,f.cookie);expect(first.status).toBe(200);expect(first.body.agents).toHaveLength(2);expect(first.body.nextCursor).toBeTruthy();
    const second=await get(`${f.base}/agents/summaries?limit=2&cursor=${first.body.nextCursor}`,f.cookie);expect(second.status).toBe(200);
    expect(new Set([...first.body.agents,...second.body.agents].map(x=>x.id)).size).toBe(4);
    const all=await get(`${f.base}/agents/summaries`,f.cookie);expect(all.body.agents.find(x=>x.id===f.agent)).toMatchObject({latestVersion:{id:f.version,number:1},hasUnpublishedChanges:false});
    expect(JSON.stringify(all.body)).not.toMatch(/instructions|configuration|position/);
    expect((await get(`${f.base}/agents/summaries?limit=101`,f.cookie)).status).toBe(400);
  });
  it("discovers only exact-principal conversations, rechecks revocation, and binds cursors to scope/filters",async()=>{
    const f=await fixture(),other=await actor();await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.org,other.user.id]);
    const own=await seed(f);await seed(f);await seed(f,other.user);
    const path=`${f.base}/conversations?agentId=${f.agent}`,page=await get(path+"&limit=1",f.cookie);expect(page.status).toBe(200);expect(page.body.conversations).toHaveLength(1);expect(page.body.nextCursor).toBeTruthy();
    const otherList=await get(path,other.cookie);expect(otherList.body.conversations).toHaveLength(1);expect(otherList.body.conversations[0].id).not.toBe(own.conversation);
    expect((await get(path+`&limit=1&cursor=${page.body.nextCursor}`,other.cookie)).status).toBe(400);
    expect((await get(path+`&versionId=${f.version}&cursor=${page.body.nextCursor}`,f.cookie)).status).toBe(400);
    expect((await get(path+`&cursor=${page.body.nextCursor}x`,f.cookie)).status).toBe(400);
    expect((await get(`${f.base}/conversations/${own.conversation}`,other.cookie)).status).toBe(403);
    expect((await get(`${f.base}/conversations`,f.cookie)).status).toBe(400);
    expect((await get(path+`&versionId=${randomUUID()}`,f.cookie)).status).toBe(404);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.org,f.user.id]);
    expect((await get(path+`&cursor=${page.body.nextCursor}`,f.cookie)).status).toBe(403);
  });
  it("loads more than 100 turns and events without silent truncation, body leakage or unstable duplicates",async()=>{
    const f=await fixture(),seeded=await seed(f,f.user,undefined,105),path=`${f.base}/conversations/${seeded.conversation}`;
    const first=await get(path+"?limit=100",f.cookie);expect(first.status).toBe(200);expect(first.body.tasks).toHaveLength(100);expect(first.body.nextCursor).toBeTruthy();
    const second=await get(path+`?limit=100&cursor=${first.body.nextCursor}`,f.cookie);expect(second.body.tasks).toHaveLength(5);expect(second.body.nextCursor).toBeNull();expect([...second.body.tasks,...first.body.tasks].map(x=>x.id)).toEqual(seeded.ids);
    const taskId=seeded.ids[0]!;await pool.query("INSERT INTO agents_platform.task_events(task_id,event_key,kind) SELECT $1,'fixture-'||i,'fixture' FROM generate_series(1,105) i",[taskId]);
    const events=await get(`${f.base}/tasks/${taskId}?eventsLimit=100`,f.cookie);expect(events.status).toBe(200);expect(events.body.events).toHaveLength(100);expect(events.body.eventsNextCursor).toBeTruthy();
    const rest=await get(`${f.base}/tasks/${taskId}/events?limit=100&cursor=${events.body.eventsNextCursor}`,f.cookie);expect(rest.body.events).toHaveLength(5);expect(rest.body.nextCursor).toBeNull();
    expect((await get(`${f.base}/tasks/${seeded.ids[1]}/events?cursor=${events.body.eventsNextCursor}`,f.cookie)).status).toBe(400);
    await pool.query("UPDATE agents_platform.tasks SET created_at=timestamp '2025-01-01' WHERE organization_id=$1",[f.org]);
    const tasks=await get(`${f.base}/tasks?agentId=${f.agent}&state=completed&limit=100`,f.cookie);expect(tasks.status).toBe(200);expect(tasks.body.tasks).toHaveLength(100);expect(JSON.stringify(tasks.body).length).toBeLessThan(64000);expect(tasks.body.nextCursor).toBeTruthy();expect(JSON.stringify(tasks.body)).not.toMatch(/SECRET OUTPUT|First <script>|principal|requestKey|grantId|position/);
    const last=await get(`${f.base}/tasks?agentId=${f.agent}&state=completed&limit=100&cursor=${tasks.body.nextCursor}`,f.cookie);expect(last.body.tasks).toHaveLength(5);expect(new Set([...tasks.body.tasks,...last.body.tasks].map(x=>x.id)).size).toBe(105);
    expect((await get(`${f.base}/tasks?state=made-up`,f.cookie)).status).toBe(400);
    const conversations=await get(`${f.base}/conversations?agentId=${f.agent}`,f.cookie);expect(conversations.body.conversations[0].title).toBe("First <script> input text");
    await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[seeded.conversation]);
    expect((await get(`${f.base}/conversations?agentId=${f.agent}`,f.cookie)).body.conversations).toEqual([]);
    expect((await get(path,f.cookie)).body.tasks[0]).toMatchObject({input:"[Deleted conversation]",output:null});
  });
  it("keeps visitor/child tasks out of discovery and restricts automation reviewers to metadata",async()=>{
    const f=await fixture(),reviewer=await actor(),stranger=await actor();
    for(const member of [reviewer,stranger])await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.org,member.user.id]);
    const human=await seed(f);
    const automationId=randomUUID(),principal:InitiatingPrincipal={kind:"automation",id:automationId,ownerAccountId:f.user.id};
    await pool.query("INSERT INTO agents_platform.automations(id,organization_id,owner_account_id,name) VALUES($1,$2,$3,'Review report')",[automationId,f.org,f.user.id]);
    await pool.query("INSERT INTO agents_platform.automation_revisions(automation_id,revision,version_id,configuration) VALUES($1,1,$2,$3)",[automationId,f.version,{reviewerAccountId:reviewer.user.id}]);
    const automation=await seed(f,f.user,undefined,1,{principal,callerClientId:"agents-automation",resourceId:automationId});
    await pool.query("INSERT INTO agents_platform.automation_occurrences(id,automation_id,revision,occurrence_key,input_digest,scheduled_at,status,task_id) VALUES($1,$2,1,'fixture',repeat('0',64),now(),'accepted',$3)",[randomUUID(),automationId,automation.ids[0]]);
    await seed(f,f.user,undefined,1,{principal:{kind:"visitor",deploymentId:randomUUID(),sessionId:randomUUID()},callerClientId:"agents-website"});
    await seed(f,f.user,undefined,1,{parentTaskId:human.ids[0]});
    const own=await get(`${f.base}/tasks`,f.cookie);expect(own.status).toBe(200);expect(own.body.tasks.map(x=>x.id).sort()).toEqual([human.ids[0],automation.ids[0]].sort());
    const reviews=await get(`${f.base}/tasks`,reviewer.cookie);expect(reviews.status).toBe(200);expect(reviews.body.tasks).toHaveLength(1);expect(reviews.body.tasks[0]).toMatchObject({id:automation.ids[0],reviewOnly:true,canControl:false,conversationId:null});
    expect(Object.keys(reviews.body.tasks[0]).sort()).toEqual(["id","agentId","agentName","versionId","versionNumber","conversationId","state","createdAt","updatedAt","canControl","reviewOnly"].sort());
    expect((await get(`${f.base}/tasks`,stranger.cookie)).body.tasks).toEqual([]);
    expect((await get(`${f.base}/tasks/${automation.ids[0]}/events`,reviewer.cookie)).body).toEqual({events:[],nextCursor:null});
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.org,f.user.id]);
    expect((await get(`${f.base}/tasks`,reviewer.cookie)).body.tasks).toEqual([]);
  });

  it("keeps version pins and snapshots while concurrent conversations are admitted",async()=>{
    const f=await fixture();await seed(f);await seed(f);
    const path=`${f.base}/conversations?agentId=${f.agent}&versionId=${f.version}&limit=1`,first=await get(path,f.cookie);expect(first.status).toBe(200);
    const latest=await seed(f),second=await get(path+`&cursor=${first.body.nextCursor}`,f.cookie);
    expect(second.body.conversations).toHaveLength(1);expect(second.body.nextCursor).toBeNull();expect(second.body.conversations[0].id).not.toBe(latest.conversation);expect(second.body.conversations[0].id).not.toBe(first.body.conversations[0].id);
    const agent=await store.getAgent(f.user.id,f.org,f.agent);await store.updateDraft({accountId:f.user.id,organizationId:f.org,agentId:f.agent,expectedRevision:agent.draft_revision,configuration:{...agent.draft,instructions:"Updated version"}});
    const newVersion=await store.createVersion({accountId:f.user.id,organizationId:f.org,agentId:f.agent,expectedRevision:agent.draft_revision+1});
    expect((await get(`${f.base}/conversations?agentId=${f.agent}&versionId=${newVersion.id}`,f.cookie)).body.conversations).toEqual([]);
    const history=await get(`${f.base}/conversations/${latest.conversation}`,f.cookie);expect(history.body.conversation).toMatchObject({id:latest.conversation,agentId:f.agent,versionId:f.version,versionNumber:1,latestTaskId:latest.ids[0],latestTurnSequence:"1"});
    const other=await actor();expect((await get(`${f.base}/tasks`,other.cookie)).status).toBe(403);
    expect((await get(`${f.base}/tasks?agentId=${randomUUID()}`,f.cookie)).status).toBe(404);
  });

  it("searches the full roster with literal case-insensitive text and query-bound cursors",async()=>{
    const f=await fixture();for(const name of ["Campaign north","Campaign south","Campaign 100% complete","Campaign _literal","Other role"])
      await store.createAgent({accountId:f.user.id,organizationId:f.org,name});
    const path=`${f.base}/agents/summaries?q=%20CAMPAIGN%20&limit=2`,first=await get(path,f.cookie);expect(first.status).toBe(200);expect(first.body.agents).toHaveLength(2);expect(first.body.agents.every(x=>x.name.startsWith("Campaign"))).toBe(true);expect(first.body.nextCursor).toBeTruthy();
    const next=await get(path+`&cursor=${first.body.nextCursor}`,f.cookie);expect(next.body.agents).toHaveLength(2);expect(next.body.nextCursor).toBeNull();expect(new Set([...first.body.agents,...next.body.agents].map(x=>x.id)).size).toBe(4);
    expect((await get(`${f.base}/agents/summaries?q=Other&cursor=${first.body.nextCursor}`,f.cookie)).status).toBe(400);
    expect((await get(`${f.base}/agents/summaries?q=%25`,f.cookie)).body.agents.map(x=>x.name)).toEqual(["Campaign 100% complete"]);
    expect((await get(`${f.base}/agents/summaries?q=_literal`,f.cookie)).body.agents.map(x=>x.name)).toEqual(["Campaign _literal"]);
    expect((await get(`${f.base}/agents/summaries?q=${"a".repeat(121)}`,f.cookie)).status).toBe(400);
  });

});
