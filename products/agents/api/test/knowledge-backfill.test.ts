import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { textDigest } from "../src/contracts/source-contracts";
import { backfillLegacyKnowledgeObjects } from "../src/capabilities/knowledge/backfill-legacy-objects";
import type { PrivateObjectStore } from "../src/infrastructure/object-store";

function fixture(options: { unsafe?: boolean; missing?: boolean; corrupt?: boolean } = {}) {
  const body = Buffer.from("approved text");
  const objects = new Map<string, Uint8Array>();
  const source: PrivateObjectStore = { async get() { return options.corrupt ? Buffer.from("corrupt") : body; }, async put() { throw Error("source modified"); }, async delete() { throw Error("source modified"); } };
  const target: PrivateObjectStore = { async get(key) { const value = objects.get(key); if (!value) throw Error("missing"); return value; }, async put(key, value) { objects.set(key, value); }, async delete() { throw Error("unexpected deletion"); } };
  let count = 0;
  const pool = { async query() { count++; if (count % 3 === 1) return { rowCount: options.unsafe ? 1 : 0, rows: [] }; if (count % 3 === 2) return { rowCount: options.missing ? 1 : 0, rows: [] }; return { rows: [{ object_key: "knowledge/test/text", content_digest: textDigest(body), bytes: body.length, content_type: "text/plain; charset=utf-8" }] }; } } as unknown as Pool;
  return { pool, source, target, objects };
}

describe("legacy knowledge backfill", () => {
  it("verifies source bytes and can be rerun without changing the legacy store", async () => {
    const f = fixture();
    expect(await backfillLegacyKnowledgeObjects(f.pool, f.source, f.target)).toEqual({ copied: 1 });
    expect(await backfillLegacyKnowledgeObjects(f.pool, f.source, f.target)).toEqual({ copied: 1 });
    expect(Buffer.from(f.objects.get("knowledge/test/text")!).toString()).toBe("approved text");
  });
  it.each([{ unsafe: true }, { missing: true }, { corrupt: true }])("fails closed for %o", async options => {
    const f = fixture(options);
    await expect(backfillLegacyKnowledgeObjects(f.pool, f.source, f.target)).rejects.toThrow();
    expect(f.objects.size).toBe(0);
  });
});
