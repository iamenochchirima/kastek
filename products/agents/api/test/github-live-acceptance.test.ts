import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConnectedExecutor } from "../src/platform/connected-executor";
import { ConnectionStore } from "../src/platform/connections";
import { ConnectionVault } from "../src/platform/vault";
import { EvidenceStore } from "../src/platform/evidence";
import { S3PrivateStore } from "../src/platform/artifacts";
import { PlatformStore } from "../src/platform/store";
import { defaultFaqConfiguration, type ExecutionGrant } from "../src/platform/contracts";
import { beginOperation, finishOperation, settleTask } from "../src/platform/execution";
import { setupPlatformSchema } from "../src/platform/setup";
import { readGithubAcceptanceConfig } from "./support/github-acceptance-config";
import { privateFixtureBucketRequest } from "./support/private-s3-fixture";
import type { CapabilityBinding, CapabilityCatalog } from "../src/platform/capability-catalog";

/** Opt-in production-provider acceptance, never a fixture or credential search.
 * Require AGENTS_GITHUB_LIVE=1, AGENTS_GITHUB_ACCEPTANCE_TOKEN (owner-approved
 * fine-grained PAT, metadata/contents read-only on the selected public repository),
 * AGENTS_GITHUB_ACCEPTANCE_EXPIRES_AT (the token's actual finite ISO expiry), and
 * AGENTS_TEST_DATABASE_URL pointing at an owned disposable-DB-capable pgvector PG.
 * Local MinIO19000 must use the documented connected-fixture credentials.
 * Defaults: github/github-mcp-server, ref main, README.md, expected text GitHub.
 * Optional owner-approved overrides: AGENTS_GITHUB_ACCEPTANCE_REPOSITORY owner/repo,
 * _REF, _FILE, _EXPECT. No model-chosen URL/path/auth is accepted by the executor.
 * TS API+executor share source artifacts here; compiled API+worker acceptance must
 * use the same compiled build. This suite does not claim full model/schedule proof.
 */
