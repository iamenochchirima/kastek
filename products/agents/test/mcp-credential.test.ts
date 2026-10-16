import { describe, expect, it } from "vitest";
import { resolveRemoteMcpAuthorizationToken } from "../src/mcp/remote";

describe("remote MCP credentials", () => {
  it("uses the access token from an OAuth credential envelope", () => {
    expect(resolveRemoteMcpAuthorizationToken(JSON.stringify({ accessToken: "miro-access-token", refreshToken: "refresh-token" }))).toBe("miro-access-token");
  });

  it("keeps plain API keys unchanged", () => {
    expect(resolveRemoteMcpAuthorizationToken("plain-api-key")).toBe("plain-api-key");
  });
});
