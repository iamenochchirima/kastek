import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueCoreDelegation } from "../src/core/delegation";

describe("core delegation", () => {
  it("creates short-lived invocation-bound ES256 JWTs", () => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const token = issueCoreDelegation({ privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), issuer: "agents", subject: "install", organizationId: "org", installationId: "install", capability: "content.read", capabilityVersion: "1.0.0", runId: "run", invocationId: "invocation", correlationId: "correlation", audience: "kasitek-core-internal", now: 100 });
    expect(token.split(".")).toHaveLength(3);
    expect(Buffer.from(token.split(".")[1]!, "base64url").toString()).toContain("content.read");
  });
});
