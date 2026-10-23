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
export async function provisionGrowthModel(pool:Pool,vault:ModelCredentialVault,raw:unknown,options:{discoveryFetch?:ModelDiscoveryFetch;now?:Date}={}) {
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
  return transaction(pool,async db=>{
    const tenant=(await db.query("SELECT * FROM agents_platform.product_execution_tenants WHERE product='growth' AND tenant_id=$1 AND revoked_at IS NULL FOR SHARE",[input.tenantId])).rows[0];
    if(!tenant)throw new PlatformError("PRODUCT_TENANT_UNAVAILABLE",404,"Register the Growth business first");
    await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[tenant.organization_id]);
    const connectionId=randomUUID(),useGrantId=randomUUID(),context={organizationId:tenant.organization_id,connectionId,credentialRevision:1,endpoint,protocol:definition.protocol};
    const envelope=vault.seal(context,input.apiKey);
    await db.query("INSERT INTO agents_platform.model_provider_connections(id,organization_id,created_by_service,provider_id,name,endpoint,protocol,definition,custody,verification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'platform_managed','discovered')",
      [connectionId,tenant.organization_id,{product:"growth",clientId:"growth-control",issuer:tenant.issuer},definition.id,"Growth managed model",endpoint,definition.protocol,definition]);
    await db.query("INSERT INTO agents_platform.model_provider_credentials(organization_id,connection_id,revision,endpoint,protocol,envelope,state) VALUES($1,$2,1,$3,$4,$5,'active')",[tenant.organization_id,connectionId,endpoint,definition.protocol,envelope]);
    await db.query("INSERT INTO agents_platform.model_provider_catalogues(organization_id,connection_id,connection_revision,credential_revision,snapshot,snapshot_digest) VALUES($1,$2,1,1,$3,$4)",[tenant.organization_id,connectionId,discovered,requestDigest(discovered)]);
    await db.query("INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids) VALUES($1,$2,$3,$4,$5,$6)",[useGrantId,tenant.organization_id,connectionId,{kind:"service",serviceId:"product-default",product:"growth"},JSON.stringify(["primary","compaction","delegated"]),JSON.stringify([model.id])]);
    const row=(await db.query("INSERT INTO agents_platform.product_model_defaults(product,organization_id,connection_id,model_id,use_grant_id) VALUES('growth',$1,$2,$3,$4) ON CONFLICT(product,organization_id) DO UPDATE SET connection_id=excluded.connection_id,model_id=excluded.model_id,use_grant_id=excluded.use_grant_id,revision=product_model_defaults.revision+1,updated_at=now() RETURNING revision",[tenant.organization_id,connectionId,model.id,useGrantId])).rows[0];
    return {organizationId:tenant.organization_id,connectionId,modelId:model.id,revision:row.revision};
  });
}
