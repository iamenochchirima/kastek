import { observeConnectionControl,captureConnectionAuthority } from "../../observability/connection-telemetry";
import { nativeResponsePolicySchema, nativePhysicalRequestLimit } from "../../adapters/providers/native-response-policy";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { importOpenApiDocument, compileOpenApiRequest, injectOpenApiCredentials, type OpenApiImport, type OpenApiOperation,
  type RequestTemplate, type RequestArguments, type ResolvedOpenApiCredential } from "../../adapters/providers/openapi";
import { createBinding, type CapabilityBinding, type CapabilityCatalog, type ExecutableAdapterRegistry } from "../../contracts/capability-catalog";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { createBoundedFetch, ConnectedNetworkError } from "../../infrastructure/connected-network";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";

const operationKey=z.string().min(1).max(128),generation=z.number().int().positive();
const secretText=z.string().min(1).max(4096).refine(value=>Buffer.byteLength(value)<=4096&&!/[\x00-\x1f\x7f]/.test(value));
const credentialSchema=z.discriminatedUnion("type",[
  z.strictObject({type:z.literal("bearer"),token:secretText}),
  z.strictObject({type:z.literal("api_key"),value:secretText}),
  z.strictObject({type:z.literal("basic"),username:z.string().min(1).max(512).refine(value=>!/[\x00-\x1f\x7f:]/.test(value)),password:secretText}),
]);
const credentialsSchema=z.record(z.string().min(1).max(128),credentialSchema).refine(value=>Object.keys(value).length<=16&&Buffer.byteLength(JSON.stringify(value))<=60000);
type Credentials=z.infer<typeof credentialsSchema>;
const authored=z.strictObject({title:z.string().min(1).max(256),method:z.enum(["GET","POST","PUT","PATCH","DELETE","HEAD","OPTIONS"]),
  path:z.string().min(1).max(2048),parameters:z.array(z.unknown()).max(50).default([]),
  requestBody:z.strictObject({required:z.boolean().default(false),contentType:z.literal("application/json"),schema:z.unknown()}).nullable().optional(),
  responsePolicy:nativeResponsePolicySchema.optional(),securityScheme:z.unknown().optional(),securityScopes:z.array(z.string().min(1).max(256)).max(32).optional()});
const sourceSchema=z.strictObject({serverUrl:z.string().min(1).max(2048),document:z.unknown().optional(),requestTemplate:authored.optional(),
  securitySelections:z.record(z.string().regex(/^api_[a-f0-9]{32}$/),z.number().int().min(0).max(7)).optional()});
const oneSource=(value:{document?:unknown;requestTemplate?:unknown})=>Number(value.document!==undefined)+Number(value.requestTemplate!==undefined)===1;
export const apiPreviewInput=sourceSchema.refine(oneSource,"Provide an OpenAPI document or a request template");
export const apiConnectionInput=sourceSchema.extend({operationId:operationKey,name:z.string().trim().min(1).max(120),
  expectedImportDigest:z.string().regex(/^[a-f0-9]{64}$/),credentials:credentialsSchema.default({})}).refine(oneSource,"Provide an OpenAPI document or a request template");
export const apiSelectionInput=z.strictObject({operationId:operationKey,expectedGeneration:generation,
  selections:z.array(z.strictObject({operationId:z.uuid(),effectPolicy:z.enum(["exact_review","owner_reviewed_read"]).default("exact_review")})).min(1).max(8)
    .refine(value=>new Set(value.map(item=>item.operationId)).size===value.length)});
