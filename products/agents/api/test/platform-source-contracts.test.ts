import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { assertDependencyManifest, assertIngestionPublication, collectDependencyGraph, createDependencyManifest,
  sourceChunkSchema, textDigest, type DependencyNode, type EvidenceDependency, type IngestionJob, type Source } from "../src/contracts/source-contracts";

const dependency = (): EvidenceDependency => ({ kind: "source", sourceId: randomUUID(), revisionId: randomUUID(), generation: 1, visibility: "private" });

describe("source and evidence contracts", () => {
  it("deduplicates shared ancestors without dropping influencing dependencies", () => {
    const a = dependency(), b = dependency();
    const node = (id: string, parents: string[], dependencies: EvidenceDependency[]): DependencyNode => ({ id, parents, manifest: createDependencyManifest(dependencies) });
    const nodes = new Map([node("root", ["left", "right"], []), node("left", ["shared"], [a]), node("right", ["shared"], [b]), node("shared", [], [a])].map(value => [value.id, value]));
    const result = collectDependencyGraph(["root"], nodes);
    expect(result.dependencies).toHaveLength(2);
    expect(result.digest).toBe(createDependencyManifest([b, a]).digest);
    expect(assertDependencyManifest(result)).toEqual(result);
  });

  it("rejects missing ancestors, cycles, and excessive graph depth", () => {
    const manifest = createDependencyManifest([]);
    expect(() => collectDependencyGraph(["missing"], new Map())).toThrow("unavailable");
    expect(() => collectDependencyGraph(["a"], new Map([["a", { id: "a", manifest, parents: ["b"] }], ["b", { id: "b", manifest, parents: ["a"] }]]))).toThrow("cycle");
    const nodes = new Map(Array.from({ length: 35 }, (_, i) => [String(i), { id: String(i), manifest, parents: i < 34 ? [String(i + 1)] : [] }] as const));
    expect(() => collectDependencyGraph(["0"], nodes)).toThrow("limit");
  });

  it("rejects stale or tampered manifests rather than choosing one policy generation", () => {
    const first = dependency();
    expect(() => createDependencyManifest([first, { ...first, generation: 2 }])).toThrow("policy changed");
    const manifest = createDependencyManifest([first]);
    expect(() => assertDependencyManifest({ ...manifest, digest: "0".repeat(64) })).toThrow("invalid");
    const second = dependency(), ordered = createDependencyManifest([first, second]);
    expect(() => assertDependencyManifest({ ...ordered, dependencies: ordered.dependencies.toReversed() })).toThrow("invalid");
  });

  it("binds Unicode chunks to exact text offsets and content hashes", () => {
    const text = "尾の証拠 🧪 café";
    const chunk = { id: randomUUID(), revisionId: randomUUID(), ordinal: 0, start: 3200, end: 3200 + text.length,
      page: 90, section: null, text, digest: textDigest(text), tokens: 18 };
    expect(sourceChunkSchema.parse(chunk)).toEqual(chunk);
    expect(sourceChunkSchema.safeParse({ ...chunk, end: chunk.end - 1 }).success).toBe(false);
    expect(sourceChunkSchema.safeParse({ ...chunk, text: "forged" }).success).toBe(false);
  });

  it("denies late publication after cancellation, withdrawal, refresh, or deadline", () => {
    const source: Source = { id: randomUUID(), organizationId: randomUUID(), importerAccountId: randomUUID(), title: "Research", kind: "upload", generation: 1,
      state: "active", visibility: "private", createdAt: "2026-10-17T00:00:00Z" };
    const job: IngestionJob = { id: randomUUID(), sourceId: source.id, revisionId: randomUUID(), revision: 1,
      acceptedGeneration: 1, state: "indexing", parserRelease: "document-v1", deadline: "2026-10-17T00:10:00Z" };
    const now = Date.parse("2026-10-17T00:05:00Z");
    expect(() => assertIngestionPublication(job, source, now)).not.toThrow();
    expect(() => assertIngestionPublication({ ...job, state: "cancelled" }, source, now)).toThrow("no longer eligible");
    expect(() => assertIngestionPublication(job, { ...source, state: "withdrawn" }, now)).toThrow("no longer eligible");
    expect(() => assertIngestionPublication(job, { ...source, generation: 2 }, now)).toThrow("no longer eligible");
    expect(() => assertIngestionPublication(job, source, now + 600_000)).toThrow("no longer eligible");
  });
});
