import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";

export interface InstallationTokenClaims {
  iss: string;
  sub: string;
  organizationId: string;
  credentialId: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

export function issueInstallationToken(input: {
  privateKeyPem: string;
  issuer: string;
  installationId: string;
  organizationId: string;
  credentialId: string;
  audience: string;
  now?: number;
}): { accessToken: string; expiresAt: string; claims: InstallationTokenClaims } {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: InstallationTokenClaims = {
    iss: input.issuer,
    sub: input.installationId,
    organizationId: input.organizationId,
    credentialId: input.credentialId,
    aud: input.audience,
    iat: now,
    exp: now + 60 * 60,
    jti: randomUUID(),
  };
  const header = encode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = encode(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(input.privateKeyPem), dsaEncoding: "ieee-p1363" });
  return { accessToken: `${header}.${payload}.${encode(signature)}`, expiresAt: new Date(claims.exp * 1000).toISOString(), claims };
}

export function verifyInstallationToken(token: string, publicKeyPem: string, audience: string, now = Math.floor(Date.now() / 1000)): InstallationTokenClaims {
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra) throw new Error("Malformed installation token");
  const header = decode<{ alg?: string; typ?: string }>(headerPart);
  if (header.alg !== "ES256" || header.typ !== "JWT") throw new Error("Invalid installation token header");
  const valid = verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" }, Buffer.from(signaturePart, "base64url"));
  if (!valid) throw new Error("Invalid installation token signature");
  const claims = decode<InstallationTokenClaims>(payloadPart);
  if (claims.aud !== audience || claims.exp <= now || !claims.sub || !claims.credentialId || !claims.organizationId || !claims.jti) throw new Error("Invalid installation token claims");
  return claims;
}

export function installationTokenJwks(privateKeyPem: string, keyId = "agents-installation-current"): { keys: Array<Record<string, string>> } {
  const key = createPublicKey(privateKeyPem).export({ format: "jwk" }) as JsonWebKey;
  if (!key.x || !key.y || !key.crv) throw new Error("Installation token key must be an EC key");
  return { keys: [{ kty: "EC", crv: key.crv, x: key.x, y: key.y, use: "sig", alg: "ES256", kid: keyId }] };
}