export interface ApiOperationRuntime {
  authorizationGeneration?:number;operationId:string;template:RequestTemplate;serverOrigin:string;importDigest:string;policyRevision:number;
  credentialReferences:Record<string,string>;credentials:Record<string,ResolvedOpenApiCredential>;effectPolicy:"exact_review"|"owner_reviewed_read";
}
export interface ApiConnectionDTO {
  id:string;name:string;serverUrl:string;origin:string;title:string;importDigest:string;sourceKind:"openapi"|"request_template";
  status:string;revision:number;policyRevision:number;generation:number;selectedOperationIds:string[];bindingIds:string[];
  credentialSchemes:{schemeId:string;type:string;configured:boolean}[];lastError:string|null;createdAt:string;expiresAt:string;
}
export interface ApiConnectionStoreOptions {
  registry?:ExecutableAdapterRegistry<unknown>;
  createCatalog?:(imported:OpenApiImport,context:{id:string;organizationId:string;connectionId:string;revision:number})=>CapabilityCatalog;
  testLoopback?:boolean;
}
type Row=Record<string,any>;
const changed=()=>new PlatformError("CONNECTION_CHANGED",409,"Connection changed; refresh and try again");
const unavailable=()=>new PlatformError("CONNECTION_NOT_FOUND",404,"API connection not found");
const oauthDiagnostic={code:"API_OAUTH_CLIENT_REQUIRED",message:"OAuth requires a configured provider and client before this operation can be enabled"};
function securitySummary(security:OpenApiOperation["security"]) {
  return security?{schemeId:security.schemeId,type:security.type,...(security.in?{in:security.in}:{}),...(security.name?{name:security.name}:{}),scopes:security.scopes}:null;
}
function operationSummary(operation:OpenApiOperation,configured:Row[]=[],executable=true) {
  const oauth=operation.security?.type==="oauth2",security=securitySummary(operation.security),invalidReference=security&&security.type!=="none"&&!/^[A-Za-z0-9:._/-]{1,128}$/.test(security.schemeId);
  return {id:operation.alias,alias:operation.alias,operationId:operation.operationId,method:operation.method,path:operation.path,summary:operation.summary,
    compatible:operation.compatible&&!oauth&&!invalidReference&&executable,diagnostics:[...operation.diagnostics,...(oauth?[oauthDiagnostic]:[]),
      ...(invalidReference?[{code:"API_CREDENTIAL_REFERENCE_UNSUPPORTED",message:"Authentication scheme identifier cannot be mapped to a private credential reference"}]:[]),
      ...(operation.compatible&&!oauth&&!executable?[{code:"API_SCHEMA_UNSUPPORTED",message:"Operation schema is not supported by the installed native API adapter"}]:[])],security,
    securityChoices:operation.securityChoices.map(choice=>({index:choice.index,security:securitySummary(choice.security),diagnostics:choice.diagnostics})),
    credentialState:oauth||invalidReference?"unsupported":!security||security.type==="none"?"none":configured.some(item=>item.schemeId===security.schemeId&&item.type===security.type)?"configured":"required",
    effect:"unknown" as const,reviewRequired:true as const,responsePolicy:operation.template?.responsePolicy,parameters:operation.parameters,requestBody:operation.requestBody,responseSchemas:operation.responseSchemas};
}
function importedSource(input:z.infer<typeof sourceSchema>,testLoopback=false) {
  const authored=input.requestTemplate;
  const document=authored?{openapi:"3.1.0",info:{title:authored.title,version:"1"},servers:[{url:input.serverUrl}],
    ...(authored.securityScheme?{components:{securitySchemes:{credential:authored.securityScheme}},security:[{credential:authored.securityScopes??[]}]}:{}),
    paths:{[authored.path]:{[authored.method.toLowerCase()]:{operationId:"authoredRequest",parameters:authored.parameters,...(authored.responsePolicy?{"x-kasitek-response":authored.responsePolicy}:{}),
      ...(authored.requestBody?{requestBody:{required:authored.requestBody.required,content:{"application/json":{schema:authored.requestBody.schema}}}}:{}),responses:{"200":{description:"Provider response"}}}}}}:input.document;
  const imported=importOpenApiDocument(document,{serverUrl:input.serverUrl,testLoopback,securitySelections:input.securitySelections});
  return {imported,sourceKind:authored?"request_template" as const:"openapi" as const,importDigest:requestDigest(imported)};
}
function configured(credentials:Credentials) {return Object.entries(credentials).map(([schemeId,value])=>({schemeId,type:value.type}));}
function validateCredentials(imported:OpenApiImport,credentials:Credentials) {
  for(const [schemeId,value] of Object.entries(credentials)) if(!imported.operations.some(operation=>operation.compatible&&operation.security?.schemeId===schemeId&&operation.security.type===value.type))
    throw new PlatformError("API_CREDENTIAL_SCHEME_INVALID",400,"Credential does not match a supported imported authentication scheme");
}
async function owner(db:Pool|PoolClient,scope:ActionScope) {
  await requireActionMember(db,scope);
  if(!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount)
    throw new PlatformError("ACCESS_DENIED",403,"An owner must configure API connections");
}
const rowQuery=`SELECT c.*,s.import_id,s.catalog_id,s.status,s.generation,s.credential_schemes,s.selected_operation_ids,s.binding_ids,s.last_error,
  i.catalog AS imported,i.import_digest,i.source_kind FROM agents_platform.connections c
  JOIN agents_platform.api_connection_settings s ON s.connection_id=c.id JOIN agents_platform.api_import_catalogs i ON i.id=s.import_id
  WHERE c.organization_id=$1 AND c.account_id=$2 AND c.profile_id='custom-api-v1'`;

