import { createHash,randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname,join } from "node:path";
import type { Pool,PoolClient } from "pg";
import { z } from "zod";
import { GITHUB_ADAPTER_RELEASE,GithubReadAdapter,githubRepositoryHandle,type GithubFileHandle,type GithubObservation,type GithubRepositorySelection } from "../../adapters/providers/github-adapter";
import { githubMcpFileText } from "../../adapters/providers/github-mcp-file";
import { MCP_ADAPTER_RELEASE,callMcpTool,discoverMcpCatalog,type McpEndpoint,type McpTool } from "../../adapters/providers/mcp-adapter";
import type { RemoteMcpAttempt,RemoteMcpEndpoint } from "../../adapters/providers/remote-mcp";
import type { NativeApiOperationRuntime } from "../../adapters/providers/native-api";
import { STASH_ADAPTER_RELEASE,STASH_MCP_ENDPOINT,stashItemObservation } from "../../adapters/providers/stash-adapter";
import { ExecutableAdapterRegistry,capabilityBindingSchema,createCatalog,digestToolSchema,type CapabilityBinding,type CapabilityCatalog,type ResourceHandle } from "../../contracts/capability-catalog";
import type { ActionScope,ConnectionCredentialPort } from "../../contracts/connections";
import { PlatformError,requestDigest } from "../../contracts/contracts";
import { textDigest } from "../../contracts/source-contracts";
import { writeExecutionObject } from "../../execution/artifacts/execution-objects";
import { EvidenceStore,assertChildConnectedAuthority,assertCurrentEvidence,taskEvidenceManifest } from "../../execution/context/evidence";
import { assertCurrentAuthority,loadExecution,type Execution } from "../../execution/lifecycle/execution";
import { requireActionMember } from "../../infrastructure/action-authority";
import type { NetworkAttempt } from "../../infrastructure/connected-network";
import { transaction } from "../../infrastructure/database";
import { PrivateObjectStore } from "../../infrastructure/object-store";
import { recordEvent } from "../../observability/event-store";
import { ConnectedCatalogStore,GITHUB_MCP_READ_OPERATIONS,connectedProviderOperationAllowed } from "./connected-catalog-store";
import { assertConnectedBindingDependencies,connectedModelArguments,connectedModelTool,connectedParameters,type ConnectedModelArguments } from "./connected-tool-schema";
import { executeGenericConnectedTool,executeGenericNativeApi,genericToolReviewDigest,remoteMcpAdapterManifest,nativeApiAdapterManifest,type GenericToolReviewInput,type GenericToolReviewPort } from "./generic-connected-runtime";

