import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { fetchClientMetadata } from "./oauth-clients";

const hash = (v:string) => createHash("sha256").update(v).digest("hex");
const random = () => randomBytes(32).toString("base64url");
const scopesSchema = z.string().max(100).transform(v => [...new Set(v.split(/\s+/).filter(Boolean))]).refine(v => v.length > 0 && v.every(x => ["agents:read", "agents:manage", "agents:publish", "runs:read", "runs:start", "runs:control", "reviews:decide"].includes(x)));
const bounded = z.string().min(1).max(2048);
const redirect = bounded.refine(v => { try { const u = new URL(v); return !u.username && !u.password && !u.hash && (u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname))); } catch { return false; } });
const fail = (code:string, message:string, status=400):never => { throw new PlatformError(code, status, message); };
async function tx<T>(pool:Pool, fn:(c:PoolClient)=>Promise<T>):Promise<T> { const c = await pool.connect(); try { await c.query("BEGIN"); const out=await fn(c); await c.query("COMMIT"); return out; } catch(e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); } }
async function member(db:Pool | PoolClient, accountId:string, organizationId:string) { const row = await db.query("SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 AND organization_id=$2 AND revoked_at IS NULL",[accountId,organizationId]); if (!row.rowCount) fail("access_denied","Organization access unavailable",403); }
interface Code { hash:string; client_id:string; account_id:string; organization_id:string; redirect_uri:string; resource:string; scopes:string[]; agent_ids:string[]; challenge:string; used_at:Date|null }
interface Connection { id:string; client_id:string; account_id:string; organization_id:string; resource:string; scopes:string[]; revoked_at:Date|null }
const equal = (a:string,b:string) => { const x=Buffer.from(a), y=Buffer.from(b); return x.length===y.length && timingSafeEqual(x,y); };
// Refresh CIMD redirect data within ten minutes while avoiding a fetch on every authorization.
const CLIENT_METADATA_TTL = "10 minutes";
const AUTHORIZE_IP_LIMIT = 300;
const AUTHORIZE_CLIENT_LIMIT = 30;

/** Keep public authorization work and the temporary OAuth tables bounded in the database. */
async function consumeAgentsOAuthAuthorizeBucket(pool:Pool,bucketKey:string,limit:number,pruneExpiredOAuthRows=false):Promise<boolean> {
 return tx(pool,async db=>{
  const row=(await db.query<{request_count:number}>(`INSERT INTO agents_platform.mcp_oauth_authorize_limits(bucket_key,window_started_at,request_count)
   VALUES($1,date_trunc('minute',now()),1) ON CONFLICT(bucket_key) DO UPDATE SET
   request_count=CASE WHEN agents_platform.mcp_oauth_authorize_limits.window_started_at=excluded.window_started_at
     THEN agents_platform.mcp_oauth_authorize_limits.request_count+1 ELSE 1 END,
   window_started_at=excluded.window_started_at RETURNING request_count`,[bucketKey])).rows[0]!;
  const allowed=Number(row.request_count)<=limit;
  await db.query(`WITH expired AS (
   SELECT ctid FROM agents_platform.mcp_oauth_authorize_limits WHERE window_started_at < now()-interval '1 hour'
   ORDER BY window_started_at LIMIT 500 FOR UPDATE SKIP LOCKED
  ) DELETE FROM agents_platform.mcp_oauth_authorize_limits target USING expired WHERE target.ctid=expired.ctid`);
  if(allowed&&pruneExpiredOAuthRows){
   await db.query(`WITH expired AS (
    SELECT ctid FROM agents_platform.mcp_oauth_requests WHERE expires_at<=now()
    ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
   ) DELETE FROM agents_platform.mcp_oauth_requests target USING expired WHERE target.ctid=expired.ctid`);
   await db.query(`WITH expired AS (
    SELECT ctid FROM agents_platform.mcp_oauth_codes WHERE expires_at<=now()
    ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
   ) DELETE FROM agents_platform.mcp_oauth_codes target USING expired WHERE target.ctid=expired.ctid`);
   // Keep a used refresh token through the latest access-token expiry so replay still revokes its connection.
   await db.query(`WITH expired AS (
    SELECT ctid FROM agents_platform.mcp_oauth_refresh WHERE expires_at<=now()-interval '1 hour'
    ORDER BY expires_at LIMIT 500 FOR UPDATE SKIP LOCKED
   ) DELETE FROM agents_platform.mcp_oauth_refresh target USING expired WHERE target.ctid=expired.ctid`);
  }
  return allowed;
 });
}

