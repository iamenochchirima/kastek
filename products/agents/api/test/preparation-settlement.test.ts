import { describe, it, expect } from "vitest";
import * as restate from "@restatedev/restate-sdk";
import { preparationFailureCode } from "../src/execution/business/business";
import { PlatformError } from "../src/contracts/contracts";
import { ModelOperationError } from "../src/execution/business/model";

describe("preparation settlement", () => {
  it("settles deterministic preparation failures", () => {
    expect(preparationFailureCode(new PlatformError("HARNESS_RELEASE_UNAVAILABLE", 503, "x"))).toBeNull();
    expect(preparationFailureCode(new PlatformError("TASK_CONTEXT_INVALID", 409, "x"))).toBe("TASK_CONTEXT_INVALID");
    expect(preparationFailureCode(new PlatformError("CAPABILITY_BINDING_UNAVAILABLE", 409, "x"))).toBe("CAPABILITY_BINDING_UNAVAILABLE");
    expect(preparationFailureCode(new restate.TerminalError("identity", { errorCode: 409 }))).toBe("PREPARATION_REJECTED");
    expect(preparationFailureCode(new ModelOperationError("MODEL_INVALID_TOOLS", "rejected", 400))).toBe("MODEL_INVALID_TOOLS");
  });

  it("keeps transient failures retryable instead of inventing a terminal outcome", () => {
    expect(preparationFailureCode(new PlatformError("SERVICE_UNAVAILABLE", 503, "x"))).toBeNull();
    expect(preparationFailureCode(new ModelOperationError("MODEL_OUTCOME_UNCERTAIN", "uncertain"))).toBeNull();
    expect(preparationFailureCode(new Error("connect ECONNREFUSED"))).toBeNull();
    expect(preparationFailureCode("not an error")).toBeNull();
  });
});
