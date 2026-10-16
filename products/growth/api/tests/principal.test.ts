import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { generateKeyPair, exportSPKI, SignJWT } from 'jose';
import { hash } from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../src/context.js';
import { publicApiPolicy,toDirectActor,directUser,type Principal } from '../src/identity/principal.js';
import { optionalHeader,resolvePublicCredentialContext,verifyInstallationToken,requirePublicAction,type RequestContext } from '../src/identity/request-context.js';
import { resolveDelegation,resolveInternalAgentContext,selectDelegationPublicKey,signInternalAuth,resolveCreditIdempotencyKey } from '../src/identity/internal-delegation.js';
import { grantsForRole,canViewCustomerContent,canExecuteOperatorCommand,canManageSupportAccess,canUseEmergencyAccess,authenticateAdmin,resolveAdminContext } from '../src/identity/admin-session.js';
const core=(env:Record<string,string>={},environment='test'):CoreContext=>({config:{env,environment},pool:{}} as CoreContext);
const request=(authorization?:string):FastifyRequest=>({headers:{authorization},cookies:{},url:'/v1/customers',method:'GET'} as FastifyRequest);
const installationContext:RequestContext={principal:{kind:'agent_installation',id:'i',subjectUserId:null,clientId:'c'},organizationId:'o',userId:null,clientId:null,installationId:'i',effectiveGrants:new Set(),apiScopes:null,correlationId:null,causationId:null,idempotencyKey:null};
test('principal matrix keeps platform/admin and unimplemented OAuth credentials out of public/direct actions',()=>{
  assert.equal(toDirectActor(directUser('u')).kind,'direct_user');
  for(const kind of ['platform_admin','oauth_user','oauth_application'] as const){const p:Principal={kind,id:'x',clientId:null,subjectUserId:null};assert.throws(()=>publicApiPolicy(p));assert.throws(()=>toDirectActor(p));}
  assert.throws(()=>publicApiPolicy({kind:'service_account',id:'x',clientId:null,subjectUserId:null}));
  assert.equal(publicApiPolicy(installationContext.principal).requiresInstallationCapabilities,true);
  assert.equal(optionalHeader({headers:{'x-correlation-id':'a'.repeat(257)}},'x-correlation-id'),null);
});
test('installation JWT requires real signature, issuer, audience, subject and credential claims; no session fallback',async()=>{
  const keys=await generateKeyPair('ES256');const publicKey=await exportSPKI(keys.publicKey);
  const now=Math.floor(Date.now()/1000);
  const claims={iss:'agents',aud:'kasitek-public-api',sub:'i',jti:'once',iat:now,exp:now+60,organizationId:'o',credentialId:'c'};
  const token=await new SignJWT(claims).setProtectedHeader({alg:'ES256'}).sign(keys.privateKey);
  assert.deepEqual(await verifyInstallationToken(publicKey,'agents',token),{installationId:'i',organizationId:'o',credentialId:'c'});
  await assert.rejects(verifyInstallationToken(publicKey,'other',token));
  await assert.rejects(verifyInstallationToken(publicKey,'agents',token+'x'));
  const malformed=request('Bearer bad.jwt.signature');malformed.cookies.kasitek_session='valid-cookie';
  let databaseCalled=false;const context=core();context.pool={query:async()=>{databaseCalled=true;throw Error('unexpected DB');}} as unknown as CoreContext['pool'];
  await assert.rejects(resolvePublicCredentialContext(malformed,context));assert.equal(databaseCalled,false);
});
test('delegation key rotation, replay, narrow grants and production static-bearer refusal',async()=>{
  const keys=await generateKeyPair('ES256');const publicKey=await exportSPKI(keys.publicKey);const now=Math.floor(Date.now()/1000);
  const payload={iss:'agents',aud:'core',sub:'i',jti:'once',iat:now,exp:now+60,organizationId:'o',installationId:'i',capability:'customer_get',capabilityVersion:'1',runId:'r',invocationId:'call',correlationId:'trace',idempotencyKey:'signed'};
  const token=await new SignJWT(payload).setProtectedHeader({alg:'ES256',kid:'current'}).sign(keys.privateKey);
  const config=core({AGENTS_DELEGATION_PUBLIC_KEYS_JSON:JSON.stringify({current:publicKey}),AGENTS_DELEGATION_ISSUER:'agents',AGENTS_DELEGATION_AUDIENCE:'core'});
  assert.equal(selectDelegationPublicKey(config,token),publicKey);
  const used=new Set<string>();const replay=async(_issuer:string,jti:string)=>{if(used.has(jti))return false;used.add(jti);return true;};
  const context=await resolveDelegation(request('Bearer '+token),config,replay);assert.equal(context.organizationId,'o');assert.deepEqual([...context.effectiveGrants],['customer_get']);
  assert.equal(resolveCreditIdempotencyKey(context,'signed'),'signed');assert.throws(()=>resolveCreditIdempotencyKey(context,'other'));
  await assert.rejects(resolveDelegation(request('Bearer '+token),config,replay));
  await assert.rejects(resolveInternalAgentContext(request('Bearer dev'),core({KASITEK_AGENTS_INTERNAL_TOKEN:'dev'},'production'),'customer_get'));
  await assert.rejects(resolveDelegation(request('Bearer '+token),config)); // Missing shared replay store fails closed.
  const old=await new SignJWT({...payload,iat:now-121,exp:now+60}).setProtectedHeader({alg:'ES256',kid:'current'}).sign(keys.privateKey);
  await assert.rejects(resolveDelegation(request('Bearer '+old),config,async()=>true));
  const future=await new SignJWT({...payload,iat:now+890,exp:now+950,nbf:now+890}).setProtectedHeader({alg:'ES256',kid:'current'}).sign(keys.privateKey);
  await resolveDelegation(request('Bearer '+future),config,async()=>true); // Rust jwt-simple default 900-second drift.
  const beyond=await new SignJWT({...payload,iat:now+910,exp:now+950}).setProtectedHeader({alg:'ES256',kid:'current'}).sign(keys.privateKey);
  await assert.rejects(resolveDelegation(request('Bearer '+beyond),config,async()=>true));
  const optionalTimes=await new SignJWT({...payload,iat:undefined,exp:undefined}).setProtectedHeader({alg:'ES256',kid:'current'}).sign(keys.privateKey);
  await resolveDelegation(request('Bearer '+optionalTimes),config,async()=>true); // Rust checks times only when present.

});
test('public capabilities require action visibility, machine scopes and available installation grants',async()=>{
  const definition={name:'customers.list',lifecycle:'public',supportedRuntimes:['direct'],supportedActors:['external_agent' as const],requiredGrants:['customers.read'],risk:'read'};
  await requirePublicAction(installationContext,definition,definition.name,async()=>({apiScopes:['api:read'],capabilities:[{manifest:{requiredScope:'customers.read'}}]}));
  await assert.rejects(requirePublicAction(installationContext,definition,definition.name,async()=>({apiScopes:['api:read'],capabilities:[{availability:'disabled',manifest:{requiredScope:'customers.read'}}]})));
  await assert.rejects(requirePublicAction(installationContext,definition,definition.name,async()=>({apiScopes:[],capabilities:[{manifest:{requiredScope:'customers.read'}}]})));
  await assert.rejects(requirePublicAction(installationContext,{...definition,lifecycle:'internal'},definition.name,async()=>({})));
});
test('admin bcrypt authentication and role separation preserve narrow platform permissions',async()=>{
  const password=await hash('correct password',4);const admin={id:'a',name:'A',email:'a@test',password,role:'support',createdAt:new Date(),updatedAt:new Date()};
  const context=core();context.pool={query:async()=>({rows:[admin]})} as unknown as CoreContext['pool'];
  assert.equal((await authenticateAdmin(context,' A@Test ',' correct password ')).id,'a');await assert.rejects(authenticateAdmin(context,'a@test','wrong'));
  const req=request();req.cookies.kasitek_admin_session='a';const resolved=await resolveAdminContext(req,context);assert.equal(resolved.organizationId,'platform');assert.deepEqual([...resolved.effectiveGrants],['admin:read','admin:support']);
  assert.equal(canViewCustomerContent('support'),true);assert.equal(canExecuteOperatorCommand('support'),false);assert.equal(canManageSupportAccess('support'),false);assert.equal(canUseEmergencyAccess('operator'),false);assert.equal(canUseEmergencyAccess('OWNER'),true);assert.equal(grantsForRole('unknown').size,0);
});
test('Agents internal HMAC wire format signs exact base64url payload',()=>{
  const claims={organizationId:'o',actorId:'u',correlationId:'c',audience:'agents',expiresAt:1000,scopes:['agents:read']};
  const token=signInternalAuth('secret',claims);const [payload,signature]=token.split('.');assert.deepEqual(JSON.parse(Buffer.from(payload!,'base64url').toString()),claims);assert.equal(signature,createHmac('sha256','secret').update(payload!).digest('base64url'));
});
