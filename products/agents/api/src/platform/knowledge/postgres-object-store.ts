import type { Pool, PoolClient } from "pg";
import { PlatformError } from "../../contracts/contracts";
import type { PrivateObjectStore } from "../../infrastructure/object-store";
import { SOURCE_LIMITS } from "../../contracts/source-contracts";

/** Durable knowledge ingestion data and receipts, scoped to the knowledge namespaces. */
export class PostgresKnowledgeObjectStore implements PrivateObjectStore {
  constructor(readonly pool: Pool, readonly maxBytes = SOURCE_LIMITS.rawBytes) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > SOURCE_LIMITS.rawBytes) {
      throw new PlatformError("OBJECT_STORE_CONFIGURATION", 503, "Private storage configuration is invalid");
    }
  }

  private validateKey(key: string): void {
    if (!/^(knowledge|knowledge-query)\/[a-zA-Z0-9/_-]+$/.test(key) || key.length > 512 || key.split("/").some(part => !part)) {
      throw new PlatformError("ARTIFACT_KEY_INVALID", 400, "Invalid content reference");
    }
  }

  async put(key: string, content: Uint8Array, contentType: string, client?: PoolClient): Promise<void> {
    this.validateKey(key);
    if (content.byteLength > this.maxBytes) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    if (!contentType || contentType.length > 255) throw new PlatformError("ARTIFACT_CONTENT_TYPE_INVALID", 400, "Invalid content type");
    const result = await (client ?? this.pool).query(`INSERT INTO agents_platform.knowledge_object_contents (object_key, content, content_type)
      VALUES ($1,$2,$3) ON CONFLICT (object_key) DO UPDATE SET object_key = EXCLUDED.object_key
      WHERE agents_platform.knowledge_object_contents.content = EXCLUDED.content
        AND agents_platform.knowledge_object_contents.content_type = EXCLUDED.content_type RETURNING object_key`,
      [key, Buffer.from(content), contentType]);
    if (!result.rowCount) throw new PlatformError("ARTIFACT_CONTENT_CONFLICT", 409, "Content reference already exists");
  }

  async get(key: string, client?: PoolClient): Promise<Uint8Array> {
    this.validateKey(key);
    const result = await (client ?? this.pool).query<{ content: Buffer }>("SELECT content FROM agents_platform.knowledge_object_contents WHERE object_key=$1", [key]);
    if (!result.rowCount) throw new PlatformError("ARTIFACT_CONTENT_MISSING", 404, "Content is unavailable");
    const content = result.rows[0]!.content;
    if (content.byteLength > this.maxBytes) throw new PlatformError("ARTIFACT_TOO_LARGE", 413, "Content exceeds the storage limit");
    return content;
  }

  async delete(key: string, client?: PoolClient): Promise<void> {
    this.validateKey(key);
    await (client ?? this.pool).query("DELETE FROM agents_platform.knowledge_object_contents WHERE object_key=$1", [key]);
  }
}
