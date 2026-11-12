import {randomUUID} from "node:crypto";
import type {Pool} from "pg";
import {getProviderDefinition} from "../../adapters/models/registry";
import {modelProviderAdapter} from "../../adapters/models/model-adapter";
import type {ModelDiscoveryFetch,ModelDiscoveryResult} from "../../adapters/models/discovery";
import type {ActionScope} from "../../contracts/connections";
import {PlatformError,requestDigest} from "../../contracts/contracts";
import {modelIdSchema} from "../../contracts/model-providers";
import {ModelCredentialVault,modelApiKeySchema} from "../../infrastructure/model-credential-vault";
import {createBoundedFetch} from "../../infrastructure/connected-network";
import {transaction} from "../../infrastructure/database";

export const defaultAgentsModelId="nvidia/nemotron-3.5-lightning:free";

/** An optional operator allowlist. An empty value exposes the provider catalogue. */
function managedModelAllowlist(env:NodeJS.ProcessEnv,defaultModelId:string):string[]|null {
  const raw=env.AGENTS_DEFAULT_MODEL_IDS?.trim();
  if(!raw)return null;
  const ids=[...new Set(raw.split(",").map(value=>value.trim()).filter(Boolean).map(value=>modelIdSchema.parse(value)))];
  if(!ids.includes(defaultModelId))ids.unshift(defaultModelId);
  return ids.slice(0,64);
}

/** Provision once during owner bootstrap. Revoked connections and explicit choices are never repaired implicitly. */
export function managedModelDefaultFromEnvironment(pool:Pool,vault:ModelCredentialVault|undefined,
  env:NodeJS.ProcessEnv=process.env,options:{discoveryFetch?:ModelDiscoveryFetch}={}) {
  if(env.AGENTS_DEFAULT_MODEL_ENABLED==="false")return undefined;
  const rawKey=env.AGENTS_DEFAULT_MODEL_API_KEY??env.OPENROUTER_API_KEY;
  if(!rawKey||!vault)return undefined;
  const apiKey=modelApiKeySchema.parse(rawKey),modelId=modelIdSchema.parse(env.AGENTS_DEFAULT_MODEL_ID??defaultAgentsModelId);
  const allowlist=managedModelAllowlist(env,modelId),allowed=allowlist?new Set(allowlist):null;
  const definition=getProviderDefinition("openrouter")!;
  let discovery:Promise<ModelDiscoveryResult>|undefined;
  async function eligible(db:import("pg").PoolClient,scope:ActionScope) {
    const owner=(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE",[scope.organizationId,scope.accountId])).rowCount;
    if(!owner)return false;
    const existing=(await db.query(`SELECT 1 FROM agents_platform.model_provider_defaults WHERE organization_id=$1
      UNION ALL SELECT 1 FROM agents_platform.model_provider_connections WHERE organization_id=$1 AND managed_model_id IS NOT NULL LIMIT 1`,[scope.organizationId])).rowCount;
    return !existing;
  }
  async function prepare() {
    const network:ModelDiscoveryFetch=options.discoveryFetch??(async request=>{
      const destination=new URL(request.url),bounded=createBoundedFetch({authorizeUrl:url=>url.href===destination.href,
        headers:{...request.headers},maxRequestBytes:1,maxResponseBytes:request.maxResponseBytes,maxRequests:1,maxAttempts:1,
        deadlineAt:Date.now()+15000,returnAuthenticationResponses:true,returnProviderErrorResponses:true});
      const response=await bounded(request.url,{method:request.method,redirect:"error"});return {status:response.status,body:await response.text()};
    });
    const result=await modelProviderAdapter.discover(definition,{apiKey,endpoint:definition.baseUrl,fetch:network,
      observedAt:new Date().toISOString(),maxResponseBytes:2097152,maxModels:5000});
    const filtered=result.kind==="discovered"?result.models.filter(item=>(!allowed||allowed.has(item.id))&&!result.unavailableModelIds?.includes(item.id)):[];
    // The default is a required member: a managed connection without it would need an owner decision.
    if(!filtered.some(item=>item.id===modelId))throw new PlatformError("MODEL_DEFAULT_UNAVAILABLE",503,"The managed default model is unavailable");
    const models=[...filtered].sort((left,right)=>left.id===modelId?-1:right.id===modelId?1:left.id.localeCompare(right.id));
    const unavailable=allowlist?allowlist.filter(id=>!models.some(item=>item.id===id)):result.kind==="discovered"?result.unavailableModelIds:undefined;
    const catalogue:Record<string,unknown>={...result,models};
    delete catalogue.unavailableModelIds;
    if(unavailable)catalogue.unavailableModelIds=unavailable;
    return catalogue as typeof result;
  }
  return async(scope:ActionScope):Promise<boolean>=>{
    if(!await transaction(pool,db=>eligible(db,scope)))return false;
    discovery??=prepare().catch(error=>{discovery=undefined;throw error;});
    const catalogue=await discovery;
    const catalogueIds=catalogue.models.map(item=>item.id);
    return transaction(pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[scope.organizationId]);
      if(!await eligible(db,scope))return false;
      const connectionId=randomUUID(),grantId=randomUUID();
      const envelope=vault.seal({organizationId:scope.organizationId,connectionId,credentialRevision:1,endpoint:definition.baseUrl,protocol:definition.protocol},apiKey);
      await db.query(`INSERT INTO agents_platform.model_provider_connections
        (id,organization_id,created_by,provider_id,name,endpoint,protocol,definition,custody,verification,managed_model_id,managed_model_ids)
        VALUES($1,$2,$3,'openrouter','OpenRouter',$4,$5,$6,'platform_managed','discovered',$7,$8)`,
      [connectionId,scope.organizationId,scope.accountId,definition.baseUrl,definition.protocol,definition,modelId,JSON.stringify(allowlist?catalogueIds:[])]);
      await db.query(`INSERT INTO agents_platform.model_provider_credentials(organization_id,connection_id,revision,endpoint,protocol,envelope,state)
        VALUES($1,$2,1,$3,$4,$5,'active')`,[scope.organizationId,connectionId,definition.baseUrl,definition.protocol,envelope]);
      await db.query(`INSERT INTO agents_platform.model_provider_catalogues(organization_id,connection_id,connection_revision,credential_revision,snapshot,snapshot_digest)
        VALUES($1,$2,1,1,$3,$4)`,[scope.organizationId,connectionId,catalogue,requestDigest(catalogue)]);
      await db.query(`INSERT INTO agents_platform.model_provider_use_grants(id,organization_id,connection_id,consumer,roles,model_ids)
        VALUES($1,$2,$3,$4,$5,$6)`,[grantId,scope.organizationId,connectionId,{kind:"service",serviceId:"organization-default",product:"agents"},JSON.stringify(["primary","compaction","delegated"]),JSON.stringify(catalogueIds)]);
      await db.query(`INSERT INTO agents_platform.model_provider_defaults(organization_id,connection_id,model_id,use_grant_id,revision,updated_by)
        VALUES($1,$2,$3,$4,1,$5)`,[scope.organizationId,connectionId,modelId,grantId,scope.accountId]);
      return true;
    });
  };
}
