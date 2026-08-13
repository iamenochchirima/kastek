import { createPrivateKey, randomUUID, sign } from "node:crypto";

export interface DelegationClaims {
  iss: string;
  sub: string;
  organizationId: string;
  installationId: string;
  capability: string;
  capabilityVersion: string;
  runId: string;
  invocationId: string;
  correlationId: string;
  actorId?: string;
  idempotencyKey?: string;
  argumentsHash?: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
}

const encode = (value: string | Buffer) => Buffer.from(value).toString("base64url");

export function issueCoreDelegation(input: {
  privateKeyPem: string;
  issuer: string;
  subject: string;
  organizationId: string;
  installationId: string;
  capability: string;
  capabilityVersion: string;
  runId: string;
  invocationId: string;
  correlationId: string;
  actorId?: string;
  audience: string;
  idempotencyKey?: string;
  argumentsHash?: string;
  now?: number;
}): string {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const claims: DelegationClaims = {
    iss: input.issuer,
    sub: input.subject,
    organizationId: input.organizationId,
    installationId: input.installationId,
    capability: input.capability,
    capabilityVersion: input.capabilityVersion,
    runId: input.runId,
    invocationId: input.invocationId,
    correlationId: input.correlationId,
    actorId: input.actorId,
    idempotencyKey: input.idempotencyKey,
    argumentsHash: input.argumentsHash,
    aud: input.audience,
    iat: now,
    exp: now + 120,
    jti: randomUUID(),
  };
  const header = encode(JSON.stringify({ alg: "ES256", typ: "JWT" }));
  const payload = encode(JSON.stringify(claims));
  const signature = sign("sha256", Buffer.from(`${header}.${payload}`), { key: createPrivateKey(input.privateKeyPem), dsaEncoding: "ieee-p1363" });
  return `${header}.${payload}.${encode(signature)}`;
}
