import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { PlatformError } from "../src/contracts/contracts";
import { projectGrowthRuntime, readGrowthRuntime } from "../src/product/integrations/growth-runtime-reporting";
import { assertCurrentEvidence, taskEvidenceManifest } from "../src/execution/context/evidence";
vi.mock("../src/execution/context/evidence", () => ({ assertCurrentEvidence: vi.fn(), taskEvidenceManifest: vi.fn() }));
const now = new Date("2026-11-02T10:00:10Z"), start = "2026-11-02T10:00:00Z";
const root = () => ({id: randomUUID(), organization_id: randomUUID(), principal:{kind:"human",issuer:"fixture",subject:"owner"}, created_at:start, updated_at:"2026-11-02T10:00:04Z",state:"running"});
const rows = () => ({tasks:[],operations:[],aggregate:{}});
it("reports unavailable context and first token honestly while measuring live versus terminal elapsed time",()=>{
  const task=root(), live=projectGrowthRuntime(task,rows(),now);
  expect(live).toMatchObject({elapsedMs:10000,model:{firstTokenMs:null,latencyMs:null},context:{estimatedInputTokens:null,windowTokens:null,utilizationPercent:null,compactionCount:0},usage:{inputTokens:null,outputTokens:null,accountedTokens:0,observedModelCalls:0}});
  expect(projectGrowthRuntime({...task,state:"completed"},rows(),now).elapsedMs).toBe(4000);
  expect(projectGrowthRuntime({...task,created_at:undefined},rows(),now).elapsedMs).toBeNull();
  expect(projectGrowthRuntime({...task,state:"completed",updated_at:"invalid"},rows(),now).elapsedMs).toBeNull();
});
it("projects actual context, compaction, provider timing and accounted versus observed usage independently",()=>{
  const task=root();const value=projectGrowthRuntime(task,{tasks:[{id:task.id,name:"Assistant",tokens_used:120,model_calls:2,tool_calls:1}],operations:[],aggregate:{input_tokens:"80",output_tokens:"20",observed_calls:1,compaction_count:1,last_compacted_at:start},snapshot:{estimated_tokens:300,history_count:3,source_count:2},route:{model_id:"fixture/model",provider_id:"fixture",policy:{contextTokens:1000,maxInputTokens:800,maxOutputTokens:100,safetyTokens:50,compactAtTokens:600}},timing:{duration_ms:2000,first_token_ms:300,output_tokens:20}},now);
  expect(value.context).toMatchObject({estimatedInputTokens:300,inputLimitTokens:800,windowTokens:1000,utilizationPercent:37.5,compactionCount:1,historyGroups:3,sourceCount:2,compactAtTokens:600,pressure:"normal",decision:"prepared"});
  expect(value.usage).toEqual({accountedTokens:120,inputTokens:80,outputTokens:20,modelCalls:2,toolCalls:1,observedModelCalls:1});
  expect(value.model).toMatchObject({id:"fixture/model",latencyMs:2000,firstTokenMs:300,outputTokensPerSecond:10});
});
it("never serializes raw tool names, arguments, result bodies or hostile error messages",()=>{
  const task=root(), op={id:"operation",task_id:task.id,kind:"tool",name:"private_tool_containing_secret",state:"started",started_at:start,completed_at:null,error_code:"Bearer SECRET"};
  const value=projectGrowthRuntime(task,{tasks:[{id:task.id,name:"Assistant",tokens_used:0,model_calls:0,tool_calls:0}],operations:[op],aggregate:{operation_count:61}},now);
  expect(value.operations[0]).toMatchObject({label:"Using a tool",durationMs:10000,errorCode:null});
  expect(value.operationsTruncated).toBe(true);expect(JSON.stringify(value)).not.toMatch(/private_tool|Bearer|SECRET|arguments|messages/);
});
it("uses bounded approved catalogue descriptions for otherwise unnamed product operations",()=>{
  const task=root(),operation={id:"read",task_id:task.id,kind:"tool",name:"agency.workspace_agents.read",state:"completed",started_at:start,completed_at:now,error_code:null,
    catalog_description:"Read permitted workspace agents. Does not return configuration or messages."};
  const value=projectGrowthRuntime(task,{...rows(),operations:[operation]},now);
  expect(value.operations[0]?.label).toBe("Read permitted workspace agents.");
  const long=projectGrowthRuntime(task,{...rows(),operations:[{...operation,catalog_description:"  Read\n"+"word ".repeat(100)}]},now).operations[0]!.label;
  expect(long.length).toBeLessThanOrEqual(120);expect(long).not.toContain("\n");
  expect(projectGrowthRuntime(task,{...rows(),operations:[{...operation,catalog_description:"  "}]},now).operations[0]?.label).toBe("Using a tool");
});
it("bounds timeline size, retains chronological display and does not turn invalid observations into measurements",()=>{
  const task=root(), operations=Array.from({length:65},(_,index)=>({id:String(index),task_id:task.id,kind:"model",name:"model.generate",state:"completed",started_at:new Date(now.getTime()-index*1000).toISOString(),completed_at:now.toISOString(),error_code:null}));
  const value=projectGrowthRuntime(task,{tasks:[],operations,aggregate:{operation_count:65},snapshot:{estimated_tokens:-1},timing:{duration_ms:Infinity,first_token_ms:"private"}},now);
  expect(value.operations).toHaveLength(60);expect(value.operations[0]!.id).toBe("59");expect(value.operations.at(-1)!.id).toBe("0");expect(value.model.latencyMs).toBeNull();expect(value.context.estimatedInputTokens).toBeNull();
});
it("displays an active-first bounded selection in chronological order",()=>{
  const task=root(),operation=(id:string,started_at:string,state:string)=>({id,task_id:task.id,kind:"model",name:"model.generate",state,started_at,completed_at:state==="started"?null:now.toISOString(),error_code:null});
  const value=projectGrowthRuntime(task,{tasks:[],operations:[operation("old-running",start,"started"),operation("newest","2026-11-02T10:00:08Z","completed"),operation("middle","2026-11-02T10:00:05Z","completed")],aggregate:{}},now);
  expect(value.operations.map(item=>item.id)).toEqual(["old-running","middle","newest"]);
});
it("scopes all operation and usage queries to inspected same-principal children and omits withdrawn evidence",async()=>{
  const task=root(), allowed=randomUUID(), denied=randomUUID();
  vi.mocked(taskEvidenceManifest).mockResolvedValue({} as never);vi.mocked(assertCurrentEvidence).mockImplementation(async(_pool,id)=>{if(id===denied)throw new PlatformError("EVIDENCE_UNAVAILABLE",403,"Unavailable");});
  const calls:{sql:string;values:unknown[]}[]=[];
  const pool={query:vi.fn(async(sql:string,values:unknown[])=>{calls.push({sql,values});if(sql.includes("SELECT t.id,t.parent_task_id"))return{rows:[{id:task.id,name:"Assistant",parent_task_id:null},{id:allowed,name:"Content",parent_task_id:task.id},{id:denied,name:"Research",parent_task_id:task.id}]};return{rows:[]};})} as unknown as Pool;
  await readGrowthRuntime(pool,task);
  expect(calls[0]!.sql).toContain("t.organization_id=$2 AND t.principal=$3::jsonb");expect(calls[0]!.sql).toContain("c.deleted_at IS NULL");expect(calls[0]!.sql).toContain("WITH RECURSIVE family");expect(calls[0]!.values).toEqual([task.id,task.organization_id,JSON.stringify(task.principal),"growth"]);
  for(const call of calls.filter(call=>call.sql.includes("task_id=ANY")))expect(call.values[0]).toEqual([task.id,allowed]);
  expect(calls.filter(call=>call.sql.includes("task_id=ANY"))).toHaveLength(2);
  expect(calls.find(call=>call.sql.includes("SELECT o.id"))?.sql).toContain("ORDER BY (o.state='started') DESC");
  expect(vi.mocked(assertCurrentEvidence)).toHaveBeenCalledWith(pool,allowed,{}, {requireActiveTask:false});
});

