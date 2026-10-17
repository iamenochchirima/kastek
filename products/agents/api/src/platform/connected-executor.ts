import {writeExecutionObject} from "./execution-objects";
import {createHash,randomUUID} from "node:crypto";
import {readFileSync} from "node:fs";
import {extname,join} from "node:path";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {PlatformError,requestDigest} from "./contracts";
import {transaction} from "./database";
import {assertCurrentAuthority,loadExecution,type Execution} from "./execution";
import {ConnectionStore,requireActionMember,type ActionScope} from "./connections";
import {ConnectedCatalogStore,GITHUB_MCP_READ_OPERATIONS,githubProviderOperationAllowed} from "./connected-catalog-store";
import {createCatalog,digestToolSchema,ExecutableAdapterRegistry,capabilityBindingSchema,type CapabilityBinding,type ResourceHandle,type CapabilityCatalog} from "./capability-catalog";
import {GithubReadAdapter,GITHUB_ADAPTER_RELEASE,githubRepositoryHandle,type GithubObservation,type GithubRepositorySelection,type GithubRevision,type GithubFileHandle} from "./github-adapter";
import {callMcpTool,discoverMcpCatalog,MCP_ADAPTER_RELEASE,type McpEndpoint,type McpTool} from "./mcp-adapter";
import type {NetworkAttempt} from "./connected-network";
import type {PrivateObjectStore} from "./artifacts";
import {EvidenceStore,assertCurrentEvidence} from "./evidence";
import {textDigest} from "./source-contracts";
import {assertConnectedBindingDependencies,connectedModelArguments,connectedModelTool,connectedParameters,type ConnectedModelArguments} from "./connected-tool-schema";

