import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CoreContext } from "../context.js";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import type { RequestContext } from "../identity/request-context.js";
import { extractUser, requireOrigin, resolveActiveOrgId } from "../identity/session.js";
import { clientMetadata, fetchClientMetadata, OAuthError, type OAuthClient } from "./clients.js";

export { OAuthError } from "./clients.js";
export const GROWTH_OAUTH_SCOPES = ["growth:read", "growth:draft", "growth:publish", "growth:manage"] as const;
const ACCESS_SECONDS = 3600;
const REFRESH_SECONDS = 30 * 86400;
const opaque = () => randomBytes(32).toString("base64url");
export const oauthDigest = (value: string) => createHash("sha256").update(value).digest("hex");
export const growthOAuthResource = (core: CoreContext) => `${core.config.publicApiUrl}/mcp`;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthError("invalid_request", "Invalid request");
  return value as Record<string, unknown>;
}
function text(value: unknown, required = true, max = 2048): string {
  if (value === undefined && !required) return "";
  if (typeof value !== "string" || value.length > max || (required && !value)) throw new OAuthError("invalid_request", "Invalid request field");
  return value;
}
export function parseGrowthOAuthScopes(value: string): string[] {
  const scopes = [...new Set(value.split(/\s+/).filter(Boolean))];
  if (!scopes.length || scopes.some(scope => !(GROWTH_OAUTH_SCOPES as readonly string[]).includes(scope)))
    throw new OAuthError("invalid_scope", "Unsupported Growth permission");
  return scopes;
}
const challenge = (value: string) => createHash("sha256").update(value).digest("base64url");
function secureEqual(a: string, b: string): boolean {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
async function member(db: PoolClient | CoreContext["pool"], org: string, user: string): Promise<void> {
  const found = await db.query(`SELECT 1 FROM "OrganizationMember" m JOIN "User" u ON u.id=m."userId" WHERE m."orgId"=$1 AND m."userId"=$2 AND u."emailVerified" IS NOT NULL`, [org, user]);
  if (!found.rowCount) throw new OAuthError("access_denied", "Workspace access is no longer available", 403);
}
interface CodeRow {
  hash: string; clientId: string; userId: string; orgId: string; redirectUri: string;
  resource: string; scopes: string[]; challenge: string; usedAt: Date | null;
}
interface ConnectionRow {
  id: string; clientId: string; userId: string; orgId: string; resource: string; scopes: string[];
  accessExpiresAt: Date; revokedAt: Date | null; lastUsedAt: Date | null;
}

async function client(core: CoreContext, id: string): Promise<OAuthClient> {
  const existing = (await core.pool.query<OAuthClient>(`SELECT id,name,"redirectUris" FROM "GrowthOAuthClient" WHERE id=$1`, [id])).rows[0];
  if (existing && !id.startsWith("https://")) return existing;
  if (!id.startsWith("https://")) throw new OAuthError("invalid_client", "Unknown client");
  // URL clients are revalidated on every authorization, so consent cannot use stale redirects.
  const metadata = await fetchClientMetadata(id);
  await core.pool.query(`INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris") VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,"redirectUris"=EXCLUDED."redirectUris"`, [id, metadata.name, metadata.redirectUris]);
  return metadata;
}

/** OAuth tokens are valid only for the Growth MCP resource, never as user-session cookies. */
export async function resolveGrowthOAuthContext(core: CoreContext, bearer: string): Promise<RequestContext | null> {
  if (!bearer.startsWith("growth_oauth_")) return null;
  if (!/^growth_oauth_[A-Za-z0-9_-]{43}$/.test(bearer)) throw new ApiError(401, "unauthorized", "Invalid OAuth access token");
  const connection = (await core.pool.query<ConnectionRow>(`SELECT id,"clientId","userId","orgId",resource,scopes,"accessExpiresAt","revokedAt","lastUsedAt" FROM "GrowthOAuthConnection" WHERE "accessHash"=$1 AND "revokedAt" IS NULL AND "accessExpiresAt">NOW()`, [oauthDigest(bearer)])).rows[0];
  if (!connection || connection.resource !== growthOAuthResource(core)) throw new ApiError(401, "unauthorized", "OAuth access expired or revoked");
  try { await member(core.pool, connection.orgId, connection.userId); }
  catch { throw new ApiError(403, "forbidden", "Workspace access is no longer available"); }
  await core.pool.query(`UPDATE "GrowthOAuthConnection" SET "lastUsedAt"=NOW() WHERE id=$1 AND "revokedAt" IS NULL`, [connection.id]);
  return {
    principal: { kind: "oauth_user", id: connection.id, subjectUserId: connection.userId, clientId: connection.clientId },
    organizationId: connection.orgId, userId: connection.userId, clientId: connection.clientId,
    effectiveGrants: new Set(), apiScopes: new Set(connection.scopes),
    correlationId: null, causationId: null, idempotencyKey: null,
  };
}

function tokenResponse(access: string, refresh: string, scopes: string[]) {
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_SECONDS, refresh_token: refresh, scope: scopes.join(" ") };
}
async function issueTokens(db: PoolClient, row: CodeRow): Promise<ReturnType<typeof tokenResponse>> {
  const access = `growth_oauth_${opaque()}`, refresh = `growth_refresh_${opaque()}`, id = opaque();
  await db.query(`INSERT INTO "GrowthOAuthConnection"(id,"clientId","userId","orgId",resource,scopes,"accessHash","accessExpiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+make_interval(secs=>$8))`, [id,row.clientId,row.userId,row.orgId,row.resource,row.scopes,oauthDigest(access),ACCESS_SECONDS]);
  await db.query(`INSERT INTO "GrowthOAuthRefresh"(hash,"connectionId","expiresAt") VALUES($1,$2,NOW()+make_interval(secs=>$3))`, [oauthDigest(refresh),id,REFRESH_SECONDS]);
  return tokenResponse(access,refresh,row.scopes);
}

