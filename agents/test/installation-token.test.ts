import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueInstallationToken, verifyInstallationToken } from "../src/auth/installation-token";

describe("installation access tokens", () => {
  it("issues a one-hour ES256 token with an audience boundary", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const issued = issueInstallationToken({ privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(), issuer: "agents", installationId: "installation", organizationId: "org", credentialId: "credential", audience: "mcp", now: 100 });
    expect(verifyInstallationToken(issued.accessToken, publicKey.export({ type: "spki", format: "pem" }).toString(), "mcp", 3_699)).toMatchObject({ sub: "installation", credentialId: "credential" });
    expect(verifyInstallationToken(issued.accessToken, publicKey.export({ type: "spki", format: "pem" }).toString(), "mcp", 3_699, "agents")).toMatchObject({ iss: "agents" });
    expect(() => verifyInstallationToken(issued.accessToken, publicKey.export({ type: "spki", format: "pem" }).toString(), "mcp", 3_699, "other-issuer")).toThrow();
    expect(() => verifyInstallationToken(issued.accessToken, publicKey.export({ type: "spki", format: "pem" }).toString(), "kasitek-public-api", 101)).toThrow();
    expect(() => verifyInstallationToken(issued.accessToken, publicKey.export({ type: "spki", format: "pem" }).toString(), "mcp", 3_700)).toThrow();
  });
});
