import { describe, expect, it } from "vitest";
import { isCustomRemoteMcpProvider } from "../src/db/repositories/remote-mcp-provider-repository";

describe("remote MCP directory classification", () => {
  it("keeps reviewed catalogue providers out of the custom MCP list", () => {
    expect(isCustomRemoteMcpProvider({ catalog_id: null })).toBe(true);
    expect(isCustomRemoteMcpProvider({ catalog_id: "hermes.mcp.miro" })).toBe(false);
  });
});
