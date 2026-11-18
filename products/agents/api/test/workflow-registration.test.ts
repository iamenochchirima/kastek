import { describe, expect, it } from "vitest";
import { registeredWorkflowServices } from "../src/platform/capabilities/workflows";

describe("workflow registration", () => {
  it("keeps enabled services in registration order and skips disabled ones", () => {
    const a = { name: "a" }, b = { name: "b" }, c = { name: "c" };
    expect(registeredWorkflowServices([
      { id: "a", service: a }, { id: "b", service: b, enabled: false }, { id: "c", service: c },
    ])).toEqual([a, c]);
  });
});
