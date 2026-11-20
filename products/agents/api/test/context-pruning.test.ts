import { describe, expect, it } from "vitest";
import { pruneCompactedGroups } from "../src/execution/context/pruning";
import type { ContextGroup } from "../src/execution/context/context";

const group = (id: string): ContextGroup => ({ id, messages: [{ role: "user", content: id }] });

describe("compaction pruning fallback", () => {
  it("drops compacted groups and keeps unrelated working groups", () => {
    const result = pruneCompactedGroups(["already"], [group("a"), group("b"), group("instruction:1")], ["a", "b", "already"]);
    expect(result.pruned).toEqual(["a", "b"]);
    expect(result.omitted).toEqual(["already", "a", "b"]);
    expect(result.working.map(item => item.id)).toEqual(["instruction:1"]);
  });

  it("is idempotent and does not re-prune omitted groups", () => {
    const first = pruneCompactedGroups([], [group("a"), group("b")], ["a", "b"]);
    const second = pruneCompactedGroups(first.omitted, first.working, ["a", "b"]);
    expect(second.pruned).toEqual([]);
    expect(second.omitted).toEqual(["a", "b"]);
    expect(second.working).toEqual([]);
  });

  it("reports no change when the plan has nothing compactable", () => {
    const working = [group("a")];
    expect(pruneCompactedGroups([], working, [])).toEqual({ omitted: [], working, pruned: [] });
  });
});