const MAX_HANDLES=2000,MAX_BODY_BYTES=2097152;
const denied=()=>new PlatformError("CONNECTED_SCOPE_DENIED",403,"Connected resource is outside the task's authorized scope");
const uncertain=()=>new PlatformError("CONNECTED_READ_UNCERTAIN",409,"The previous connected read has an unknown outcome; it was not repeated");
const genericUncertain=()=>new PlatformError("CONNECTED_OPERATION_UNCERTAIN",409,"The previous remote operation has an unknown outcome; it was not repeated");
const code=(error:unknown):string=>{const value=(error as {code?:unknown})?.code;return typeof value==="string"&&/^[A-Z0-9_]{1,80}$/.test(value)?value:"CONNECTED_READ_FAILED";};
export interface ConnectedExecutorOptions {testGithubOrigin?:string;testMcpEndpoint?:string;testStashMcpEndpoint?:string;testPublicMcpEndpoint?:string;
 resolveRemoteEndpoint?(db:PoolClient,scope:ActionScope,connectionId:string,policyRevision:number):Promise<RemoteMcpEndpoint>;
 resolveApiOperation?(db:PoolClient,scope:ActionScope,connectionId:string,policyRevision:number,providerOperation:string):Promise<NativeApiOperationRuntime>;
 ensureCredentialFresh?(scope:ActionScope,connectionId:string):Promise<void>;
 testApiLoopback?:boolean;
 genericReview?:GenericToolReviewPort;
}
export interface ConnectedObservation {
 status:"ok"|"tool_error";bindingId:string;operationId:string;content:string;truncated:boolean;
 evidence:{id:string;label:string;citation:string;contentDigest:string};handles?:unknown;
 observation:{digest:string;acquiredAt:string;provenance:unknown};
}
interface Handle {id:string;kind:"revision"|"file"|"release";resource:ResourceHandle;payload:any}
interface Projection {text:string;truncated:boolean;handles?:unknown;resource:ResourceHandle;acquiredAt:string;digest:string;provenance:unknown;isError?:boolean}
function prefix(text:string,maximum=4096):{text:string;truncated:boolean}{const bytes=Buffer.from(text);return{text:bytes.length<=maximum?text:new TextDecoder().decode(bytes.subarray(0,maximum),{stream:true}),truncated:bytes.length>maximum};}
export class ConnectedExecutor {
 readonly registry=new ExecutableAdapterRegistry<ConnectedExecutor>();
 readonly catalogs:ConnectedCatalogStore;
 readonly nativeAdapter;readonly mcpAdapter;readonly stashAdapter;readonly publicMcpAdapter;readonly remoteMcpAdapter;readonly nativeApiAdapter;
 constructor(readonly pool:Pool,readonly connections:ConnectionCredentialPort,readonly objects:PrivateObjectStore,readonly evidence:EvidenceStore,private readonly options:ConnectedExecutorOptions={}){
  const extension=extname(__filename),modules=[
    ["connected-executor","./connected-executor"],["connected-tool-schema","./connected-tool-schema"],
    ["connected-network","../../infrastructure/connected-network"],["github-adapter","../../adapters/providers/github-adapter"],
    ["github-mcp-file","../../adapters/providers/github-mcp-file"],["stash-adapter","../../adapters/providers/stash-adapter"],
    ["mcp-adapter","../../adapters/providers/mcp-adapter"],["adapter-process","../../adapters/providers/adapter-process"],
    ["capability-catalog","../../contracts/capability-catalog"],["github-contract","../../contracts/github"],["resources","../../contracts/resources"],
  ];
  const hash=createHash("sha256");for(const [id,file] of modules)hash.update(id!).update(readFileSync(join(__dirname,`${file}${extension}`)));
  const executableDigest=hash.digest("hex");
  this.nativeAdapter=this.registry.register({schemaVersion:1,id:"github-native-read",release:GITHUB_ADAPTER_RELEASE,executableDigest,transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true},this);
  this.mcpAdapter=this.registry.register({schemaVersion:1,id:"github-mcp-read",release:MCP_ADAPTER_RELEASE,executableDigest,transports:["mcp_http"],protocolVersions:["2026-07-28","2025-11-25"],boundedSchemaValidation:true},this);
  this.stashAdapter=this.registry.register({schemaVersion:1,id:"stash-mcp-read",release:STASH_ADAPTER_RELEASE,executableDigest,transports:["mcp_http"],protocolVersions:["2026-07-28","2025-11-25"],boundedSchemaValidation:true},this);
  this.publicMcpAdapter=this.registry.register({schemaVersion:1,id:"deepwiki-mcp-read",release:"public-repository-read-v1",executableDigest,transports:["mcp_http"],protocolVersions:["2026-07-28","2025-11-25"],boundedSchemaValidation:true},this);
  this.remoteMcpAdapter=this.registry.register(remoteMcpAdapterManifest(),this);
  this.nativeApiAdapter=this.registry.register(nativeApiAdapterManifest(),this);
  this.catalogs=new ConnectedCatalogStore(pool,connections,this.registry);
 }
 assertAvailable(bindings:readonly CapabilityBinding[]):void{assertConnectedBindingDependencies(bindings);for(const binding of bindings){capabilityBindingSchema.parse(binding);this.registry.resolve(binding);}}
 modelToolsFor(bindings:readonly CapabilityBinding[]){this.assertAvailable(bindings);return bindings.map(connectedModelTool);}
 private endpoint(authorization:string,deadlineAt:number,protocolVersion?:McpEndpoint["protocolVersion"],profileId="github-public-read-v1"):McpEndpoint{
  if(profileId==="public-repository-read-v1")return{endpoint:this.options.testPublicMcpEndpoint??"https://mcp.deepwiki.com/mcp",deadlineAt,protocolVersion,testLoopback:this.options.testPublicMcpEndpoint!==undefined};
  if(profileId==="stash-read-v1")return{endpoint:this.options.testStashMcpEndpoint??STASH_MCP_ENDPOINT,authorization:`Bearer ${authorization}`,deadlineAt,protocolVersion,testLoopback:this.options.testStashMcpEndpoint!==undefined};
  return{endpoint:this.options.testMcpEndpoint??"https://api.githubcopilot.com/mcp/",authorization:`Bearer ${authorization}`,deadlineAt,protocolVersion,
   headers:{"X-MCP-Tools":[...GITHUB_MCP_READ_OPERATIONS].sort().join(","),"X-MCP-Readonly":"true"},testLoopback:this.options.testMcpEndpoint!==undefined};
 }
 async discover(scope:ActionScope,input:{operationId:string;connectionId:string;expectedRevision:number;transport:"native_http"|"mcp_http"}){
  const parsed=z.strictObject({operationId:z.string().min(1).max(128),connectionId:z.uuid(),expectedRevision:z.number().int().positive(),transport:z.enum(["native_http","mcp_http"])}).parse(input),digest=requestDigest(parsed);
  const claim=await transaction(this.pool,async db=>{
   await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);await requireActionMember(db,scope);
   const prior=(await db.query("SELECT * FROM agents_platform.connected_discoveries WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,parsed.operationId])).rows[0];
   if(prior){if(prior.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Discovery request identity changed");if(prior.state==="completed")return{replay:prior.result};throw uncertain();}
   const row=(await db.query("SELECT * FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3",[parsed.connectionId,scope.organizationId,scope.accountId])).rows[0];
   if(!row||row.revision!==parsed.expectedRevision||!["github-public-read-v1","stash-read-v1","public-repository-read-v1"].includes(row.profile_id)||row.profile_id==="stash-read-v1"&&parsed.transport!=="mcp_http")throw denied();
   const resolved=await this.connections.resolveCredential(db,scope,row.id,row.policy_revision);
   await db.query("INSERT INTO agents_platform.connected_discoveries(organization_id,account_id,operation_id,connection_id,request_digest,state) VALUES($1,$2,$3,$4,$5,'started')",[scope.organizationId,scope.accountId,parsed.operationId,row.id,digest]);
   return{resolved,revision:Number((await db.query("SELECT COALESCE(max(revision),0)+1 AS revision FROM agents_platform.capability_catalogs WHERE connection_id=$1",[row.id])).rows[0].revision)};
  });
  if("replay"in claim)return claim.replay;
  const attempts:NetworkAttempt[]=[];
  const observe=async(attempt:NetworkAttempt)=>{
   if(attempt.outcome==="in_flight")await transaction(this.pool,async db=>{
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
    const current=await this.connections.resolveCredential(db,scope,parsed.connectionId,claim.resolved!.connection.policyRevision);
    if(current.connection.revision!==parsed.expectedRevision)throw new PlatformError("CONNECTION_CREDENTIAL_CHANGED",403,"Connection credentials changed during discovery");
   });
   const index=attempts.findIndex(prior=>prior.attempt===attempt.attempt);if(index<0)attempts.push(attempt);else attempts[index]=attempt;await this.pool.query("UPDATE agents_platform.connected_discoveries SET attempts=$4 WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,parsed.operationId,JSON.stringify(attempts)]);};
  try{
   const resolved=claim.resolved!,nativeNames=["get_repository","list_releases","resolve_ref","list_tree","read_file"];
   let tools:CapabilityCatalog["tools"],protocolVersion:CapabilityCatalog["protocolVersion"]=null;
   if(parsed.transport==="native_http")tools=nativeNames.map(providerOperation=>{const inputSchema=connectedParameters(providerOperation,resolved.connection.resources);return{providerOperation,description:`Approved GitHub read: ${providerOperation}`,inputSchema:inputSchema as any,inputDigest:digestToolSchema(inputSchema),outputSchema:null,outputDigest:null};});
   else{
    const catalog=await discoverMcpCatalog(this.endpoint(resolved.authorization,Date.now()+30000,undefined,resolved.connection.profileId),undefined,{beforeAttempt:observe,onAttempt:observe});
    protocolVersion=catalog.protocolVersion as CapabilityCatalog["protocolVersion"];
    tools=catalog.tools.map(tool=>({providerOperation:tool.name,description:tool.description,inputSchema:tool.inputSchema as any,inputDigest:digestToolSchema(tool.inputSchema),outputSchema:tool.outputSchema as any??null,outputDigest:tool.outputSchema?digestToolSchema(tool.outputSchema):null}));
   }
   const catalog=createCatalog({schemaVersion:1,id:randomUUID(),organizationId:scope.organizationId,connectionId:parsed.connectionId,revision:claim.revision!,transport:parsed.transport,protocolVersion,adapter:resolved.connection.profileId==="stash-read-v1"?this.stashAdapter:resolved.connection.profileId==="public-repository-read-v1"&&parsed.transport==="mcp_http"?this.publicMcpAdapter:parsed.transport==="native_http"?this.nativeAdapter:this.mcpAdapter,tools});
   const result=await this.catalogs.saveCandidate(scope,{operationId:`discovery:${parsed.operationId}`,connectionId:parsed.connectionId,expectedRevision:parsed.expectedRevision,catalog});
   await this.pool.query("UPDATE agents_platform.connected_discoveries SET state='completed',result=$4 WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3 AND state='started'",[scope.organizationId,scope.accountId,parsed.operationId,JSON.stringify(result)]);return result;
  }catch(error){await this.pool.query("UPDATE agents_platform.connected_discoveries SET state=$4,error_code=$5 WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3 AND state='started'",[scope.organizationId,scope.accountId,parsed.operationId,attempts.some(item=>item.outcome==="in_flight")?"uncertain":"failed",code(error)]);throw new PlatformError(code(error),502,"Connected tool discovery did not complete");}
 }
 private async scopeAuthority(db:PoolClient,taskId:string,binding:CapabilityBinding):Promise<{execution:Execution;scope:ActionScope}>{
  const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
  if(!binding.connection||binding.organizationId!==execution.task.organization_id||!execution.configuration.connectedToolBindingIds.includes(binding.id)||!connectedProviderOperationAllowed(binding.connection.profileId,binding.transport,binding.definition.providerOperation))throw denied();
  const principal=execution.task.principal;
  const accountId=principal.kind==="automation"?principal.ownerAccountId:principal.kind==="human"?(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[principal.issuer,principal.subject])).rows[0]?.id:null;
  if(!accountId)throw denied();
  const grant=(await db.query("SELECT operations,connected_tool_binding_ids FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
  const operation=["remote-mcp-v1","custom-api-v1"].includes(binding.connection.profileId)&&binding.policy.effect==="reviewed_write"?"connected.execute":"connected.read";
  if(!grant?.operations.includes(operation)||!grant.connected_tool_binding_ids.includes(binding.id))throw denied();
  if(!(await db.query(`SELECT 1 FROM agents_platform.version_connected_tools v JOIN agents_platform.capability_bindings b ON b.id=v.binding_id
    WHERE v.version_id=$1 AND v.organization_id=$2 AND b.id=$3 AND b.digest=$4 AND b.account_id=$5`,[execution.task.version_id,execution.task.organization_id,binding.id,binding.digest,accountId])).rowCount)throw denied();
  await assertChildConnectedAuthority(db,execution,binding.id);
  const scope={organizationId:execution.task.organization_id,accountId};
  await requireActionMember(db,scope);
  const connection=(await db.query("SELECT profile_id,resource_handles FROM agents_platform.connections WHERE id=$1 AND organization_id=$2 AND account_id=$3 AND policy_revision=$4 AND state='active' AND expires_at>now() FOR SHARE",[binding.connection.id,scope.organizationId,accountId,binding.connection.policyRevision])).rows[0];
  if(!connection||connection.profile_id!==binding.connection.profileId||binding.resources.some(resource=>!connection.resource_handles.some((current:ResourceHandle)=>requestDigest(current)===requestDigest(resource))))throw denied();
  await assertCurrentEvidence(db,taskId,await taskEvidenceManifest(db,taskId));return{execution,scope};
 }
 private async scope(db:PoolClient,taskId:string,binding:CapabilityBinding):Promise<{execution:Execution;scope:ActionScope;credential:Awaited<ReturnType<ConnectionCredentialPort["resolveCredential"]>>}>{
  const{execution,scope}=await this.scopeAuthority(db,taskId,binding);
  const credential=await this.connections.resolveCredential(db,scope,binding.connection!.id,binding.connection!.policyRevision);
  if(binding.connection!.profileId!==credential.connection.profileId)throw denied();
  if(binding.resources.some(resource=>!credential.connection.resources.some(current=>requestDigest(current)===requestDigest(resource))))throw denied();
  return{execution,scope,credential};
 }
 private async handle(db:PoolClient,execution:Execution,binding:CapabilityBinding,id:string,kind:Handle["kind"]):Promise<Handle>{
  const row=(await db.query("SELECT * FROM agents_platform.connected_handles WHERE id=$1 AND organization_id=$2 AND root_task_id=$3 AND connection_id=$4 AND policy_revision=$5 AND kind=$6",[id,execution.task.organization_id,execution.task.root_task_id,binding.connection!.id,binding.connection!.policyRevision,kind])).rows[0];
  if(!row||!binding.resources.some(resource=>requestDigest(resource)===requestDigest(row.resource))||row.digest!==requestDigest(row.payload))throw denied();
  return{id:row.id,kind:row.kind,resource:row.resource,payload:row.payload};
 }
 private async issue(taskId:string,operationId:string,binding:CapabilityBinding,resource:ResourceHandle,kind:Handle["kind"],payload:unknown):Promise<string>{
  return transaction(this.pool,async db=>{
   const initial=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);const{execution}=await this.scope(db,taskId,binding);
   const digest=requestDigest(payload),prior=(await db.query("SELECT id FROM agents_platform.connected_handles WHERE root_task_id=$1 AND connection_id=$2 AND policy_revision=$3 AND kind=$4 AND digest=$5",[execution.task.root_task_id,binding.connection!.id,binding.connection!.policyRevision,kind,digest])).rows[0];if(prior)return prior.id;
   const count=Number((await db.query("SELECT count(*) AS count FROM agents_platform.connected_handles WHERE root_task_id=$1",[execution.task.root_task_id])).rows[0].count);if(count>=MAX_HANDLES)throw new PlatformError("CONNECTED_HANDLE_LIMIT",413,"This task reached its connected resource handle limit");
   const id=randomUUID();await db.query("INSERT INTO agents_platform.connected_handles(id,organization_id,root_task_id,connection_id,policy_revision,resource,kind,digest,payload,created_by_operation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",[id,execution.task.organization_id,execution.task.root_task_id,binding.connection!.id,binding.connection!.policyRevision,resource,kind,digest,payload,operationId]);return id;
  });
 }
 async execute(taskId:string,operationId:string,bindingInput:CapabilityBinding,input:unknown,signal?:AbortSignal):Promise<ConnectedObservation>{
  const invokedAt=Date.now();
  const binding=capabilityBindingSchema.parse(bindingInput),args=connectedModelArguments(binding,input),digest=requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args});
  const remote=binding.connection?.profileId==="remote-mcp-v1",api=binding.connection?.profileId==="custom-api-v1",generic=remote||api,reviewed=generic&&binding.policy.effect==="reviewed_write";
  const reviewInput:GenericToolReviewInput={taskId,operationId,binding,arguments:args,requestDigest:genericToolReviewDigest(binding,args)};
  if(remote&&this.options.ensureCredentialFresh){
   const prior=(await this.pool.query("SELECT task_id,binding_id,request_digest,state,result FROM agents_platform.connected_reads WHERE operation_id=$1",[operationId])).rows[0];
   if(prior){
    if(prior.task_id!==taskId||prior.binding_id!==binding.id||prior.request_digest!==digest)throw new PlatformError("OPERATION_CONFLICT",409,"Connected operation identity changed");
    if(prior.state==="completed")return prior.result;
   }else{
    const freshScope=await transaction(this.pool,async db=>{
     this.registry.resolve(binding);const authorized=await this.scopeAuthority(db,taskId,binding);
     if(reviewed){if(!this.options.genericReview)throw new PlatformError("TOOL_REVIEW_REQUIRED",409,"This operation requires exact approval");await this.options.genericReview.assertApproved(db,reviewInput);}
     return authorized.scope;
    });
    await this.options.ensureCredentialFresh(freshScope,binding.connection!.id);
   }
  }
  const claim=await transaction(this.pool,async db=>{
   const initial=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
   const prior=(await db.query("SELECT * FROM agents_platform.connected_reads WHERE operation_id=$1 FOR UPDATE",[operationId])).rows[0];
   if(prior){
    if(prior.task_id!==taskId||prior.binding_id!==binding.id||prior.request_digest!==digest)throw new PlatformError("OPERATION_CONFLICT",409,"Connected read identity changed");
    if(prior.state==="completed")return{replay:prior.result};
    if(prior.state==="started"){
     const live=(await db.query("SELECT 1 FROM agents_platform.connected_reads WHERE operation_id=$1 AND claim_token IS NOT NULL AND claim_expires_at>clock_timestamp()",[operationId])).rowCount;
     if(live)return{error:"CONNECTED_READ_IN_PROGRESS"};
     await db.query("UPDATE agents_platform.connected_reads SET state='uncertain',error_code='CONNECTED_READ_UNCERTAIN',updated_at=now() WHERE operation_id=$1",[operationId]);
    }
    return{error:prior.state==="failed"?prior.error_code:"CONNECTED_READ_UNCERTAIN"};
   }
   this.registry.resolve(binding);const authorized=await this.scope(db,taskId,binding);
   if(remote&&!this.options.resolveRemoteEndpoint||api&&!this.options.resolveApiOperation)throw new PlatformError("REMOTE_RUNTIME_UNAVAILABLE",503,"Connected operation runtime is unavailable");
   if(reviewed){if(!this.options.genericReview)throw new PlatformError("TOOL_REVIEW_REQUIRED",409,"This remote operation requires exact approval");await this.options.genericReview.assertApproved(db,reviewInput);}
   const operation=(await db.query("SELECT started_at,reserved_ms FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name=$3 AND kind='tool' AND state='started'",[operationId,taskId,binding.alias])).rows[0];
   if(!operation)throw denied();
   let selected:GithubRepositorySelection|undefined,handle:Handle|undefined;
   if(args.repository)selected=authorized.credential.connection.selections.find(selection=>githubRepositoryHandle(selection).id===args.repository&&binding.resources.some(resource=>resource.id===args.repository&&resource.kind==="github.repository"));
   else if(args.revisionId)handle=await this.handle(db,authorized.execution,binding,args.revisionId,"revision");else if(args.fileId)handle=await this.handle(db,authorized.execution,binding,args.fileId,"file");else if(args.releaseId)handle=await this.handle(db,authorized.execution,binding,args.releaseId,"release");
   if(!selected&&handle)selected=authorized.credential.connection.selections.find(selection=>githubRepositoryHandle(selection).id===handle!.resource.id);
   const stashResource=binding.connection?.profileId==="stash-read-v1"?binding.resources.find(resource=>resource.kind==="stash.item"&&resource.id===args.itemId):undefined;
   const genericResource=generic?binding.resources.find(resource=>resource.kind===(api?"api.origin":"mcp.endpoint")):undefined;
   if(!selected&&!stashResource&&!genericResource)throw denied();
   const remoteEndpoint=remote?await this.options.resolveRemoteEndpoint!(db,authorized.scope,binding.connection!.id,binding.connection!.policyRevision):undefined;
   const apiOperation=api?await this.options.resolveApiOperation!(db,authorized.scope,binding.connection!.id,binding.connection!.policyRevision,binding.definition.providerOperation):undefined;
   if(remoteEndpoint&&genericResource?.id!==remoteEndpoint.endpoint)throw denied();
   const claimToken=randomUUID();
   const inserted=(await db.query(`INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state,claim_token,claim_expires_at)
    SELECT $1,$2,$3,$4,$5,$6,$7,'started',$8,LEAST(o.started_at+make_interval(secs=>LEAST(o.reserved_ms,$9)::double precision/1000),t.deadline_at)
    FROM agents_platform.operations o JOIN agents_platform.tasks t ON t.id=o.task_id WHERE o.id=$1 AND t.id=$2 RETURNING claim_expires_at`,[operationId,taskId,initial.task.organization_id,initial.task.root_task_id,binding.connection!.id,binding.id,digest,claimToken,binding.limits.timeoutMs])).rows[0]!;
   if(generic)await recordEvent(db,taskId,`connected-claim:${operationId}`,"tool.connected_claimed",{operationId,connectionId:binding.connection!.id,bindingId:binding.id,policyRevision:binding.connection!.policyRevision,outcome:"started"});
   return{...authorized,selected:selected!,stashResource,genericResource,remoteEndpoint,apiOperation,handle,claimToken,deadlineAt:new Date(inserted.claim_expires_at).getTime()};
  });
  if("replay"in claim)return claim.replay;
  if("error"in claim){if(claim.error==="CONNECTED_READ_UNCERTAIN")throw generic?genericUncertain():uncertain();throw new PlatformError(claim.error,claim.error==="CONNECTED_READ_IN_PROGRESS"?409:502,"The connected read did not complete");}
  const deadlineAt=claim.deadlineAt;
  const assertClaim=async(db:PoolClient)=>{
   await db.query("SELECT operation_id FROM agents_platform.connected_reads WHERE operation_id=$1 FOR UPDATE",[operationId]);
   if(!(await db.query("SELECT 1 FROM agents_platform.connected_reads WHERE operation_id=$1 AND task_id=$2 AND state='started' AND claim_token=$3 AND claim_expires_at>clock_timestamp()",[operationId,taskId,claim.claimToken])).rowCount)throw uncertain();
  };
  const checkDeadline=()=>{if(Date.now()>=deadlineAt)throw new PlatformError("CONNECTED_READ_DEADLINE",409,"The connected read exceeded its original operation deadline");};
  let ordinal=0,pending=0,readCount=0,setupCount=0,genericCalls=0,genericEffectClaimed=false;
  const before=async(phase:"setup"|"read"="read",attempt?:RemoteMcpAttempt)=>{
   checkDeadline();
   await transaction(this.pool,async db=>{
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);const current=await this.scope(db,taskId,binding);
    await assertClaim(db);
    if(current.credential.connection.revision!==claim.credential.connection.revision)throw new PlatformError("CONNECTION_CREDENTIAL_CHANGED",403,"Connection credentials changed during this read");
    if(reviewed)await this.options.genericReview!.assertApproved(db,reviewInput);
    if(generic){
     if(++ordinal>(binding.limits.maxPhysicalRequests??128))throw new PlatformError("CONNECTED_ATTEMPT_LIMIT",409,"The remote operation reached its request limit");
     if(attempt?.rpcMethod==="tools/call"){
      if(++genericCalls>1)throw new PlatformError("CONNECTED_ATTEMPT_LIMIT",409,"The remote invocation cannot be repeated");
      if(reviewed)await this.options.genericReview!.claim(db,reviewInput);
     }
    }else if(++ordinal>7||phase==="read"&&++readCount>3||phase==="setup"&&++setupCount>4)throw new PlatformError("CONNECTED_ATTEMPT_LIMIT",409,"The connected read reached its request limit");
    await db.query("INSERT INTO agents_platform.connected_attempts(operation_id,ordinal,phase,state) VALUES($1,$2,$3,'started')",[operationId,ordinal,phase]);pending=ordinal;
   });
   if(attempt?.rpcMethod==="tools/call")genericEffectClaimed=true;
  };
  const after=async(receipt:NetworkAttempt)=>{const attempt=generic?receipt.attempt:pending;await this.pool.query("UPDATE agents_platform.connected_attempts SET state='completed',receipt=$3 WHERE operation_id=$1 AND ordinal=$2 AND state='started'",[operationId,attempt,JSON.stringify({...receipt,attempt})]);};
  let responseOrdinal=0;
  const capture=async(response:{body:unknown;digest:string;observedAt:string})=>{
    checkDeadline();
    const bytes=Buffer.from(JSON.stringify(response.body));if(bytes.length>MAX_BODY_BYTES)throw new PlatformError("CONNECTED_BODY_LIMIT",413,"Provider response exceeds private storage limit");
    if(claim.credential.authorization&&bytes.includes(Buffer.from(claim.credential.authorization)))throw new PlatformError("CONNECTED_CREDENTIAL_REFLECTION",502,"Provider response reflected private authorization");
    const contentDigest=textDigest(bytes),key=`connected/${claim.execution.task.organization_id}/${claim.execution.task.root_task_id}/${textDigest(operationId)}/response-${++responseOrdinal}-${contentDigest}`;
    await writeExecutionObject(this.pool,this.objects,{taskId,operationId,key,bytes,contentType:"application/json"});
    checkDeadline();
    await transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);
      await this.scope(db,taskId,binding);
      await assertClaim(db);
      if(!(await db.query("SELECT 1 FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND state='started'",[operationId,taskId])).rowCount)throw uncertain();
      const object=(await db.query("SELECT state,content_digest FROM agents_platform.execution_objects WHERE object_key=$1 FOR SHARE",[key])).rows[0];
      if(object?.state!=="available"||object.content_digest!==contentDigest)throw new PlatformError("EXECUTION_OBJECT_UNCERTAIN",409,"The private response body is unavailable");
      checkDeadline();
      await db.query("INSERT INTO agents_platform.connected_response_bodies(operation_id,ordinal,object_key,content_digest,provider_digest,observed_at) VALUES($1,$2,$3,$4,$5,$6)",[operationId,responseOrdinal,key,contentDigest,response.digest,response.observedAt]);
    });
  };
  const native=()=>new GithubReadAdapter({authorization:claim.credential.authorization,...(claim.credential.connection.profileId==="public-repository-read-v1"?{authentication:"none" as const}:{}),selections:claim.credential.connection.selections,deadlineAt,signal,testLoopbackOrigin:this.options.testGithubOrigin,beforeAttempt:()=>before(),onAttempt:after,onResponse:capture,maxPhysicalRequests:binding.transport==="mcp_http"?1:3});
  try{
   let projection:Projection,full:unknown;
   if(claim.genericResource){
    const observation=api?await executeGenericNativeApi(binding,claim.apiOperation!,args,{deadlineAt,signal,testLoopback:this.options.testApiLoopback,
      beforeAttempt:attempt=>before("read",{...attempt,rpcMethod:"tools/call"}),onAttempt:after})
     :await executeGenericConnectedTool(binding,{...claim.remoteEndpoint!,deadlineAt,effectiveAuthorityDigest:requestDigest({principal:claim.execution.task.principal,versionId:claim.execution.task.version_id,
       product:claim.execution.task.product,resourceId:claim.execution.task.resource_id,callerClientId:claim.execution.task.caller_client_id,
       bindings:claim.execution.connectedBindings.map(selected=>({id:selected.id,digest:selected.digest,resources:selected.resources})).sort((a,b)=>a.id.localeCompare(b.id))})},args,signal,{beforeAttempt:attempt=>before(attempt.phase??"read",attempt),onAttempt:after});
    full=observation.rawResult;
    const inline=observation.content.filter(block=>block.type==="text"&&typeof block.text==="string").map(block=>block.text).join("\n");
    const blocks=observation.content.slice(0,16).map((block,index)=>({index,type:String(block.type).slice(0,64),digest:requestDigest(block),...(typeof block.mimeType==="string"?{mimeType:block.mimeType.slice(0,128)}:{})}));
    const display=inline|| (observation.structuredContent!==undefined?JSON.stringify(observation.structuredContent):`The provider returned ${observation.content.length} content blocks. The complete result is in the private operation receipt.`);
    projection={...prefix(display),resource:claim.genericResource,acquiredAt:new Date().toISOString(),digest:observation.resultDigest,isError:observation.isError,
     handles:{contentBlocks:blocks,omittedContentBlocks:Math.max(0,observation.content.length-blocks.length),privateReceipt:true},
     provenance:{kind:api?"native_api_observation":"remote_mcp_observation",...(api?{templateDigest:binding.definition.nativeApi!.templateDigest,importDigest:binding.definition.nativeApi!.importDigest,httpStatus:(observation as {status:number}).status}
      :{protocolVersion:(observation as {protocolVersion:string}).protocolVersion,transport:(observation as {transport:string}).transport,definitionDigest:binding.definition.remote!.definitionDigest}),contentBlockCount:observation.content.length,hasStructuredContent:observation.structuredContent!==undefined}};
   }else if(claim.stashResource){
    const remoteArgs=binding.definition.providerOperation==="get_item"?{id:claim.stashResource.id}:{id:claim.stashResource.id,offset:args.offset??0};
    const tool:McpTool={name:binding.definition.providerOperation,description:binding.definition.description,inputSchema:binding.definition.inputSchema as Record<string,unknown>,...(binding.definition.outputSchema?{outputSchema:binding.definition.outputSchema as Record<string,unknown>}:{}),schemaDigest:requestDigest({inputSchema:binding.definition.inputSchema,outputSchema:binding.definition.outputSchema})};
    const observation=await callMcpTool(this.endpoint(claim.credential.authorization,deadlineAt,binding.protocolVersion!,"stash-read-v1"),tool,remoteArgs,signal,{beforeAttempt:attempt=>before(attempt.phase??"setup"),onAttempt:after});
    full=observation.rawResult;
    if(observation.isError)projection={...prefix(observation.text),resource:claim.stashResource,acquiredAt:new Date().toISOString(),digest:observation.resultDigest,provenance:{kind:"timestamped_observation",itemId:claim.stashResource.id},isError:true};
    else{
     const item=stashItemObservation(observation.rawResult,claim.stashResource.id,binding.definition.providerOperation,args.offset??0);
     await this.stashRevision(taskId,operationId,binding,claim.stashResource,item.provenance.revision);
     projection={...item,resource:claim.stashResource,acquiredAt:new Date().toISOString(),digest:observation.resultDigest};
    }
   }else if(binding.connection?.profileId==="public-repository-read-v1"&&binding.transport==="mcp_http"){
    await native().getRepository(claim.selected);
    const tool:McpTool={name:binding.definition.providerOperation,description:binding.definition.description,inputSchema:binding.definition.inputSchema as Record<string,unknown>,...(binding.definition.outputSchema?{outputSchema:binding.definition.outputSchema as Record<string,unknown>}:{}),schemaDigest:requestDigest({inputSchema:binding.definition.inputSchema,outputSchema:binding.definition.outputSchema})};
    const observation=await callMcpTool({...this.endpoint("",deadlineAt,binding.protocolVersion!,"public-repository-read-v1"),readAttempts:2},tool,{repoName:`${claim.selected.owner}/${claim.selected.repository}`},signal,{beforeAttempt:attempt=>before(attempt.phase??"setup"),onAttempt:after});
    full=observation.rawResult;
    const contents=observation.rawResult.content;
    if(!Array.isArray(contents)||!contents.length||contents.some((entry:any)=>entry?.type!=="text"||typeof entry.text!=="string"))throw new PlatformError("PUBLIC_MCP_RESULT_INVALID",502,"The public tool did not return inline text");
    const source=contents.map((entry:any)=>entry.text).join("\n"),text=source.slice(args.offset??0);
    if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(text))throw new PlatformError("PUBLIC_MCP_TEXT_BOUNDARY",400,"Read from a complete Unicode character boundary");
    const visible=prefix(text);projection={...visible,resource:githubRepositoryHandle(claim.selected),acquiredAt:new Date().toISOString(),digest:observation.resultDigest,provenance:{kind:"timestamped_observation",provider:"deepwiki",repository:githubRepositoryHandle(claim.selected).id,offset:args.offset??0,nextOffset:visible.truncated?(args.offset??0)+visible.text.length:null},isError:observation.isError};
   }else if(binding.transport==="native_http"){
    let observation:GithubObservation<unknown>;
    switch(binding.definition.providerOperation){
     case"get_repository":observation=await native().getRepository(claim.selected);break;
     case"resolve_ref":observation=await native().resolveRevision(claim.selected);break;
     case"list_tree":observation=await native().listTree(claim.handle!.payload);break;
     case"read_file":observation=await native().readFile(claim.handle!.payload.revision,claim.handle!.payload.file);break;
     case"list_releases":observation=await native().listReleases(claim.selected);break;
     default:throw denied();
    }
    full=observation;projection=await this.projectNative(taskId,operationId,binding,args,claim.selected,observation,checkDeadline);
   }else{
    await native().getRepository(claim.selected);
    const remoteArgs=this.remoteArguments(binding,args,claim.selected,claim.handle);
    const tool:McpTool={name:binding.definition.providerOperation,description:binding.definition.description,inputSchema:binding.definition.inputSchema as Record<string,unknown>,...(binding.definition.outputSchema?{outputSchema:binding.definition.outputSchema as Record<string,unknown>}:{}),schemaDigest:requestDigest({inputSchema:binding.definition.inputSchema,outputSchema:binding.definition.outputSchema})};
    const observation=await callMcpTool({...this.endpoint(claim.credential.authorization,deadlineAt,binding.protocolVersion!),readAttempts:2},tool,remoteArgs,signal,{beforeAttempt:attempt=>before(attempt.phase??"setup"),onAttempt:after});
    full=observation.rawResult;const allText=binding.definition.providerOperation==="get_file_contents"&&!observation.isError?githubMcpFileText(observation.rawResult,claim.handle!.payload.revision,claim.handle!.payload.file):Array.isArray(observation.rawResult.content)?observation.rawResult.content.filter((item:any)=>item?.type==="text"&&typeof item.text==="string").map((item:any)=>item.text).join("\n"):observation.text;const visible=prefix(allText.slice(args.offset??0));projection={...visible,resource:githubRepositoryHandle(claim.selected),acquiredAt:new Date().toISOString(),digest:observation.resultDigest,provenance:binding.definition.providerOperation==="get_file_contents"&&!observation.isError?{kind:"commit_snapshot",commitSha:claim.handle!.payload.revision.commitSha}:{kind:"timestamped_observation",...(claim.handle?.kind==="revision"?{requestedCommit:claim.handle.payload.commitSha}:{})},isError:observation.isError};
   }
   checkDeadline();
   const body=Buffer.from(JSON.stringify(full));if(body.length>MAX_BODY_BYTES)throw new PlatformError("CONNECTED_BODY_LIMIT",413,"Connected receipt exceeds the private storage limit");
   if(claim.credential.authorization&&body.includes(Buffer.from(claim.credential.authorization)))throw new PlatformError("CONNECTED_CREDENTIAL_REFLECTION",502,"The connected response reflected private authorization");
   const bodyDigest=textDigest(body),bodyKey=`connected/${claim.execution.task.organization_id}/${claim.execution.task.root_task_id}/${textDigest(operationId)}/${bodyDigest}`;
   await writeExecutionObject(this.pool,this.objects,{taskId,operationId,key:bodyKey,bytes:body,contentType:"application/json"});
   if(reviewed&&projection.isError){
    await transaction(this.pool,async db=>{
     await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);
     await this.scope(db,taskId,binding);await assertClaim(db);
     await db.query("UPDATE agents_platform.connected_reads SET body_key=$2,body_digest=$3,updated_at=now() WHERE operation_id=$1 AND state='started' AND claim_token=$4",[operationId,bodyKey,bodyDigest,claim.claimToken]);
    });
    throw genericUncertain();
   }
   checkDeadline();
   const passage=await this.evidence.recordConnected(taskId,operationId,{bindingId:binding.id,resource:projection.resource,text:projection.text||"The provider returned an empty result.",title:`${api?"Native API":generic?"Remote MCP":binding.connection?.profileId==="stash-read-v1"?"Stash":binding.connection?.profileId==="public-repository-read-v1"&&binding.transport==="mcp_http"?"DeepWiki":"GitHub"} ${binding.definition.providerOperation}${projection.isError?" error":""}`,acquiredAt:projection.acquiredAt,receiptDigest:bodyDigest});
   const result:ConnectedObservation={status:projection.isError?"tool_error":"ok",bindingId:binding.id,operationId,content:passage.text,truncated:projection.truncated,evidence:{id:passage.reference.id,label:passage.label,citation:`[${passage.label}]`,contentDigest:passage.reference.contentDigest},...(projection.handles?{handles:projection.handles}:{}),observation:{digest:projection.digest,acquiredAt:projection.acquiredAt,provenance:projection.provenance}};
   if(Buffer.byteLength(JSON.stringify(result))>8192)throw new PlatformError("CONNECTED_RESULT_LIMIT",413,"Connected observation exceeds its model result limit");
   checkDeadline();
   const published=await transaction(this.pool,async db=>{
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);
    const current=await this.scope(db,taskId,binding);
    if(current.credential.connection.revision!==claim.credential.connection.revision)throw new PlatformError("CONNECTION_CREDENTIAL_CHANGED",403,"Connection credentials changed during this read");
    await assertClaim(db);
    if(reviewed)await this.options.genericReview!.assertApproved(db,reviewInput);
    const published=await db.query("UPDATE agents_platform.connected_reads SET state='completed',result=$2,body_key=$3,body_digest=$4,updated_at=now() WHERE operation_id=$1 AND state='started' AND claim_token=$5 AND claim_expires_at>clock_timestamp() AND EXISTS(SELECT 1 FROM agents_platform.operations p WHERE p.id=$1 AND p.state='started')",[operationId,JSON.stringify(result),bodyKey,bodyDigest,claim.claimToken]);
    if(published.rowCount&&reviewed)await this.options.genericReview!.completed?.(db,reviewInput,projection.digest);
    if(published.rowCount&&generic)await recordEvent(db,taskId,`connected-result:${operationId}`,"tool.connected_result",{operationId,connectionId:binding.connection!.id,bindingId:binding.id,policyRevision:binding.connection!.policyRevision,outcome:"completed",durationMs:Math.max(0,Date.now()-invokedAt)});
    return published;
   });
   if(!published.rowCount) throw new PlatformError("CONNECTED_READ_UNCERTAIN",409,"Connected read receipt is no longer publishable");
   return result;
  }catch(error){
   const active=Number((await this.pool.query("SELECT count(*) AS count FROM agents_platform.connected_attempts WHERE operation_id=$1 AND (state='started' OR (receipt->>'status' IS NULL AND receipt->>'outcome' IN ('CANCELLED','DEADLINE','NETWORK_UNAVAILABLE')))",[operationId])).rows[0].count);
   const unknown=!!active||reviewed&&genericEffectClaimed||error instanceof PlatformError&&["CONNECTED_READ_DEADLINE","CONNECTED_READ_UNCERTAIN"].includes(error.code);
   if(reviewed&&this.options.genericReview?.failed)await transaction(this.pool,db=>this.options.genericReview!.failed!(db,reviewInput,{uncertain:genericEffectClaimed}));
   const settled=await this.pool.query("UPDATE agents_platform.connected_reads SET state=CASE WHEN $2 OR claim_expires_at<=clock_timestamp() THEN 'uncertain' ELSE 'failed' END,error_code=$3,updated_at=now() WHERE operation_id=$1 AND state='started' AND claim_token=$4 RETURNING state",[operationId,unknown,code(error),claim.claimToken]);
   if(generic)await recordEvent(this.pool,taskId,`connected-result:${operationId}`,"tool.connected_result",{operationId,connectionId:binding.connection!.id,bindingId:binding.id,policyRevision:binding.connection!.policyRevision,outcome:unknown||settled.rows[0]?.state==="uncertain"?"uncertain":"failed",errorCode:code(error),durationMs:Math.max(0,Date.now()-invokedAt)});
   if(unknown||!settled.rowCount||settled.rows[0]?.state==="uncertain")throw generic?genericUncertain():uncertain();
   throw new PlatformError(code(error),502,"Connected read did not complete");
  }
 }
 private async stashRevision(taskId:string,operationId:string,binding:CapabilityBinding,resource:ResourceHandle,revision:number):Promise<void>{
  await transaction(this.pool,async db=>{
   const initial=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
   const{execution}=await this.scope(db,taskId,binding);
   const prior=(await db.query("SELECT payload FROM agents_platform.connected_handles WHERE root_task_id=$1 AND connection_id=$2 AND policy_revision=$3 AND kind='revision' AND resource=$4",[execution.task.root_task_id,binding.connection!.id,binding.connection!.policyRevision,resource])).rows;
   if(prior.some(row=>row.payload.stashItemId!==resource.id||row.payload.revision!==revision))throw new PlatformError("STASH_OBSERVATION_CONFLICT",409,"The Stash item changed during this task; start a fresh task for its new revision");
   if(prior.length)return;
   const count=Number((await db.query("SELECT count(*) AS count FROM agents_platform.connected_handles WHERE root_task_id=$1",[execution.task.root_task_id])).rows[0].count);if(count>=MAX_HANDLES)throw new PlatformError("CONNECTED_HANDLE_LIMIT",413,"This task reached its connected resource handle limit");
   const payload={stashItemId:resource.id,revision};
   await db.query("INSERT INTO agents_platform.connected_handles(id,organization_id,root_task_id,connection_id,policy_revision,resource,kind,digest,payload,created_by_operation) VALUES($1,$2,$3,$4,$5,$6,'revision',$7,$8,$9)",[randomUUID(),execution.task.organization_id,execution.task.root_task_id,binding.connection!.id,binding.connection!.policyRevision,resource,requestDigest(payload),payload,operationId]);
  });
 }
 private async projectNative(taskId:string,operationId:string,binding:CapabilityBinding,args:ConnectedModelArguments,selection:GithubRepositorySelection,observation:GithubObservation<unknown>,checkDeadline:()=>void):Promise<Projection>{
  const resource=githubRepositoryHandle(selection),value=observation.value as any;let visible:unknown=value,handles:unknown;
  switch(binding.definition.providerOperation){
   case"resolve_ref":{const revisionId=await this.issue(taskId,operationId,binding,resource,"revision",value);visible={revisionId,repository:resource.id,commitSha:value.commitSha,resolvedAt:value.resolvedAt};handles={revisionId};break;}
   case"list_tree":{const files=(value.files as GithubFileHandle[]).filter(file=>args.filePath===undefined||file.path===args.filePath),entries=[];for(const file of files.slice(args.offset??0,(args.offset??0)+20)){checkDeadline();if(Buffer.byteLength(JSON.stringify([...entries,{fileId:"0".repeat(36),path:file.path,bytes:file.size}]))>2400)break;const fileId=await this.issue(taskId,operationId,binding,resource,"file",{revision:value.revision,file});entries.push({fileId,path:file.path,bytes:file.size});}visible={files:entries,...(args.filePath===undefined?{}:{filePath:args.filePath}),omittedUnsupported:value.omittedUnsupported,hasMore:files.length>(args.offset??0)+entries.length,nextOffset:(args.offset??0)+entries.length};handles={files:entries.map(({fileId})=>({fileId}))};break;}
   case"read_file":visible=value.content.slice(args.offset??0);if(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(visible as string))throw new PlatformError("CONNECTED_TEXT_BOUNDARY",400,"Read from a complete Unicode character boundary");break;
   case"list_releases":{const entries=[];for(const release of value.releases){checkDeadline();const releaseId=await this.issue(taskId,operationId,binding,resource,"release",{repository:selection,release});entries.push({releaseId,tag:release.tag,name:release.name,publishedAt:release.publishedAt,body:prefix(release.body??"",512).text});}visible={releases:entries,hasMore:value.hasMore,pageSize:value.pageSize};handles={releases:entries.map(({releaseId})=>({releaseId}))};break;}
  }
  const projected=prefix(typeof visible==="string"?visible:JSON.stringify(visible),binding.definition.providerOperation==="read_file"?args.maxBytes??4096:4096);return{...projected,handles,resource,acquiredAt:observation.observedAt,digest:observation.digest,provenance:observation.provenance};
 }
 private remoteArguments(binding:CapabilityBinding,args:ConnectedModelArguments,selection:GithubRepositorySelection,handle?:Handle):Record<string,unknown>{
  const base={owner:selection.owner,repo:selection.repository};
  switch(binding.definition.providerOperation){
   case"list_releases":return{...base,perPage:20,page:1};
   case"get_latest_release":return base;
   case"get_release_by_tag":return{...base,tag:handle!.payload.release.tag};
   case"get_repository_tree":return{...base,tree_sha:handle!.payload.treeSha,recursive:false};
   case"get_file_contents":return{...base,path:handle!.payload.file.path,ref:handle!.payload.revision.commitSha};
   default:throw denied();
  }
 }
}
