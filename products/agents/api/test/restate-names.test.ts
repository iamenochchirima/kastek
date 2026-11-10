import { describe, expect, it } from "vitest";
import { restateServiceName } from "../src/contracts/restate-names";

describe("restateServiceName", () => {
  it("keeps the logical workflow name without a sandbox namespace", () => {
    expect(restateServiceName("AgentsBusinessRunV25", undefined)).toBe("AgentsBusinessRunV25");
    expect(restateServiceName("AgentsBusinessRunV25", "")).toBe("AgentsBusinessRunV25");
  });

  it("prefixes the physical service name for a sandbox", () => {
    expect(restateServiceName("AgentsBusinessRunV25", "sbx-aba713a07365"))
      .toBe("sbx-aba713a07365-AgentsBusinessRunV25");
  });

  it("rejects an invalid namespace", () => {
    expect(() => restateServiceName("AgentsBusinessRunV25", "Sandbox 1"))
      .toThrow("Invalid AGENTS_RESTATE_NAMESPACE");
  });
});
