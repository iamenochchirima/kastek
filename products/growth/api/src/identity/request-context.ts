import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { directUser, publicApiPolicy, type Principal, type ActorKind } from './principal.js';
import { extractUser, resolveActiveOrgId, sha256 } from './session.js';
import { unauthorized } from './provider.js';
import { resolveGrowthOAuthContext } from '../oauth/index.js';
export interface RequestContext { principal: Principal; organizationId:string; userId:string|null; clientId:string|null; effectiveGrants:Set<string>; apiScopes:Set<string>|null; correlationId:string|null; causationId:string|null; idempotencyKey:string|null; operationReviewId?:string }
export function directScope(context: RequestContext): {type:'direct';organisation_id:string} { return {type:'direct',organisation_id:context.organizationId}; }
export function hasGrant(context: RequestContext, grant:string): boolean {return context.effectiveGrants.has(grant);}
export function optionalHeader(request:Pick<FastifyRequest,'headers'>,name:string):string|null {
  const value=request.headers[name];
  if(typeof value!=='string')return null;
  const trimmed=value.trim();return trimmed&&Buffer.byteLength(trimmed)<=256?trimmed:null;
}
function traces(request:FastifyRequest) {return {correlationId:optionalHeader(request,'x-correlation-id'),causationId:optionalHeader(request,'x-causation-id'),idempotencyKey:optionalHeader(request,'idempotency-key')};}
export function bearerToken(request:Pick<FastifyRequest,'headers'>):string|null {
  const auth=request.headers.authorization;
  if(auth===undefined)return null;
  if(!/^Bearer [A-Za-z0-9._~-]+$/i.test(auth))throw unauthorized();
  return auth.slice(7);
}
export async function resolveProductContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const user=await extractUser(request,core);return {principal:directUser(user.id),organizationId:await resolveActiveOrgId(request,core,user.id),userId:user.id,clientId:null,effectiveGrants:new Set(),apiScopes:null,...traces(request)};
}
export function validApiSecret(secret:string):boolean{return Buffer.byteLength(secret)>=40&&/^kst_[A-Za-z0-9_-]+$/.test(secret);}
/** A malformed machine bearer never falls back to an accompanying product cookie. */
export async function resolvePublicCredentialContext(request:FastifyRequest,core:CoreContext):Promise<RequestContext> {
  const path=request.url.split('?')[0]!;
  if(core.config.env.PUBLIC_API_DISABLED_ROUTES?.split(',').some(p=>p.trim()===path))throw new ApiError(503,'service_unavailable','This public API route is disabled by deployment policy');
  const token=bearerToken(request);let context:RequestContext;
  if(token?.startsWith('growth_oauth_')) {
    if(core.config.env.GROWTH_AGENT_ACCESS_ENABLED==='false'||(core.config.environment==='production'&&core.config.env.GROWTH_AGENT_ACCESS_ENABLED!=='true'))throw new ApiError(503,'agent_access_disabled','Agent access is unavailable');
    const oauth=await resolveGrowthOAuthContext(core,token);
    if(!oauth)throw unauthorized();
    context={...oauth,...traces(request)};
  }else if(token?.startsWith('kst_')) {
    if(!validApiSecret(token))throw unauthorized();
    const result=await core.pool.query<{id:string;orgId:string;createdById:string;scopes:string[]}>('SELECT id,"orgId","createdById",scopes FROM "DeveloperApiKey" WHERE "keyHash"=$1 AND status=\'ACTIVE\' AND ("expiresAt" IS NULL OR "expiresAt">NOW())',[sha256(token)]);
    const auth=result.rows[0];if(!auth)throw unauthorized();
    await core.pool.query('UPDATE "DeveloperApiKey" SET "lastUsedAt"=NOW(),"updatedAt"=NOW() WHERE id=$1',[auth.id]);
    context={principal:{kind:'workspace_api_key',id:auth.id,subjectUserId:auth.createdById,clientId:auth.id},organizationId:auth.orgId,userId:auth.createdById,clientId:null,effectiveGrants:new Set(),apiScopes:new Set(auth.scopes),...traces(request)};
  }else if(token) throw unauthorized();
  else context=await resolveProductContext(request,core);
  publicApiPolicy(context.principal);return context;
}
export interface PublicActionPolicy {name:string;lifecycle:string;supportedRuntimes:string[];supportedActors:ActorKind[];requiredGrants:string[];risk:string}
/** Generic write scope permits drafts, never publication or destructive operations. */
export function publicActionHasScope(context:RequestContext,risk:string):boolean {
  if(context.apiScopes===null)return context.principal.kind==='direct_user';
  const scope=risk==='read'?'growth:read':risk==='draft'?'growth:draft':risk==='external_effect'?'growth:publish':'growth:manage';
  return context.apiScopes.has(scope)||(risk==='read'&&context.apiScopes.has('api:read'))||(risk==='draft'&&context.apiScopes.has('api:write'));
}
export async function requirePublicAction(context:RequestContext,definition:PublicActionPolicy|undefined,name:string):Promise<void> {
  const policy=publicApiPolicy(context.principal);
  if(!definition||definition.name!==name||definition.lifecycle!=="public"||!definition.supportedRuntimes.includes("direct")||!definition.supportedActors.includes(policy.actorKind))throw new ApiError(403,"forbidden","Public capability is unavailable: "+name);
  if(!publicActionHasScope(context,definition.risk))throw new ApiError(403,'forbidden','The credential does not permit this operation');
}
export async function requireWebhookScope(context:RequestContext,write:boolean):Promise<void> {
  publicApiPolicy(context.principal);
  const allowed=context.apiScopes===null||context.apiScopes.has(write?'api:write':'api:read')||context.apiScopes.has(write?'growth:manage':'growth:read');
  if(!allowed)throw new ApiError(403,'forbidden','The credential does not permit webhook access');
}
