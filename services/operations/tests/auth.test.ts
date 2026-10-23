import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import Fastify from 'fastify';
import type { Pool } from 'pg';
import { registerOperationsAuth, encryptRefresh, decryptRefresh, operationsIdentityConfig } from '../src/auth.js';

const key = randomBytes(32);
test('refresh-token authenticated encryption detects tampering and wrong keys',()=>{
 const value=encryptRefresh('refresh-secret',key);
 assert.equal(decryptRefresh(value,key),'refresh-secret');
 assert.throws(()=>decryptRefresh(value,randomBytes(32)));
 const bytes=Buffer.from(value,'base64url');bytes[30]=bytes[30]!^1;
 assert.throws(()=>decryptRefresh(bytes.toString('base64url'),key));
 assert(!value.includes('refresh-secret'));
});
test('unsafe identity deployment configuration fails closed',()=>{
 assert.equal(operationsIdentityConfig({}),null);
 const base={OPS_OIDC_ISSUER:'http://localhost:8080/realms/kasitek',OPS_OIDC_CLIENT_SECRET:'test',OPS_SESSION_ENCRYPTION_KEY:key.toString('hex')};
 assert.throws(()=>operationsIdentityConfig({...base,ENVIRONMENT:'production'}));
 assert.throws(()=>operationsIdentityConfig({...base,OPS_PUBLIC_URL:'http://evil.example'}));
 assert.throws(()=>operationsIdentityConfig({...base,OPS_OIDC_REDIRECT_URI:'http://localhost:9000/callback'}));
 assert.throws(()=>operationsIdentityConfig({...base,OPS_SESSION_ENCRYPTION_KEY:'short'}));
});