(process.env.AGENTS_GITHUB_LIVE==="1"?describe:describe.skip)("actual GitHub native and hosted MCP read acceptance",()=>{
 const database=`agents_github_live_${randomUUID().replaceAll("-","")}`,bucket=`agents-ingestion-${randomUUID().replaceAll("-","")}`;
 const s3={endpoint:"http://127.0.0.1:19000",region:"us-east-1",bucket,accessKeyId:"connected-fixture-user",secretAccessKey:"connected-fixture-secret"},objects=new S3PrivateStore({...s3,maxBytes:2097152});
 let admin:Pool,pool:Pool,platform:PlatformStore,connections:ConnectionStore,executor:ConnectedExecutor,createdBucket=false,taskId:string|undefined;
 let token:string,expiresAt:string,selection:{owner:string;repository:string;ref:string},selectedFile:string,expected:string;
 const observations:unknown[]=[],catalogs:unknown[]=[];let result="not_run",errorCode:string|undefined;
 beforeAll(async()=>{
  ({token,expiresAt,selection,selectedFile,expected}=readGithubAcceptanceConfig());
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
  const directory=resolve(process.cwd(),"../../../.audit");await mkdir(directory,{recursive:true});const proof=JSON.stringify({result,errorCode:errorCode??(result==="not_run"?"GITHUB_LIVE_PREREQUISITES_UNSATISFIED":undefined),repository:selection?`${selection.owner}/${selection.repository}`:undefined,ref:selection?.ref,file:selectedFile,catalogs,observations,modelCalls:0,providerEndpoints:["https://api.github.com","https://api.githubcopilot.com/mcp/"],privateStorageEndpoint:s3.endpoint,executionMode:"source TypeScript, exact source adapter registry",scope:"connected SDK/executor acceptance; full real-model scheduling not claimed"},null,2);if(token&&proof.includes(token))throw Error("Credential reflection withheld from acceptance proof");await writeFile(resolve(directory,"agents-github-live.json"),proof);
 },60000);
 it("publishes discovered immutable bindings and reads one pinned public file through native HTTP and the official MCP SDK",async()=>{
  try{
   const owner=await platform.ensureAccount({issuer:"http://localhost/github-live",subject:randomUUID(),email:"acceptance@example.test",displayName:"Approved acceptance owner"}),org=await platform.createOrganization(owner.id,"Actual GitHub acceptance"),scope={accountId:owner.id,organizationId:org.id};
   const connection=await connections.create(scope,{operationId:randomUUID(),profileId:"github-public-read-v1",targetId:"provider:github",name:"Approved GitHub acceptance",apiKey:token,expiresAt,selections:[selection]});
   const bindings:CapabilityBinding[]=[];
   for(const transport of ["native_http","mcp_http"] as const){
    const candidate=await executor.discover(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:connection.revision,transport});
    catalogs.push({transport,protocolVersion:candidate.catalog.protocolVersion,catalogDigest:candidate.catalog.digest,adapter:candidate.catalog.adapter,tools:candidate.catalog.tools.map((tool:CapabilityCatalog["tools"][number])=>({operation:tool.providerOperation,inputSchemaDigest:tool.inputDigest,outputSchemaDigest:tool.outputDigest}))});
    const operations=transport==="native_http"?["get_repository","resolve_ref","list_tree","read_file"]:["get_file_contents"];
    if(operations.some(operation=>!candidate.selectableOperations.includes(operation)))throw Error("GITHUB_REQUIRED_TOOL_UNAVAILABLE");
    bindings.push(...await executor.catalogs.selectBindings(scope,{operationId:randomUUID(),connectionId:connection.id,expectedRevision:connection.revision,catalogId:candidate.id,selections:operations.map(providerOperation=>({providerOperation,resources:connection.resources}))}));
   }
   executor.assertAvailable(bindings);const configuration={...defaultFaqConfiguration(),connectedToolBindingIds:bindings.map(binding=>binding.id)},agent=await platform.createAgent({...scope,name:"Actual connected reader",configuration}),version=await platform.createVersion({...scope,agentId:agent.id,expectedRevision:1});
   const authority={product:"agents" as const,organizationId:org.id,resourceId:agent.id,callerClientId:"agents-execution",principal:{kind:"human" as const,issuer:owner.issuer,subject:owner.subject}};
   const grant:ExecutionGrant={...authority,id:randomUUID(),versionId:version.id,operations:["model.reply","connected.read"],sourceRevisionIds:[],connectedToolBindingIds:configuration.connectedToolBindingIds,maxInputBytes:configuration.model.maxInputBytes,maxOutputTokens:configuration.model.maxOutputTokens,maxContextTokens:configuration.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Math.min(Date.now()+600000,Date.parse(expiresAt))).toISOString(),revokedAt:null};await platform.createGrant({...scope,grant});
   const admitted=await platform.admitTask({authority,versionId:version.id,grantId:grant.id,requestKey:randomUUID(),input:"Read the owner's approved public repository"});taskId=admitted.task.id;
   async function call(operation:string,args:object){
    const binding=bindings.find(binding=>binding.definition.providerOperation===operation)!,operationId=`github-live:${taskId}:${randomUUID()}`;await beginOperation(pool,taskId!,{id:operationId,kind:"tool",name:binding.alias,request:args,reservedTokens:0,reservedMs:binding.limits.timeoutMs,retrySafe:true});
    const observation=await executor.execute(taskId!,operationId,binding,args);expect(observation.status).toBe("ok");const serialized=JSON.stringify(observation);expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(8192);expect(serialized.includes(token)).toBe(false);await finishOperation(pool,taskId!,operationId,"completed",observation,null,0);
    const attempts=(await pool.query("SELECT phase,state,receipt->>'status' AS status FROM agents_platform.connected_attempts WHERE operation_id=$1 ORDER BY ordinal",[operationId])).rows;
    observations.push({operation,transport:binding.transport,digest:observation.observation.digest,acquiredAt:observation.observation.acquiredAt,provenance:observation.observation.provenance,resultBytes:Buffer.byteLength(serialized),truncated:observation.truncated,evidenceDigest:observation.evidence.contentDigest,attempts});return observation;
   }
   const repository=`${selection.owner}/${selection.repository}`.toLowerCase(),metadata=JSON.parse((await call("get_repository",{repository})).content);expect(metadata.fullName.toLowerCase()).toBe(repository);
   const revision=await call("resolve_ref",{repository}),revisionId=(revision.handles as any).revisionId,commitSha=JSON.parse(revision.content).commitSha;expect(commitSha).toMatch(/^[a-f0-9]{40}$/);
   let fileId:string|undefined;for(let page=0,offset=0;page<8&&!fileId;page++){
    const listing=JSON.parse((await call("list_tree",{revisionId,offset})).content);fileId=listing.files.find((file:any)=>file.path===selectedFile)?.fileId;if(!listing.hasMore)break;offset=listing.nextOffset;
   }
   if(!fileId)throw Error("GITHUB_APPROVED_FILE_NOT_IN_BOUNDED_TREE_WINDOW");
   for(const operation of ["read_file","get_file_contents"]){const read=await call(operation,{fileId});expect(read.content.toLowerCase()).toContain(expected.toLowerCase());}
   result="passed";
  }catch(error){result="failed";errorCode=typeof(error as{code?:unknown})?.code==="string"?(error as{code:string}).code:error instanceof Error&&/^GITHUB_[A-Z_]+$/.test(error.message)?error.message:"GITHUB_LIVE_ACCEPTANCE_FAILED";throw error;}
 },180000);
});