export class ApiConnectionStore {
  constructor(readonly pool:Pool,readonly vault:ConnectionVault,readonly options:ApiConnectionStoreOptions={}) {}
  private dto(row:Row):ApiConnectionDTO {
    captureConnectionAuthority(row);
    const imported=row.imported as OpenApiImport;
    const schemes=new Map(imported.operations.flatMap(operation=>operation.security&&operation.security.type!=="none"?[[operation.security.schemeId,operation.security] as const]:[]));
    return {id:row.id,name:row.name,serverUrl:imported.server.url,origin:imported.server.origin,title:imported.title,sourceKind:row.source_kind,importDigest:row.import_digest,
      status:row.state==="revoked"?"disconnected":row.status,revision:row.revision,policyRevision:row.policy_revision,generation:row.generation,
      selectedOperationIds:row.selected_operation_ids,bindingIds:row.binding_ids,credentialSchemes:[...schemes].map(([schemeId,security])=>({schemeId,type:security.type,configured:row.credential_schemes.some((item:Row)=>item.schemeId===schemeId&&item.type===security.type)})),
      lastError:row.last_error,createdAt:new Date(row.created_at).toISOString(),expiresAt:new Date(row.expires_at).toISOString()};
  }
  private async row(db:Pool|PoolClient,scope:ActionScope,id:string,lock:boolean|"share"=false) {
    z.uuid().parse(id);await requireActionMember(db,scope);
    const row=(await db.query(rowQuery+" AND c.id=$3"+(lock==="share"?" FOR SHARE OF c,s":lock?" FOR UPDATE OF c,s":""),[scope.organizationId,scope.accountId,id])).rows[0];
    if(!row)throw unavailable();
    if(requestDigest(row.imported)!==row.import_digest)throw new PlatformError("API_IMPORT_INTEGRITY",409,"Imported API catalog has changed");
    captureConnectionAuthority(row);return row;
  }
  private assertGeneration(row:Row,expected:number) {if(row.state!=="active"||new Date(row.expires_at).getTime()<=Date.now()||row.generation!==expected)throw changed();}
  private async replay(db:PoolClient,scope:ActionScope,key:string,digest:string) {
    const old=(await db.query("SELECT request_digest,result FROM agents_platform.connection_mutations WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3",[scope.organizationId,scope.accountId,key])).rows[0];
    if(old&&old.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"Request key was already used");return old?.result;
  }
  private async record(db:PoolClient,scope:ActionScope,key:string,digest:string,id:string,result:unknown) {
    await db.query("INSERT INTO agents_platform.connection_mutations(organization_id,account_id,operation_id,request_digest,connection_id,result) VALUES($1,$2,$3,$4,$5,$6)",[scope.organizationId,scope.accountId,key,digest,id,JSON.stringify(result)]);
  }
  async preview(scope:ActionScope,raw:unknown) {
    await requireActionMember(this.pool,scope);const source=importedSource(apiPreviewInput.parse(raw),this.options.testLoopback);
    const native=this.options.createCatalog?.(source.imported,{id:randomUUID(),organizationId:scope.organizationId,connectionId:randomUUID(),revision:1});
    return {importDigest:source.importDigest,title:source.imported.title,server:source.imported.server,sourceKind:source.sourceKind,
      operations:source.imported.operations.map(operation=>operationSummary(operation,[],!native||native.tools.some(tool=>tool.providerOperation===operation.alias))),diagnostics:source.imported.diagnostics};
  }
  async list(scope:ActionScope) {await requireActionMember(this.pool,scope);return (await this.pool.query(rowQuery+" ORDER BY c.created_at DESC,c.id LIMIT 100",[scope.organizationId,scope.accountId])).rows.map(row=>this.dto(row));}
  async get(scope:ActionScope,id:string) {return this.dto(await this.row(this.pool,scope,id));}
  async create(scope:ActionScope,raw:unknown):Promise<ApiConnectionDTO> {return observeConnectionControl(this.pool,"native_api","connect",{organizationId:scope.organizationId},async()=>{
    const input=apiConnectionInput.parse(raw),source=importedSource(input,this.options.testLoopback);
    if(source.importDigest!==input.expectedImportDigest)throw new PlatformError("API_IMPORT_CHANGED",409,"Preview the exact API server and authentication selection before saving");
    validateCredentials(source.imported,input.credentials);
    const digest=requestDigest({kind:"api.create",...input});
    return transaction(this.pool,async db=>{
      await owner(db,scope);await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",[`api:${scope.organizationId}:${scope.accountId}:${input.operationId}`]);
      const previous=await this.replay(db,scope,input.operationId,digest);if(previous)return previous;
      const id=randomUUID(),importId=randomUUID();
      await db.query(`INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,profile_id,expires_at,resource_handles)
        VALUES($1,$2,$3,$4,'provider:custom-api',$5,'custom-api-v1',now()+interval '90 days',$6::jsonb)`,
      [id,scope.organizationId,scope.accountId,input.name,source.imported.server.url,JSON.stringify([{kind:"api.origin",id:source.imported.server.origin}])]);
      await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,1,$2::jsonb)",[id,JSON.stringify(this.vault.seal(scope.organizationId,id,1,JSON.stringify({kind:"api-credentials",version:1,credentials:input.credentials}),65536))]);
      await db.query("INSERT INTO agents_platform.api_import_catalogs(id,organization_id,connection_id,source_kind,import_digest,catalog,created_by) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
        [importId,scope.organizationId,id,source.sourceKind,source.importDigest,JSON.stringify(source.imported),scope.accountId]);
      for(const operation of source.imported.operations)await db.query("INSERT INTO agents_platform.api_operation_templates(id,organization_id,connection_id,import_id,alias,definition,template,template_digest) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)",
        [randomUUID(),scope.organizationId,id,importId,operation.alias,JSON.stringify(operation),operation.template?JSON.stringify(operation.template):null,operation.template?.digest??null]);
      let usable=source.imported.operations.some(operation=>operationSummary(operation).compatible);
      let catalogId:string|null=null;
      if(usable&&this.options.createCatalog&&this.options.registry) {
        const catalog=this.options.createCatalog(source.imported,{id:randomUUID(),organizationId:scope.organizationId,connectionId:id,revision:1});this.options.registry.resolve(catalog);catalogId=catalog.id;
        usable=catalog.tools.length>0;
        await db.query("INSERT INTO agents_platform.capability_catalogs(id,organization_id,connection_id,account_id,revision,credential_revision,policy_revision,digest,catalog) VALUES($1,$2,$3,$4,1,1,1,$5,$6::jsonb)",[catalog.id,scope.organizationId,id,scope.accountId,catalog.digest,JSON.stringify(catalog)]);
      }
      await db.query("INSERT INTO agents_platform.api_connection_settings(connection_id,organization_id,import_id,catalog_id,status,credential_schemes) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
        [id,scope.organizationId,importId,catalogId,usable?"selection_required":"unsupported",JSON.stringify(configured(input.credentials))]);
      const result=this.dto(await this.row(db,scope,id));await this.record(db,scope,input.operationId,digest,id,result);return result;
    });

});}
  async operations(scope:ActionScope,id:string) {
    const row=await this.row(this.pool,scope,id);
    const native=row.catalog_id?(await this.pool.query("SELECT catalog FROM agents_platform.capability_catalogs WHERE id=$1 AND connection_id=$2",[row.catalog_id,id])).rows[0]?.catalog as CapabilityCatalog|undefined:undefined;
    const rows=(await this.pool.query(`SELECT t.*,s.effect_policy FROM agents_platform.api_operation_templates t LEFT JOIN agents_platform.api_operation_selections s
      ON s.operation_id=t.id AND s.connection_id=t.connection_id AND s.policy_revision=$2 WHERE t.connection_id=$1 ORDER BY t.alias`,[id,row.policy_revision])).rows;
    return rows.map(operation=>({...operationSummary(operation.definition,row.credential_schemes,!native||native.tools.some(tool=>tool.providerOperation===operation.alias)),id:operation.id,selected:row.selected_operation_ids.includes(operation.id),effectPolicy:operation.effect_policy??null}));
  }
  async select(scope:ActionScope,id:string,raw:unknown):Promise<{connection:ApiConnectionDTO;bindings:CapabilityBinding[]}> {return observeConnectionControl(this.pool,"native_api","select",{organizationId:scope.organizationId,connectionId:id},async()=>{
    const input=apiSelectionInput.parse(raw),digest=requestDigest({kind:"api.select",id,...input});
    return transaction(this.pool,async db=>{
      await owner(db,scope);const row=await this.row(db,scope,id,true),previous=await this.replay(db,scope,input.operationId,digest);if(previous)return previous;
      this.assertGeneration(row,input.expectedGeneration);
      if(!this.options.createCatalog||!this.options.registry)throw new PlatformError("API_RUNTIME_UNAVAILABLE",503,"Native API operation runtime is unavailable");
      const policyRevision=row.policy_revision+1;
      const catalogRevision=Number((await db.query("SELECT coalesce(max(revision),0)+1 AS next FROM agents_platform.capability_catalogs WHERE connection_id=$1",[id])).rows[0].next);
      const catalog=this.options.createCatalog(row.imported,{id:randomUUID(),organizationId:scope.organizationId,connectionId:id,revision:catalogRevision});this.options.registry.resolve(catalog);
      await db.query("INSERT INTO agents_platform.capability_catalogs(id,organization_id,connection_id,account_id,revision,credential_revision,policy_revision,digest,catalog) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
        [catalog.id,scope.organizationId,id,scope.accountId,catalog.revision,row.revision,policyRevision,catalog.digest,JSON.stringify(catalog)]);
      const templates=(await db.query("SELECT * FROM agents_platform.api_operation_templates WHERE connection_id=$1 AND id=ANY($2::uuid[])",[id,input.selections.map(item=>item.operationId)])).rows;
      if(templates.length!==input.selections.length)throw new PlatformError("API_OPERATION_UNAVAILABLE",403,"Choose operations from this API connection");
      const bindings:CapabilityBinding[]=[];
      for(const selection of input.selections) {
        const operation=templates.find(template=>template.id===selection.operationId)!,definition=operation.definition as OpenApiOperation,info=operationSummary(definition,row.credential_schemes);
        if(!info.compatible)throw new PlatformError(definition.security?.type==="oauth2"?"API_OAUTH_CLIENT_REQUIRED":"API_OPERATION_UNSUPPORTED",400,"Selected operation requires unsupported API configuration");
        if(info.credentialState==="required")throw new PlatformError("API_CREDENTIAL_REQUIRED",400,"Configure credentials for each selected operation");
        const tool=catalog.tools.find(tool=>tool.providerOperation===definition.alias);if(!tool)throw new PlatformError("API_OPERATION_UNSUPPORTED",400,"Selected operation has no executable request schema");
        const read=selection.effectPolicy==="owner_reviewed_read",requestLimit=nativePhysicalRequestLimit(definition.template?.responsePolicy);
        if(requestLimit>1&&!read)throw new PlatformError("API_READ_AUTHORIZATION_REQUIRED",403,"Automatic pages and retries require explicit authorization of this GET as a read");
        const binding=createBinding({schemaVersion:1,id:randomUUID(),organizationId:scope.organizationId,catalog:{id:catalog.id,revision:catalog.revision,digest:catalog.digest},definition:tool,adapter:catalog.adapter,
          transport:"native_http",protocolVersion:null,connection:{id,profileId:"custom-api-v1",policyRevision},resources:[{kind:"api.origin",id:row.imported.server.origin}],
          policy:read?{effect:"read",disclosure:"approved_resource_identifiers",retry:"never",approval:"none",cancel:"stop_admission"}:{effect:"reviewed_write",disclosure:"exact_reviewed_payload",retry:"status_only",approval:"exact_single_use",cancel:"reconcile_claimed"},
          limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxPhysicalRequests:requestLimit,maxResponseBytes:1048576,maxModelResultBytes:8192}},catalog);
        await db.query("INSERT INTO agents_platform.capability_bindings(id,organization_id,connection_id,catalog_id,account_id,alias,digest,binding) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)",[binding.id,scope.organizationId,id,catalog.id,scope.accountId,binding.alias,binding.digest,JSON.stringify(binding)]);
        await db.query("INSERT INTO agents_platform.api_operation_selections(id,organization_id,connection_id,operation_id,policy_revision,effect_policy,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",[randomUUID(),scope.organizationId,id,operation.id,policyRevision,selection.effectPolicy,scope.accountId]);bindings.push(binding);
      }
      await db.query("UPDATE agents_platform.connections SET policy_revision=$2 WHERE id=$1",[id,policyRevision]);
      await db.query("UPDATE agents_platform.api_connection_settings SET status='ready',generation=generation+1,selected_operation_ids=$2::uuid[],binding_ids=$3::uuid[],catalog_id=$4,last_error=NULL WHERE connection_id=$1",[id,input.selections.map(item=>item.operationId),bindings.map(binding=>binding.id),catalog.id]);
      const result={connection:this.dto(await this.row(db,scope,id)),bindings};await this.record(db,scope,input.operationId,digest,id,result);return result;
    });

});}
  async updateCredentials(scope:ActionScope,id:string,raw:unknown) {return observeConnectionControl(this.pool,"native_api","rotate",{organizationId:scope.organizationId,connectionId:id},async()=>{
    const input=z.strictObject({operationId:operationKey,expectedGeneration:generation,credentials:credentialsSchema}).parse(raw),digest=requestDigest({kind:"api.credentials",id,...input});
    return transaction(this.pool,async db=>{
      await owner(db,scope);const row=await this.row(db,scope,id,true),previous=await this.replay(db,scope,input.operationId,digest);if(previous)return previous;this.assertGeneration(row,input.expectedGeneration);
      validateCredentials(row.imported,input.credentials);const revision=row.revision+1;
      await db.query("INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3::jsonb)",[id,revision,JSON.stringify(this.vault.seal(scope.organizationId,id,revision,JSON.stringify({kind:"api-credentials",version:1,credentials:input.credentials}),65536))]);
      await db.query("UPDATE agents_platform.connections SET revision=$2,policy_revision=policy_revision+1 WHERE id=$1",[id,revision]);
      await db.query("UPDATE agents_platform.api_connection_settings SET generation=generation+1,status='selection_required',credential_schemes=$2::jsonb,selected_operation_ids='{}',binding_ids='{}',last_error=NULL WHERE connection_id=$1",[id,JSON.stringify(configured(input.credentials))]);
      const result=this.dto(await this.row(db,scope,id));await this.record(db,scope,input.operationId,digest,id,result);return result;
    });

});}
  async disconnect(scope:ActionScope,id:string,expectedGeneration:number) {return observeConnectionControl(this.pool,"native_api","disconnect",{organizationId:scope.organizationId,connectionId:id},async()=>{
    return transaction(this.pool,async db=>{await owner(db,scope);const row=await this.row(db,scope,id,true);this.assertGeneration(row,generation.parse(expectedGeneration));
      const changed=(await db.query("UPDATE agents_platform.connections SET state='revoked',policy_revision=policy_revision+1 WHERE id=$1 RETURNING id,organization_id,policy_revision",[id])).rows[0];
      const settings=(await db.query("UPDATE agents_platform.api_connection_settings SET status='disconnected',generation=generation+1 WHERE connection_id=$1 RETURNING generation",[id])).rows[0];captureConnectionAuthority({...changed,generation:settings.generation});return {disconnected:true as const};});

});}
  async resolveApiOperation(db:PoolClient,scope:ActionScope,id:string,policyRevision:number,providerOperation:string,forProbe=false):Promise<ApiOperationRuntime> {
    const row=await this.row(db,scope,id,"share");
    if(row.state!=="active"||!(forProbe?["ready","failed","credentials_required"].includes(row.status):row.status==="ready")||new Date(row.expires_at).getTime()<=Date.now()||row.policy_revision!==policyRevision)throw new PlatformError("CONNECTION_INACTIVE",403,"API connection authorization is unavailable");
    const selected=(await db.query(`SELECT t.*,s.effect_policy FROM agents_platform.api_operation_templates t JOIN agents_platform.api_operation_selections s ON s.operation_id=t.id
      WHERE t.connection_id=$1 AND t.alias=$2 AND s.policy_revision=$3 AND t.id=ANY($4::uuid[])`,[id,providerOperation,policyRevision,row.selected_operation_ids])).rows[0];
    if(!selected?.template)throw new PlatformError("API_OPERATION_UNAVAILABLE",403,"Operation is outside the selected API scope");
    const template=selected.template as RequestTemplate;
    const {digest,...content}=template,importedOperation=(row.imported as OpenApiImport).operations.find(operation=>operation.alias===providerOperation);
    if(digest!==selected.template_digest||digest!==requestDigest(content)||importedOperation?.template?.digest!==digest||template.serverOrigin!==row.imported.server.origin)
      throw new PlatformError("API_IMPORT_INTEGRITY",409,"Operation template does not match its immutable imported catalog");
    const encrypted=(await db.query("SELECT envelope FROM agents_platform.connection_credentials WHERE connection_id=$1 AND revision=$2",[id,row.revision])).rows[0];
    const stored=JSON.parse(this.vault.open(scope.organizationId,id,row.revision,encrypted.envelope)) as {credentials:Credentials};
    const references:Record<string,string>={},credentials:Record<string,ResolvedOpenApiCredential>={};
    if(template.security.type!=="none") {
      if(template.security.type==="oauth2")throw new PlatformError("API_OAUTH_CLIENT_REQUIRED",400,"OAuth requires a configured provider and client");
      const credential=stored.credentials[template.security.schemeId];if(!credential||credential.type!==template.security.type)throw new PlatformError("API_CREDENTIAL_REQUIRED",403,"API connection credentials are unavailable");
      const reference=`api:${id}:${template.security.schemeId}`;references[template.security.schemeId]=reference;credentials[reference]=credential;
    }
    return {authorizationGeneration:row.generation,operationId:selected.id,template,serverOrigin:row.imported.server.origin,importDigest:row.import_digest,policyRevision,
      credentialReferences:references,credentials,effectPolicy:selected.effect_policy};
  }
  async probe(scope:ActionScope,id:string,raw:unknown) {return observeConnectionControl(this.pool,"native_api","probe",{organizationId:scope.organizationId,connectionId:id},async()=>{
    const input=z.strictObject({operationId:z.uuid(),expectedGeneration:generation,arguments:z.object({path:z.record(z.string(),z.unknown()).optional(),query:z.record(z.string(),z.unknown()).optional(),headers:z.record(z.string(),z.unknown()).optional(),body:z.unknown().optional()}).strict().default({})}).parse(raw);
    const prepared=await transaction(this.pool,async db=>{
      await owner(db,scope);const row=await this.row(db,scope,id);this.assertGeneration(row,input.expectedGeneration);
      const operation=(await db.query("SELECT alias FROM agents_platform.api_operation_templates WHERE id=$1 AND connection_id=$2",[input.operationId,id])).rows[0];if(!operation)throw unavailable();
      const runtime=await this.resolveApiOperation(db,scope,id,row.policy_revision,operation.alias,true);
      if(runtime.effectPolicy!=="owner_reviewed_read"||!["GET","HEAD"].includes(runtime.template.method))throw new PlatformError("API_PROBE_REVIEW_REQUIRED",403,"Choose an explicitly approved read-only GET or HEAD operation for testing");
      const request=injectOpenApiCredentials(compileOpenApiRequest(runtime.template,input.arguments as RequestArguments,runtime.credentialReferences),runtime.credentials);
      return {request,policyRevision:row.policy_revision,generation:row.generation};
    });
    try {
      const fetch=createBoundedFetch({authorizeUrl:url=>url.href===prepared.request.url&&url.origin===prepared.request.origin,headers:prepared.request.headers,maxRequestBytes:0,maxResponseBytes:65536,deadlineAt:Date.now()+10000,maxAttempts:1,maxRequests:1,testLoopback:this.options.testLoopback,
        beforeAttempt:async()=>{await owner(this.pool,scope);const row=await this.row(this.pool,scope,id);this.assertGeneration(row,prepared.generation);if(row.policy_revision!==prepared.policyRevision)throw changed();}});
      const response=await fetch(prepared.request.url,{method:prepared.request.method});
      const successful=response.status>=200&&response.status<300;
      await this.pool.query("UPDATE agents_platform.api_connection_settings SET last_error=$2,last_probe_at=now(),status=$4 WHERE connection_id=$1 AND generation=$3",[id,successful?null:`HTTP_${response.status}`,prepared.generation,successful?"ready":response.status===401||response.status===403?"credentials_required":"failed"]);
      return {status:successful?"ready":"failed",httpStatus:response.status,connection:await this.get(scope,id)};
    }catch(error) {
      const code=error instanceof ConnectedNetworkError?error.code:error instanceof PlatformError?error.code:"API_PROBE_FAILED";
      await this.pool.query("UPDATE agents_platform.api_connection_settings SET last_error=$2,last_probe_at=now(),status=$4 WHERE connection_id=$1 AND generation=$3",[id,code,prepared.generation,code==="AUTHENTICATION"?"credentials_required":"failed"]);
      return {status:"failed",error:code,connection:await this.get(scope,id)};
    }

});}
}
