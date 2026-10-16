import { describe, expect, it, vi } from "vitest";
import { currentDatabaseContext } from "../src/db/context";
import { reconcileSimpleRuns } from "../src/runtime/simple-run-reconciliation";

describe("simple run reconciliation", () => {
  it("discovers overdue runs as an operator and writes failures in each tenant scope", async () => {
    const failRun = vi.fn(async () => {
      expect(currentDatabaseContext()).toEqual({ organizationId: "org", actorId: "owner" });
      return { status: "failed", error: { code: "SIMPLE_EXECUTION_INTERRUPTED" } } as never;
    });
    const count = await reconcileSimpleRuns({
      listOverdueSimpleRuns: async () => {
        expect(currentDatabaseContext()?.operator).toBe(true);
        return [{ id: "run", organization_id: "org", created_by: "owner" }];
      },
      failRun,
    });
    expect(count).toBe(1);
    expect(failRun).toHaveBeenCalledWith("run", expect.objectContaining({ code: "SIMPLE_EXECUTION_INTERRUPTED" }));
    expect(currentDatabaseContext()).toBeUndefined();
  });

  it("preserves a terminal outcome saved between discovery and the locked failure write", async () => {
    const count = await reconcileSimpleRuns({
      listOverdueSimpleRuns: async () => [{ id: "run", organization_id: "org", created_by: "owner" }],
      failRun: vi.fn(async () => ({ status: "completed", error: null }) as never),
    });
    expect(count).toBe(0);
  });
});
