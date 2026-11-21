import {randomUUID,createPublicKey} from "node:crypto";
import {importPKCS8,importSPKI,jwtVerify,SignJWT} from "jose";
import type {FastifyInstance} from "fastify";
import type {Pool,PoolClient} from "pg";
import {z} from "zod";
import {GROWTH_AGENT_PROVISION_PATH,GROWTH_AGENT_PROVISION_CHECK_PATH,GROWTH_AGENT_PUBLICATION_MAX_BYTES,parseGrowthAgentProvisionRequest,parseProductAgentLifecycleCommand,type GrowthAgentProvisionRequest,type GrowthAgentProvisionResult} from "@kasitek-labs/contracts";
import {PlatformError,requestDigest,agentConfigurationSchema} from "../../contracts/contracts";
import {modelDescriptorSchema,modelEndpointSchema} from "../../contracts/model-providers";
import {connectionVaultFromEnvironment} from "../../infrastructure/vault";
import {ModelCredentialVault,modelApiKeySchema} from "../../infrastructure/model-credential-vault";
import type {GrowthServiceTrust} from "../../adapters/products/growth-service-auth";
import {GrowthExecutionService} from "./growth-execution";
import {assertModelCredentialAvailable} from "../../execution/models/credential-readiness";
import {discoverGrowthModel,provisionGrowthModel,type PreparedGrowthModel} from "./growth-model-provisioning";
import {ModelDiscoveryError,type ModelDiscoveryFetch} from "../../adapters/models/discovery";
import {resolveAcceptedModelRoutes} from "../../execution/models/resolution";
import {modelServicePolicy,executionModelLayers,contextGrantCeiling} from "../../execution/models/settings";

export const growthManagedModelProfileSchema=z.strictObject({id:z.string().min(1).max(128),revision:z.string().min(1).max(128),
  providerId:z.string().min(1).max(64),modelId:z.string().min(1).max(256),credentialRef:z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/),endpoint:modelEndpointSchema.optional()});
