import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PostgresKnowledgeObjectStore } from "../src/capabilities/knowledge/postgres-object-store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("PostgreSQL knowledge content", () => {
  let admin: Pool, pool: Pool, store: PostgresKnowledgeObjectStore;
  const database = `agents_knowledge_objects_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool);
    store = new PostgresKnowledgeObjectStore(pool, 32);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("round trips bytes, permits identical retries, and rejects changes", async () => {
    const key = "knowledge/org/source/content";
    await store.put(key, Buffer.from("original 🧪"), "text/plain");
    await store.put(key, Buffer.from("original 🧪"), "text/plain");
    await expect(store.put(key, Buffer.from("changed"), "text/plain")).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_CONFLICT" });
    await expect(store.put(key, Buffer.from("original 🧪"), "text/html")).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_CONFLICT" });
    expect(Buffer.from(await store.get(key)).toString()).toBe("original 🧪");
  });

  it("serializes concurrent conflicting writes and keeps the winning content", async () => {
    const key = "knowledge-query/org/task/receipt";
    const results = await Promise.allSettled([store.put(key, Buffer.from("one"), "text/plain"), store.put(key, Buffer.from("two"), "text/plain")]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect(["one", "two"]).toContain(Buffer.from(await store.get(key)).toString());
  });

  it("uses the caller transaction for writes and deletes", async () => {
    const key = "knowledge/org/transaction";
    await store.put(key, Buffer.from("data"), "text/plain");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await store.delete(key, client);
      await expect(store.get(key, client)).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_MISSING" });
      await client.query("ROLLBACK");
    } finally { client.release(); }
    expect(Buffer.from(await store.get(key)).toString()).toBe("data");
  });

  it("enforces namespace and size, and removes content idempotently", async () => {
    await expect(store.put("artifacts/org/file", Buffer.from("x"), "text/plain")).rejects.toMatchObject({ code: "ARTIFACT_KEY_INVALID" });
    await expect(store.put("knowledge//bad", Buffer.from("x"), "text/plain")).rejects.toMatchObject({ code: "ARTIFACT_KEY_INVALID" });
    await expect(store.put("knowledge/org/large", Buffer.alloc(33), "text/plain")).rejects.toMatchObject({ code: "ARTIFACT_TOO_LARGE" });
    const key = "knowledge/org/delete";
    await store.put(key, Buffer.from("data"), "text/plain");
    await store.delete(key); await store.delete(key);
    await expect(store.get(key)).rejects.toMatchObject({ code: "ARTIFACT_CONTENT_MISSING" });
  });
});
