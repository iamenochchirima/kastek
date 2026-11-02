import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { hash } from 'bcryptjs';
import type { FastifyRequest } from 'fastify';
import type { CoreContext } from '../src/context.js';
import { publicApiPolicy,toDirectActor,directUser,type Principal } from '../src/identity/principal.js';
import { optionalHeader,resolvePublicCredentialContext,requirePublicAction,requireWebhookScope,type RequestContext } from '../src/identity/request-context.js';
import { grantsForRole,canViewCustomerContent,canExecuteOperatorCommand,canManageSupportAccess,canUseEmergencyAccess,authenticateAdmin,resolveAdminContext } from '../src/identity/admin-session.js';
const core=(env:Record<string,string>={},environment='test'):CoreContext=>({config:{env,environment},pool:{}} as CoreContext);
const request=(authorization?:string):FastifyRequest=>({headers:{authorization},cookies:{},url:'/v1/customers',method:'GET'} as FastifyRequest);
test('public principal matrix allows direct users, Developer API keys and delegated OAuth users',()=>{
  assert.equal(toDirectActor(directUser('u')).kind,'direct_user');
  for(const kind of ['platform_admin','oauth_application','service_account','trusted_internal_service'] as const){
    const p:Principal={kind,id:'x',clientId:null,subjectUserId:null};assert.throws(()=>publicApiPolicy(p));
  }
  assert.equal(publicApiPolicy({kind:'workspace_api_key',id:'k',clientId:'k',subjectUserId:'u'}).actorKind,'api_client');
  const oauth:Principal={kind:'oauth_user',id:'connection',clientId:'registered-client',subjectUserId:'user'};
  assert.equal(publicApiPolicy(oauth).actorKind,'external_agent');
  assert.deepEqual(toDirectActor(oauth),{kind:'external_agent',id:'connection',realm:'direct',authenticated_client_id:'registered-client',delegated_by:null});
  assert.equal(optionalHeader({headers:{'x-correlation-id':'a'.repeat(257)}},'x-correlation-id'),null);
});
test('retired installation JWT and malformed bearers never fall back to a product cookie',async()=>{
  const keys=await generateKeyPair('ES256');
  const token=await new SignJWT({organizationId:'o',credentialId:'c'}).setProtectedHeader({alg:'ES256'}).setIssuer('agents').setAudience('kasitek-public-api').setSubject('installation').setJti('once').setIssuedAt().setExpirationTime('1m').sign(keys.privateKey);
  let databaseCalled=false;const context=core();context.pool={query:async()=>{databaseCalled=true;throw Error('unexpected DB');}} as unknown as CoreContext['pool'];
  for(const authorization of ['Bearer '+token,'Bearer bad.jwt.signature','Bearer arbitrary-token','Bearer ','Basic arbitrary-token']){
    const req=request(authorization);req.cookies.kasitek_session='valid-cookie';
    await assert.rejects(resolvePublicCredentialContext(req,context));assert.equal(databaseCalled,false);
  }
});
test('public actions and webhooks retain local Developer API key scopes',async()=>{
  const context:RequestContext={principal:{kind:'workspace_api_key',id:'k',clientId:'k',subjectUserId:'u'},organizationId:'o',userId:'u',clientId:null,effectiveGrants:new Set(),apiScopes:new Set(['api:read']),correlationId:null,causationId:null,idempotencyKey:null};
  const definition={name:'customers.list',lifecycle:'public',supportedRuntimes:['direct'],supportedActors:['api_client'],requiredGrants:[],risk:'read'};
  await requirePublicAction(context,definition,definition.name);await requireWebhookScope(context,false);
  await assert.rejects(requirePublicAction(context,{...definition,risk:'write'},definition.name));
  await assert.rejects(requirePublicAction(context,{...definition,lifecycle:'internal'},definition.name));
  await assert.rejects(requireWebhookScope(context,true));
});
test('delegated OAuth permissions do not inherit generic API write publication authority',async()=>{
  const context:RequestContext={principal:{kind:'oauth_user',id:'connection',clientId:'client',subjectUserId:'user'},organizationId:'org',userId:'user',clientId:'client',effectiveGrants:new Set(),apiScopes:new Set(['growth:read','growth:draft']),correlationId:null,causationId:null,idempotencyKey:null};
  const definition={name:'contacts.list',lifecycle:'public',supportedRuntimes:['direct'],supportedActors:['external_agent' as const],requiredGrants:[],risk:'read'};
  await requirePublicAction(context,definition,definition.name);
  await requirePublicAction(context,{...definition,risk:'draft'},definition.name);
  await assert.rejects(requirePublicAction(context,{...definition,risk:'external_effect'},definition.name));
  context.apiScopes=new Set(['api:write']);await assert.rejects(requirePublicAction(context,{...definition,risk:'external_effect'},definition.name));
  await assert.rejects(requireWebhookScope(context,false));
});
test('admin bcrypt authentication and role separation preserve narrow platform permissions',async()=>{
  const password=await hash('correct password',4);const admin={id:'a',name:'A',email:'a@test',password,role:'support',createdAt:new Date(),updatedAt:new Date()};
  const context=core();context.pool={query:async()=>({rows:[admin]})} as unknown as CoreContext['pool'];
  assert.equal((await authenticateAdmin(context,' A@Test ',' correct password ')).id,'a');await assert.rejects(authenticateAdmin(context,'a@test','wrong'));
  const req=request();req.cookies.kasitek_admin_session='a'.repeat(43);const resolved=await resolveAdminContext(req,context);assert.equal(resolved.organizationId,'platform');assert.deepEqual([...resolved.effectiveGrants],['admin:read','admin:report','admin:support']);
  assert.equal(canViewCustomerContent('support'),true);assert.equal(canExecuteOperatorCommand('support'),false);assert.equal(canManageSupportAccess('support'),false);assert.equal(canUseEmergencyAccess('operator'),false);assert.equal(canUseEmergencyAccess('OWNER'),true);assert.equal(grantsForRole('unknown').size,0);
});
