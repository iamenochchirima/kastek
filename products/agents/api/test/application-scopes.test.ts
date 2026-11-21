import { describe, expect, it } from "vitest";
import { applicationScopeSchema } from "../src/platform/access/applications";

describe("application scope vocabulary", () => {
  it("keeps management, publication, connection, run and review grants separate", () => {
    expect(applicationScopeSchema.options).toEqual([
      "agents:read", "agents:manage", "agents:publish", "connections:manage",
      "runs:start", "runs:read", "runs:control", "reviews:decide",
    ]);
    expect(applicationScopeSchema.safeParse("agents:manage").success).toBe(true);
    expect(applicationScopeSchema.safeParse("workspace:admin").success).toBe(false);
  });
});
