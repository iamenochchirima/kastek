import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueInstallationToken, readClientAssertionSubject, validateClientAssertionPublicKey, verifyClientAssertion, verifyInstallationToken } from "../src/auth/installation-token";

function assertion(input: { privateKeyPem: string; keyId: string; credentialId: string; now?: number; audience?: string }): string {
  const now = input.now ?? 1_000;
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const header = encode({ alg: "ES256", typ: "JWT", kid: input.keyId });
  const payload = encode({ iss: input.keyId, sub: input.credentialId, aud: input.audience ?? "kasitek-agents-token", iat: now, exp: now + 120, jti: "assertion-1" });
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: input.privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${signature.toString("base64url")}`;
}

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

  it("verifies short-lived registered client assertions and exposes only lookup identifiers", () => {
    const client = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const clientPrivateKeyPem = client.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const clientPublicKeyPem = client.publicKey.export({ type: "spki", format: "pem" }).toString();
    const signed = assertion({ privateKeyPem: clientPrivateKeyPem, keyId: "codex-prod-1", credentialId: "credential-1" });
    expect(readClientAssertionSubject(signed)).toEqual({ keyId: "codex-prod-1", credentialId: "credential-1" });
    validateClientAssertionPublicKey(clientPublicKeyPem);
    expect(verifyClientAssertion(signed, clientPublicKeyPem, { keyId: "codex-prod-1", credentialId: "credential-1", now: 1_000 })).toMatchObject({ aud: "kasitek-agents-token", jti: "assertion-1" });
    expect(() => verifyClientAssertion(signed, clientPublicKeyPem, { keyId: "other-key", credentialId: "credential-1", now: 1_000 })).toThrow();
    expect(() => verifyClientAssertion(assertion({ privateKeyPem: clientPrivateKeyPem, keyId: "codex-prod-1", credentialId: "credential-1", audience: "mcp" }), clientPublicKeyPem, { keyId: "codex-prod-1", credentialId: "credential-1", now: 1_000 })).toThrow();
    expect(() => verifyClientAssertion(assertion({ privateKeyPem: clientPrivateKeyPem, keyId: "codex-prod-1", credentialId: "credential-1", now: 400 }), clientPublicKeyPem, { keyId: "codex-prod-1", credentialId: "credential-1", now: 1_000 })).toThrow();
  });
});
