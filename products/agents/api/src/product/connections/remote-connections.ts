import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../contracts/connections";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
import { ConnectionVault } from "../../infrastructure/vault";
import { authorizeRemote, remoteEndpoint, type RemoteAuthorization, type RemoteAuthOptions } from "./remote-auth";
import { discoverMcpCatalog } from "../../adapters/providers/mcp-adapter";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const missing = () => new PlatformError("CONNECTION_NOT_FOUND", 404, "Connection not found");
const conflict = () => new PlatformError("CONNECTION_CHANGED", 409, "Connection changed; refresh and try again");
const authSchema = z.enum(["auto", "none", "bearer", "header", "oauth"]);
export const remoteConnectionInput = z.strictObject({ operationId: z.string().min(1).max(128),
  name: z.string().trim().min(1).max(120).optional(), endpoint: z.string().min(1).max(2048),
  authentication: authSchema.default("auto"), secret: z.string().min(1).max(4096).optional(),
  headerName: z.string().regex(/^[A-Za-z][A-Za-z0-9-]{0,63}$/).optional() });
export interface RemoteConnectionDTO {
  id: string; name: string; endpoint: string; authentication: z.infer<typeof authSchema>;
  status: string; revision: number; generation: number; lastError: string | null;
  identity: unknown; createdAt: string; expiresAt: string;
}
interface StoredSecret { authorization?: RemoteAuthorization; secret?: string; }
type Row = Record<string, any>;

