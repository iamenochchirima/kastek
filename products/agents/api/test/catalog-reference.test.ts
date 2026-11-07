import { describe, it, expect } from "vitest";
import { catalogReferenceEnabled, catalogSnapshotFields, hydrateCatalog } from "../src/execution/context/catalog-reference";

const catalog = { digest: "a".repeat(64) };

describe("catalog snapshot references", () => {
  it("keeps the inline catalog when the switch is off", () => {
    const fields = catalogSnapshotFields(catalog, { id: "snap-0", owner: null, digest: catalog.digest }, false);
    expect(fields.catalog).toBe(catalog);
    expect(fields.catalogRef).toBeUndefined();
  });

  it("references the owning snapshot when the digest is unchanged", () => {
    const fields = catalogSnapshotFields(catalog, { id: "snap-0", owner: null, digest: catalog.digest }, true);
    expect(fields.catalogRef).toBe("snap-0");
    expect(fields.catalogOwner).toBe("snap-0");
    expect(fields.catalog).toBeUndefined();
  });

  it("keeps a stable owner instead of chaining references", () => {
    const fields = catalogSnapshotFields(catalog, { id: "snap-1", owner: "snap-0", digest: catalog.digest }, true);
    expect(fields.catalogRef).toBe("snap-0");
  });

  it("writes a fresh inline copy when the digest changes", () => {
    const fields = catalogSnapshotFields(catalog, { id: "snap-1", owner: "snap-0", digest: "b".repeat(64) }, true);
    expect(fields.catalog).toBe(catalog);
    expect(fields.catalogOwner).toBeNull();
  });

  it("defaults the switch off", () => {
    expect(catalogReferenceEnabled({})).toBe(false);
    expect(catalogReferenceEnabled({ AGENTS_CATALOG_REFERENCE: "on" })).toBe(true);
  });
});

describe("catalog hydration", () => {
  it("resolves a reference through the owner snapshot", async () => {
    const payload = { messages: [], catalogRef: "snap-0", catalogDigest: catalog.digest };
    const hydrated = await hydrateCatalog(payload, async id => (id === "snap-0" ? { entries: [], digest: catalog.digest } : null));
    expect(hydrated.catalog).toEqual({ entries: [], digest: catalog.digest });
  });

  it("leaves an inline payload untouched", async () => {
    const payload = { catalog };
    expect(await hydrateCatalog(payload, async () => null)).toBe(payload);
  });

  it("fails loudly when the owner is missing", async () => {
    await expect(hydrateCatalog({ catalogRef: "snap-9" }, async () => null)).rejects.toThrow("CATALOG_REFERENCE_UNAVAILABLE");
  });
});
