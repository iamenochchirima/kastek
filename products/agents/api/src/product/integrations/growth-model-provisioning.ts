import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {z} from "zod";
import {getProviderDefinition} from "../../adapters/models/registry";
import {modelProviderAdapter} from "../../adapters/models/model-adapter";
import {enrichProviderModels} from "../../adapters/models/model-metadata";
import type {ModelDiscoveryFetch,ModelDiscoveryResult} from "../../adapters/models/discovery";
import {modelDescriptorSchema,modelEndpointSchema} from "../../contracts/model-providers";
import {ModelCredentialVault,modelApiKeySchema} from "../../infrastructure/model-credential-vault";
import {createBoundedFetch} from "../../infrastructure/connected-network";
import {transaction} from "../../infrastructure/database";
import {PlatformError,requestDigest} from "../../contracts/contracts";
const inputSchema=z.strictObject({tenantId:z.string().min(1).max(256),providerId:z.string().min(1).max(64),
  modelId:z.string().min(1).max(256),apiKey:modelApiKeySchema,endpoint:modelEndpointSchema.optional()});
/** Trusted operator setup only. Keys enter protected custody once, never the durable command or user API. */
export async function discoverGrowthModel(raw:unknown,options:{discoveryFetch?:ModelDiscoveryFetch;now?:Date}={}) {
  const input=inputSchema.parse(raw),definition=getProviderDefinition(input.providerId);
  if(!definition||definition.adapter.readiness!=="installed")throw new PlatformError("MODEL_PROVIDER_UNSUPPORTED",400,"Choose an installed model provider");
  const endpoint=input.endpoint??definition.baseUrl,observedAt=(options.now??new Date()).toISOString();
  const network:ModelDiscoveryFetch=options.discoveryFetch??(async request=>{
    const destination=new URL(request.url),bounded=createBoundedFetch({authorizeUrl:url=>url.href===destination.href,
      headers:{...request.headers},maxRequestBytes:1,maxResponseBytes:request.maxResponseBytes,maxRequests:1,maxAttempts:1,
      deadlineAt:Date.now()+15000,returnAuthenticationResponses:true,returnProviderErrorResponses:true});
    const response=await bounded(request.url,{method:request.method,redirect:"error"});
    return {status:response.status,body:await response.text()};
  });
  let discovered:ModelDiscoveryResult=await modelProviderAdapter.discover(definition,{apiKey:input.apiKey,endpoint,fetch:network,observedAt,maxResponseBytes:4194304,maxModels:5000});
  if(discovered.kind==="discovered"&&!options.discoveryFetch)discovered={...discovered,models:await enrichProviderModels(definition.id,discovered.models,observedAt)};
  const selected=discovered.models.find(model=>model.id===input.modelId);
  if(!selected||discovered.kind==="discovered"&&discovered.unavailableModelIds?.includes(input.modelId))throw new PlatformError("MODEL_UNAVAILABLE",409,"The selected model was not discovered");
  const model=modelDescriptorSchema.parse(selected);
  if(model.providerId!==definition.id||model.protocol!==definition.protocol)throw new PlatformError("MODEL_ROUTE_CHANGED",409,"Model metadata does not cover the provider");
  return {input,definition,endpoint,discovered,model};
}
export type PreparedGrowthModel=Awaited<ReturnType<typeof discoverGrowthModel>>;
interface ProductModelOptions {discoveryFetch?:ModelDiscoveryFetch;now?:Date;prepared?:PreparedGrowthModel;preserveExisting?:boolean;replaceExisting?:boolean;
  requestIdentity?:{id:string;digest:string};validate?:(db:import("pg").PoolClient,organizationId:string)=>Promise<void>}
