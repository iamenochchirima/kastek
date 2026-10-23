import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';
import * as oidc from 'openid-client';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { OperationsActor } from '@kasitek-labs/contracts';

export const SESSION_COOKIE = 'labs_admin_session';
const TRANSACTION_COOKIE = 'labs_admin_login';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const validToken = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const cookies = (request: FastifyRequest): Record<string,string> => Object.fromEntries((request.headers.cookie ?? '').split(';').map(item => item.trim().split('=')).filter(pair => pair.length === 2));
export function encryptRefresh(value: string, key: Buffer): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function decryptRefresh(value: string, key: Buffer): string {
  const bytes = Buffer.from(value, 'base64url');
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0,12));
  decipher.setAuthTag(bytes.subarray(12,28));
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8');
}
function safeUrl(raw: string, production: boolean): URL {
  const value = new URL(raw);
  if (value.username || value.password || value.search || value.hash || (value.protocol !== 'https:' && !(value.protocol === 'http:' && !production && ['localhost','127.0.0.1','[::1]'].includes(value.hostname)))) throw new Error('Operations identity URLs require HTTPS or local development loopback');
  return value;
}
export function operationsIdentityConfig(environment: Record<string,string|undefined>) {
  const issuer = environment.OPS_OIDC_ISSUER, secret = environment.OPS_OIDC_CLIENT_SECRET;
  if (!issuer || !secret) return null;
  const production = !['development','test','local'].includes(environment.ENVIRONMENT ?? environment.NODE_ENV ?? 'development');
  const origin = safeUrl(environment.OPS_PUBLIC_URL ?? 'http://localhost:3001', production).origin;
  const callback = safeUrl(environment.OPS_OIDC_REDIRECT_URI ?? `${origin}/api/operations-auth/callback`,production).href;
  if (new URL(callback).origin !== origin) throw new Error('Operations callback must use admin origin');
  const keyText = environment.OPS_SESSION_ENCRYPTION_KEY ?? '';
  if (!/^[a-fA-F0-9]{64}$/.test(keyText)) throw new Error('OPS_SESSION_ENCRYPTION_KEY must be 32 random bytes encoded as hex');
  return { issuer:safeUrl(issuer,production).href.replace(/\/$/,''), secret, clientId:environment.OPS_OIDC_CLIENT_ID ?? 'labs-admin', origin, callback, key:Buffer.from(keyText,'hex'), secure:new URL(origin).protocol === 'https:' };
}