/** Serialize all client admission so public URL metadata cannot bypass registration limits. */
export async function storeAgentsClientMetadata(pool:Pool, metadata:{id:string;name:string;redirectUris:string[]}, ip:string):Promise<void> {
 await tx(pool,async db=>{
  await db.query("SELECT pg_advisory_xact_lock(71825191)");
  const existing=await db.query("SELECT 1 FROM agents_platform.mcp_oauth_clients WHERE id=$1",[metadata.id]);
  if(!existing.rowCount){
   const count=(await db.query<{total:number;recent:number}>("SELECT count(*)::int total,count(*) FILTER (WHERE registration_hash=$1 AND created_at>now()-interval '1 hour')::int recent FROM agents_platform.mcp_oauth_clients",[hash(ip)])).rows[0]!;
   if(count.total>=10000||count.recent>=30) fail("temporarily_unavailable","Client registration limit reached",429);
  }
  await db.query(`INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash,metadata_refreshed_at) VALUES($1,$2,$3,$4,now())
   ON CONFLICT(id) DO UPDATE SET name=excluded.name,redirect_uris=excluded.redirect_uris,metadata_refreshed_at=now()`,[metadata.id,metadata.name,metadata.redirectUris,hash(ip)]);
 });
}

export async function resolveAgentsOAuthToken(pool:Pool, raw:string, resource:string) {
 if (!/^agents_oauth_[A-Za-z0-9_-]{43}$/.test(raw)) return null;
 const row=(await pool.query<Connection>(`SELECT id,client_id,account_id,organization_id,resource,scopes,revoked_at FROM agents_platform.mcp_oauth_connections WHERE access_hash=$1 AND revoked_at IS NULL AND access_expires_at>now()`,[hash(raw)])).rows[0];
 if (!row || row.resource!==resource) return null;
 await member(pool,row.account_id,row.organization_id);
 await pool.query("UPDATE agents_platform.mcp_oauth_connections SET last_used_at=now() WHERE id=$1 AND revoked_at IS NULL",[row.id]);
 return {accountId:row.account_id,organizationId:row.organization_id,connectionId:row.id,scopes:row.scopes};
}