class Database {
 transactions=new Map<string,any>(); sessions=new Map<string,any>(); principals=new Map<string,any>(); logoutTokens=new Set<string>();
 async query(sql:string,args:any[]=[]):Promise<any>{
  const rows:any[]=[];
  if(sql.includes('INSERT INTO operations.login_transactions'))this.transactions.set(args[0],{state:args[1],nonce:args[2],verifier:args[3]});
  else if(sql.includes('RETURNING *')&&sql.includes('login_transactions')) {const row=this.transactions.get(args[0]);this.transactions.delete(args[0]);if(row)rows.push(row);}
  else if(sql.startsWith('SELECT * FROM operations.admin_principals')) {const row=this.principals.get(args[1]);if(row&&row.issuer===args[0]&&row.active)rows.push(row);}
  else if(sql.includes('INSERT INTO operations.admin_sessions'))this.sessions.set(args[0],{token_hash:args[0],admin_id:args[1],principal_revision:args[2],provider_sid:args[3],refresh_token:args[4],expires_at:args[5],refresh_after:new Date(Date.now()+args[6]*1000),last_seen_at:new Date(),revoked_at:null});
  else if(sql.includes('SELECT s.*,p.role')){const session=this.sessions.get(args[0]);const principal=[...this.principals.values()].find(p=>p.admin_id===session?.admin_id);if(session&&principal)rows.push({...session,...principal});}
  else if(sql.includes('INSERT INTO operations.logout_tokens')){if(!this.logoutTokens.has(args[0])){this.logoutTokens.add(args[0]);rows.push({jti:args[0]});}}
  else if(sql.includes('SET revoked_at=')&&sql.includes('FROM operations.admin_principals')){for(const session of this.sessions.values()){const principal=[...this.principals.values()].find(p=>p.admin_id===session.admin_id);if(principal?.issuer===args[0]&&(!args[1]||principal.subject===args[1])&&(!args[2]||session.provider_sid===args[2]))session.revoked_at=new Date();}}
  else if(sql.includes('SET revoked_at=')){const session=this.sessions.get(args[0]);if(session)session.revoked_at=new Date();}
  else if(sql.includes('SET last_seen_at=')){const session=this.sessions.get(args[0]);if(session)session.last_seen_at=new Date();}
  else if(sql.includes('SET refresh_token=')){const session=this.sessions.get(args[0]);if(session){session.refresh_token=args[1];session.refresh_after=new Date(Date.now()+args[2]*1000);}}
  return {rows,rowCount:rows.length};
 }
 async connect(){return{query:this.query.bind(this),release(){}};}
}
let issuer:string, privateKey:CryptoKey, jwk:any, app:ReturnType<typeof Fastify>, db:Database;
let claimOverride:Record<string,unknown>={}, expectedVerifier='', expectedNonce='', refreshFails=false, tokenCalls=0;
const server=createServer(async(req,res)=>{
 res.setHeader('content-type','application/json');
 if(req.url==='/.well-known/openid-configuration')return res.end(JSON.stringify({issuer,authorization_endpoint:issuer+'/authorize',token_endpoint:issuer+'/token',jwks_uri:issuer+'/jwks',end_session_endpoint:issuer+'/logout',response_types_supported:['code'],subject_types_supported:['public'],id_token_signing_alg_values_supported:['RS256'],token_endpoint_auth_methods_supported:['client_secret_post']}));
 if(req.url==='/jwks')return res.end(JSON.stringify({keys:[jwk]}));
 if(req.url==='/token'){
  const body=[];for await(const chunk of req)body.push(chunk);
  const fields=new URLSearchParams(Buffer.concat(body).toString());tokenCalls++;
  if(fields.get('grant_type')==='refresh_token'){
   if(refreshFails){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_grant'}));}
   return res.end(JSON.stringify({access_token:'new-access',token_type:'Bearer',refresh_token:'rotated-refresh',expires_in:60}));
  }
  if(fields.get('code_verifier')!==expectedVerifier||fields.get('client_secret')!=='fixture-client-secret'){res.statusCode=400;return res.end(JSON.stringify({error:'invalid_grant'}));}
  const jwt=await new SignJWT({sub:'approved-subject',nonce:expectedNonce,auth_time:Math.floor(Date.now()/1000),sid:'provider-session',...claimOverride}).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(typeof claimOverride.iss==='string'?claimOverride.iss:issuer).setAudience(typeof claimOverride.aud==='string'?claimOverride.aud:'labs-admin').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  return res.end(JSON.stringify({access_token:'access',token_type:'Bearer',id_token:jwt,refresh_token:'refresh-secret',expires_in:60}));
 }
 res.statusCode=404;res.end('{}');
});
before(async()=>{
 const keys=await generateKeyPair('RS256');privateKey=keys.privateKey;jwk={...await exportJWK(keys.publicKey),kid:'fixture',alg:'RS256'};
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));issuer=`http://127.0.0.1:${(server.address() as any).port}`;
 db=new Database();db.principals.set('approved-subject',{admin_id:'stable-admin-id',issuer,subject:'approved-subject',role:'operator',name:'Operator',email:'',active:true,revision:1});
 app=Fastify();await registerOperationsAuth(app,db as unknown as Pool,{OPS_OIDC_ISSUER:issuer,OPS_OIDC_CLIENT_SECRET:'fixture-client-secret',OPS_SESSION_ENCRYPTION_KEY:key.toString('hex'),ENVIRONMENT:'test'});await app.ready();
});
after(async()=>{await app?.close();await new Promise<void>(resolve=>server.close(()=>resolve()));});
async function begin(){
 claimOverride={};refreshFails=false;
 const response=await app.inject({url:'/auth/login'});assert.equal(response.statusCode,302,response.body);
 const location=new URL(response.headers.location!);const cookie=String(response.headers['set-cookie']).split(';')[0]!;
 const transaction=[...db.transactions.values()].at(-1);expectedVerifier=transaction.verifier;expectedNonce=transaction.nonce;
 assert.equal(location.searchParams.get('code_challenge_method'),'S256');
 assert.equal(location.searchParams.get('code_challenge'),createHash('sha256').update(expectedVerifier).digest('base64url'));
 return {cookie,state:location.searchParams.get('state')!};
}
async function complete(login:{cookie:string;state:string}){return app.inject({url:'/auth/callback?code=fixture-code&state='+login.state,headers:{cookie:login.cookie}});}
function sessionCookie(response:any){return (response.headers['set-cookie'] as string[]).find(value=>value.startsWith('labs_admin_session='))!.split(';')[0]!;}