const MAX_HANDLES=2000,MAX_BODY_BYTES=2097152;
const denied=()=>new PlatformError("CONNECTED_SCOPE_DENIED",403,"Connected resource is outside the task's authorized scope");
const uncertain=()=>new PlatformError("CONNECTED_READ_UNCERTAIN",409,"The previous connected read has an unknown outcome; it was not repeated");
const code=(error:unknown):string=>{const value=(error as {code?:unknown})?.code;return typeof value==="string"&&/^[A-Z0-9_]{1,80}$/.test(value)?value:"CONNECTED_READ_FAILED";};
export interface ConnectedExecutorOptions {testGithubOrigin?:string;testMcpEndpoint?:string}
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
 readonly nativeAdapter;readonly mcpAdapter;
 constructor(readonly pool:Pool,readonly connections:ConnectionStore,readonly objects:PrivateObjectStore,readonly evidence:EvidenceStore,private readonly options:ConnectedExecutorOptions={}){
  const extension=extname(__filename),files=["connected-executor","connected-tool-schema","connected-network","github-adapter","mcp-adapter","adapter-process","capability-catalog"];
  const hash=createHash("sha256");for(const file of files)hash.update(file).update(readFileSync(join(__dirname,`${file}${extension}`)));
  const executableDigest=hash.digest("hex");
  this.nativeAdapter=this.registry.register({schemaVersion:1,id:"github-native-read",release:GITHUB_ADAPTER_RELEASE,executableDigest,transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true},this);
  this.mcpAdapter=this.registry.register({schemaVersion:1,id:"github-mcp-read",release:MCP_ADAPTER_RELEASE,executableDigest,transports:["mcp_http"],protocolVersions:["2026-07-28","2025-11-25"],boundedSchemaValidation:true},this);
  this.catalogs=new ConnectedCatalogStore(pool,connections,this.registry);
 }
 assertAvailable(bindings:readonly CapabilityBinding[]):void{assertConnectedBindingDependencies(bindings);for(const binding of bindings){capabilityBindingSchema.parse(binding);this.registry.resolve(binding);}}
 modelToolsFor(bindings:readonly CapabilityBinding[]){this.assertAvailable(bindings);return bindings.map(connectedModelTool);}
 private endpoint(authorization:string,deadlineAt:number,protocolVersion?:McpEndpoint["protocolVersion"]):McpEndpoint{
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
   if(!row||row.revision!==parsed.expectedRevision||row.profile_id!=="github-public-read-v1")throw denied();
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
    const catalog=await discoverMcpCatalog(this.endpoint(resolved.authorization,Date.now()+30000),undefined,{beforeAttempt:observe,onAttempt:observe});
    protocolVersion=catalog.protocolVersion as CapabilityCatalog["protocolVersion"];
    tools=catalog.tools.map(tool=>({providerOperation:tool.name,description:tool.description,inputSchema:tool.inputSchema as any,inputDigest:digestToolSchema(tool.inputSchema),outputSchema:tool.outputSchema as any??null,outputDigest:tool.outputSchema?digestToolSchema(tool.outputSchema):null}));
   }
   const catalog=createCatalog({schemaVersion:1,id:randomUUID(),organizationId:scope.organizationId,connectionId:parsed.connectionId,revision:claim.revision!,transport:parsed.transport,protocolVersion,adapter:parsed.transport==="native_http"?this.nativeAdapter:this.mcpAdapter,tools});
   const result=await this.catalogs.saveCandidate(scope,{operationId:`discovery:${parsed.operationId}`,connectionId:parsed.connectionId,expectedRevision:parsed.expectedRevision,catalog});
   await this.pool.query("UPDATE agents_platform.connected_discoveries SET state='completed',result=$4 WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3 AND state='started'",[scope.organizationId,scope.accountId,parsed.operationId,JSON.stringify(result)]);return result;
  }catch(error){await this.pool.query("UPDATE agents_platform.connected_discoveries SET state=$4,error_code=$5 WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3 AND state='started'",[scope.organizationId,scope.accountId,parsed.operationId,attempts.some(item=>item.outcome==="in_flight")?"uncertain":"failed",code(error)]);throw new PlatformError(code(error),502,"Connected tool discovery did not complete");}
 }
 private async scope(db:PoolClient,taskId:string,binding:CapabilityBinding):Promise<{execution:Execution;scope:ActionScope;credential:Awaited<ReturnType<ConnectionStore["resolveCredential"]>>}>{
  const execution=await loadExecution(db,taskId);await assertCurrentAuthority(db,execution);
  if(!binding.connection||binding.organizationId!==execution.task.organization_id||!execution.configuration.connectedToolBindingIds.includes(binding.id)||!githubProviderOperationAllowed(binding.transport,binding.definition.providerOperation))throw denied();
  const principal=execution.task.principal;
  const accountId=principal.kind==="automation"?principal.ownerAccountId:principal.kind==="human"?(await db.query("SELECT id FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2",[principal.issuer,principal.subject])).rows[0]?.id:null;
  if(!accountId)throw denied();
  const grant=(await db.query("SELECT operations,connected_tool_binding_ids FROM agents_platform.execution_grants WHERE id=$1",[execution.task.grant_id])).rows[0];
  if(!grant?.operations.includes("connected.read")||!grant.connected_tool_binding_ids.includes(binding.id))throw denied();
  if(!(await db.query(`SELECT 1 FROM agents_platform.version_connected_tools v JOIN agents_platform.capability_bindings b ON b.id=v.binding_id
    WHERE v.version_id=$1 AND v.organization_id=$2 AND b.id=$3 AND b.digest=$4 AND b.account_id=$5`,[execution.task.version_id,execution.task.organization_id,binding.id,binding.digest,accountId])).rowCount)throw denied();
  if(execution.task.parent_task_id){const root=await loadExecution(db,execution.task.root_task_id);if(!root.configuration.connectedToolBindingIds.includes(binding.id))throw denied();const rootGrant=(await db.query("SELECT connected_tool_binding_ids,operations FROM agents_platform.execution_grants WHERE id=$1",[root.task.grant_id])).rows[0];if(!rootGrant?.operations.includes("connected.read")||!rootGrant.connected_tool_binding_ids.includes(binding.id))throw denied();}
  const scope={organizationId:execution.task.organization_id,accountId};
  const credential=await this.connections.resolveCredential(db,scope,binding.connection.id,binding.connection.policyRevision);
  if(binding.resources.some(resource=>!credential.connection.resources.some(current=>requestDigest(current)===requestDigest(resource))))throw denied();
  await assertCurrentEvidence(db,taskId,await this.evidence.taskManifest(taskId));return{execution,scope,credential};
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
  const lease=await this.pool.connect(),key=BigInt.asIntN(64,BigInt(`0x${textDigest(operationId).slice(0,16)}`)).toString();let locked=false;
  try{
   locked=(await lease.query("SELECT pg_try_advisory_lock($1::bigint) AS locked",[key])).rows[0].locked;
   if(!locked)throw new PlatformError("CONNECTED_READ_IN_PROGRESS",409,"The connected read is already running");
   return await this.executeClaim(taskId,operationId,bindingInput,input,signal);
  }finally{if(locked)await lease.query("SELECT pg_advisory_unlock($1::bigint)",[key]).catch(()=>undefined);lease.release();}
 }
 private async executeClaim(taskId:string,operationId:string,bindingInput:CapabilityBinding,input:unknown,signal?:AbortSignal):Promise<ConnectedObservation>{
  const binding=capabilityBindingSchema.parse(bindingInput),args=connectedModelArguments(binding,input),digest=requestDigest({bindingId:binding.id,bindingDigest:binding.digest,args});
  const claim=await transaction(this.pool,async db=>{
   const initial=await loadExecution(db,taskId);await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[initial.task.organization_id]);
   const prior=(await db.query("SELECT * FROM agents_platform.connected_reads WHERE operation_id=$1 FOR UPDATE",[operationId])).rows[0];
   if(prior){if(prior.task_id!==taskId||prior.binding_id!==binding.id||prior.request_digest!==digest)throw new PlatformError("OPERATION_CONFLICT",409,"Connected read identity changed");if(prior.state==="completed")return{replay:prior.result};if(prior.state==="started")await db.query("UPDATE agents_platform.connected_reads SET state='uncertain',error_code='CONNECTED_READ_UNCERTAIN' WHERE operation_id=$1",[operationId]);return{error:prior.state==="failed"?prior.error_code:"CONNECTED_READ_UNCERTAIN"};}
   this.registry.resolve(binding);const authorized=await this.scope(db,taskId,binding);
   const operation=(await db.query("SELECT started_at,reserved_ms FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND name=$3 AND kind='tool' AND state='started'",[operationId,taskId,binding.alias])).rows[0];
   if(!operation)throw denied();
   let selected:GithubRepositorySelection|undefined,handle:Handle|undefined;
   if(args.repository)selected=authorized.credential.connection.selections.find(selection=>githubRepositoryHandle(selection).id===args.repository&&binding.resources.some(resource=>resource.id===args.repository&&resource.kind==="github.repository"));
   else if(args.revisionId)handle=await this.handle(db,authorized.execution,binding,args.revisionId,"revision");else if(args.fileId)handle=await this.handle(db,authorized.execution,binding,args.fileId,"file");else if(args.releaseId)handle=await this.handle(db,authorized.execution,binding,args.releaseId,"release");
   if(!selected&&handle)selected=authorized.credential.connection.selections.find(selection=>githubRepositoryHandle(selection).id===handle!.resource.id);
   if(!selected)throw denied();
   await db.query("INSERT INTO agents_platform.connected_reads(operation_id,task_id,organization_id,root_task_id,connection_id,binding_id,request_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,'started')",[operationId,taskId,initial.task.organization_id,initial.task.root_task_id,binding.connection!.id,binding.id,digest]);
   return{...authorized,selected,handle,operationDeadline:new Date(operation.started_at).getTime()+Math.min(operation.reserved_ms,binding.limits.timeoutMs)};
  });
  if("replay"in claim)return claim.replay;if("error"in claim)throw claim.error==="CONNECTED_READ_UNCERTAIN"?uncertain():new PlatformError(claim.error,502,"The connected read failed");
  const deadlineAt=Math.min(claim.operationDeadline,new Date(claim.execution.task.deadline_at).getTime());
  const checkDeadline=()=>{if(Date.now()>=deadlineAt)throw new PlatformError("CONNECTED_READ_DEADLINE",409,"The connected read exceeded its original operation deadline");};
  let ordinal=0,pending=0,readCount=0,setupCount=0;
  const before=async(phase:"setup"|"read"="read")=>{
   checkDeadline();
   await transaction(this.pool,async db=>{
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);const current=await this.scope(db,taskId,binding);
    if(current.credential.connection.revision!==claim.credential.connection.revision)throw new PlatformError("CONNECTION_CREDENTIAL_CHANGED",403,"Connection credentials changed during this read");
    if(++ordinal>7||phase==="read"&&++readCount>3||phase==="setup"&&++setupCount>4)throw new PlatformError("CONNECTED_ATTEMPT_LIMIT",409,"The connected read reached its request limit");
    await db.query("INSERT INTO agents_platform.connected_attempts(operation_id,ordinal,phase,state) VALUES($1,$2,$3,'started')",[operationId,ordinal,phase]);pending=ordinal;
   });
  };
  const after=async(receipt:NetworkAttempt)=>{await this.pool.query("UPDATE agents_platform.connected_attempts SET state='completed',receipt=$3 WHERE operation_id=$1 AND ordinal=$2 AND state='started'",[operationId,pending,JSON.stringify({...receipt,attempt:pending})]);};
  let responseOrdinal=0;
  const capture=async(response:{body:unknown;digest:string;observedAt:string})=>{
    checkDeadline();
    const bytes=Buffer.from(JSON.stringify(response.body));if(bytes.length>MAX_BODY_BYTES)throw new PlatformError("CONNECTED_BODY_LIMIT",413,"Provider response exceeds private storage limit");
    if(bytes.includes(Buffer.from(claim.credential.authorization)))throw new PlatformError("CONNECTED_CREDENTIAL_REFLECTION",502,"Provider response reflected private authorization");
    const contentDigest=textDigest(bytes),key=`connected/${claim.execution.task.organization_id}/${claim.execution.task.root_task_id}/${textDigest(operationId)}/response-${++responseOrdinal}-${contentDigest}`;
    await writeExecutionObject(this.pool,this.objects,{taskId,operationId,key,bytes,contentType:"application/json"});
    checkDeadline();
    await transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[claim.execution.task.organization_id]);
      await this.scope(db,taskId,binding);
      if(!(await db.query("SELECT 1 FROM agents_platform.operations WHERE id=$1 AND task_id=$2 AND state='started'",[operationId,taskId])).rowCount)throw uncertain();
      const object=(await db.query("SELECT state,content_digest FROM agents_platform.execution_objects WHERE object_key=$1 FOR SHARE",[key])).rows[0];
      if(object?.state!=="available"||object.content_digest!==contentDigest)throw new PlatformError("EXECUTION_OBJECT_UNCERTAIN",409,"The private response body is unavailable");
      checkDeadline();
      await db.query("INSERT INTO agents_platform.connected_response_bodies(operation_id,ordinal,object_key,content_digest,provider_digest,observed_at) VALUES($1,$2,$3,$4,$5,$6)",[operationId,responseOrdinal,key,contentDigest,response.digest,response.observedAt]);
    });
  };
  const native=()=>new GithubReadAdapter({authorization:claim.credential.authorization,selections:claim.credential.connection.selections,deadlineAt,signal,testLoopbackOrigin:this.options.testGithubOrigin,beforeAttempt:()=>before(),onAttempt:after,onResponse:capture,maxPhysicalRequests:binding.transport==="mcp_http"?1:3});
  try{
   let projection:Projection,full:unknown;
   if(binding.transport==="native_http"){
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
    full=observation.rawResult;const allText=Array.isArray(observation.rawResult.content)?observation.rawResult.content.filter((item:any)=>item?.type==="text"&&typeof item.text==="string").map((item:any)=>item.text).join("\n"):observation.text;const visible=prefix(allText.slice(args.offset??0));projection={...visible,resource:githubRepositoryHandle(claim.selected),acquiredAt:new Date().toISOString(),digest:observation.resultDigest,provenance:{kind:"timestamped_observation",...(claim.handle?.kind==="revision"?{requestedCommit:claim.handle.payload.commitSha}:{})},isError:observation.isError};
   }
   checkDeadline();
   const body=Buffer.from(JSON.stringify(full));if(body.length>MAX_BODY_BYTES)throw new PlatformError("CONNECTED_BODY_LIMIT",413,"Connected receipt exceeds the private storage limit");
   if(body.includes(Buffer.from(claim.credential.authorization)))throw new PlatformError("CONNECTED_CREDENTIAL_REFLECTION",502,"The connected response reflected private authorization");
   const bodyDigest=textDigest(body),bodyKey=`connected/${claim.execution.task.organization_id}/${claim.execution.task.root_task_id}/${textDigest(operationId)}/${bodyDigest}`;
   await writeExecutionObject(this.pool,this.objects,{taskId,operationId,key:bodyKey,bytes:body,contentType:"application/json"});
   checkDeadline();
   const passage=await this.evidence.recordConnected(taskId,operationId,{bindingId:binding.id,resource:projection.resource,text:projection.text||"The provider returned an empty read result.",title:`GitHub ${binding.definition.providerOperation}`,acquiredAt:projection.acquiredAt,receiptDigest:bodyDigest});
   const result:ConnectedObservation={status:projection.isError?"tool_error":"ok",bindingId:binding.id,operationId,content:passage.text,truncated:projection.truncated,evidence:{id:passage.reference.id,label:passage.label,citation:`[${passage.label}]`,contentDigest:passage.reference.contentDigest},...(projection.handles?{handles:projection.handles}:{}),observation:{digest:projection.digest,acquiredAt:projection.acquiredAt,provenance:projection.provenance}};
   if(Buffer.byteLength(JSON.stringify(result))>8192)throw new PlatformError("CONNECTED_RESULT_LIMIT",413,"Connected observation exceeds its model result limit");
   checkDeadline();
   const published=await this.pool.query("UPDATE agents_platform.connected_reads SET state='completed',result=$2,body_key=$3,body_digest=$4,updated_at=now() WHERE operation_id=$1 AND state='started' AND EXISTS(SELECT 1 FROM agents_platform.operations p WHERE p.id=$1 AND p.state='started')",[operationId,JSON.stringify(result),bodyKey,bodyDigest]);
   if(!published.rowCount) throw new PlatformError("CONNECTED_READ_UNCERTAIN",409,"Connected read receipt is no longer publishable");
   return result;
  }catch(error){const active=Number((await this.pool.query("SELECT count(*) AS count FROM agents_platform.connected_attempts WHERE operation_id=$1 AND (state='started' OR (receipt->>'status' IS NULL AND receipt->>'outcome' IN ('CANCELLED','DEADLINE','NETWORK_UNAVAILABLE')))",[operationId])).rows[0].count);await this.pool.query("UPDATE agents_platform.connected_reads SET state=$2,error_code=$3,updated_at=now() WHERE operation_id=$1 AND state='started'",[operationId,active||error instanceof PlatformError&&error.code==="CONNECTED_READ_DEADLINE"?"uncertain":"failed",code(error)]);throw active||error instanceof PlatformError&&error.code==="CONNECTED_READ_DEADLINE"?uncertain():new PlatformError(code(error),502,"Connected read did not complete");}
 }
 private async projectNative(taskId:string,operationId:string,binding:CapabilityBinding,args:ConnectedModelArguments,selection:GithubRepositorySelection,observation:GithubObservation<unknown>,checkDeadline:()=>void):Promise<Projection>{
  const resource=githubRepositoryHandle(selection),value=observation.value as any;let visible:unknown=value,handles:unknown;
  switch(binding.definition.providerOperation){
   case"resolve_ref":{const revisionId=await this.issue(taskId,operationId,binding,resource,"revision",value);visible={revisionId,repository:resource.id,commitSha:value.commitSha,resolvedAt:value.resolvedAt};handles={revisionId};break;}
   case"list_tree":{const entries=[];for(const file of (value.files as GithubFileHandle[]).slice(args.offset??0,(args.offset??0)+20)){checkDeadline();if(Buffer.byteLength(JSON.stringify([...entries,{fileId:"0".repeat(36),path:file.path,bytes:file.size}]))>2400)break;const fileId=await this.issue(taskId,operationId,binding,resource,"file",{revision:value.revision,file});entries.push({fileId,path:file.path,bytes:file.size});}visible={files:entries,omittedUnsupported:value.omittedUnsupported,hasMore:value.files.length>(args.offset??0)+entries.length,nextOffset:(args.offset??0)+entries.length};handles={files:entries.map(({fileId})=>({fileId}))};break;}
   case"read_file":visible=value.content.slice(args.offset??0);break;
   case"list_releases":{const entries=[];for(const release of value.releases){checkDeadline();const releaseId=await this.issue(taskId,operationId,binding,resource,"release",{repository:selection,release});entries.push({releaseId,tag:release.tag,name:release.name,publishedAt:release.publishedAt,body:prefix(release.body??"",512).text});}visible={releases:entries,hasMore:value.hasMore,pageSize:value.pageSize};handles={releases:entries.map(({releaseId})=>({releaseId}))};break;}
  }
  const projected=prefix(typeof visible==="string"?visible:JSON.stringify(visible));return{...projected,handles,resource,acquiredAt:observation.observedAt,digest:observation.digest,provenance:observation.provenance};
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
