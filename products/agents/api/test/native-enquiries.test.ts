import {randomUUID} from "node:crypto";
import {Pool} from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {defaultBusinessConfiguration,assertGrantAuthority,type AdmissionAuthority,type ExecutionGrant} from "../src/contracts/contracts";
import {EnquiryStore,enquiryArguments} from "../src/capabilities/enquiries/enquiries";
import {executeTool} from "../src/capabilities/tools";
import {loadExecution} from "../src/execution/lifecycle/execution";
import {visibleRecordTools} from "../src/capabilities/enquiries/record-tools";
import {toolsFor} from "../src/capabilities/tool-definitions";
import {enquiryReviewDecision,enquiryReviewText,enquiryReviewButtons} from "../src/product/channels/channel-enquiry-reviews";
import {channelWebhookEventSchema} from "../src/contracts/channel-adapters";
import {PlatformStore} from "../src/product/agents/store";
import {setupPlatformSchema} from "../src/composition/setup";
import {connectFixtureModel} from "./model-fixture";
import {EvaluationTrials} from "../src/product/evaluation/evaluation-trials";
import {dropClosedTestDatabase} from "./support/database-cleanup";
function configuration(){const config=defaultBusinessConfiguration();config.tools=["enquiry.submit"];config.capabilities.enquiries={enabled:true,fields:["name","email","message"]};return config;}
const args={fields:{name:"Ada",email:"ada@example.test",message:"Please call me"}};
describe("native enquiry configuration",()=>{
 it("exposes selected required fields and enforces exact configured input",()=>{const config=configuration(),tool=toolsFor(config).find(tool=>tool.function.name==="enquiry_submit")!;expect(tool.function.parameters).toMatchObject({properties:{fields:{required:["name","email","message"],additionalProperties:false}}});expect(enquiryArguments(config,args)).toEqual(args);expect(()=>enquiryArguments(config,{fields:{...args.fields,service:"Unconfigured"}})).toThrow();expect(()=>enquiryArguments(config,{fields:{email:"bad"}})).toThrow();config.capabilities.enquiries={enabled:false};expect(toolsFor(config)).not.toContainEqual(expect.objectContaining({function:expect.objectContaining({name:"enquiry_submit"})}));expect(()=>enquiryArguments(config,args)).toThrow();});
 it("rejects oversized UTF-8 and null bytes before persistence",()=>{const config=configuration();expect(()=>enquiryArguments(config,{fields:{...args.fields,message:"界".repeat(4000)}})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_LIMIT"}));expect(()=>enquiryArguments(config,{fields:{...args.fields,message:"bad\0value"}})).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));expect(enquiryArguments(config,{fields:{...args.fields,message:"界".repeat(2000)}}).fields.message).toHaveLength(2000);});

 it("requires enquiry grant authority",()=>{const config=configuration(),authority:AdmissionAuthority={product:"agents",organizationId:randomUUID(),resourceId:randomUUID(),callerClientId:"agents-execution",principal:{kind:"human",issuer:"https://test.example",subject:"owner"}},versionId=randomUUID();const grant:ExecutionGrant={...authority,id:randomUUID(),versionId,operations:["model.reply"],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null};expect(()=>assertGrantAuthority(grant,authority,versionId,config)).toThrow();expect(()=>assertGrantAuthority({...grant,operations:["model.reply","enquiry.submit"]},authority,versionId,config)).not.toThrow();});
 it("uses explicit bounded callback payloads and exact field text",()=>{const id=randomUUID();expect(enquiryReviewButtons(id)[0]!.payload.length).toBeLessThanOrEqual(64);expect(enquiryReviewText(args.fields)).toContain("Email: ada@example.test");const event=channelWebhookEventSchema.parse({kind:"interaction",eventId:"event",occurredAt:new Date().toISOString(),providerMessageId:"message",assetId:"asset",senderId:"sender",externalConversationId:"conversation",interaction:`enquiry:a:${id}`});expect(enquiryReviewDecision(event)).toEqual({id,decision:"approve"});expect(enquiryReviewDecision({...event,echo:true})).toBeNull();expect(enquiryReviewDecision({...event,interaction:"confirm"})).toBeNull();});
});
const databaseUrl=process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("native enquiry durable confirmation",()=>{
 let admin:Pool,pool:Pool,store:EnquiryStore,platform:PlatformStore;
 const database=`agents_enquiries_${randomUUID().replaceAll("-","")}`;
 beforeAll(async()=>{admin=new Pool({connectionString:databaseUrl});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(databaseUrl!);url.pathname=`/${database}`;pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);store=new EnquiryStore(pool);platform=new PlatformStore(pool);});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
 async function fixture(config=configuration(),withTrial=false){
  const account=await platform.ensureAccount({issuer:"https://enquiries.example.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
  const organization=await platform.createOrganization(account.id,"Enquiries"),scope={accountId:account.id,organizationId:organization.id};await connectFixtureModel(pool,account.id,organization.id);
  const agent=await platform.createAgent({...scope,name:"Assistant",configuration:config});const version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:agent.draft_revision});
  const authority:AdmissionAuthority={product:"agents",organizationId:organization.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human",issuer:account.issuer,subject:account.subject}};
  const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","enquiry.submit","enquiry.read","enquiry.amend","records.read","records.write"],sourceRevisionIds:[],connectedToolBindingIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+300000).toISOString(),revokedAt:null};await platform.createGrant({accountId:account.id,grant});
  let evaluationTrialId:string|undefined;
  if(withTrial){const trials=new EvaluationTrials(pool),preview=await trials.preview(account.id,organization.id,agent.id,{versionId:version.id,rootTokenLimit:32000});const trial=await trials.prepare(account.id,organization.id,{trialId:randomUUID(),agentId:agent.id,versionId:version.id,expectedCompositionDigest:version.effective_composition!.digest,expectedModelRoutesDigest:preview.modelRoutesDigest,rootTokenLimit:32000,maxTokens:32000,expiresAt:new Date(Date.now()+300000).toISOString()});evaluationTrialId=trial.id;}
  const {task}=await platform.admitTask({authority,grantId:grant.id,versionId:version.id,requestKey:randomUUID(),input:"Submit my enquiry",evaluationTrialId});return {scope,task,grant,authority,agent,version};
 }
 it("requires exact confirmation then writes one record with trusted provenance and replays lost acknowledgement",async()=>{
  const f=await fixture(),operationId=randomUUID(),pending=await store.prepare(f.task.id,operationId,args);expect(pending.state).toBe("pending");expect(await store.listStaff(f.scope)).toEqual([]);
  await expect(store.submit(f.task.id,operationId,args)).rejects.toMatchObject({code:"ENQUIRY_CONFIRMATION_REQUIRED"});
  await expect(store.prepare(f.task.id,operationId,{fields:{...args.fields,name:"Changed"}})).rejects.toMatchObject({code:"IDEMPOTENCY_CONFLICT"});
  await expect(store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:"0".repeat(64)})).rejects.toMatchObject({code:"REVIEW_CHANGED"});
  await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest});
  const receipt=await store.submit(f.task.id,operationId,args);expect(receipt).toMatchObject({state:"submitted",enquiryId:pending.id,receiptDigest:expect.stringMatching(/^[a-f0-9]{64}$/)});expect(await store.submit(f.task.id,operationId,args)).toEqual(receipt);
  const records=await store.listStaff(f.scope,{agentId:f.agent.id,conversationId:f.task.conversation_id});expect(records).toHaveLength(1);expect(records[0]).toMatchObject({fields:args.fields,taskId:f.task.id,agentId:f.agent.id});expect(await store.readStaff(f.scope,pending.id)).toEqual(records[0]);
 });
 it("denies cross principal/tenant reads and confirmations",async()=>{const f=await fixture(),other=await fixture(),pending=await store.prepare(f.task.id,randomUUID(),args);await expect(store.listForPrincipal(f.task.id,other.authority.principal)).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});await expect(store.decide(f.task.id,other.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest})).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});expect(await store.listStaff(other.scope)).toEqual([]);await expect(store.readStaff(other.scope,pending.id)).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});});
 it("rejects declined, expired and revoked submissions without records",async()=>{const f=await fixture(),operation=randomUUID(),pending=await store.prepare(f.task.id,operation,args);await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"reject",requestDigest:pending.requestDigest});await expect(store.submit(f.task.id,operation,args)).rejects.toMatchObject({code:"ENQUIRY_CONFIRMATION_REQUIRED"});const op2=randomUUID(),second=await store.prepare(f.task.id,op2,args);await pool.query("UPDATE agents_platform.enquiries SET expires_at=now()-interval '1 second' WHERE id=$1",[second.id]);await expect(store.decide(f.task.id,f.authority.principal,second.id,{decision:"approve",requestDigest:second.requestDigest})).rejects.toMatchObject({code:"ENQUIRY_REVIEW_EXPIRED"});await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.grant.id]);await expect(store.prepare(f.task.id,randomUUID(),args)).rejects.toMatchObject({code:"GRANT_REVOKED"});expect(await store.listStaff(f.scope)).toEqual([]);});
 it("denies disabled capability before persisting personal details",async()=>{const config=defaultBusinessConfiguration(),f=await fixture(config);await expect(store.prepare(f.task.id,randomUUID(),args)).rejects.toMatchObject({code:"ENQUIRY_DISABLED"});expect((await pool.query("SELECT 1 FROM agents_platform.enquiries WHERE task_id=$1",[f.task.id])).rowCount).toBe(0);});
 it("grants website/channel intake and allows review prompts before exactly one final assistant message",async()=>{
  const f=await fixture(),deployment=await platform.publishWebsite({...f.scope,agentId:f.agent.id,versionId:f.version.id,allowedOrigins:["https://customer.example.test"]}),sessionId=randomUUID();
  const visitorGrant=await platform.createWebsiteGrant({deploymentId:deployment.id,origin:"https://customer.example.test",sessionId});expect(visitorGrant.operations).toContain("enquiry.submit");
  await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)",[sessionId,deployment.id,"a".repeat(64),"https://customer.example.test"]);
  const conversation=randomUUID();await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,deployment_id,agent_id,version_id,session_id,execution_conversation_id) VALUES($1,$2,$3,$4,$5,$6,$7)`,[conversation,f.scope.organizationId,deployment.id,f.agent.id,f.version.id,sessionId,f.task.conversation_id]);
  for(const [index,key] of ["enquiry-review:first","enquiry-review:second","task:final"].entries())await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,task_id,ownership_generation) VALUES($1,$2,$3,'assistant','Review or answer',$4,'digest',$5,1)`,[randomUUID(),conversation,index+1,key,f.task.id]);
  await expect(pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,body,request_key,request_digest,task_id,ownership_generation) VALUES($1,$2,4,'assistant','Duplicate final','task:duplicate','digest',$3,1)`,[randomUUID(),conversation,f.task.id])).rejects.toMatchObject({code:"23505"});
  const connectionId=randomUUID(),channelDeploymentId=randomUUID(),participantId=randomUUID();
  await pool.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state) VALUES($1,$2,$3,'telegram','Support','fixture-bot','bot','active')`,[connectionId,f.scope.organizationId,f.scope.accountId]);
  await pool.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[channelDeploymentId,f.scope.organizationId,connectionId,f.agent.id,f.version.id,f.scope.accountId]);
  await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id) VALUES($1,$2,$3,$4,'telegram',$5,'chat','sender')`,[participantId,f.scope.organizationId,f.agent.id,f.version.id,channelDeploymentId]);
  const db=await pool.connect();try{await db.query("BEGIN");const grant=await platform.createChannelGrantInTransaction(db,{deploymentId:channelDeploymentId,participantId});expect(grant.operations).toContain("enquiry.submit");await db.query("ROLLBACK");}finally{db.release();}
 });

 it("limits submitted trial records to their owner even within the same workspace",async()=>{
  const f=await fixture(configuration(),true),operationId=randomUUID(),pending=await store.prepare(f.task.id,operationId,args);await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest});await store.submit(f.task.id,operationId,args);
  const other=await platform.ensureAccount({issuer:"https://enquiries.example.test",subject:randomUUID(),email:"staff@example.test",displayName:"Staff"});await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.scope.organizationId,other.id]);const otherScope={organizationId:f.scope.organizationId,accountId:other.id};
  expect(await store.listStaff(f.scope)).toHaveLength(1);expect(await store.readStaff(f.scope,pending.id)).toMatchObject({id:pending.id});expect(await store.listStaff(otherScope)).toEqual([]);await expect(store.readStaff(otherScope,pending.id)).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});
 });
 it("reads and amends only the exact participant conversation, retaining original evidence and retry receipts",async()=>{
  const config=configuration();config.tools.push("enquiry.read","enquiry.amend");const f=await fixture(config),other=await fixture(config),op=randomUUID();
  const pending=await store.prepare(f.task.id,op,args);await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest});await store.submit(f.task.id,op,args);
  expect(await executeTool(pool,f.task.id,"read","enquiry.read","{}",8192)).toMatchObject({enquiries:[{enquiryId:pending.id,fields:args.fields}]});
  expect(await executeTool(pool,other.task.id,"read","enquiry.read","{}",8192)).toEqual({enquiries:[]});
  const amended={enquiryId:pending.id,fields:{...args.fields,message:"Please email instead"}},change=randomUUID();
  await expect(store.prepare(other.task.id,change,amended,"enquiry.amend")).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});
  await expect(store.prepare(f.task.id,change,{...amended,email:"ada@example.test"},"enquiry.amend")).rejects.toMatchObject({code:"TOOL_ARGUMENTS_INVALID"});
  const review=await store.prepare(f.task.id,change,amended,"enquiry.amend");expect(review.amendsEnquiryId).toBe(pending.id);
  await expect(store.submit(f.task.id,change,amended,"enquiry.amend")).rejects.toMatchObject({code:"ENQUIRY_CONFIRMATION_REQUIRED"});
  await store.decide(f.task.id,f.authority.principal,review.id,{decision:"approve",requestDigest:review.requestDigest});
  const receipt=await executeTool(pool,f.task.id,change,"enquiry.amend",JSON.stringify(amended));expect((await store.prepare(f.task.id,change,amended,"enquiry.amend")).state).toBe("submitted");expect(await executeTool(pool,f.task.id,change,"enquiry.amend",JSON.stringify(amended))).toEqual(receipt);
  expect((await pool.query("SELECT fields FROM agents_platform.enquiries WHERE id=$1",[pending.id])).rows[0].fields).toEqual(args.fields);
  expect(await store.readOwn(f.task.id,{})).toMatchObject({enquiries:[{enquiryId:review.id,fields:amended.fields}]});
  await expect(store.prepare(f.task.id,randomUUID(),amended,"enquiry.amend")).rejects.toMatchObject({code:"ENQUIRY_CHANGED"});
 });
 it("materializes staff tools only with current human membership and grants, and excludes private notes",async()=>{
  const config=configuration();config.tools.push("records.search","records.update");const f=await fixture(config),operation=randomUUID(),pending=await store.prepare(f.task.id,operation,args);await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest});await store.submit(f.task.id,operation,args);
  const recordId=randomUUID();await pool.query(`INSERT INTO agents_platform.customer_record_enquiries(id,organization_id,source_enquiry_id,source_task_id,agent_id,conversation_id,original_fields,fields) VALUES($1,$2,$3,$4,$5,$6,$7,$7)`,[recordId,f.scope.organizationId,pending.id,f.task.id,f.agent.id,f.task.conversation_id,args.fields]);
  await pool.query("INSERT INTO agents_platform.customer_record_activity(id,organization_id,enquiry_id,kind,actor_account_id,body) VALUES($1,$2,$3,'note',$4,'STAFF_PRIVATE_SECRET')",[randomUUID(),f.scope.organizationId,recordId,f.scope.accountId]);
  const execution=await loadExecution(pool,f.task.id);expect((await visibleRecordTools(pool,execution,toolsFor(config))).map(tool=>tool.function.name)).toContain("records_update");
  expect((await visibleRecordTools(pool,{...execution,task:{...execution.task,principal:{kind:"visitor",deploymentId:randomUUID(),sessionId:randomUUID()}}},toolsFor(config))).map(tool=>tool.function.name)).not.toContain("records_search");
  expect((await visibleRecordTools(pool,{...execution,task:{...execution.task,evaluation_trial_id:randomUUID()}},toolsFor(config))).map(tool=>tool.function.name)).not.toContain("records_search");
  const trial=await fixture(config,true);await expect(executeTool(pool,trial.task.id,"trial-search","records.search","{}")).rejects.toMatchObject({code:"RECORD_SCOPE_DENIED"});
  const result=await executeTool(pool,f.task.id,"search","records.search","{}");expect(result).toMatchObject({records:[{enquiryId:recordId,status:"new",revision:"1"}]});expect(JSON.stringify(result)).not.toContain("notes");expect(JSON.stringify(result)).not.toContain("STAFF_PRIVATE_SECRET");
  const input={enquiryId:recordId,expectedRevision:"1",action:"set-status",status:"in_progress"};const receipt=await executeTool(pool,f.task.id,"staff-update","records.update",JSON.stringify(input));expect(await executeTool(pool,f.task.id,"staff-update","records.update",JSON.stringify(input))).toEqual(receipt);
  await expect(executeTool(pool,f.task.id,"staff-note","records.update",JSON.stringify({...input,body:"Private note"}))).rejects.toMatchObject({code:"TOOL_ARGUMENTS_INVALID"});
  await pool.query("UPDATE agents_platform.execution_grants SET operations=operations-'records.write' WHERE id=$1",[f.grant.id]);
  expect((await visibleRecordTools(pool,execution,toolsFor(config))).map(tool=>tool.function.name)).not.toContain("records_update");
  await expect(executeTool(pool,f.task.id,"denied","records.update",JSON.stringify(input))).rejects.toMatchObject({code:"RECORD_SCOPE_DENIED"});
  await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.scope.organizationId,f.scope.accountId]);
  await expect(executeTool(pool,f.task.id,"denied-search","records.search","{}")).rejects.toBeDefined();
 });
 it("fences an approved amendment when authority is revoked",async()=>{
  const config=configuration();config.tools.push("enquiry.read","enquiry.amend");const f=await fixture(config),op=randomUUID(),pending=await store.prepare(f.task.id,op,args);await store.decide(f.task.id,f.authority.principal,pending.id,{decision:"approve",requestDigest:pending.requestDigest});await store.submit(f.task.id,op,args);
  const input={enquiryId:pending.id,fields:{...args.fields,message:"New"}},change=randomUUID(),review=await store.prepare(f.task.id,change,input,"enquiry.amend");await store.decide(f.task.id,f.authority.principal,review.id,{decision:"approve",requestDigest:review.requestDigest});await pool.query("UPDATE agents_platform.execution_grants SET revoked_at=now() WHERE id=$1",[f.grant.id]);await expect(store.submit(f.task.id,change,input,"enquiry.amend")).rejects.toMatchObject({code:"GRANT_REVOKED"});expect((await pool.query("SELECT state FROM agents_platform.enquiries WHERE id=$1",[review.id])).rows[0].state).toBe("approved");
 });
 it("does not reopen unsubmitted details through a deleted conversation",async()=>{const f=await fixture();await store.prepare(f.task.id,randomUUID(),args);await pool.query("UPDATE agents_platform.conversations SET deleted_at=now() WHERE id=$1",[f.task.conversation_id]);await expect(store.listForPrincipal(f.task.id,f.authority.principal)).rejects.toMatchObject({code:"ENQUIRY_NOT_FOUND"});});

});
