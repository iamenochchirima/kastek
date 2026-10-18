import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConnectedExecutor } from "../src/capabilities/connected-tools/connected-executor";
import { ConnectionStore } from "../src/product/connections/connections";
import { ConnectionVault } from "../src/infrastructure/vault";
import { EvidenceStore } from "../src/execution/context/evidence";
import {S3PrivateStore} from "../src/infrastructure/object-store";
import { PlatformStore } from "../src/product/agents/store";
import { defaultFaqConfiguration, type ExecutionGrant } from "../src/contracts/contracts";
import { beginOperation, finishOperation, settleTask } from "../src/execution/lifecycle/execution";
import { setupPlatformSchema } from "../src/composition/setup";
import { readPublicRepositoryAcceptanceConfig } from "./support/public-repository-acceptance-config";
import { privateFixtureBucketRequest } from "./support/private-s3-fixture";
import type { CapabilityBinding, CapabilityCatalog } from "../src/contracts/capability-catalog";

/** Opt-in real public-provider service acceptance. No model or external credentials.
 * AGENTS_PUBLIC_REPOSITORY_LIVE=1 and AGENTS_TEST_DATABASE_URL select an owned
 * disposable PG fixture. Local MinIO19000 uses connected-fixture credentials.
 * Repository defaults/overrides come from public-repository-acceptance-config.
 * This uses the source registry and does not claim browser or scheduled execution.
 */
