import { createHmac, timingSafeEqual } from 'node:crypto';
import { decodeProtectedHeader, importSPKI, jwtVerify } from 'jose';
import { createClient } from 'redis';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../context.js';
import { ApiError } from '../error.js';
import { unauthorized } from './provider.js';
import { bearerToken, hasGrant, type RequestContext } from './request-context.js';
export interface DelegationClaims { organizationId:string;installationId:string;capability:string;capabilityVersion:string;runId:string;invocationId:string;correlationId:string;actorId?:string|null;idempotencyKey?:string|null;argumentsHash?:string|null }
export type ReplayGuard=(issuer:string,jti:string)=>Promise<boolean>;
export function selectDelegationPublicKey(core:CoreContext,token:string):string {
  try {
    const {kid}=decodeProtectedHeader(token);
    if(kid!==undefined&&(typeof kid!=='string'||!kid.trim()||Buffer.byteLength(kid)>128))throw unauthorized();
    const env=core.config.env;
    if(env.AGENTS_DELEGATION_PUBLIC_KEYS_JSON){const keys:unknown=JSON.parse(env.AGENTS_DELEGATION_PUBLIC_KEYS_JSON);if(!kid||!keys||typeof keys!=='object'||Array.isArray(keys))throw unauthorized();const key=(keys as Record<string,unknown>)[kid];if(typeof key!=='string'||!key.trim())throw unauthorized();return key;}
    if(kid!==undefined||!env.AGENTS_DELEGATION_PUBLIC_KEY)throw unauthorized();return env.AGENTS_DELEGATION_PUBLIC_KEY;
  }catch{throw unauthorized();}
}
/** Shared Redis SET NX PX is mandatory. No process-local replay fallback. */
export async function claimDelegationReplay(core:CoreContext,issuer:string,jti:string):Promise<boolean> {
  const url=core.config.env.REDIS_URL;if(!url)throw unauthorized();
  const client=createClient({url,socket:{connectTimeout:5000,reconnectStrategy:false}});
  client.on('error',()=>{});
  try {await client.connect();const result=await Promise.race([client.set(`agents:delegation:${issuer.trim()}:${jti}`,'1',{NX:true,PX:125000}),new Promise<never>((_,reject)=>{const timer=setTimeout(()=>reject(unauthorized()),5000);timer.unref();})]);return result==='OK';}
  catch{throw unauthorized();}finally{if(client.isOpen)client.destroy();}
}
export async function resolveDelegation(request:FastifyRequest,core:CoreContext,replay:ReplayGuard=(iss,jti)=>claimDelegationReplay(core,iss,jti)):Promise<RequestContext> {
  const token=bearerToken(request);if(!token)throw unauthorized();
  const keyPem=selectDelegationPublicKey(core,token);
  const issuer=core.config.env.AGENTS_DELEGATION_ISSUER??'kasitek-agents';
  const audience=core.config.env.AGENTS_DELEGATION_AUDIENCE??'kasitek-core-internal';
  let c:DelegationClaims;let sub:string;let jti:string;
  try {
    if(token.length>1_000_000)throw unauthorized();
    const key=await importSPKI(keyPem,'ES256');
    const {payload}=await jwtVerify(token,key,{algorithms:['ES256'],issuer,audience,requiredClaims:['sub','jti'],clockTolerance:900});
    for(const field of ['iat','exp','nbf'] as const)if(payload[field]!==undefined&&(!Number.isSafeInteger(payload[field])||(payload[field] as number)<0))throw unauthorized();
    if(payload.iat!==undefined&&(typeof payload.iat!=='number'||Math.floor(Date.now()/1000)-payload.iat>120||payload.iat>Math.floor(Date.now()/1000)+900))throw unauthorized();
    for(const name of ['organizationId','installationId','capability','capabilityVersion','runId','invocationId','correlationId'] as const){if(typeof payload[name]!=='string'||!payload[name].trim())throw unauthorized();}
    if(typeof payload.sub!=='string'||payload.sub!==payload.installationId||typeof payload.jti!=='string'||!payload.jti.trim()||Buffer.byteLength(payload.jti)>255)throw unauthorized();
    for(const field of ['actorId','idempotencyKey','argumentsHash'] as const)if(payload[field]!=null&&typeof payload[field]!=='string')throw unauthorized();
    c=payload as unknown as DelegationClaims;sub=payload.sub;jti=payload.jti;
  }catch{throw unauthorized();}
  if(!await replay(issuer,jti))throw unauthorized();
  return {principal:{kind:'agent_installation',id:sub,subjectUserId:c.actorId??null,clientId:sub},organizationId:c.organizationId,userId:c.actorId??null,clientId:null,installationId:c.installationId,effectiveGrants:new Set([c.capability]),apiScopes:null,correlationId:c.correlationId,causationId:c.invocationId,idempotencyKey:c.idempotencyKey??null};
}
function equalSecret(a:string,b:string):boolean{const left=Buffer.from(a),right=Buffer.from(b);return left.length===right.length&&timingSafeEqual(left,right);}
export async function resolveInternalAgentContext(request:FastifyRequest,core:CoreContext,requiredCapability:string,replay?:ReplayGuard):Promise<RequestContext> {
  const env=core.config.env;
  if(env.AGENTS_DELEGATION_PUBLIC_KEY||env.AGENTS_DELEGATION_PUBLIC_KEYS_JSON){const context=await resolveDelegation(request,core,replay);if(!hasGrant(context,requiredCapability))throw new ApiError(403,'forbidden',`Missing delegated capability: ${requiredCapability}`);return context;}
  if(core.config.environment.toLowerCase()==='production')throw unauthorized();
  const expected=env.KASITEK_AGENTS_INTERNAL_TOKEN?.trim(),provided=bearerToken(request);
  if(!expected||!provided||!equalSecret(expected,provided))throw unauthorized();
  const org=request.headers['x-organization-id'];if(typeof org!=='string'||!org.trim())throw new ApiError(400,'bad_request','x-organization-id is required');
  const actor=typeof request.headers['x-actor-id']==='string'?request.headers['x-actor-id'].trim():'kasitek-agent-platform';
  const installation=typeof request.headers['x-installation-id']==='string'?request.headers['x-installation-id'].trim()||null:null;
  const idempotency=typeof request.headers['idempotency-key']==='string'?request.headers['idempotency-key'].trim()||null:null;
  return {principal:{kind:'trusted_internal_service',id:actor,subjectUserId:null,clientId:null},organizationId:org.trim(),userId:null,clientId:null,installationId:installation,effectiveGrants:new Set([requiredCapability]),apiScopes:null,correlationId:null,causationId:null,idempotencyKey:idempotency};
}
export async function requireInternalAgent(request:FastifyRequest,core:CoreContext,capability:string,replay?:ReplayGuard):Promise<{organizationId:string;actorId:string}> {
  const context=await resolveInternalAgentContext(request,core,capability,replay);return {organizationId:context.organizationId,actorId:context.principal.id||'kasitek-agent-platform'};
}
export function resolveCreditIdempotencyKey(context:RequestContext,requested:string|undefined):string {
  const key=requested?.trim()||null;
  if(context.idempotencyKey){if(key&&key!==context.idempotencyKey)throw new ApiError(409,'conflict','Request idempotency key does not match the signed delegation');return context.idempotencyKey;}
  if(!key)throw new ApiError(400,'bad_request','idempotency-key is required');return key;
}
export interface InternalAuthClaims {organizationId:string;actorId:string;correlationId:string;audience:string;expiresAt:number;scopes:string[];operator?:boolean}
/** Current Agents wire protocol is payload.HMAC, not a JWT. */
export function signInternalAuth(secret:string,claims:InternalAuthClaims):string {
  const payload=Buffer.from(JSON.stringify(claims)).toString('base64url');const signature=createHmac('sha256',secret).update(payload).digest('base64url');return `${payload}.${signature}`;
}
