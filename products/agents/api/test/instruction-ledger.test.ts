import { describe, it, expect } from "vitest";
import { ACTIVE_INSTRUCTION_LIMIT, retainedInstructionGroups } from "../src/execution/delegation/progress";

const row = (sequence: number, instruction: string, task = "task-1") => ({
  task_id: task, sequence, instruction, created_at: new Date("2026-11-07T09:15:00.000Z"),
});

describe("active instruction ledger", () => {
  it("keeps a delivered instruction after a newer one arrives", () => {
    const rows = [row(1, "Keep drafts under 100 words"), row(2, "Use a warmer tone")];
    // Instruction 1 has already reached a model call; it is still applicable.
    const { retained, omittedActive } = retainedInstructionGroups(rows, new Set(["instruction:task-1:2"]));
    const text = retained.flatMap(group => group.messages.map(message => message.content)).join("\n");
    expect(text).toContain("Keep drafts under 100 words");
    expect(text).not.toContain("Use a warmer tone");
    expect(omittedActive).toBe(0);
  });

  it("never injects an undelivered instruction twice", () => {
    const rows = [row(1, "first"), row(2, "second")];
    const pending = new Set(["instruction:task-1:1", "instruction:task-1:2"]);
    expect(retainedInstructionGroups(rows, pending).retained).toEqual([]);
  });

  it("bounds the window and reports what was omitted instead of dropping it silently", () => {
    const rows = Array.from({ length: ACTIVE_INSTRUCTION_LIMIT + 3 }, (_, index) => row(index + 1, `instruction ${index + 1}`));
    const { retained, omittedActive } = retainedInstructionGroups(rows, new Set());
    expect(omittedActive).toBe(3);
    expect(retained).toHaveLength(ACTIVE_INSTRUCTION_LIMIT);
    // The newest instructions are kept; the oldest are the ones disclosed as omitted.
    expect(retained.at(-1)?.messages[0]?.content).toContain(`instruction ${ACTIVE_INSTRUCTION_LIMIT + 3}`);
    expect(retained[0]?.messages[0]?.content).toContain("instruction 4");
  });

  it("carries each retained instruction's received time", () => {
    const { retained } = retainedInstructionGroups([row(1, "deadline is Friday")], new Set());
    expect(retained[0]?.messages[0]?.content).toContain("(received 2026-11-07T09:15:00.000Z)");
  });
});

describe("progress observation scope", () => {
  it("applies to a non-delegating tool-directed agent", async () => {
    const { progressObservationApplies } = await import("../src/execution/delegation/progress");
    expect(progressObservationApplies({ program: { version: "4" } })).toBe(true);
    expect(progressObservationApplies({ program: { version: "3" } })).toBe(false);
  });
});