(process.env.AGENTS_PUBLIC_REPOSITORY_LIVE==="1"?describe:describe.skip)("actual credential-free native and DeepWiki scoped read acceptance",()=>{
 const database=`agents_public_live_${randomUUID().replaceAll("-","")}`,bucket=`agents-ingestion-${randomUUID().replaceAll("-","")}`;
 const s3={endpoint:"http://127.0.0.1:19000",region:"us-east-1",bucket,accessKeyId:"connected-fixture-user",secretAccessKey:"connected-fixture-secret"},objects=new S3PrivateStore({...s3,maxBytes:2097152});
 let admin:Pool,pool:Pool,platform:PlatformStore,connections:ConnectionStore,executor:ConnectedExecutor,createdBucket=false,taskId:string|undefined;
 let expiresAt:string,mcpExpected:string,selection:{owner:string;repository:string;ref:string},selectedFile:string,expected:string;
 const observations:unknown[]=[],catalogs:unknown[]=[];let result="not_run",errorCode:string|undefined;
 beforeAll(async()=>{
  ({expiresAt,selection,selectedFile,expected,mcpExpected}=readPublicRepositoryAcceptanceConfig());
  if(!process.env.AGENTS_TEST_DATABASE_URL)throw Error("Set AGENTS_TEST_DATABASE_URL for an owned disposable PostgreSQL fixture");
  admin=new Pool({connectionString:process.env.AGENTS_TEST_DATABASE_URL});await admin.query(`CREATE DATABASE "${database}"`);const url=new URL(process.env.AGENTS_TEST_DATABASE_URL);url.pathname=`/${database}`;
  pool=new Pool({connectionString:url.href});await setupPlatformSchema(pool);expect((await privateFixtureBucketRequest(s3,"PUT")).ok).toBe(true);createdBucket=true;
  platform=new PlatformStore(pool);connections=new ConnectionStore(pool,new ConnectionVault("v1",{v1:randomBytes(32).toString("base64")}),[]);
  // No test endpoint override: production origins are fixed by ConnectedExecutor.
  executor=new ConnectedExecutor(pool,connections,objects,new EvidenceStore(pool,objects));
 },60000);
 afterAll(async()=>{
  if(taskId&&pool)await settleTask(pool,taskId,{state:result==="passed"?"completed":"incomplete"}).catch(()=>undefined);
  if(createdBucket){const xml=await(await privateFixtureBucketRequest(s3,"GET","list-type=2")).text();for(const match of xml.matchAll(/<Key>([^<]+)<\/Key>/g))await objects.delete(match[1]!);expect((await privateFixtureBucketRequest(s3,"DELETE")).ok).toBe(true);}
  await pool?.end();if(admin){await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`);await admin.end();}
  const directory=resolve(process.cwd(),"../../../.audit");await mkdir(directory,{recursive:true});const proof=JSON.stringify({result,errorCode:errorCode??(result==="not_run"?"PUBLIC_LIVE_PREREQUISITES_UNSATISFIED":undefined),repository:selection?`${selection.owner}/${selection.repository}`:undefined,ref:selection?.ref,file:selectedFile,catalogs,observations,modelCalls:0,authentication:"none",providerEndpoints:["https://api.github.com","https://mcp.deepwiki.com/mcp"],privateStorageEndpoint:s3.endpoint,executionMode:"source TypeScript, exact source adapter registry",scope:"connected SDK/executor acceptance; full real-model scheduling not claimed"},null,2);await writeFile(resolve(directory,"agents-public-repository-live.json"),proof);
 },60000);
 it("reads a pinned public file and DeepWiki topics through scoped immutable bindings, then replays every receipt without adapter resolution",async()=>{
  try{
   const owner=await platform.ensureAccount({issuer:"http://localhost/public-live",subject:randomUUID(),email:"acceptance@example.test",displayName:"Approved acceptance owner"}),org=await platform.createOrganization(owner.id,"Actual public repository acceptance"),scope={accountId:owner.id,organizationId:org.id};
   const connection=await connections.create(scope,{operationId:randomUUID(),profileId:"public-repository-read-v1",targetId:"provider:public-repository",name:"Approved public repository acceptance",expiresAt,selections:[selection]});
   expect(connection.authentication).toBe("none");
   expect((await pool.query("SELECT envelope IS NULL AS credential_free FROM agents_platform.connection_credentials WHERE connection_id=$1",[connection.id])).rows).toEqual([{credential_free:true}]);
   const bindings:CapabilityBinding[]=[];
   for(const transport of ["native_http","mcp_http"] as const){
    const candidate=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:connection.revision,transport});
    catalogs.push({transport,protocolVersion:candidate.catalog.protocolVersion,catalogDigest:candidate.catalog.digest,adapter:candidate.catalog.adapter,tools:candidate.catalog.tools.map((tool:CapabilityCatalog["tools"][number])=>({operation:tool.providerOperation,inputSchemaDigest:tool.inputDigest,outputSchemaDigest:tool.outputDigest}))});
    const operations=transport==="native_http"?["get_repository","resolve_ref","list_tree","read_file"]:["read_wiki_structure"];
    if(operations.some(operation=>!candidate.selectableOperations.includes(operation)))throw Error("PUBLIC_REQUIRED_TOOL_UNAVAILABLE");
    bindings.push(...await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:connection.revision,catalogId:candidate.id,selections:operations.map(providerOperation=>({providerOperation,resources:connection.resources}))}));
   }
   expect(bindings).toHaveLength(5);expect(bindings.filter(binding=>binding.transport==="mcp_http").map(binding=>binding.protocolVersion)).toEqual(["2025-11-25"]);
   executor.assertAvailable(bindings);const configuration={...defaultFaqConfiguration(),connectedToolBindingIds:bindings.map(binding=>binding.id)},agent=await platform.createAgent({...scope,name:"Actual connected reader",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
   const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:owner.issuer,subject:owner.subject}};
   const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","connected.read"],sourceRevisionIds:[],connectedToolBindingIds:configuration.connectedToolBindingIds,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Math.min(Date.now()+600000,Date.parse(expiresAt))).toISOString(),revokedAt:null};await platform.createGrant({...scope,grant});
   const admitted=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read the owner's approved public repository"});taskId=admitted.task.id;
   async function call(operation:string,args:object){
    const binding=bindings.find(binding=>binding.definition.providerOperation===operation)!,operationId=`public-live:${taskId}:${randomUUID()}`;await beginOperation(pool,taskId!,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:binding.limits.timeoutMs,retrySafe:true});
    const observation=await executor.execute(taskId!,operationId,binding,args);expect(observation.status).toBe("ok");const serialized=JSON.stringify(observation);expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);expect(observation.evidence.citation).toMatch(/^\[E[a-f0-9]{32}\]$/);await finishOperation(pool,taskId!,operationId,"completed",observation,null,0);
    const attempts=(await pool.query("SELECT phase,state,receipt->>'status' AS status FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[operationId])).rows;
    observations.push({operation,excerpt:observation.content.slice(0,200),replayedWithoutAdapterResolution:true,transport:binding.transport,digest:observation.observation.digest,acquiredAt:observation.observation.acquiredAt,provenance:observation.observation.provenance,resultBytes:Buffer.byteLength(serialized),truncated:observation.truncated,evidenceDigest:observation.evidence.contentDigest,attempts,evidenceId:observation.evidence.id,citation:observation.evidence.citation,operationId});
    expect(attempts.length).toBeGreaterThan(0);expect(attempts.length).toBeLessThanOrEqual(7);expect(attempts.every(attempt=>attempt.state==="completed")).toBe(true);expect(attempts.filter(attempt=>attempt.phase==="read").length).toBeLessThanOrEqual(3);expect(attempts.filter(attempt=>attempt.phase==="setup").length).toBeLessThanOrEqual(4);
    const fresh=new ConnectedExecutor(pool,connections,objects,new EvidenceStore(pool,objects));
    const unavailable=vi.spyOn(fresh.registry,"resolve").mockImplementation(()=>{throw Error("Old executable release unavailable");});
    const receiptBefore=(await pool.query("SELECT ordinal,phase,state,receipt FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[operationId])).rows;
    expect(await fresh.execute(taskId!,operationId,binding,args)).toEqual(observation);expect(unavailable).not.toHaveBeenCalled();
    expect((await pool.query("SELECT ordinal,phase,state,receipt FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[operationId])).rows).toEqual(receiptBefore);
    return {...observation,operationId};
   }
   const repository=`${selection.owner}/${selection.repository}`.toLowerCase(),metadata=JSON.parse((await call("get_repository",{repository})).content);expect(metadata.fullName.toLowerCase()).toBe(repository);
   const revision=await call("resolve_ref",{repository}),revisionId=(revision.handles as any).revisionId,commitSha=JSON.parse(revision.content).commitSha;expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
   let fileId:string|undefined;for(let page=0,offset=0;page<8&&!fileId;page++){
    const listing=JSON.parse((await call("list_tree",{revisionId,offset})).content);fileId=listing.files.find((file:any)=>file.path===selectedFile)?.fileId;if(!listing.hasMore)break;offset=listing.nextOffset;
   }
   if(!fileId)throw Error("PUBLIC_APPROVED_FILE_NOT_IN_BOUNDED_TREE_WINDOW");
   const nativeRead=await call("read_file",{fileId});expect(nativeRead.content).toContain(expected);
   const mcpRead=await call("read_wiki_structure",{repository});expect(mcpRead.content).toContain(mcpExpected);
   expect(nativeRead.evidence.id).not.toBe(mcpRead.evidence.id);
   const references=(await pool.query("SELECT id,citation_label,operation_id,manifest FROM agents_platform.evidence_references WHERE id=ANY($1::uuid[])",[[nativeRead.evidence.id,mcpRead.evidence.id]])).rows;
   expect(references).toHaveLength(2);expect(references.every(reference=>reference.manifest.dependencies.some((dependency:{kind:string})=>dependency.kind==="connection"))).toBe(true);
   const successes=(await pool.query("SELECT state,result->>'status' AS result_status FROM agents_platform.connected_reads WHERE task_id=$1",[taskId])).rows;
   expect(successes.length).toBeGreaterThanOrEqual(6);expect(successes.every(read=>read.state==="completed"&&read.result_status==="ok")).toBe(true);
   const captured=(await pool.query("SELECT content_digest,provider_digest FROM agents_platform.connected_response_bodies WHERE operation_id=$1",[nativeRead.operationId])).rows;
   expect(captured.length).toBeGreaterThan(0);expect(captured.every(body=>/^[a-f0-9]{64}$/.test(body.content_digest)&&/^[a-f0-9]{64}$/.test(body.provider_digest))).toBe(true);
   result="passed";
  }catch(error){result="failed";errorCode=typeof(error as{code?:unknown})?.code==="string"?(error as{code:string}).code:error instanceof Error&&/^PUBLIC_[A-Z_]+$/.test(error.message)?error.message:"PUBLIC_LIVE_ACCEPTANCE_FAILED";throw error;}
 },180000);
});