export function provisionGrowthModel(pool:Pool,vault:ModelCredentialVault,raw:unknown,options:ProductModelOptions={}) {
  return provisionProductModel(pool,vault,"growth",raw,options);
}
export async function provisionProductModel(pool:Pool,vault:ModelCredentialVault,product:"growth"|"agencies",raw:unknown,options:ProductModelOptions={}) {
  const input=inputSchema.parse(raw);
  const identity=options.requestIdentity?z.strictObject({id:z.uuid(),digest:z.string().regex(/^[a-f0-9]{64}$/)}).parse(options.requestIdentity):undefined;
  const replay=async(db:Pool|import("pg").PoolClient)=>{
    if(!identity)return;
    const row=(await db.query(`SELECT r.request_digest,r.response FROM agents_platform.product_command_receipts r
      JOIN agents_platform.product_execution_tenants n ON n.product=r.product AND n.tenant_id=r.tenant_id AND n.revoked_at IS NULL
      WHERE r.product=$1 AND r.tenant_id=$2 AND r.request_id=$3`,[product,input.tenantId,identity.id])).rows[0];
    if(row&&row.request_digest!==identity.digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The model request identity was used for different input");
    return row?.response as {organizationId:string;connectionId:string;modelId:string;revision:number}|undefined;
  };
  const prior=await replay(pool);if(prior)return prior;
  const prepared=options.prepared??await discoverGrowthModel(input,options);
  const {definition,endpoint,discovered,model}=prepared;
  if(requestDigest(input)!==requestDigest(prepared.input))throw new PlatformError("MODEL_PROFILE_CHANGED",409,"The managed profile changed");
  return transaction(pool,async db=>{
    const tenant=(await db.query("SELECT * FROM agents_platform.product_execution_tenants WHERE product=$2 AND tenant_id=$1 AND revoked_at IS NULL FOR SHARE",[input.tenantId,product])).rows[0];
    if(!tenant)throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",404,"Register the product workspace first");
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
    const recorded=await replay(db);if(recorded)return recorded;
    const remember=async(result:{organizationId:string;connectionId:string;modelId:string;revision:number})=>{
      if(identity)await db.query("INSERT INTO agents_platform.product_command_receipts(product,tenant_id,request_id,request_digest,response) VALUES($1,$2,$3,$4,$5)",[product,input.tenantId,identity.id,identity.digest,result]);
      return result;
    };
    const existing=(await db.query("SELECT d.*,c.provider_id,c.endpoint,c.state FROM agents_platform.product_model_defaults d JOIN agents_platform.model_provider_connections c ON c.id=d.connection_id WHERE d.product=$2 AND d.organization_id=$1",[tenant.organization_id,product])).rows[0];
    if(existing&&!options.replaceExisting&&(options.preserveExisting||existing.provider_id===input.providerId&&existing.model_id===input.modelId&&existing.endpoint===endpoint)) {
      if(existing.state!=="active")throw new PlatformError("MODEL_CONNECTION_UNAVAILABLE",409,"The managed model was revoked");
      await options.validate?.(db,tenant.organization_id);
      return remember({organizationId:tenant.organization_id,connectionId:existing.connection_id,modelId:existing.model_id,revision:existing.revision});
    }
    if(options.preserveExisting&&(await db.query("SELECT 1 FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND created_by_service->>'product'=$2 AND state='revoked' LIMIT 1",[tenant.organization_id,product])).rowCount)
      throw new PlatformError("MODEL_CONNECTION_UNAVAILABLE",409,"The managed model was revoked");
    const connectionId=randomUUID(),useGrantId=randomUUID(),context={organizationId:tenant.organization_id,connectionId,credentialRevision:1,endpoint,protocol:definition.protocol};
    const envelope=vault.seal(context,input.apiKey);
    await db.query("INSERT INTO agents_platform.model_provider_connections(id,organization_id,created_by_service,provider_id,name,endpoint,protocol,definition,custody,verification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'platform_managed','discovered')",
      [connectionId,tenant.organization_id,{product,clientId:product==="growth"?"growth-control":"agency-control",issuer:tenant.issuer},definition.id,product==="growth"?"Growth managed model":"Agency managed model",endpoint,definition.protocol,definition]);
    await db.query("INSERT INTO agents_platform.model_provider_credentials(organization_id,connection_id,revision,endpoint,protocol,envelope,state) VALUES($1,$2,1,$3,$4,$5,'active')",[tenant.organization_id,connectionId,endpoint,definition.protocol,envelope]);
    await db.query("INSERT INTO agents_platform.model_provider_catalogues(organization_id,connection_id,connection_revision,credential_revision,snapshot,snapshot_digest) VALUES($1,$2,1,1,$3,$4)",[tenant.organization_id,connectionId,discovered,requestDigest(discovered)]);
    await db.query("INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids) VALUES($1,$2,$3,$4,$5,$6)",[useGrantId,tenant.organization_id,connectionId,{kind:"service",serviceId:"product-default",product},JSON.stringify(["primary","compaction","delegated"]),JSON.stringify([model.id])]);
    const row=(await db.query("INSERT INTO agents_platform.product_model_defaults(product,organization_id,connection_id,model_id,use_grant_id) VALUES($5,$1,$2,$3,$4) ON CONFLICT(product,organization_id) DO UPDATE SET connection_id=excluded.connection_id,model_id=excluded.model_id,use_grant_id=excluded.use_grant_id,revision=product_model_defaults.revision+1,updated_at=now() RETURNING revision",[tenant.organization_id,connectionId,model.id,useGrantId,product])).rows[0];
    await options.validate?.(db,tenant.organization_id);
    return remember({organizationId:tenant.organization_id,connectionId,modelId:model.id,revision:row.revision});
  });
}
