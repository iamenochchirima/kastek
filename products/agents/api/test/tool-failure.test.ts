import { describe, expect, it } from "vitest";
import { classifyToolFailure } from "../src/runtime/tool-failure";

describe("tool failure classification", () => {
  it("retries transient provider failures before an effect starts", () => {
    expect(classifyToolFailure({ code: "PROVIDER_TIMEOUT" })).toBe("retryable");
    expect(classifyToolFailure({ code: "RATE_LIMITED" })).toBe("retryable");
  });

  it("keeps authorization and configuration failures terminal", () => {
    expect(classifyToolFailure({ code: "TOOL_NOT_GRANTED" })).toBe("blocked");
    expect(classifyToolFailure({ code: "CONNECTOR_NOT_CONFIGURED" })).toBe("blocked");
    expect(classifyToolFailure({ code: "INVALID_ARGUMENTS" })).toBe("blocked");
  });

  it("never retries after an external effect boundary has been crossed", () => {
    expect(classifyToolFailure({ code: "PROVIDER_TIMEOUT", effectStarted: true })).toBe("unknown");
  });

  it("keeps approval as a durable wait", () => {
    expect(classifyToolFailure({ code: "APPROVAL_REQUIRED" })).toBe("waiting");
  });

  it("classifies cancellation and worker interruption separately", () => {
    expect(classifyToolFailure({ code: "ACTIVITY_CANCELLED" })).toBe("interrupted");
    expect(classifyToolFailure({ code: "WORKER_LOST" })).toBe("interrupted");
  });
});