const adminUrl=process.env.AGENTS_TEST_ADMIN_URL;
(adminUrl?it:it.skip)("reads native PostgreSQL rows while excluding foreign organization, principal, deleted conversation and unrelated roots",async()=>{
  const {Pool}=await import("pg"),{dropClosedTestDatabase}=await import("./support/database-cleanup");
  const admin=new Pool({connectionString:adminUrl}),database="agents_runtime_report_"+randomUUID().replaceAll("-","");let pool:InstanceType<typeof Pool>|undefined;
  await admin.query('CREATE DATABASE "'+database+'"');
  try{
    const url=new URL(adminUrl!);url.pathname="/"+database;pool=new Pool({connectionString:url.href});
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.agents(id uuid PRIMARY KEY,organization_id uuid,name text);
      CREATE TABLE agents_platform.agent_versions(id uuid PRIMARY KEY,organization_id uuid,agent_id uuid,configuration jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE agents_platform.conversations(id uuid PRIMARY KEY,deleted_at timestamptz);
      CREATE TABLE agents_platform.tasks(id uuid PRIMARY KEY,product text,organization_id uuid,principal jsonb,version_id uuid,conversation_id uuid,parent_task_id uuid,root_task_id uuid,created_at timestamptz,tokens_used int,model_calls int,tool_calls int,effective_configuration jsonb DEFAULT '{}'::jsonb);
      CREATE TABLE agents_platform.capability_bindings(alias text,organization_id uuid,binding jsonb);
      CREATE TABLE agents_platform.operations(id text,task_id uuid,kind text,name text,state text,started_at timestamptz,completed_at timestamptz,error_code text,accounted_tokens int,output jsonb);
      CREATE TABLE agents_platform.context_snapshots(id text,task_id uuid,step int,payload jsonb,source_references jsonb);
      CREATE TABLE agents_platform.task_model_routes(task_id uuid,organization_id uuid,routes jsonb);
      CREATE TABLE agents_platform.task_events(task_id uuid,kind text,payload jsonb,sequence bigserial);`);
    const task=root(),allowed=randomUUID();
    for(const [id,org,principal,deleted,parent,rootId]of [
      [task.id,task.organization_id,task.principal,false,null,task.id],
      [allowed,task.organization_id,task.principal,false,task.id,task.id],
      [randomUUID(),randomUUID(),task.principal,false,task.id,task.id],
      [randomUUID(),task.organization_id,{...task.principal,subject:"another-member"},false,task.id,task.id],
      [randomUUID(),task.organization_id,task.principal,true,task.id,task.id],
      [randomUUID(),task.organization_id,task.principal,false,null,randomUUID()],
    ]as const){
      const agent=randomUUID(),version=randomUUID(),conversation=randomUUID();
      await pool.query("INSERT INTO agents_platform.agents VALUES($1,$2,'Fixture agent')",[agent,org]);
      await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id) VALUES($1,$2,$3)",[version,org,agent]);
      await pool.query("INSERT INTO agents_platform.conversations VALUES($1,$2)",[conversation,deleted?now:null]);
      await pool.query("INSERT INTO agents_platform.tasks(id,product,organization_id,principal,version_id,conversation_id,parent_task_id,root_task_id,created_at,tokens_used,model_calls,tool_calls) VALUES($1,'growth',$2,$3,$4,$5,$6,$7,$8,10,1,0)",[id,org,principal,version,conversation,parent,rootId,start]);
      await pool.query(`INSERT INTO agents_platform.operations VALUES($1,$2,'model','model.generate','completed',$3,$4,null,10,$5)`,["model:"+id,id,start,now,{message:{content:"NEVER_EXPOSE_PRIVATE_RESPONSE"},usage:{observed:true,inputTokens:6,outputTokens:4}}]);
    }
    await pool.query("UPDATE agents_platform.tasks SET effective_configuration=null WHERE id=$1",[task.id]);
    await pool.query("UPDATE agents_platform.agent_versions v SET configuration=$2 FROM agents_platform.tasks t WHERE t.id=$1 AND v.id=t.version_id",[task.id,{productBindings:[{alias:"opaque-tool-alias",definition:{providerOperation:"content.list"}},{alias:"opaque-metadata-alias",definition:{providerOperation:"agency.workspace_agents.read",description:"Read permitted workspace agents. No private conversation bodies."}}]}]);
    await pool.query("UPDATE agents_platform.agent_versions v SET configuration=$2 FROM agents_platform.tasks t WHERE t.id=$1 AND v.id=t.version_id",[allowed,{productBindings:[{alias:"opaque-child-alias",definition:{providerOperation:"campaigns.list"}}]}]);
    await pool.query("UPDATE agents_platform.tasks SET effective_configuration=$2 WHERE id=$1",[allowed,{productBindings:[{alias:"opaque-child-alias",definition:{providerOperation:"analytics.read"}}]}]);
    await pool.query(`INSERT INTO agents_platform.operations VALUES('read-analytics',$1,'tool','opaque-child-alias','completed',$2,$3,null,0,null)`,[allowed,start,now]);
    await pool.query(`INSERT INTO agents_platform.operations VALUES('read-content',$1,'tool','opaque-tool-alias','completed',$2,$3,null,0,null)`,[task.id,start,now]);
    await pool.query(`INSERT INTO agents_platform.operations VALUES('read-metadata',$1,'tool','opaque-metadata-alias','completed',$2,$3,null,0,null)`,[task.id,start,now]);
    await pool.query("INSERT INTO agents_platform.context_snapshots VALUES($1,$2,1,$3,$4)",["context:"+task.id+":1",task.id,{estimatedTokens:250,historyGroupIds:["a"],messages:[{content:"NEVER_EXPOSE_PRIVATE_PROMPT"}]},JSON.stringify([{id:"source"}])]);
    await pool.query("INSERT INTO agents_platform.task_model_routes VALUES($1,$2,$3)",[task.id,task.organization_id,{primary:{binding:{modelId:"fixture/model",providerId:"fixture",credential:"NEVER_EXPOSE_SECRET"},policy:{contextTokens:1000,maxInputTokens:800,maxOutputTokens:100,safetyTokens:50,compactAtTokens:600}}}]);
    await pool.query("INSERT INTO agents_platform.task_events(task_id,kind,payload) VALUES($1,'model.observed',$2)",[task.id,{role:"primary",durationMs:1000,firstTokenMs:20,outputTokens:4}]);
    vi.mocked(assertCurrentEvidence).mockResolvedValue(undefined);vi.mocked(taskEvidenceManifest).mockResolvedValue({}as never);
    const result=await readGrowthRuntime(pool,task);
    expect([...new Set(result.operations.map(operation=>operation.taskId))].sort()).toEqual([task.id,allowed].sort());
    expect(result.operations.find(operation=>operation.id==="read-content")?.label).toBe("Finding content");
    expect(result.operations.find(operation=>operation.id==="read-analytics")?.label).toBe("Reading analytics");
    expect(result.operations.find(operation=>operation.id==="read-metadata")?.label).toBe("Read permitted workspace agents.");
    expect(result.usage).toMatchObject({accountedTokens:20,inputTokens:12,outputTokens:8,modelCalls:2,observedModelCalls:2});
    expect(result.context).toMatchObject({estimatedInputTokens:250,historyGroups:1,sourceCount:1,windowTokens:1000});
    expect(result.model).toMatchObject({firstTokenMs:20,latencyMs:1000});
    expect(JSON.stringify(result)).not.toMatch(/NEVER_EXPOSE|credential|"messages"|"content"/);
    await pool.query(`INSERT INTO agents_platform.operations
      SELECT 'new-completed-'||n,$1,'model','model.generate','completed',$2::timestamptz+n*interval '1 second',$2::timestamptz+n*interval '1 second',null,0,null FROM generate_series(1,65) n`,[allowed,now]);
    await pool.query(`INSERT INTO agents_platform.operations VALUES('older-running',$1,'model','model.generate','started',$2,null,null,0,null)`,[task.id,start]);
    const bounded=await readGrowthRuntime(pool,task);
    expect(bounded.operations).toHaveLength(60);expect(bounded.operationsTruncated).toBe(true);
    expect(bounded.operations[0]).toMatchObject({id:"older-running",state:"started"});
    expect(bounded.operations.at(-1)?.id).toBe("new-completed-65");

  }finally{await pool?.end();await dropClosedTestDatabase(admin,database);await admin.end();}
});

it("uses shared catalogue presentation and typed discovery activity for public operation labels",()=>{
  const task=root();
  const operation=(name:string)=>({id:name,task_id:task.id,kind:"tool",name,state:"completed",started_at:start,completed_at:now,error_code:null});
  const value=projectGrowthRuntime(task,{...rows(),operations:[operation("tools.discover"),operation("tools.load"),operation("memory.search")]},now);
  expect(value.operations.find(item=>item.id==="tools.discover")).toMatchObject({label:"Find tools",category:"Capabilities",activityKind:"capability_discovery",technicalName:"tools.discover"});
  expect(value.operations.find(item=>item.id==="tools.load")).toMatchObject({label:"Load tools",activityKind:"capability_loading"});
  expect(value.operations.find(item=>item.id==="memory.search")).toMatchObject({label:"Find memory",category:"Memory"});
  expect(value.operations.find(item=>item.id==="memory.search")?.activityKind).toBeUndefined();
});
