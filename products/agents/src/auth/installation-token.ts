import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from "node:crypto";

export interface InstallationTokenClaims {
  iss: string;
  sub: string;
  organizationId: string;
  credentialId: string;
  aud: string;
  iat: number;
  nbf?: number;
  exp: number;
  jti: string;
}

export interface ClientAssertionClaims {
  iss: string;
  sub: string;
  aud: "kasitek-agents-token";
  iat: number;
  exp: number;
  jti: string;
}

export interface ClientAssertionSubject {
  keyId: string;
  credentialId: string;
}

function encode(value: Buffer | string): string {
  return Buffer.from(value).toString("base64url");
}

function decode<T>(value: string): T {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseClientAssertion(assertion: string): {
  header: { alg?: unknown; typ?: unknown; kid?: unknown };
  claims: Partial<ClientAssertionClaims> & Record<string, unknown>;
  signingInput: string;
  signature: Buffer;
} {
  const [headerPart, payloadPart, signaturePart, extra] = assertion.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra) throw new Error("Malformed client assertion");
  try {
    const header = decode<unknown>(headerPart);
    const claims = decode<unknown>(payloadPart);
    if (!isRecord(header) || !isRecord(claims)) throw new Error("Malformed client assertion");
    const signature = Buffer.from(signaturePart, "base64url");
    if (signature.length !== 64) throw new Error("Malformed client assertion");
    return {
      header,
      claims: claims as Partial<ClientAssertionClaims> & Record<string, unknown>,
      signingInput: `${headerPart}.${payloadPart}`,
      signature,
    };
  } catch {
    throw new Error("Malformed client assertion");
  }
}

/** Reads only the untrusted identifiers needed to find a registered key. */
export function readClientAssertionSubject(assertion: string): ClientAssertionSubject {
  const { header, claims } = parseClientAssertion(assertion);
  if (header.alg !== "ES256" || header.typ !== "JWT" || typeof header.kid !== "string" || !header.kid || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("Invalid client assertion subject");
  }
  return { keyId: header.kid, credentialId: claims.sub };
}

export function validateClientAssertionPublicKey(publicKeyPem: string): void {
  try {
    const key = createPublicKey(publicKeyPem);
    const jwk = key.export({ format: "jwk" }) as JsonWebKey;
    if (key.asymmetricKeyType !== "ec" || jwk.crv !== "P-256" || !jwk.x || !jwk.y) throw new Error("Client assertion key must be P-256");
  } catch {
    throw new Error("Invalid client assertion public key");
  }
}

export function verifyClientAssertion(
  assertion: string,
  publicKeyPem: string,
  input: { keyId: string; credentialId: string; now?: number },
): ClientAssertionClaims {
  const { header, claims, signingInput, signature } = parseClientAssertion(assertion);
  const now = input.now ?? Math.floor(Date.now() / 1000);
  if (
    header.alg !== "ES256"
    || header.typ !== "JWT"
    || header.kid !== input.keyId
    || claims.iss !== input.keyId
    || claims.sub !== input.credentialId
    || claims.aud !== "kasitek-agents-token"
    || typeof claims.iat !== "number"
    || !Number.isSafeInteger(claims.iat)
    || typeof claims.exp !== "number"
    || !Number.isSafeInteger(claims.exp)
    || typeof claims.jti !== "string"
    || claims.jti.length < 1
    || claims.jti.length > 200
    || claims.iat < now - 300
    || claims.iat > now + 60
    || claims.exp <= now
    || claims.exp <= claims.iat
    || claims.exp > now + 300
  ) throw new Error("Invalid client assertion claims");
  let valid = false;
  try {
    valid = verify("sha256", Buffer.from(signingInput), { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" }, signature);
  } catch {
    throw new Error("Invalid client assertion signature");
  }
  if (!valid) throw new Error("Invalid client assertion signature");
  return claims as ClientAssertionClaims;
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

export function verifyInstallationToken(
  token: string,
  publicKeyPem: string,
  audience: string,
  now = Math.floor(Date.now() / 1000),
  issuer?: string,
): InstallationTokenClaims {
  const [headerPart, payloadPart, signaturePart, extra] = token.split(".");
  if (!headerPart || !payloadPart || !signaturePart || extra) throw new Error("Malformed installation token");
  let header: { alg?: string; typ?: string };
  let claims: InstallationTokenClaims;
  try {
    header = decode<{ alg?: string; typ?: string }>(headerPart);
    claims = decode<InstallationTokenClaims>(payloadPart);
  } catch {
    throw new Error("Malformed installation token");
  }
  if (header.alg !== "ES256" || header.typ !== "JWT") throw new Error("Invalid installation token header");
  const valid = verify("sha256", Buffer.from(`${headerPart}.${payloadPart}`), { key: createPublicKey(publicKeyPem), dsaEncoding: "ieee-p1363" }, Buffer.from(signaturePart, "base64url"));
  if (!valid) throw new Error("Invalid installation token signature");
  if (
    claims.aud !== audience
    || (issuer !== undefined && claims.iss !== issuer)
    || !Number.isSafeInteger(claims.iat)
    || !Number.isSafeInteger(claims.exp)
    || (claims.nbf !== undefined && !Number.isSafeInteger(claims.nbf))
    || claims.iat > now + 60
    || claims.exp <= now
    || (claims.nbf !== undefined && claims.nbf > now)
    || !claims.sub
    || !claims.credentialId
    || !claims.organizationId
    || !claims.jti
  ) throw new Error("Invalid installation token claims");
  return claims;
}

export function installationTokenJwks(privateKeyPem: string, keyId = "agents-installation-current"): { keys: Array<Record<string, string>> } {
  const key = createPublicKey(privateKeyPem).export({ format: "jwk" }) as JsonWebKey;
  if (!key.x || !key.y || !key.crv) throw new Error("Installation token key must be an EC key");
  return { keys: [{ kty: "EC", crv: key.crv, x: key.x, y: key.y, use: "sig", alg: "ES256", kid: keyId }] };
}