export async function registerOperationsAuth(app: FastifyInstance, pool: Pool, environment: Record<string,string|undefined>) {
  const config = operationsIdentityConfig(environment);
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) app.addContentTypeParser('application/x-www-form-urlencoded',{parseAs:'string'},(_request,body,done)=>done(null,body));
  app.addHook('onRequest',async(request,reply)=>{if(request.url.startsWith('/auth/'))reply.header('cache-control','no-store');});
  let discovery: Promise<oidc.Configuration> | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  async function provider() {
    if (!config) throw new Error('Operations identity is not configured');
    discovery ??= oidc.discovery(new URL(config.issuer), config.clientId, config.secret, undefined,
      new URL(config.issuer).protocol === 'http:' ? {execute:[oidc.allowInsecureRequests],timeout:5} : {timeout:5})
      .then(value => {value.timeout=5; oidc.enableNonRepudiationChecks(value); return value;}).catch(error => {discovery=undefined; throw error;});
    return discovery;
  }
  const cookie = (name:string,value:string,maxAge:number) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${config?.secure ? '; Secure' : ''}`;
  async function audit(action:string,status:string,actorId:string|null,code:string) {
    await pool.query(`INSERT INTO ops_audit(id,environment,actor_id,action,status,resource_type,resource_id,code) VALUES($1,$2,$3,$4,$5,'admin_session','identity',$6)`,[randomUUID(),environment.ENVIRONMENT??environment.NODE_ENV??'development',actorId,action,status,code]);
  }
  const sameOrigin = (request:FastifyRequest) => !!config && request.headers.origin === config.origin;
  async function authenticate(request:FastifyRequest): Promise<OperationsActor|null> {
    const sessionToken = cookies(request)[SESSION_COOKIE];
    if (!config || !validToken(sessionToken)) return null;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`SELECT s.*,p.role,p.name,p.email,p.active,p.revision,p.issuer,p.subject
        FROM operations.admin_sessions s JOIN operations.admin_principals p USING(admin_id)
        WHERE s.token_hash=$1 FOR UPDATE OF s`,[hash(sessionToken)]);
      const row = result.rows[0];
      if (!row || row.revoked_at || !row.active || row.issuer !== config.issuer || row.revision !== row.principal_revision || new Date(row.expires_at).getTime() <= Date.now() || new Date(row.last_seen_at).getTime() <= Date.now()-30*60_000) {
        if (row) await client.query('UPDATE operations.admin_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE token_hash=$1',[hash(sessionToken)]);
        await client.query('COMMIT'); return null;
      }
      if (new Date(row.refresh_after).getTime() <= Date.now()) {
        try {
          const refreshed = await oidc.refreshTokenGrant(await provider(),decryptRefresh(row.refresh_token,config.key));
          const claims = refreshed.claims();
          if (claims && claims.sub !== row.subject) throw new Error('Identity changed');
          if (!refreshed.access_token || (typeof refreshed.expires_in === 'number' && refreshed.expires_in <= 0)) throw new Error('Expired provider response');
          const next = refreshed.refresh_token ?? decryptRefresh(row.refresh_token,config.key);
          await client.query("UPDATE operations.admin_sessions SET refresh_token=$2,refresh_after=now()+($3 * interval '1 second') WHERE token_hash=$1",[hash(sessionToken),encryptRefresh(next,config.key),Math.min(60,refreshed.expires_in ?? 60)]);
        } catch {
          await client.query('UPDATE operations.admin_sessions SET revoked_at=now() WHERE token_hash=$1',[hash(sessionToken)]);
          await client.query('COMMIT'); return null;
        }
      }
      await client.query('UPDATE operations.admin_sessions SET last_seen_at=now() WHERE token_hash=$1',[hash(sessionToken)]);
      await client.query('COMMIT');
      return {id:row.admin_id,role:row.role,name:row.name,email:row.email};
    } catch(error) {await client.query('ROLLBACK'); throw error;} finally {client.release();}
  }
  app.get('/auth/login',async (_request,reply) => {
    if (!config) return reply.code(503).send({error:'identity_not_configured'});
    try {
      const configuration = await provider(), loginToken=token(), state=oidc.randomState(), nonce=oidc.randomNonce(), verifier=oidc.randomPKCECodeVerifier();
      await pool.query('DELETE FROM operations.login_transactions WHERE expires_at<=now()');
      await pool.query('INSERT INTO operations.login_transactions(token_hash,state,nonce,verifier) VALUES($1,$2,$3,$4)',[hash(loginToken),state,nonce,verifier]);
      const url=oidc.buildAuthorizationUrl(configuration,{redirect_uri:config.callback,scope:'openid profile email',state,nonce,code_challenge:await oidc.calculatePKCECodeChallenge(verifier),code_challenge_method:'S256',max_age:'28800'});
      return reply.header('set-cookie',cookie(TRANSACTION_COOKIE,loginToken,600)).redirect(url.href);
    } catch {return reply.code(503).send({error:'identity_unavailable'});}
  });
  app.get('/auth/callback',async (request,reply) => {
    reply.header('set-cookie',cookie(TRANSACTION_COOKIE,'',0));
    if (!config) return reply.code(503).send({error:'identity_not_configured'});
    const loginToken=cookies(request)[TRANSACTION_COOKIE];
    if (!validToken(loginToken)) return reply.code(400).send({error:'login_expired'});
    const result=await pool.query('DELETE FROM operations.login_transactions WHERE token_hash=$1 AND expires_at>now() RETURNING *',[hash(loginToken)]), transaction=result.rows[0];
    if (!transaction) return reply.code(400).send({error:'login_expired'});
    try {
      const query=request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
      const tokens=await oidc.authorizationCodeGrant(await provider(),new URL(config.callback+query),{pkceCodeVerifier:transaction.verifier,expectedState:transaction.state,expectedNonce:transaction.nonce,idTokenExpected:true,maxAge:28_800});
      const claims=tokens.claims();
      if (!claims?.sub || typeof claims.auth_time !== 'number' || !tokens.refresh_token || !tokens.access_token) return reply.code(401).send({error:'identity_invalid'});
      const principal=await pool.query('SELECT * FROM operations.admin_principals WHERE issuer=$1 AND subject=$2 AND active=true',[config.issuer,claims.sub]);
      const actor=principal.rows[0];
      if (!actor) {await audit('auth.login','denied',null,'admin_grant_required');return reply.code(403).send({error:'admin_grant_required'});}
      const sessionToken=token(), expiresAt=new Date(Math.min(Date.now()+8*3600_000,claims.auth_time*1000+8*3600_000));
      if (expiresAt.getTime()<=Date.now()) return reply.code(401).send({error:'fresh_login_required'});
      await pool.query(`INSERT INTO operations.admin_sessions(token_hash,admin_id,principal_revision,provider_sid,refresh_token,expires_at,refresh_after)
        VALUES($1,$2,$3,$4,$5,$6,now()+($7 * interval '1 second'))`,[hash(sessionToken),actor.admin_id,actor.revision,typeof claims.sid==='string' ? claims.sid : null,encryptRefresh(tokens.refresh_token,config.key),expiresAt,Math.min(60,tokens.expires_in ?? 60)]);
      await audit('auth.login','completed',actor.admin_id,'explicit_principal');
      return reply.header('set-cookie',[cookie(TRANSACTION_COOKIE,'',0),cookie(SESSION_COOKIE,sessionToken,Math.floor((expiresAt.getTime()-Date.now())/1000))]).redirect(`${config.origin}/operations`);
    } catch(error) {
      const failure=error as {code?:unknown;cause?:{code?:unknown;claim?:unknown}};
      const rawCode=failure.code??failure.cause?.code,rawClaim=failure.cause?.claim;
      const code=typeof rawCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(rawCode)?rawCode:'login_failed';
      const knownClaims=['iss','aud','sub','nonce','auth_time','exp','iat','azp'];
      const messages=[error,(error as {cause?:unknown}).cause].map(value=>value instanceof Error?value.message:'');
      const claim=typeof rawClaim==='string'&&knownClaims.includes(rawClaim)?rawClaim:knownClaims.find(value=>messages.some(message=>message.includes(`"${value}"`)));
      app.log.warn({event:'operations_oidc_login_failed',code,...(claim?{claim}:{})});
      await audit('auth.login','denied',null,code);return reply.code(401).send({error:'login_failed'});
    }
  });
  app.get('/auth/session',async (request,reply) => {reply.header('cache-control','no-store'); const actor=await authenticate(request); return actor ? {admin:actor} : reply.code(401).send({error:'unauthorized'});});
  app.post('/auth/logout',async (request,reply) => {
    if (!sameOrigin(request)) return reply.code(403).send({error:'origin_required'});
    const sessionToken=cookies(request)[SESSION_COOKIE];
    if (validToken(sessionToken)) {
      const revoked=await pool.query('UPDATE operations.admin_sessions SET revoked_at=now() WHERE token_hash=$1 AND revoked_at IS NULL RETURNING admin_id',[hash(sessionToken)]);
      if(revoked.rows[0])await audit('auth.logout','completed',revoked.rows[0].admin_id,'local_revocation');
    }
    reply.header('set-cookie',cookie(SESSION_COOKIE,'',0));
    let redirectTo=`${config!.origin}/login`;
    try {redirectTo=oidc.buildEndSessionUrl(await provider(),{client_id:config!.clientId,post_logout_redirect_uri:redirectTo}).href;} catch { /* Local revocation remains effective during provider outages. */ }
    return {ok:true,redirectTo};
  });
  app.post('/auth/backchannel-logout',async (request,reply) => {
    if (!config) return reply.code(503).send({error:'identity_not_configured'});
    try {
      const body=typeof request.body==='string' ? new URLSearchParams(request.body).get('logout_token') : (request.body as {logout_token?:string}|null)?.logout_token;
      if (!body || body.length>20_000) throw new Error('Invalid logout');
      const uri=(await provider()).serverMetadata().jwks_uri;
      if (!uri) throw new Error('Missing keys');
      jwks ??= createRemoteJWKSet(new URL(uri),{timeoutDuration:5000});
      const {payload}=await jwtVerify(body,jwks,{issuer:config.issuer,audience:config.clientId,algorithms:['RS256'],maxTokenAge:'2 minutes',clockTolerance:5});
      const event=(payload.events as Record<string,unknown>|undefined)?.['http://schemas.openid.net/event/backchannel-logout'];
      if (!event || typeof event!=='object' || Array.isArray(event) || payload.nonce!==undefined || typeof payload.jti!=='string' || payload.jti.length>256 || (typeof payload.sub!=='string' && typeof payload.sid!=='string')) throw new Error('Invalid logout');
      const client=await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('DELETE FROM operations.logout_tokens WHERE expires_at<=now()');
        const used=await client.query("INSERT INTO operations.logout_tokens(jti,expires_at) VALUES($1,now()+interval '5 minutes') ON CONFLICT DO NOTHING RETURNING jti",[payload.jti]);
        if (used.rowCount) await client.query(`UPDATE operations.admin_sessions s SET revoked_at=now() FROM operations.admin_principals p WHERE s.admin_id=p.admin_id AND p.issuer=$1 AND ($2::text IS NULL OR p.subject=$2) AND ($3::text IS NULL OR s.provider_sid=$3)`,[config.issuer,typeof payload.sub==='string'?payload.sub:null,typeof payload.sid==='string'?payload.sid:null]);
        await client.query('COMMIT');
      } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
      return reply.code(200).send({ok:true});
    } catch {return reply.code(400).send({error:'invalid_logout'});}
  });
  return {authenticate};
}