export function registerGrowthOAuthRoutes(app: FastifyInstance, core: CoreContext): void {
  const issuer = core.config.publicApiUrl, resource = growthOAuthResource(core);
  const protocol = (handler: (request: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
      try { return await handler(request,reply); }
      catch (error) {
        if (error instanceof OAuthError) {
          request.log.info({event:"oauth.request.denied",operation:request.routeOptions.url,error_code:error.code,status:error.status},"OAuth request denied");
          return reply.code(error.status).send({error:error.code,error_description:error.message});
        }
        throw error;
      }
    };
  const metadata = async () => ({resource,authorization_servers:[issuer],scopes_supported:[...GROWTH_OAUTH_SCOPES],bearer_methods_supported:["header"],resource_name:"KasiTek Growth",resource_documentation:`${core.config.frontendUrl}/developers/mcp`});
  app.get("/.well-known/oauth-protected-resource",metadata);
  app.get("/.well-known/oauth-protected-resource/mcp",metadata);
  app.get("/.well-known/oauth-authorization-server",async () => ({
    issuer,authorization_endpoint:`${issuer}/oauth/authorize`,token_endpoint:`${issuer}/oauth/token`,
    registration_endpoint:`${issuer}/oauth/register`,revocation_endpoint:`${issuer}/oauth/revoke`,
    response_types_supported:["code"],grant_types_supported:["authorization_code","refresh_token"],
    token_endpoint_auth_methods_supported:["none"],revocation_endpoint_auth_methods_supported:["none"],
    code_challenge_methods_supported:["S256"],scopes_supported:[...GROWTH_OAUTH_SCOPES],
    authorization_response_iss_parameter_supported:true,client_id_metadata_document_supported:true,
  }));

  app.post("/oauth/register",{bodyLimit:16384},protocol(async (request,reply) => {
    const id = `growth_client_${opaque()}`, metadata = clientMetadata(request.body,id);
    const fingerprint = oauthDigest(request.ip);
    await transaction(core.pool,async db => {
      await db.query("SELECT pg_advisory_xact_lock(71685131)");
      const limits = (await db.query<{total:number;recent:number}>(`SELECT COUNT(*)::integer AS total, COUNT(*) FILTER(WHERE "registrationIpHash"=$1 AND "createdAt">NOW()-INTERVAL '1 hour')::integer AS recent FROM "GrowthOAuthClient"`,[fingerprint])).rows[0]!;
      if (limits.total>=10000 || limits.recent>=30) throw new OAuthError("temporarily_unavailable","Client registration limit reached",429);
      await db.query(`INSERT INTO "GrowthOAuthClient"(id,name,"redirectUris","registrationIpHash") VALUES($1,$2,$3,$4)`,[id,metadata.name,metadata.redirectUris,fingerprint]);
    });
    return reply.code(201).send({client_id:id,client_name:metadata.name,redirect_uris:metadata.redirectUris,token_endpoint_auth_method:"none",grant_types:["authorization_code","refresh_token"],response_types:["code"]});
  }));

  app.get("/oauth/authorize",protocol(async (request,reply) => {
    const input = record(request.query);
    if (input.response_type!=="code" || input.code_challenge_method!=="S256") throw new OAuthError("invalid_request","Authorization code with S256 PKCE is required");
    const clientId=text(input.client_id), selected=await client(core,clientId), redirect=text(input.redirect_uri);
    if (!selected.redirectUris.includes(redirect)) throw new OAuthError("invalid_request","Redirect URI does not match the registered client");
    if (text(input.resource)!==resource) throw new OAuthError("invalid_target","Unknown Growth resource");
    const codeChallenge=text(input.code_challenge,true,43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) throw new OAuthError("invalid_request","Invalid PKCE challenge");
    const scopes=parseGrowthOAuthScopes(text(input.scope??"growth:read",true,200)), state=text(input.state,false), nonce=opaque();
    await core.pool.query(`INSERT INTO "GrowthOAuthRequest"(hash,"clientId","redirectUri",resource,scopes,state,challenge,"expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,NOW()+INTERVAL '10 minutes')`,[oauthDigest(nonce),clientId,redirect,resource,scopes,state,codeChallenge]);
    return reply.redirect(`${core.config.frontendUrl}/oauth/consent?request=${nonce}`);
  }));

  app.get("/api/oauth/requests/:id",async request => {
    const user=await extractUser(request,core), nonce=text(record(request.params).id,true,100);
    const result=await transaction(core.pool,async db => {
      const row=(await db.query<{clientId:string;name:string;scopes:string[];userId:string|null}>(`SELECT r."clientId",c.name,r.scopes,r."userId" FROM "GrowthOAuthRequest" r JOIN "GrowthOAuthClient" c ON c.id=r."clientId" WHERE r.hash=$1 AND r."expiresAt">NOW() AND r."usedAt" IS NULL FOR UPDATE OF r`,[oauthDigest(nonce)])).rows[0];
      if (!row || (row.userId!==null && row.userId!==user.id)) throw new ApiError(404,"not_found","Connection request is unavailable");
      await db.query(`UPDATE "GrowthOAuthRequest" SET "userId"=$2 WHERE hash=$1`,[oauthDigest(nonce),user.id]);
      return row;
    });
    const organizations=(await core.pool.query(`SELECT o.id,o.name FROM "Organization" o JOIN "OrganizationMember" m ON m."orgId"=o.id WHERE m."userId"=$1 ORDER BY o.name ASC`,[user.id])).rows;
    return {request:{clientId:result.clientId,clientName:result.name,scopes:result.scopes,resource},organizations};
  });

  app.post("/api/oauth/requests/:id/decision",{bodyLimit:8192},async request => {
    requireOrigin(request,core);
    const user=await extractUser(request,core),nonce=text(record(request.params).id,true,100),input=record(request.body);
    if (typeof input.approved!=="boolean") throw new ApiError(400,"bad_request","Choose whether to connect");
    return transaction(core.pool,async db => {
      const row=(await db.query<CodeRow & {state:string}>(`SELECT hash,"clientId","redirectUri",resource,scopes,state,challenge,"userId" FROM "GrowthOAuthRequest" WHERE hash=$1 AND "expiresAt">NOW() AND "usedAt" IS NULL FOR UPDATE`,[oauthDigest(nonce)])).rows[0];
      if (!row || row.userId!==user.id) throw new ApiError(404,"not_found","Connection request is unavailable");
      const callback=new URL(row.redirectUri);callback.searchParams.set("state",row.state);callback.searchParams.set("iss",issuer);
      if (input.approved) {
        const org=text(input.organizationId,true,256);await member(db,org,user.id);
        const scopes=input.scope===undefined?row.scopes:parseGrowthOAuthScopes(text(input.scope,true,200));
        if(scopes.some(scope=>!row.scopes.includes(scope))) throw new ApiError(403,"forbidden","Consent cannot add unrequested permissions");
        const code=opaque();
        await db.query(`INSERT INTO "GrowthOAuthCode"(hash,"clientId","userId","orgId","redirectUri",resource,scopes,challenge,"expiresAt") VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW()+INTERVAL '2 minutes')`,[oauthDigest(code),row.clientId,user.id,org,row.redirectUri,row.resource,scopes,row.challenge]);
        callback.searchParams.set("code",code);
      } else callback.searchParams.set("error","access_denied");
      await db.query(`UPDATE "GrowthOAuthRequest" SET "usedAt"=NOW() WHERE hash=$1`,[oauthDigest(nonce)]);
      return {redirectUrl:callback.toString()};
    });
  });

  app.post("/oauth/token",{bodyLimit:16384},protocol(async (request,reply) => {
    const input=record(request.body),clientId=text(input.client_id),target=text(input.resource);
    if(target!==resource)throw new OAuthError("invalid_target","Unknown Growth resource");
    const output=await transaction(core.pool,async db => {
      if(input.grant_type==="authorization_code") {
        const verifier=text(input.code_verifier,true,128);
        if(!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))throw new OAuthError("invalid_grant","Invalid PKCE verifier");
        const row=(await db.query<CodeRow>(`SELECT * FROM "GrowthOAuthCode" WHERE hash=$1 AND "expiresAt">NOW() FOR UPDATE`,[oauthDigest(text(input.code,true,100))])).rows[0];
        if(!row||row.usedAt||row.clientId!==clientId||row.resource!==target||row.redirectUri!==text(input.redirect_uri)||!secureEqual(row.challenge,challenge(verifier)))throw new OAuthError("invalid_grant","Authorization code is expired or invalid");
        await member(db,row.orgId,row.userId);
        await db.query(`UPDATE "GrowthOAuthCode" SET "usedAt"=NOW() WHERE hash=$1`,[row.hash]);
        return issueTokens(db,row);
      }
      if(input.grant_type!=="refresh_token")throw new OAuthError("unsupported_grant_type","Unsupported grant type");
      const raw=text(input.refresh_token,true,100);
      const token=(await db.query<{hash:string;connectionId:string;usedAt:Date|null;expiresAt:Date}>(`SELECT * FROM "GrowthOAuthRefresh" WHERE hash=$1`,[oauthDigest(raw)])).rows[0];
      if(!token)throw new OAuthError("invalid_grant","Refresh token is expired or revoked");
      const row=(await db.query<ConnectionRow>(`SELECT * FROM "GrowthOAuthConnection" WHERE id=$1 FOR UPDATE`,[token.connectionId])).rows[0];
      if(!row||row.clientId!==clientId||row.resource!==target||row.revokedAt)throw new OAuthError("invalid_grant","Refresh token is expired or revoked");
      // The connection lock serializes refresh rotation and family revocation.
      const current=(await db.query<{usedAt:Date|null;valid:boolean}>(`SELECT "usedAt","expiresAt">NOW() AS valid FROM "GrowthOAuthRefresh" WHERE hash=$1`,[token.hash])).rows[0]!;
      if(current.usedAt) {
        await db.query(`UPDATE "GrowthOAuthConnection" SET "revokedAt"=NOW() WHERE id=$1`,[row.id]);
        return {replayed:true as const};
      }
      if(!current.valid)throw new OAuthError("invalid_grant","Refresh token is expired or revoked");
      await member(db,row.orgId,row.userId);
      const scopes=input.scope===undefined?row.scopes:parseGrowthOAuthScopes(text(input.scope,true,200));
      if(scopes.some(scope=>!row.scopes.includes(scope)))throw new OAuthError("invalid_scope","Refresh cannot increase permissions");
      const access=`growth_oauth_${opaque()}`,refresh=`growth_refresh_${opaque()}`;
      await db.query(`UPDATE "GrowthOAuthRefresh" SET "usedAt"=NOW() WHERE hash=$1`,[token.hash]);
      await db.query(`UPDATE "GrowthOAuthConnection" SET "accessHash"=$2,scopes=$3,"accessExpiresAt"=NOW()+make_interval(secs=>$4) WHERE id=$1`,[row.id,oauthDigest(access),scopes,ACCESS_SECONDS]);
      await db.query(`INSERT INTO "GrowthOAuthRefresh"(hash,"connectionId","expiresAt") VALUES($1,$2,$3)`,[oauthDigest(refresh),row.id,token.expiresAt]);
      return tokenResponse(access,refresh,scopes);
    });
    if("replayed" in output)throw new OAuthError("invalid_grant","Refresh token was reused. Reconnect the agent");
    request.log.info({event:"oauth.token.issued",grant_type:input.grant_type,scope_count:output.scope.split(" ").length},"OAuth token issued");
    return reply.send(output);
  }));

  app.post("/oauth/revoke",{bodyLimit:8192},protocol(async (request,reply) => {
    const input=record(request.body),clientId=text(input.client_id),hash=oauthDigest(text(input.token,true,200));
    await core.pool.query(`UPDATE "GrowthOAuthConnection" SET "revokedAt"=COALESCE("revokedAt",NOW()) WHERE "clientId"=$1 AND ("accessHash"=$2 OR id IN(SELECT "connectionId" FROM "GrowthOAuthRefresh" WHERE hash=$2))`,[clientId,hash]);
    request.log.info({event:"oauth.revocation.processed"},"OAuth revocation processed");
    return reply.code(200).send({});
  }));

  app.get("/api/oauth/connections",async request => {
    const user=await extractUser(request,core),org=await resolveActiveOrgId(request,core,user.id);
    const rows=await core.pool.query(`SELECT g.id,g."clientId",c.name AS "clientName",g."orgId",g.scopes,g."createdAt",g."lastUsedAt",g."accessExpiresAt",g."revokedAt" FROM "GrowthOAuthConnection" g JOIN "GrowthOAuthClient" c ON c.id=g."clientId" WHERE g."userId"=$1 AND g."orgId"=$2 ORDER BY g."createdAt" DESC LIMIT 100`,[user.id,org]);
    return {connections:rows.rows};
  });
  app.delete("/api/oauth/connections/:id",async (request,reply) => {
    requireOrigin(request,core);
    const user=await extractUser(request,core),org=await resolveActiveOrgId(request,core,user.id),id=text(record(request.params).id,true,100);
    const changed=await core.pool.query(`UPDATE "GrowthOAuthConnection" SET "revokedAt"=COALESCE("revokedAt",NOW()) WHERE id=$1 AND "userId"=$2 AND "orgId"=$3`,[id,user.id,org]);
    if(!changed.rowCount)throw new ApiError(404,"not_found","Connection not found");
    return reply.code(204).send();
  });
}
