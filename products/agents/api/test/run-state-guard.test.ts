import { describe, expect, it } from "vitest";
import { assertRunActive } from "../src/execution/context/run-state-guard";
import type { ContextRunStateReader } from "../src/execution/context/readers";

const reader = (state: string): ContextRunStateReader => ({ read: async () => ({ state, output: null, errorCode: null }) });

describe("context run-state guard", () => {
  it("rejects a run that settled after the task was loaded", async () => {
    await expect(assertRunActive(reader("failed"), "task", "running")).rejects.toMatchObject({ code: "TASK_SETTLED" });
  });
  it("allows an active run and skips the check without a reader or for terminal loads", async () => {
    await expect(assertRunActive(reader("running"), "task", "running")).resolves.toBeUndefined();
    await expect(assertRunActive(undefined, "task", "running")).resolves.toBeUndefined();
    await expect(assertRunActive(reader("failed"), "task", "completed")).resolves.toBeUndefined();
  });
});
