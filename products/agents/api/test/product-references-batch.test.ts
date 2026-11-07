import { describe, it, expect, vi } from "vitest";
import { projectReferenceFields } from "../src/execution/products/product-references";

const rule = { resourceType: "content.post", outputRows: ["data.items.*"], labelFields: ["title"] } as never;

describe("reference projection batching", () => {
  it("issues one call per rule instead of one per identifier", async () => {
    const modelResult = { data: { items: [{ id: "p1", title: "One" }, { id: "p2", title: "Two" }, { id: "p3", title: "Three" }] } };
    const issue = vi.fn(async () => "should-not-be-used");
    const issueMany = vi.fn(async (_rule: unknown, rows: Array<{ id: string }>) => rows.map(row => `aref_${row.id}`));
    const output = await projectReferenceFields(modelResult, [rule], issue as never, issueMany as never) as { data: { items: Array<{ id: string }> } };
    expect(issueMany).toHaveBeenCalledTimes(1);
    expect(issue).not.toHaveBeenCalled();
    expect(output.data.items.map(item => item.id)).toEqual(["aref_p1", "aref_p2", "aref_p3"]);
  });

  it("falls back to per-identifier issuance when no batch issuer is supplied", async () => {
    const modelResult = { data: { items: [{ id: "p1", title: "One" }] } };
    const issue = vi.fn(async () => "aref_single");
    const output = await projectReferenceFields(modelResult, [rule], issue as never) as { data: { items: Array<{ id: string }> } };
    expect(issue).toHaveBeenCalledTimes(1);
    expect(output.data.items[0]?.id).toBe("aref_single");
  });

  it("rejects a batch that does not return one handle per identifier", async () => {
    const modelResult = { data: { items: [{ id: "p1", title: "One" }, { id: "p2", title: "Two" }] } };
    const issueMany = vi.fn(async () => ["aref_only_one"]);
    await expect(projectReferenceFields(modelResult, [rule], vi.fn() as never, issueMany as never)).rejects.toMatchObject({ code: expect.any(String) });
  });
});