export class RemoteConnectionStore {
  constructor(readonly pool: Pool, readonly vault: ConnectionVault, readonly options: Omit<RemoteAuthOptions, "endpoint">) {}
  private dto(row: Row): RemoteConnectionDTO {
    return { id: row.id, name: row.name, endpoint: row.endpoint, authentication: row.auth_method,
      status: row.state === "revoked" ? "disconnected" : row.status, revision: row.revision, generation: row.generation,
      lastError: row.last_error, identity: row.verified_identity ?? null,
      createdAt: new Date(row.created_at).toISOString(), expiresAt: new Date(row.expires_at).toISOString() };
  }
  private async row(scope: ActionScope, id: string): Promise<Row> {
    await requireActionMember(this.pool, scope);
    return (await this.pool.query(`SELECT c.*,o.endpoint,o.auth_method,o.header_name,o.status,o.generation,o.last_error,o.verified_identity,
      o.lease_id,o.lease_until,k.envelope FROM agents_platform.connections c
      JOIN agents_platform.connection_onboarding o ON o.connection_id=c.id
      JOIN agents_platform.connection_credentials k ON k.connection_id=c.id AND k.revision=c.revision
      WHERE c.id=$1 AND c.organization_id=$2 AND c.account_id=$3`, [z.uuid().parse(id), scope.organizationId, scope.accountId])).rows[0] ?? (() => { throw missing(); })();
  }
  private secret(row: Row): StoredSecret { return row.envelope ? JSON.parse(this.vault.open(row.organization_id, row.id, row.revision, row.envelope)) : {}; }
  async list(scope: ActionScope): Promise<RemoteConnectionDTO[]> {
    await requireActionMember(this.pool, scope);
    const rows = (await this.pool.query(`SELECT c.*,o.endpoint,o.auth_method,o.status,o.generation,o.last_error,o.verified_identity
      FROM agents_platform.connections c JOIN agents_platform.connection_onboarding o ON o.connection_id=c.id
      WHERE c.organization_id=$1 AND c.account_id=$2 ORDER BY c.created_at DESC,c.id`, [scope.organizationId, scope.accountId])).rows;
    return rows.map(row => this.dto(row));
  }
  async get(scope: ActionScope, id: string) { return this.dto(await this.row(scope, id)); }
  async callbackScope(accountId: string, state: string): Promise<ActionScope> {
    const row = (await this.pool.query(`SELECT c.organization_id FROM agents_platform.connection_oauth_attempts a
      JOIN agents_platform.connections c ON c.id=a.connection_id WHERE a.state_digest=$1 AND a.account_id=$2`, [hash(state), accountId])).rows[0];
    if (!row) throw new PlatformError("OAUTH_STATE_INVALID", 400, "Sign-in attempt is invalid or expired");
    return { accountId, organizationId: row.organization_id };
  }
  async create(scope: ActionScope, raw: unknown) {
    const input = remoteConnectionInput.parse(raw), endpoint = remoteEndpoint(input.endpoint, this.options.testLoopback);
    if ((input.authentication === "bearer" || input.authentication === "header") && !input.secret)
      throw new PlatformError("CONNECTION_KEY_REQUIRED", 400, "Enter the server credential");
    if (input.authentication === "header" && (!input.headerName || /^(authorization|host|cookie|content-|transfer-|connection|proxy-|mcp-)/i.test(input.headerName)))
      throw new PlatformError("CONNECTION_HEADER_INVALID", 400, "Enter a supported credential header");
    if (!["header", "bearer"].includes(input.authentication) && input.secret)
      throw new PlatformError("CONNECTION_KEY_INVALID", 400, "Choose the credential method");
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`remote:${scope.organizationId}:${scope.accountId}:${input.operationId}`]);
      const digest = requestDigest(input), old = (await db.query(`SELECT request_digest,result FROM agents_platform.connection_mutations
        WHERE organization_id=$1 AND account_id=$2 AND operation_id=$3`, [scope.organizationId, scope.accountId, input.operationId])).rows[0];
      if (old) { if (old.request_digest !== digest) throw conflict(); return old.result as RemoteConnectionDTO; }
      const id = randomUUID(), secret: StoredSecret = input.secret ? { secret: input.secret } : {};
      const created = (await db.query(`INSERT INTO agents_platform.connections(id,organization_id,account_id,name,target_id,resource,profile_id,expires_at)
        VALUES($1,$2,$3,$4,'provider:remote-mcp',$5,'remote-mcp-v1',now()+interval '90 days') RETURNING *`,
      [id, scope.organizationId, scope.accountId, input.name ?? endpoint.hostname, endpoint.href])).rows[0];
      await db.query(`INSERT INTO agents_platform.connection_onboarding(connection_id,endpoint,auth_method,header_name) VALUES($1,$2,$3,$4)`, [id, endpoint.href, input.authentication, input.headerName ?? null]);
      await db.query(`INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,1,$2)`,
        [id, JSON.stringify(this.vault.seal(scope.organizationId, id, 1, JSON.stringify({ ...secret, version: 1, kind: "remote-connection" }), 65536))]);
      const dto = this.dto({ ...created, endpoint: endpoint.href, auth_method: input.authentication, status: "draft", generation: 1, last_error: null });
      await db.query(`INSERT INTO agents_platform.connection_mutations(organization_id,account_id,operation_id,request_digest,connection_id,result) VALUES($1,$2,$3,$4,$5,$6)`,
      [scope.organizationId, scope.accountId, input.operationId, digest, id, JSON.stringify(dto)]);
      return dto;
    });
  }
  private async lease(scope: ActionScope, id: string, expectedGeneration: number) {
    const row = await this.row(scope, id), leaseId = randomUUID();
    if (row.state !== "active" || new Date(row.expires_at).getTime() <= Date.now() || row.generation !== expectedGeneration) throw conflict();
    // Expired refresh leases require reconnect: a crashed refresh may have consumed a rotating token.
    const updated = await this.pool.query(`UPDATE agents_platform.connection_onboarding SET lease_id=$2,lease_until=now()+interval '45 seconds',updated_at=now()
      WHERE connection_id=$1 AND generation=$3 AND lease_id IS NULL`, [id, leaseId, expectedGeneration]);
    if (!updated.rowCount) throw new PlatformError("CONNECTION_BUSY", 409, "Connection is being checked; retry or reconnect");
    return { row, leaseId };
  }
  private async persist(scope: ActionScope, row: Row, leaseId: string, secret: StoredSecret, status: string, error: string | null = null) {
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      const lock = (await db.query(`SELECT c.revision,c.state,o.generation FROM agents_platform.connections c JOIN agents_platform.connection_onboarding o ON o.connection_id=c.id
        WHERE c.id=$1 AND c.account_id=$2 AND c.organization_id=$3 AND o.lease_id=$4 AND o.lease_until>now() FOR UPDATE OF c,o`,
      [row.id, scope.accountId, scope.organizationId, leaseId])).rows[0];
      if (!lock || lock.state !== "active" || lock.generation !== row.generation || lock.revision !== row.revision) throw conflict();
      const revision = row.revision + 1;
      await db.query(`INSERT INTO agents_platform.connection_credentials(connection_id,revision,envelope) VALUES($1,$2,$3)`,
        [row.id, revision, JSON.stringify(this.vault.seal(scope.organizationId, row.id, revision, JSON.stringify({ ...secret, version: 1, kind: "remote-connection" }), 65536))]);
      await db.query(`UPDATE agents_platform.connections SET revision=$2 WHERE id=$1`, [row.id, revision]);
      await db.query(`UPDATE agents_platform.connection_onboarding SET status=$2,last_error=$3,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE connection_id=$1`, [row.id, status, error]);
    });
  }
  async beginAuthorization(scope: ActionScope, id: string, generation: number) {
    const current = await this.row(scope,id);
    if(current.generation !== generation) throw conflict();
    if(current.lease_id && new Date(current.lease_until).getTime() <= Date.now()) {
      const reset=await this.pool.query(`UPDATE agents_platform.connection_onboarding SET lease_id=NULL,lease_until=NULL,generation=generation+1,status='reconnect_required'
        WHERE connection_id=$1 AND generation=$2 AND lease_until<=now()`,[id,generation]);
      if(!reset.rowCount) throw conflict();
      generation++;
    }
    const { row, leaseId } = await this.lease(scope, id, generation), stored = this.secret(row);
    const state = randomBytes(32).toString("base64url"), attemptId = randomUUID();
    const authorization: RemoteAuthorization = { client: stored.authorization?.client, state };
    try {
      const result = await authorizeRemote({ ...this.options, endpoint: row.endpoint }, authorization, undefined, true);
      if (result !== "REDIRECT" || !authorization.authorizationUrl) throw new PlatformError("OAUTH_REDIRECT_UNAVAILABLE", 400, "The server did not provide a sign-in flow");
      await transaction(this.pool, async db => {
        await requireActionMember(db, scope);
        const check = await db.query(`UPDATE agents_platform.connection_onboarding SET status='authenticating',lease_id=NULL,lease_until=NULL,last_error=NULL,updated_at=now()
          WHERE connection_id=$1 AND generation=$2 AND lease_id=$3 AND lease_until>now()`, [id, generation, leaseId]);
        if (!check.rowCount) throw conflict();
        await db.query(`UPDATE agents_platform.connection_oauth_attempts SET state='failed' WHERE connection_id=$1 AND state='pending'`, [id]);
        await db.query(`INSERT INTO agents_platform.connection_oauth_attempts(id,connection_id,account_id,state_digest,generation,envelope,state,expires_at)
          VALUES($1,$2,$3,$4,$5,$6,'pending',now()+interval '10 minutes')`, [attemptId, id, scope.accountId, hash(state), generation,
          JSON.stringify(this.vault.seal(scope.organizationId, attemptId, 1, JSON.stringify(authorization), 65536))]);
      });
      return { authorizationUrl: authorization.authorizationUrl, connection: await this.get(scope, id) };
    } catch (error) {
      await this.persist(scope, row, leaseId, stored, "authorization_required", "OAUTH_SETUP_FAILED").catch(() => undefined);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("OAUTH_SETUP_FAILED", 400, "Could not start sign in; check the server or its OAuth client settings");
    }
  }
  async completeAuthorization(scope: ActionScope, state: string, code?: string, issuer?: string) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(state)) throw new PlatformError("OAUTH_STATE_INVALID", 400, "Sign-in attempt is invalid or expired");
    await requireActionMember(this.pool, scope);
    const attempt = (await this.pool.query(`UPDATE agents_platform.connection_oauth_attempts a SET state='exchanging' FROM agents_platform.connections c
      WHERE a.connection_id=c.id AND a.state_digest=$1 AND a.account_id=$2 AND c.organization_id=$3 AND c.state='active'
      AND a.state='pending' AND a.expires_at>now() RETURNING a.*`, [hash(state), scope.accountId, scope.organizationId])).rows[0];
    if (!attempt) throw new PlatformError("OAUTH_STATE_INVALID", 400, "Sign-in attempt is invalid or expired");
    const { row, leaseId } = await this.lease(scope, attempt.connection_id, attempt.generation), stored = this.secret(row);
    try {
      if (!code) throw new PlatformError("OAUTH_CANCELLED", 400, "Sign in was cancelled");
      const data = JSON.parse(this.vault.open(scope.organizationId, attempt.id, 1, attempt.envelope)) as RemoteAuthorization;
      const result = await authorizeRemote({ ...this.options, endpoint: row.endpoint }, data, { code, issuer });
      if (result !== "AUTHORIZED" || !data.tokens) throw conflict();
      delete data.verifier; delete data.state; delete data.authorizationUrl;
      stored.authorization = data;
      await this.persist(scope, row, leaseId, stored, "discovering");
      await this.pool.query(`UPDATE agents_platform.connection_oauth_attempts SET state='completed' WHERE id=$1`, [attempt.id]);
      return await this.get(scope, row.id);
    } catch (error) {
      await this.persist(scope, row, leaseId, stored, "authorization_required", "OAUTH_SIGN_IN_FAILED").catch(() => undefined);
      await this.pool.query(`UPDATE agents_platform.connection_oauth_attempts SET state='failed' WHERE id=$1`, [attempt.id]);
      if (error instanceof PlatformError) throw error;
      throw new PlatformError("OAUTH_SIGN_IN_FAILED", 400, "Sign in failed; reconnect to try again");
    }
  }
  async disconnect(scope: ActionScope, id: string, generation: number) {
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      const result = await db.query(`UPDATE agents_platform.connections c SET state='revoked',policy_revision=policy_revision+1
        FROM agents_platform.connection_onboarding o WHERE c.id=o.connection_id AND c.id=$1 AND c.organization_id=$2 AND c.account_id=$3
        AND o.generation=$4 AND c.state='active'`, [id, scope.organizationId, scope.accountId, generation]);
      if (!result.rowCount) throw conflict();
      await db.query(`UPDATE agents_platform.connection_onboarding SET status='disconnected',generation=generation+1,lease_id=NULL,lease_until=NULL,updated_at=now() WHERE connection_id=$1`, [id]);
      await db.query(`UPDATE agents_platform.connection_oauth_attempts SET state='failed' WHERE connection_id=$1 AND state='pending'`, [id]);
      return { disconnected: true, upstreamRevocation: "not_attempted" as const };
    });
  }
  async discover(scope: ActionScope, id: string, generation: number) {
    const {row,leaseId}=await this.lease(scope,id,generation),stored=this.secret(row);
    try {
      const data=stored.authorization;
      if(data?.tokens?.expires_in && data.issuedAt && data.issuedAt+data.tokens.expires_in*1000 <= Date.now()+30000) {
        if(!data.tokens.refresh_token)throw new PlatformError("AUTHENTICATION",401,"Sign in again");
        if(await authorizeRemote({...this.options,endpoint:row.endpoint},data)!=="AUTHORIZED")throw new PlatformError("AUTHENTICATION",401,"Sign in again");
      }
      const token=data?.tokens?.access_token;
      if(token && data?.tokens?.token_type.toLowerCase()!=="bearer")throw new PlatformError("OAUTH_TOKEN_UNSUPPORTED",400,"This server requires an unsupported token type");
      const headers:Record<string,string>={};
      if(row.auth_method==="header" && stored.secret)headers[row.header_name]=stored.secret;
      const authorization=token?`Bearer ${token}`:row.auth_method==="bearer"&&stored.secret?`Bearer ${stored.secret}`:undefined;
      const catalog=await discoverMcpCatalog({endpoint:row.endpoint,authorization,headers,deadlineAt:Date.now()+30000,testLoopback:this.options.testLoopback});
      await this.persist(scope,row,leaseId,stored,"selection_required");
      return {connection:await this.get(scope,id),catalog};
    } catch(error) {
      const attempts=error && typeof error==="object" && "attempts" in error && Array.isArray(error.attempts)?error.attempts:[];
      const code=attempts.at(-1)?.status===401?"AUTHENTICATION":error && typeof error==="object" && "code" in error && typeof error.code==="string" && /^[A-Z0-9_]{1,80}$/.test(error.code)?error.code:"MCP_DISCOVERY_FAILED";
      const status=code==="AUTHENTICATION"?"authorization_required":code.includes("UNSUPPORTED")?"unsupported":"failed";
      await this.persist(scope,row,leaseId,stored,status,code);
      return {connection:await this.get(scope,id)};
    }
  }
}