export type GrowthManagedModelProfile=z.infer<typeof growthManagedModelProfileSchema>;
export class GrowthProvisionAuth {
  private readonly keys:Map<string,ReturnType<typeof importSPKI>>;
  constructor(readonly issuer:string,keys:Record<string,string>) {
    if(!keys||Array.isArray(keys)||!Object.keys(keys).length||Object.keys(keys).length>8)throw Error("Invalid Growth provisioning keys");
    this.keys=new Map(Object.entries(keys).map(([id,pem])=>{
      const key=createPublicKey(pem.replace(/\\n/g,"\n"));
      if(!id||id.length>128||key.asymmetricKeyType!=="rsa"||(key.asymmetricKeyDetails?.modulusLength??0)<2048)throw Error("Invalid Growth provisioning key");
      return [id,importSPKI(String(key.export({format:"pem",type:"spki"})),"RS256")];
    }));
  }
  async verify(token:string,input:GrowthAgentProvisionRequest,digestBody?:unknown) {
    try {
      const {payload:p}=await jwtVerify(token,async h=>{const key=h.kid?this.keys.get(h.kid):this.keys.size===1?[...this.keys.values()][0]:undefined;if(!key)throw Error();return await key;},
        {issuer:this.issuer,audience:"agents-product-provisioning",algorithms:["RS256"],clockTolerance:5,requiredClaims:["iat","exp","jti","sub"]});
      const now=Math.floor(Date.now()/1000);
      if(p.sub!=="growth-provisioner"||p.product!=="growth"||p.requestDigest!==requestDigest(digestBody??input)||typeof p.iat!=="number"||typeof p.exp!=="number"||p.exp<=p.iat||p.exp-p.iat>120||p.iat>now+5||!z.uuid().safeParse(p.jti).success)throw Error();
      return {jti:p.jti as string,expiresAt:new Date(p.exp*1000)};
    }catch {throw new PlatformError("PRODUCT_PROVISION_DENIED",401,"Growth provisioning authentication is invalid");}
  }
}
export function growthProvisionLifecycleFromEnvironment(env:NodeJS.ProcessEnv=process.env,network:typeof fetch=fetch) {
  if(!env.GROWTH_PRODUCT_API_URL||!env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY)return;
  const origin=new URL(env.GROWTH_PRODUCT_API_URL);
  if(origin.pathname!=="/"||origin.username||origin.password||origin.search||origin.hash||origin.protocol!=="https:"&&!(env.NODE_ENV!=="production"&&origin.protocol==="http:"&&["localhost","127.0.0.1","[::1]"].includes(origin.hostname)))throw Error("Invalid Growth provisioning origin");
  const key=importPKCS8(env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY,"RS256");
  return async(input:GrowthAgentProvisionRequest)=>{
    const now=Math.floor(Date.now()/1000),token=await new SignJWT({product:"growth",requestDigest:requestDigest(input)})
      .setProtectedHeader({alg:"RS256",kid:env.AGENTS_PRODUCT_ACTION_KEY_ID??"agents-v1"})
      .setIssuer(env.AGENTS_PRODUCT_ACTION_ISSUER??"https://agents.kasitek.co.za").setSubject("agents-provisioner")
      .setAudience("growth-agent-provisioning-lifecycle").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now+60).sign(await key);
    let response:Response;
    try {response=await network(new URL(GROWTH_AGENT_PROVISION_CHECK_PATH,origin),{method:"POST",headers:{"content-type":"application/json",authorization:"Bearer "+token},body:JSON.stringify(input),signal:AbortSignal.timeout(10000),redirect:"error"});}
    catch {throw new PlatformError("PRODUCT_LIFECYCLE_UNAVAILABLE",503,"Growth lifecycle check is unavailable");}
    if(!response.ok)throw new PlatformError("PRODUCT_LIFECYCLE_UNAVAILABLE",503,"Growth lifecycle check is unavailable");
    const text=await response.text();if(text.length>1024)throw new PlatformError("PRODUCT_LIFECYCLE_INVALID",502,"Invalid Growth lifecycle response");
    let value:unknown;try {value=JSON.parse(text);}catch {throw new PlatformError("PRODUCT_LIFECYCLE_INVALID",502,"Invalid Growth lifecycle response");}
    const result=z.strictObject({active:z.boolean()}).safeParse(value);
    if(!result.success)throw new PlatformError("PRODUCT_LIFECYCLE_INVALID",502,"Invalid Growth lifecycle response");
    return result.data.active;
  };
}
export class GrowthProvisionService {
  private cached?:{digest:string;expires:number;value:Promise<PreparedGrowthModel>};
  constructor(readonly pool:Pool,readonly options:{trust:GrowthServiceTrust;vault:ModelCredentialVault;profile:()=>unknown;credential:(reference:string)=>string|undefined;
    active:(request:GrowthAgentProvisionRequest)=>Promise<boolean>;discoveryFetch?:ModelDiscoveryFetch}){}
  async validate(db:PoolClient,organizationId:string) {
    const features=(await db.query("SELECT f.agent_id,f.version_id,v.configuration FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.organization_id=$1",[organizationId])).rows;
    if(features.length!==4)throw new PlatformError("PRODUCT_DEFAULTS_INCOMPLETE",409,"Growth defaults are incomplete");
    for(const feature of features) {
      const config=agentConfigurationSchema.parse(feature.configuration);
      const route=await resolveAcceptedModelRoutes(db,{organizationId,agentId:feature.agent_id,product:"growth",selection:config.model.selection,generation:config.model.generation,
        layers:executionModelLayers(config,{id:feature.version_id,maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:contextGrantCeiling(config),rootTokenLimit:modelServicePolicy().maxRootTokens}),requiresTools:config.tools.length>0||config.productBindings.length>0||config.skillIds.length>0});
      await assertModelCredentialAvailable(db,route.primary.binding);
    }
  }
  async provision(input:GrowthAgentProvisionRequest):Promise<GrowthAgentProvisionResult> {
    const base={version:"1" as const,tenantId:input.tenantId,defaultsRevision:input.defaultsRevision,modelProfileId:input.modelProfileId,modelProfileRevision:input.modelProfileRevision};
    if(!await this.options.active(input))return {...base,state:"blocked",code:"PRODUCT_TENANT_INACTIVE"};
    const parsed=growthManagedModelProfileSchema.safeParse(this.options.profile());
    if(!parsed.success)return {...base,state:"blocked",code:"MODEL_PROFILE_REQUIRED"};
    const profile=parsed.data;
    if(profile.id!==input.modelProfileId||profile.revision!==input.modelProfileRevision)return {...base,state:"blocked",code:"MODEL_PROFILE_MISMATCH"};
    const applied=(await this.pool.query("SELECT profile_id,profile_revision,profile_digest,defaults_revision FROM agents_platform.product_default_provisions WHERE product='growth' AND tenant_id=$1",[input.tenantId])).rows[0];
    if(applied&&(applied.profile_id!==profile.id||applied.profile_revision!==profile.revision||(applied.defaults_revision!==input.defaultsRevision&&!input.upgradeDefaults)||applied.profile_digest!==requestDigest(profile)))return {...base,state:"blocked",code:"MODEL_PROFILE_UPGRADE_REQUIRED"};
    const secret=modelApiKeySchema.safeParse(this.options.credential(profile.credentialRef));
    if(!secret.success)return {...base,state:"blocked",code:"MODEL_CREDENTIAL_REQUIRED"};
    const execution=new GrowthExecutionService(this.pool,this.options.trust);
    try {
      // Discovery is shared by this explicit profile and runs before tenant/database locks.
      const raw={tenantId:input.tenantId,providerId:profile.providerId,modelId:profile.modelId,apiKey:secret.data,...(profile.endpoint?{endpoint:profile.endpoint}:{})};
      const digest=requestDigest({...profile,apiKey:secret.data});
      let prepared:PreparedGrowthModel|undefined;
      const old=(await this.pool.query("SELECT d.connection_id,d.model_id,c.snapshot FROM agents_platform.product_execution_tenants t JOIN agents_platform.product_model_defaults d ON d.organization_id=t.organization_id AND d.product='growth' JOIN agents_platform.model_provider_catalogues c ON c.connection_id=d.connection_id WHERE t.product='growth' AND t.tenant_id=$1 ORDER BY c.fetched_at DESC,c.connection_revision DESC,c.credential_revision DESC LIMIT 1",[input.tenantId])).rows[0];
      if(!old) {
        if(!this.cached||this.cached.digest!==digest||this.cached.expires<=Date.now()) {
          const value=discoverGrowthModel(raw,{discoveryFetch:this.options.discoveryFetch});
          this.cached={digest,expires:Date.now()+300000,value};
          void value.catch(()=>{if(this.cached?.value===value)this.cached=undefined;});
        }
        prepared=await this.cached.value;
        prepared={...prepared,input:raw};
      }
      if(!await this.options.active(input))return {...base,state:"blocked",code:"PRODUCT_TENANT_INACTIVE"};
      const model=prepared?.model??modelDescriptorSchema.parse(old?.snapshot?.models?.find((value:{id:string})=>value.id===old.model_id));
      await execution.ensureTenant(input,{model});
      const validate=async(db:PoolClient,organizationId:string)=>{
        await this.validate(db,organizationId);
        await db.query("INSERT INTO agents_platform.product_default_provisions(product,tenant_id,profile_id,profile_revision,profile_digest,defaults_revision) VALUES('growth',$1,$2,$3,$4,$5) ON CONFLICT(product,tenant_id) DO NOTHING",[input.tenantId,profile.id,profile.revision,requestDigest(profile),input.defaultsRevision]);
        if(input.upgradeDefaults)await db.query("UPDATE agents_platform.product_default_provisions SET defaults_revision=$2 WHERE product='growth' AND tenant_id=$1 AND profile_id=$3 AND profile_revision=$4 AND profile_digest=$5",[input.tenantId,input.defaultsRevision,profile.id,profile.revision,requestDigest(profile)]);
        const current=(await db.query("SELECT * FROM agents_platform.product_default_provisions WHERE product='growth' AND tenant_id=$1 FOR SHARE",[input.tenantId])).rows[0];
        if(current.profile_id!==profile.id||current.profile_revision!==profile.revision||current.profile_digest!==requestDigest(profile)||current.defaults_revision!==input.defaultsRevision)
          throw new PlatformError("MODEL_PROFILE_UPGRADE_REQUIRED",409,"A managed profile upgrade requires explicit authorization");
      };
      // An existing default is authoritative, including operator choices. Never refresh/replace it on repair.
      if(old) {
        const {transaction}=await import("../../infrastructure/database");
        await transaction(this.pool,async db=>{
          const current=await execution.tenant(db,input);
          await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[current.organization_id]);
          await validate(db,current.organization_id);
        });
      } else await provisionGrowthModel(this.pool,this.options.vault,raw,{prepared,preserveExisting:true,validate});
      // A concurrent operator revocation must remain visible to this acknowledgement.
      const currentTenant=await execution.tenant(this.pool,input);
      const {transaction}=await import("../../infrastructure/database");
      await transaction(this.pool,db=>this.validate(db,currentTenant.organization_id));
      return {...base,state:"ready"};
    }catch(error) {
      if(error instanceof PlatformError&&error.statusCode<500)return {...base,state:"blocked",code:error.code};
      throw error;
    }
  }
}
export function registerGrowthProvisionRoute(app:FastifyInstance,pool:Pool,trust:GrowthServiceTrust|undefined,env:NodeJS.ProcessEnv=process.env,options:{discoveryFetch?:ModelDiscoveryFetch}={}) {
  const keys=env.GROWTH_AGENTS_PROVISION_PUBLIC_KEYS_JSON?JSON.parse(env.GROWTH_AGENTS_PROVISION_PUBLIC_KEYS_JSON):undefined;
  const auth=trust&&keys?new GrowthProvisionAuth(trust.issuer,keys):undefined;
  const vault=connectionVaultFromEnvironment(env),active=growthProvisionLifecycleFromEnvironment(env);
  const service=trust&&vault&&active?new GrowthProvisionService(pool,{trust,vault:new ModelCredentialVault(vault),active,
    profile:()=>{try{return JSON.parse(env.GROWTH_MANAGED_MODEL_PROFILE_JSON??"null");}catch{return null;}},credential:ref=>env[ref],discoveryFetch:options.discoveryFetch}):undefined;
  async function recordAssertion(jti:string,digest:string,expiresAt:Date) {
    await pool.query("INSERT INTO agents_platform.product_service_assertions(product,client_id,jti,request_digest,expires_at) VALUES('growth','growth-provisioner',$1,$2,$3) ON CONFLICT DO NOTHING",[jti,digest,expiresAt]);
    const row=(await pool.query("SELECT request_digest FROM agents_platform.product_service_assertions WHERE product='growth' AND client_id='growth-provisioner' AND jti=$1",[jti])).rows[0];
    if(row?.request_digest!==digest)throw new PlatformError("PRODUCT_ASSERTION_CONFLICT",409,"Provisioning assertion input changed");
  }
  async function runProvision(request:import("fastify").FastifyRequest,input:GrowthAgentProvisionRequest):Promise<GrowthAgentProvisionResult>{
    let result:GrowthAgentProvisionResult;
    try { result=await service!.provision(input); }
    catch(error) {
      const known=error instanceof PlatformError;
      const code=known&&/^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)?error.code:
        error instanceof ModelDiscoveryError&&/^[a-z_]{1,40}$/.test(error.code)?`MODEL_DISCOVERY_${error.code.toUpperCase()}`:"INTERNAL_ERROR";
      const status=known&&Number.isInteger(error.statusCode)&&error.statusCode>=400&&error.statusCode<=599?error.statusCode:500;
      request.log.warn({event:"growth_default_provision_failed",code,status},"Growth defaults provisioning failed");
      throw error;
    }
    request.log.info({event:"growth_default_provision",tenantId:input.tenantId,operationId:input.requestId,state:result.state,code:result.code},"Growth defaults provisioning");
    return result;
  }
  app.post("/internal/v1/products/:product/lifecycle",{bodyLimit:GROWTH_AGENT_PUBLICATION_MAX_BYTES+16_384},async request=>{
    const product=(request.params as {product?:string}).product;
    if(product!=="growth"||!auth||!service)throw new PlatformError("PRODUCT_PROVISION_UNAVAILABLE",503,"Product lifecycle is not configured");
    let command:ReturnType<typeof parseProductAgentLifecycleCommand>;
    try {command=parseProductAgentLifecycleCommand(request.body);}catch {throw new PlatformError("INVALID_PRODUCT_PROVISION",400,"Check the lifecycle fields");}
    if(command.operation!=="agents.applyPublication"||command.product!=="growth")throw new PlatformError("INVALID_PRODUCT_PROVISION",400,"Check the lifecycle operation");
    const input:GrowthAgentProvisionRequest={version:"1",requestId:command.requestId,tenantId:command.tenantId,
      defaultsRevision:command.input.defaultsRevision,modelProfileId:command.input.modelProfileId,modelProfileRevision:command.input.modelProfileRevision,
      ...(command.input.publication===undefined?{}:{publication:command.input.publication as GrowthAgentProvisionRequest["publication"]}),
      ...(command.input.upgradeDefaults===undefined?{}:{upgradeDefaults:command.input.upgradeDefaults})};
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_PROVISION_DENIED",401,"Provisioning authentication is required");
    const verified=await auth.verify(bearer,input,command);
    await recordAssertion(verified.jti,requestDigest(command),verified.expiresAt);
    return runProvision(request,input);
  });
  app.post(GROWTH_AGENT_PROVISION_PATH,{bodyLimit:GROWTH_AGENT_PUBLICATION_MAX_BYTES+16_384},async request=>{
    if(!auth||!service)throw new PlatformError("PRODUCT_PROVISION_UNAVAILABLE",503,"Growth provisioning is not configured");
    let input:GrowthAgentProvisionRequest;try {input=parseGrowthAgentProvisionRequest(request.body);}catch {throw new PlatformError("INVALID_PRODUCT_PROVISION",400,"Check the provisioning fields");}
    const bearer=request.headers.authorization?.match(/^Bearer ([A-Za-z0-9_.-]+)$/)?.[1];
    if(!bearer)throw new PlatformError("PRODUCT_PROVISION_DENIED",401,"Provisioning authentication is required");
    const verified=await auth.verify(bearer,input);
    await recordAssertion(verified.jti,requestDigest(input),verified.expiresAt);
    return runProvision(request,input);
  });
}
