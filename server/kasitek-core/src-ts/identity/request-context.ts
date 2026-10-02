import type { FastifyRequest } from 'fastify';
import { importSPKI, jwtVerify } from 'jose';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { directUser, publicApiPolicy, type Principal, type ActorKind } from './principal.js';
import { extractUser, resolveActiveOrgId, sha256 } from './session.js';
import { unauthorized } from './provider.js';
export interface RequestContext { principal: Principal; organizationId:string; userId:string|null; clientId:string|null; installationId:string|null; effectiveGrants:Set<string>; apiScopes:Set<string>|null; correlationId:string|null; causationId:string|null; idempotencyKey:string|null }
export function directScope(context: RequestContext): {type:'direct';organisation_id:string} { return {type:'direct',organisation_id:context.organizationId}; }
export function hasGrant(context: RequestContext, grant:string): boolean {return context.effectiveGrants.has(grant);}
export function optionalHeader(request:Pick<FastifyRequest,'headers'>,name:string):string|null {
  const value=request.headers[name];
  if(typeof value!=='string')return null;
  const trimmed=value.trim();return trimmed&&Buffer.byteLength(trimmed)<=256?trimmed:null;
}
function traces(request:FastifyRequest) {return {correlationId:optionalHeader(request,'x-correlation-id'),causationId:optionalHeader(request,'x-causation-id'),idempotencyKey:optionalHeader(request,'idempotency-key')};}
export function bearerToken(request:Pick<FastifyRequest,'headers'>):string|null {const auth=request.headers.authorization;return auth?.startsWith('Bearer ')?auth.slice(7).trim()||null:null;}
export async function resolveProductContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const user=await extractUser(request,core);return {principal:directUser(user.id),organizationId:await resolveActiveOrgId(request,core,user.id),userId:user.id,clientId:null,installationId:null,effectiveGrants:new Set(),apiScopes:null,...traces(request)};
}
export function validApiSecret(secret:string):boolean{return Buffer.byteLength(secret)>=40&&/^kst_[A-Za-z0-9_-]+$/.test(secret);}
export async function verifyInstallationToken(publicKey:string,issuer:string,token:string):Promise<{installationId:string;organizationId:string;credentialId:string}> {
  try {
    if(token.length>1_000_000)throw unauthorized();
    const key=await importSPKI(publicKey,'ES256');
    const {payload:c}=await jwtVerify(token,key,{algorithms:['ES256'],issuer,audience:'kasitek-public-api',clockTolerance:900,requiredClaims:['sub','jti']});
    for(const field of ['iat','exp','nbf'] as const)if(c[field]!==undefined&&(!Number.isSafeInteger(c[field])||(c[field] as number)<0))throw unauthorized();
    if((c.iat!==undefined&&(typeof c.iat!=='number'||Math.floor(Date.now()/1000)-c.iat>3600||c.iat>Math.floor(Date.now()/1000)+900))||typeof c.sub!=='string'||!c.sub.trim()||typeof c.jti!=='string'||!c.jti.trim()||typeof c.organizationId!=='string'||!c.organizationId.trim()||typeof c.credentialId!=='string'||!c.credentialId.trim())throw unauthorized();
    return {installationId:c.sub,organizationId:c.organizationId,credentialId:c.credentialId};
  }catch{throw unauthorized();}
}
/** A malformed machine bearer never falls back to an accompanying product cookie. */
export async function resolvePublicCredentialContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const path=request.url.split('?')[0]!;
  if(core.config.env.PUBLIC_API_DISABLED_ROUTES?.split(',').some(p=>p.trim()===path))throw new ApiError(503,'service_unavailable','This public API route is disabled by deployment policy');
  const token=bearerToken(request);let context:RequestContext;
  if(token?.startsWith('kst_')) {
    if(!validApiSecret(token))throw unauthorized();
    const result=await core.pool.query<{id:string;orgId:string;createdById:string;scopes:string[]}>('SELECT id,"orgId","createdById",scopes FROM "DeveloperApiKey" WHERE "keyHash"=$1 AND status=\'ACTIVE\' AND ("expiresAt" IS NULL OR "expiresAt">NOW())',[sha256(token)]);
    const auth=result.rows[0];if(!auth)throw unauthorized();
    await core.pool.query('UPDATE "DeveloperApiKey" SET "lastUsedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1',[auth.id]);
    context={principal:{kind:'workspace_api_key',id:auth.id,subjectUserId:auth.createdById,clientId:auth.id},organizationId:auth.orgId,userId:auth.createdById,clientId:null,installationId:null,effectiveGrants:new Set(),apiScopes:new Set(auth.scopes),...traces(request)};
  }else if(token?.split('.').length===3) {
    const key=core.config.env.AGENTS_INSTALLATION_TOKEN_PUBLIC_KEY;if(!key)throw unauthorized();
    const claim=await verifyInstallationToken(key,core.config.env.AGENTS_INSTALLATION_TOKEN_ISSUER??'kasitek-agents',token);
    context={principal:{kind:'agent_installation',id:claim.installationId,subjectUserId:null,clientId:claim.credentialId},organizationId:claim.organizationId,userId:null,clientId:null,installationId:claim.installationId,effectiveGrants:new Set(),apiScopes:null,...traces(request)};
  }else context=await resolveProductContext(request,core);
  publicApiPolicy(context.principal);return context;
}
export interface PublicActionPolicy {name:string;lifecycle:string;supportedRuntimes:string[];supportedActors:ActorKind[];requiredGrants:string[];risk:string}
export interface InstallationCapabilities {apiScopes?:unknown;capabilities?:unknown}
export type CapabilityResolver=(context:RequestContext)=>Promise<InstallationCapabilities>;
export async function requirePublicAction(context:RequestContext,definition:PublicActionPolicy|undefined,name:string,loadCapabilities:CapabilityResolver):Promise<void> {
  const policy=publicApiPolicy(context.principal);
  if(!definition||definition.name!==name||definition.lifecycle!=='public'||!definition.supportedRuntimes.includes('direct')||!definition.supportedActors.includes(policy.actorKind))throw new ApiError(403,'forbidden',`Public capability is unavailable: ${name}`);
  const scope=definition.risk==='read'?'api:read':'api:write';
  if(!policy.requiresInstallationCapabilities){if(context.apiScopes&&!context.apiScopes.has(scope))throw new ApiError(403,'forbidden',`Developer API key is missing scope: ${scope}`);return;}
  const capabilities=await loadCapabilities(context);const grants=new Set<string>();
  if(Array.isArray(capabilities.capabilities))for(const item of capabilities.capabilities){if(item&&typeof item==='object'&&(item.availability??'available')==='available'&&typeof item.manifest?.requiredScope==='string')grants.add(item.manifest.requiredScope);}
  if(!Array.isArray(capabilities.apiScopes)||!capabilities.apiScopes.includes(scope)||!definition.requiredGrants.every(g=>grants.has(g)))throw new ApiError(403,'forbidden',`Public capability is unavailable: ${name}`);
}
export async function requireWebhookScope(context:RequestContext,write:boolean,loadCapabilities:CapabilityResolver):Promise<void> {
  const scope=write?'api:write':'api:read',grant=write?'webhooks.manage':'webhooks.read';
  if(context.apiScopes){if(!context.apiScopes.has(scope))throw new ApiError(403,'forbidden',`Developer API key is missing scope: ${scope}`);return;}
  if(!publicApiPolicy(context.principal).requiresInstallationCapabilities)return;
  const capabilities=await loadCapabilities(context);
  const allowed=Array.isArray(capabilities.apiScopes)&&capabilities.apiScopes.includes(scope)&&Array.isArray(capabilities.capabilities)&&capabilities.capabilities.some(item=>item?.availability==='available'&&item?.manifest?.requiredScope===grant);
  if(!allowed)throw new ApiError(403,'forbidden',`Public webhook capability requires ${scope} and ${grant}`);
}
