import { describe, it, expect } from "vitest";
import { instructionContent } from "../src/execution/delegation/progress";

describe("steering instruction time", () => {
  it("carries the instruction's own received time, not the original request time", () => {
    const text = instructionContent("schedule it for tomorrow", new Date("2026-11-07T09:15:00.000Z"));
    expect(text).toContain("(received 2026-11-07T09:15:00.000Z)");
    expect(text).toContain("schedule it for tomorrow");
  });

  it("keeps the instruction when no time is available rather than inventing one", () => {
    const text = instructionContent("use a warmer tone", undefined);
    expect(text).not.toContain("received");
    expect(text).toContain("use a warmer tone");
  });

  it("accepts a serialized timestamp from the driver", () => {
    expect(instructionContent("x", "2026-11-07T09:15:00.000Z")).toContain("(received 2026-11-07T09:15:00.000Z)");
  });
});
