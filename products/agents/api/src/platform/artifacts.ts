import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "./contracts";
import { requireMemoryAccess, type ManagementScope } from "./memory";

import {transaction as memoryTransaction} from "./database";

const sha = (input: string | Uint8Array) => createHash("sha256").update(input).digest("hex");
const hmac = (key: string | Uint8Array, value: string) => createHmac("sha256", key).update(value).digest();
const encode = (value: string) => encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
export interface S3PrivateConfig { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; maxBytes?: number }
export interface PrivateObjectStore { put(key: string, content: Uint8Array, contentType: string): Promise<void>; get(key: string): Promise<Uint8Array>; delete(key: string): Promise<void> }
export function privateStoreFromEnvironment(env: NodeJS.ProcessEnv = process.env): S3PrivateStore | undefined {
  const keys = ["AGENTS_S3_ENDPOINT", "AGENTS_S3_REGION", "AGENTS_S3_BUCKET", "AGENTS_S3_ACCESS_KEY_ID", "AGENTS_S3_SECRET_ACCESS_KEY"] as const;
  if (keys.every(key => !env[key])) return;
  if (keys.some(key => !env[key])) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage configuration is incomplete");
  return new S3PrivateStore({ endpoint: env.AGENTS_S3_ENDPOINT!, region: env.AGENTS_S3_REGION!, bucket: env.AGENTS_S3_BUCKET!, accessKeyId: env.AGENTS_S3_ACCESS_KEY_ID!, secretAccessKey: env.AGENTS_S3_SECRET_ACCESS_KEY! });
}
export class S3PrivateStore implements PrivateObjectStore {
  readonly maxBytes: number;
  private readonly endpoint: URL;
  constructor(private readonly config: S3PrivateConfig, private readonly fetcher: typeof fetch = fetch) {
    this.endpoint = new URL(config.endpoint);
    if (this.endpoint.username || this.endpoint.password || this.endpoint.search || this.endpoint.hash || this.endpoint.pathname !== "/") throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage endpoint is invalid");
    if (this.endpoint.protocol !== "https:" && !(this.endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(this.endpoint.hostname))) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage requires HTTPS or local development");
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(config.bucket) || !/^[a-z0-9-]{1,32}$/.test(config.region)) throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage location is invalid");
    this.maxBytes = config.maxBytes ?? 1_048_576;
  }
  private async request(method: "GET" | "PUT" | "DELETE", key: string, content?: Uint8Array, contentType?: string): Promise<Uint8Array> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]{0,511}$/.test(key) || key.split("/").some(part => !part || part === "." || part === "..")) throw new PlatformError("ARTIFACT_KEY_INVALID", 400, "Invalid content reference");
    if (content && content.byteLength > this.maxBytes) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, ""), day = date.slice(0, 8);
    const path = `/${encode(this.config.bucket)}/${key.split("/").map(encode).join("/")}`;
    const payload = sha(content ?? new Uint8Array());
    const signedHeaders = "host;x-amz-content-sha256;x-amz-date";
    const canonicalHeaders = `host:${this.endpoint.host}\nx-amz-content-sha256:${payload}\nx-amz-date:${date}\n`;
    const canonicalRequest = [method, path, "", canonicalHeaders, signedHeaders, payload].join("\n");
    const scope = `${day}/${this.config.region}/s3/aws4_request`;
    const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${scope}\n${sha(canonicalRequest)}`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, day), this.config.region), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
    let response: Response;
    try {
      response = await this.fetcher(new URL(path, this.endpoint), { method, redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: { "x-amz-date": date, "x-amz-content-sha256": payload,
          authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
          ...(contentType ? { "content-type": contentType } : {}) },
        ...(content ? { body: Buffer.from(content) } : {}) });
    } catch { throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable"); }
    if (!response.ok) {
      await response.body?.cancel();
      throw new PlatformError(response.status === 404 ? "ARTIFACT_CONTENT_MISSING" : "OBJECT_STORE_UNAVAILABLE", response.status === 404 ? 404 : 503,
        response.status === 404 ? "Content is unavailable" : "Private storage is unavailable");
    }
    if (method !== "GET") { await response.body?.cancel(); return new Uint8Array(); }
    const reader = response.body?.getReader(); if (!reader) throw new PlatformError("ARTIFACT_CONTENT_MISSING", 404, "Content is unavailable");
    const chunks: Uint8Array[] = []; let bytes = 0;
    while (true) {
      const next = await reader.read(); if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > this.maxBytes) { await reader.cancel(); throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit"); }
      chunks.push(next.value);
    }
    return Buffer.concat(chunks);
  }
  async put(key: string, content: Uint8Array, contentType: string) { await this.request("PUT", key, content, contentType); }
  get(key: string) { return this.request("GET", key); }
  async delete(key: string) { await this.request("DELETE", key); }
}
export interface ArtifactRecord { id: string; contentType: string; bytes: number; contentDigest: string; state: "pending" | "available" | "deleted"; createdAt: string }
const artifact = (row: Record<string, any>): ArtifactRecord => ({ id: row.id, contentType: row.content_type, bytes: row.bytes, contentDigest: row.content_digest, state: row.state, createdAt: row.created_at.toISOString() });
export class ArtifactStore {
  constructor(readonly pool: Pool, readonly objects?: PrivateObjectStore) {}
  async list(scope: ManagementScope): Promise<ArtifactRecord[]> {
    return memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      return (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND task_id IS NULL AND state='available' ORDER BY created_at,id LIMIT 100", [scope.organizationId, scope.agentId, scope.accountId])).rows.map(artifact); });
  }
  async put(scope: ManagementScope, input: { operationId: string; contentType: string; content: Uint8Array }): Promise<ArtifactRecord> {
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    z.string().min(1).max(128).parse(input.operationId);
    z.enum(["text/plain", "text/markdown", "application/json"]).parse(input.contentType);
    if (input.content.byteLength > 1_048_576) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    const contentDigest = sha(input.content), requestDigest = sha(JSON.stringify([contentDigest, input.contentType]));
    const row = await memoryTransaction(this.pool, async db => {
      await requireMemoryAccess(db, scope);
      await db.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`artifact:${scope.organizationId}:${scope.agentId}:${scope.accountId}:${input.operationId}`]);
      const old = (await db.query("SELECT * FROM agents_platform.artifacts WHERE organization_id=$1 AND agent_id=$2 AND account_id=$3 AND operation_id=$4", [scope.organizationId, scope.agentId, scope.accountId, input.operationId])).rows[0];
      if (old) { if (old.request_digest !== requestDigest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "Request key was already used"); return old; }
      const id = randomUUID(), key = `${scope.organizationId}/${scope.agentId}/${scope.accountId}/${id}`;
      return (await db.query("INSERT INTO agents_platform.artifacts(id,organization_id,agent_id,account_id,operation_id,request_digest,object_key,content_type,bytes,content_digest,state) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending') RETURNING *", [id, scope.organizationId, scope.agentId, scope.accountId, input.operationId, requestDigest, key, input.contentType, input.content.byteLength, contentDigest])).rows[0];
    });
    if (row.state === "deleted") throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted");
    if (row.state === "available") return artifact(row);
    // Immutable key and exact payload make a retry safe after a lost PUT response.
    await this.objects.put(row.object_key, input.content, input.contentType);
    let finalized: ArtifactRecord | undefined;
    try { finalized = await memoryTransaction(this.pool, async db => {
      await requireMemoryAccess(db, scope);
      const current = (await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 FOR UPDATE", [row.id])).rows[0];
      if (current.state === "deleted") return undefined;
      if (current.state === "available") return artifact(current);
      return artifact((await db.query("UPDATE agents_platform.artifacts SET state='available' WHERE id=$1 RETURNING *", [row.id])).rows[0]);
    }); } catch (error) {
      if (error instanceof PlatformError && error.code === "ACCESS_DENIED") {
        await this.pool.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1", [row.id]);
        await this.objects.delete(row.object_key);
      }
      throw error;
    }
    if (!finalized) { await this.objects.delete(row.object_key); throw new PlatformError("ARTIFACT_DELETED", 410, "Content was deleted"); }
    return finalized;
  }
  async get(scope: ManagementScope, artifactId: string, allowTaskArtifact = false): Promise<{ artifact: ArtifactRecord; content: Uint8Array }> {
    z.uuid().parse(artifactId);
    const row = await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      const value = (await db.query("SELECT * FROM agents_platform.artifacts WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND account_id=$4 AND state='available'", [artifactId, scope.organizationId, scope.agentId, scope.accountId])).rows[0];
      if (!value || (value.task_id && !allowTaskArtifact)) throw new PlatformError("NOT_FOUND", 404, "Content not found"); return value; });
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    const content = await this.objects.get(row.object_key);
    if (sha(content) !== row.content_digest || content.byteLength !== row.bytes) throw new PlatformError("ARTIFACT_INTEGRITY", 502, "Content integrity check failed");
    await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      if (!(await db.query("SELECT 1 FROM agents_platform.artifacts WHERE id=$1 AND state='available'", [row.id])).rowCount) throw new PlatformError("NOT_FOUND", 404, "Content not found"); });
    return { artifact: artifact(row), content };
  }
  async forget(scope: ManagementScope, artifactId: string) {
    z.uuid().parse(artifactId);
    const row = await memoryTransaction(this.pool, async db => { await requireMemoryAccess(db, scope);
      const value = (await db.query("UPDATE agents_platform.artifacts SET state='deleted' WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND account_id=$4 AND task_id IS NULL RETURNING *", [artifactId, scope.organizationId, scope.agentId, scope.accountId])).rows[0];
      if (!value) throw new PlatformError("NOT_FOUND", 404, "Content not found"); return value; });
    if (!this.objects) throw new PlatformError("OBJECT_STORE_UNAVAILABLE", 503, "Private storage is unavailable");
    await this.objects.delete(row.object_key); return artifact(row);
  }
}