export function registerAgentsOAuth(app:FastifyInstance, options:{pool:Pool; publicUrl:string; account:(r:FastifyRequest)=>Promise<{id:string}>; fetchClientMetadata?:typeof fetchClientMetadata}) {
 const {pool,account}=options; const issuer=new URL(options.publicUrl).origin; const resource=new URL("/mcp",issuer).toString(); const fetchMetadata=options.fetchClientMetadata??fetchClientMetadata;
 const protocol=(fn:(r:FastifyRequest,reply:import("fastify").FastifyReply)=>Promise<unknown>)=>async(r:FastifyRequest,reply:import("fastify").FastifyReply)=>{ reply.header("Cache-Control","no-store").header("Pragma","no-cache"); try { return await fn(r,reply); } catch(e) { if(e instanceof PlatformError) return reply.code(e.statusCode).send({error:e.code,error_description:e.message}); if(e instanceof z.ZodError) return reply.code(400).send({error:"invalid_request",error_description:"Invalid request"}); throw e; } };
 app.get("/.well-known/oauth-authorization-server",async()=>({issuer,authorization_endpoint:`${issuer}/oauth/authorize`,token_endpoint:`${issuer}/oauth/token`,registration_endpoint:`${issuer}/oauth/register`,revocation_endpoint:`${issuer}/oauth/revoke`,response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],token_endpoint_auth_methods_supported:["none"],revocation_endpoint_auth_methods_supported:["none"],code_challenge_methods_supported:["S256"],scopes_supported:["agents:read","agents:manage","agents:publish","runs:read","runs:start","runs:control","reviews:decide"],authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:true}));
 app.post("/oauth/register",{bodyLimit:16384},protocol(async (r,reply)=>{
  const input=z.object({client_name:z.string().trim().min(1).max(100).default("MCP client"),redirect_uris:z.array(redirect).min(1).max(10),token_endpoint_auth_method:z.literal("none").optional(),grant_types:z.array(z.enum(["authorization_code","refresh_token"])).optional(),response_types:z.array(z.literal("code")).optional()}).parse(r.body);
  const id=`agents_client_${random()}`; await tx(pool,async db=>{await db.query("SELECT pg_advisory_xact_lock(71825191)");const count=(await db.query<{total:number;recent:number}>("SELECT count(*)::int total,count(*) FILTER (WHERE registration_hash=$1 AND created_at>now()-interval '1 hour')::int recent FROM agents_platform.mcp_oauth_clients",[hash(r.ip)])).rows[0]!;if(count.total>=10000||count.recent>=30) fail("temporarily_unavailable","Client registration limit reached",429);await db.query("INSERT INTO agents_platform.mcp_oauth_clients(id,name,redirect_uris,registration_hash) VALUES($1,$2,$3,$4)",[id,input.client_name,[...new Set(input.redirect_uris)],hash(r.ip)]);});
  reply.code(201); return {client_id:id,client_name:input.client_name,redirect_uris:input.redirect_uris,token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]};
 }));
 app.get("/oauth/authorize",protocol(async (r,reply)=>{
  const i=z.object({response_type:z.literal("code"),client_id:bounded,redirect_uri:redirect,resource:bounded,scope:scopesSchema.default(["agents:read"]),state:z.string().max(2048).default(""),code_challenge:z.string().regex(/^[A-Za-z0-9_-]{43}$/),code_challenge_method:z.literal("S256")}).parse(r.query);
  if(i.resource!==resource) fail("invalid_target","Unknown resource");
  // Agents runs Fastify without trustProxy, so request.ip is the socket peer rather than caller-supplied X-Forwarded-For.
  if(!await consumeAgentsOAuthAuthorizeBucket(pool,`ip:${hash(r.ip)}`,AUTHORIZE_IP_LIMIT,true))fail("temporarily_unavailable","Authorization request limit reached",429);
  let client=(await pool.query<{redirect_uris:string[];metadata_fresh:boolean}>(`SELECT redirect_uris,metadata_refreshed_at>now()-interval '${CLIENT_METADATA_TTL}' AS metadata_fresh
   FROM agents_platform.mcp_oauth_clients WHERE id=$1`,[i.client_id])).rows[0];
  const persistedClient=Boolean(client);
  if(client&&!await consumeAgentsOAuthAuthorizeBucket(pool,`client:${hash(i.client_id)}`,AUTHORIZE_CLIENT_LIMIT))fail("temporarily_unavailable","Authorization request limit reached",429);
  if(i.client_id.startsWith("https://")&&(!client||!client.metadata_fresh)){
   const metadata=await fetchMetadata(i.client_id);await storeAgentsClientMetadata(pool,metadata,r.ip);client={redirect_uris:metadata.redirectUris,metadata_fresh:true};
   if(!persistedClient&&!await consumeAgentsOAuthAuthorizeBucket(pool,`client:${hash(i.client_id)}`,AUTHORIZE_CLIENT_LIMIT))fail("temporarily_unavailable","Authorization request limit reached",429);
  }
  if(!client||!client.redirect_uris.includes(i.redirect_uri)) fail("invalid_client","Unknown client or redirect");
  const nonce=random();await pool.query("INSERT INTO agents_platform.mcp_oauth_requests(hash,client_id,redirect_uri,resource,scopes,state,challenge,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,now()+interval '10 minutes')",[hash(nonce),i.client_id,i.redirect_uri,resource,i.scope,i.state,i.code_challenge]);
  return reply.redirect(`${issuer}/app/oauth/consent?request=${nonce}`);
 }));
 app.get("/api/mcp/oauth/requests/:id",async r=>{
  const user=await account(r), id=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(r.params).id;
  const row=await tx(pool,async db=>{const found=(await db.query<{client_id:string;name:string;redirect_uri:string;scopes:string[];account_id:string|null}>(`SELECT q.client_id,c.name,q.redirect_uri,q.scopes,q.account_id FROM agents_platform.mcp_oauth_requests q JOIN agents_platform.mcp_oauth_clients c ON c.id=q.client_id WHERE q.hash=$1 AND q.expires_at>now() AND q.used_at IS NULL FOR UPDATE OF q`,[hash(id)])).rows[0];if(!found||(found.account_id&&found.account_id!==user.id))return fail("NOT_FOUND","Connection request unavailable",404);await db.query("UPDATE agents_platform.mcp_oauth_requests SET account_id=$2 WHERE hash=$1",[hash(id),user.id]);return found;});
  const organizations=(await pool.query("SELECT o.id,o.name FROM agents_platform.organizations o JOIN agents_platform.memberships m ON m.organization_id=o.id WHERE m.account_id=$1 AND m.revoked_at IS NULL ORDER BY o.name",[user.id])).rows;
  return {request:{clientName:row.name,clientId:row.client_id,redirectHost:new URL(row.redirect_uri).host,scopes:row.scopes},organizations};
 });
 app.post("/api/mcp/oauth/requests/:id/decision",{bodyLimit:8192},async r=>{
  const user=await account(r),id=z.object({id:z.string().regex(/^[A-Za-z0-9_-]{43}$/)}).parse(r.params).id,input=z.object({approved:z.boolean(),organizationId:z.uuid().optional(),agentIds:z.array(z.uuid()).max(100).refine(ids=>new Set(ids).size===ids.length).optional()}).strict().parse(r.body);
  return tx(pool,async db=>{const row=(await db.query<Code & {state:string}>("SELECT * FROM agents_platform.mcp_oauth_requests WHERE hash=$1 AND expires_at>now() AND used_at IS NULL FOR UPDATE",[hash(id)])).rows[0];if(!row||row.account_id!==user.id)return fail("NOT_FOUND","Connection request unavailable",404);const callback=new URL(row.redirect_uri);callback.searchParams.set("state",row.state);callback.searchParams.set("iss",issuer);
   if(input.approved){if(!input.organizationId)return fail("INVALID_INPUT","Choose an organization");await member(db,user.id,input.organizationId);const agentIds=input.agentIds??[];
    if(row.scopes.includes("runs:start")&&!agentIds.length)return fail("INVALID_INPUT","Choose at least one agent");
    if(agentIds.length){const agents=await db.query("SELECT id FROM agents_platform.agents WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL FOR SHARE",[input.organizationId,agentIds]);if(agents.rowCount!==agentIds.length)return fail("ACCESS_DENIED","An agent is unavailable",403);}
    const code=random();await db.query(`INSERT INTO agents_platform.mcp_oauth_codes(hash,client_id,account_id,organization_id,redirect_uri,resource,scopes,challenge,agent_ids,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+interval '2 minutes')`,[hash(code),row.client_id,user.id,input.organizationId,row.redirect_uri,row.resource,row.scopes,row.challenge,agentIds]);callback.searchParams.set("code",code);}else callback.searchParams.set("error","access_denied");await db.query("UPDATE agents_platform.mcp_oauth_requests SET used_at=now() WHERE hash=$1",[hash(id)]);return {redirectUrl:callback.toString()}; });
 });
 app.post("/oauth/token",{bodyLimit:16384},protocol(async r=>{
  const i=z.object({grant_type:z.enum(["authorization_code","refresh_token"]),client_id:bounded,resource:bounded,code:z.string().max(100).optional(),redirect_uri:redirect.optional(),code_verifier:z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/).optional(),refresh_token:z.string().max(100).optional(),scope:scopesSchema.optional()}).parse(r.body);if(i.resource!==resource)return fail("invalid_target","Unknown resource");
  const result=await tx(pool,async db=>{
   if(i.grant_type==="authorization_code") {if(!i.code||!i.code_verifier||!i.redirect_uri)return fail("invalid_grant","Invalid code");const row=(await db.query<Code>("SELECT * FROM agents_platform.mcp_oauth_codes WHERE hash=$1 AND expires_at>now() FOR UPDATE",[hash(i.code)])).rows[0];const challenge=createHash("sha256").update(i.code_verifier).digest("base64url");if(!row||row.used_at||row.client_id!==i.client_id||row.redirect_uri!==i.redirect_uri||row.resource!==resource||!equal(row.challenge,challenge))return fail("invalid_grant","Invalid code");await member(db,row.account_id,row.organization_id);await db.query("UPDATE agents_platform.mcp_oauth_codes SET used_at=now() WHERE hash=$1",[row.hash]);const access=`agents_oauth_${random()}`,refresh=`agents_refresh_${random()}`,connection=randomUUID();await db.query(`INSERT INTO agents_platform.mcp_oauth_connections(id,client_id,account_id,organization_id,resource,scopes,access_hash,agent_ids,access_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+interval '1 hour')`,[connection,row.client_id,row.account_id,row.organization_id,resource,row.scopes,hash(access),row.agent_ids]);await db.query("INSERT INTO agents_platform.mcp_oauth_refresh(hash,connection_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(refresh),connection]);return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:3600,scope:row.scopes.join(" ")};}
   if(!i.refresh_token)return fail("invalid_grant","Invalid refresh token");const old=(await db.query<{connection_id:string;expires_at:Date}>("SELECT connection_id,expires_at FROM agents_platform.mcp_oauth_refresh WHERE hash=$1",[hash(i.refresh_token)])).rows[0];if(!old)return fail("invalid_grant","Invalid refresh token");const row=(await db.query<Connection>("SELECT * FROM agents_platform.mcp_oauth_connections WHERE id=$1 FOR UPDATE",[old.connection_id])).rows[0];if(!row||row.revoked_at||row.client_id!==i.client_id||row.resource!==resource)return fail("invalid_grant","Invalid refresh token");const current=(await db.query<{used_at:Date|null;valid:boolean}>("SELECT used_at,expires_at>now() valid FROM agents_platform.mcp_oauth_refresh WHERE hash=$1",[hash(i.refresh_token)])).rows[0]!;if(current.used_at){await db.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=now() WHERE id=$1",[row.id]);return {replayed:true};}if(!current.valid)return fail("invalid_grant","Expired refresh token");await member(db,row.account_id,row.organization_id);const scopes=i.scope??row.scopes;if(scopes.some(s=>!row.scopes.includes(s)))return fail("invalid_scope","Cannot expand permissions");const access=`agents_oauth_${random()}`,refresh=`agents_refresh_${random()}`;await db.query("UPDATE agents_platform.mcp_oauth_refresh SET used_at=now() WHERE hash=$1",[hash(i.refresh_token)]);await db.query("UPDATE agents_platform.mcp_oauth_connections SET access_hash=$2,scopes=$3,access_expires_at=now()+interval '1 hour' WHERE id=$1",[row.id,hash(access),scopes]);await db.query("INSERT INTO agents_platform.mcp_oauth_refresh(hash,connection_id,expires_at) VALUES($1,$2,$3)",[hash(refresh),row.id,old.expires_at]);return {access_token:access,refresh_token:refresh,token_type:"Bearer",expires_in:3600,scope:scopes.join(" ")};
  });if("replayed" in result)return fail("invalid_grant","Refresh token reused");return result;
 }));
 app.post("/oauth/revoke",{bodyLimit:8192},protocol(async r=>{const i=z.object({client_id:bounded,token:bounded}).parse(r.body);await pool.query(`UPDATE agents_platform.mcp_oauth_connections SET revoked_at=COALESCE(revoked_at,now()) WHERE client_id=$1 AND (access_hash=$2 OR id IN(SELECT connection_id FROM agents_platform.mcp_oauth_refresh WHERE hash=$2))`,[i.client_id,hash(i.token)]);return {}; }));
 app.get("/api/organizations/:organizationId/mcp/oauth/connections",async r=>{const user=await account(r),org=z.object({organizationId:z.uuid()}).parse(r.params).organizationId;await member(pool,user.id,org);return {connections:(await pool.query(`SELECT c.id,c.client_id,c.scopes,c.created_at,c.last_used_at,c.revoked_at,k.name AS client_name FROM agents_platform.mcp_oauth_connections c JOIN agents_platform.mcp_oauth_clients k ON k.id=c.client_id WHERE c.account_id=$1 AND c.organization_id=$2 ORDER BY c.created_at DESC LIMIT 100`,[user.id,org])).rows};});
 app.delete("/api/organizations/:organizationId/mcp/oauth/connections/:id",async(r,reply)=>{const user=await account(r),p=z.object({organizationId:z.uuid(),id:z.uuid()}).parse(r.params);await member(pool,user.id,p.organizationId);const result=await pool.query("UPDATE agents_platform.mcp_oauth_connections SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND account_id=$2 AND organization_id=$3",[p.id,user.id,p.organizationId]);if(!result.rowCount)return fail("NOT_FOUND","Connection not found",404);return reply.code(204).send();});

}