test('real signed OIDC exchange validates PKCE and maps subject to explicit stable principal',async()=>{
 const login=await begin(), response=await complete(login);assert.equal(response.statusCode,302,response.body);
 const cookie=sessionCookie(response);assert(!cookie.includes('refresh'));
 const session=await app.inject({url:'/auth/session',headers:{cookie}});assert.equal(session.statusCode,200);assert.equal(session.json().admin.id,'stable-admin-id');
 assert.equal((await complete(login)).statusCode,400,'callback replay rejected');
});
test('state, nonce, issuer, audience, missing principal and PKCE mismatch all fail closed',async()=>{
 for(const fault of ['state','nonce','issuer','audience','principal','pkce']){
  const login=await begin();
  if(fault==='state')login.state='wrong-state';
  if(fault==='nonce')claimOverride={nonce:'wrong-nonce'};
  if(fault==='issuer')claimOverride={iss:'https://other.invalid'};
  if(fault==='audience')claimOverride={aud:'customer-client'};
  if(fault==='principal')claimOverride={sub:'ungranted-customer'};
  if(fault==='pkce')expectedVerifier='invalid';
  const response=await complete(login);assert([401,403].includes(response.statusCode),fault+':'+response.body);assert(!String(response.headers['set-cookie']).includes('labs_admin_session='));
 }
});
test('sessions revoke on role revision, inactivity, absolute deadline, disabled grant, provider refresh failure and logout',async()=>{
 for(const fault of ['revision','idle','absolute','disabled','refresh','logout']){
  const principal=db.principals.get('approved-subject');principal.revision=1;principal.active=true;
  const response=await complete(await begin());assert.equal(response.statusCode,302,response.body);const cookie=sessionCookie(response);
  const row=[...db.sessions.values()].at(-1);
  if(fault==='revision')principal.revision=2;
  if(fault==='idle')row.last_seen_at=new Date(Date.now()-31*60_000);
  if(fault==='absolute')row.expires_at=new Date(Date.now()-1000);
  if(fault==='disabled')principal.active=false;
  if(fault==='refresh'){row.refresh_after=new Date(0);refreshFails=true;}
  if(fault==='logout'){
   assert.equal((await app.inject({method:'POST',url:'/auth/logout',headers:{cookie,origin:'https://other.invalid'}})).statusCode,403);
   assert.equal((await app.inject({method:'POST',url:'/auth/logout',headers:{cookie,origin:'http://localhost:3001'}})).statusCode,200);
  }
  assert.equal((await app.inject({url:'/auth/session',headers:{cookie}})).statusCode,401,fault);
 }
});
test('provider refresh rotates encrypted token under a session lock',async()=>{
 const principal=db.principals.get('approved-subject');principal.revision=1;principal.active=true;
 const response=await complete(await begin());const cookie=sessionCookie(response);const row=[...db.sessions.values()].at(-1);row.refresh_after=new Date(0);
 const beforeCalls=tokenCalls;
 assert.equal((await app.inject({url:'/auth/session',headers:{cookie}})).statusCode,200);
 assert(tokenCalls>beforeCalls);assert.equal(decryptRefresh(row.refresh_token,key),'rotated-refresh');
});

test('signed provider backchannel revokes matching sessions and rejects arbitrary JWTs',async()=>{
 const principal=db.principals.get('approved-subject');principal.revision=1;principal.active=true;
 const response=await complete(await begin());const cookie=sessionCookie(response);
 const signed=async(payload:Record<string,unknown>,audience='labs-admin')=>new SignJWT(payload).setProtectedHeader({alg:'RS256',kid:'fixture'}).setIssuer(issuer).setAudience(audience).setJti(randomBytes(12).toString('hex')).setIssuedAt().sign(privateKey);
 const events={'http://schemas.openid.net/event/backchannel-logout':{}};
 for(const bad of [await signed({sub:'approved-subject',events},'wrong-client'),await signed({sub:'approved-subject',events,nonce:'forbidden'}),await signed({sub:'approved-subject'})]){
  const result=await app.inject({method:'POST',url:'/auth/backchannel-logout',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({logout_token:bad}).toString()});assert.equal(result.statusCode,400);
 }
 const jwt=await signed({sub:'approved-subject',sid:'provider-session',events});
 for(let i=0;i<2;i++)assert.equal((await app.inject({method:'POST',url:'/auth/backchannel-logout',headers:{'content-type':'application/x-www-form-urlencoded'},payload:new URLSearchParams({logout_token:jwt}).toString()})).statusCode,200);
 assert.equal((await app.inject({url:'/auth/session',headers:{cookie}})).statusCode,401);
});
