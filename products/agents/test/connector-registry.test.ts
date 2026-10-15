import { describe, expect, it } from "vitest";
import { ConnectorRegistry } from "../src/connectors";

describe("connector registry", () => {
  it("keeps connector metadata immutable and validates ownership/rate limits", () => {
    const registry = new ConnectorRegistry();
    registry.register({
      id: "provider.mail",
      version: "1.0.0",
      displayName: "Provider Mail",
      ownerService: "agents",
      auth: "oauth2",
      requiredScopes: ["mail.send"],
      capabilityNames: ["mail.send"],
      rateLimit: { requests: 10, windowSeconds: 60 },
      redactedFields: ["accessToken"],
      supportsReconciliation: true,
    });
    const listed = registry.list();
    listed[0]!.requiredScopes.push("secret");
    expect(registry.get("provider.mail")?.requiredScopes).toEqual(["mail.send"]);
    expect(() => registry.register({ ...listed[0]!, id: "bad id" })).toThrow();
  });
});
