import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config";

const claimsSchema = z.object({
  organizationId: z.string().min(1),
  actorId: z.string().min(1),
  audience: z.string().min(1),
  expiresAt: z.number().int(),
  scopes: z.array(z.string()).default([]),
});

export type InternalAuthClaims = z.infer<typeof claimsSchema>;
export interface AuthContext {
  organizationId: string;
  actorId: string;
  scopes: string[];
}

function encode(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function signature(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signInternalToken(claims: InternalAuthClaims, secret: string): string {
  const parsed = claimsSchema.parse(claims);
  const payload = encode(JSON.stringify(parsed));
  return `${payload}.${signature(payload, secret)}`;
}

export function verifyInternalToken(token: string, secret: string, audience: string): AuthContext {
  const [payload, providedSignature] = token.split(".");
  if (!payload || !providedSignature) throw new Error("Malformed internal token");
  const expected = signature(payload, secret);
  const providedBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expected);
  if (providedBuffer.length !== expectedBuffer.length || !timingSafeEqual(providedBuffer, expectedBuffer)) {
    throw new Error("Invalid internal token signature");
  }
  let claims: InternalAuthClaims;
  try {
    claims = claimsSchema.parse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
  } catch {
    throw new Error("Invalid internal token claims");
  }
  if (claims.audience !== audience) throw new Error("Invalid internal token audience");
  if (claims.expiresAt <= Math.floor(Date.now() / 1000)) throw new Error("Internal token expired");
  return { organizationId: claims.organizationId, actorId: claims.actorId, scopes: claims.scopes };
}

export function authenticateRequest(
  headers: { authorization?: string; organizationId?: string; actorId?: string },
  config: AppConfig,
): AuthContext {
  if (config.AUTH_MODE === "headers") {
    if (!headers.organizationId || !headers.actorId) throw Object.assign(new Error("x-organization-id and x-actor-id are required"), { statusCode: 401 });
    return { organizationId: headers.organizationId, actorId: headers.actorId, scopes: [] };
  }
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw Object.assign(new Error("Bearer internal token required"), { statusCode: 401 });
  try {
    return verifyInternalToken(authorization.slice("Bearer ".length), config.INTERNAL_AUTH_SECRET!, config.INTERNAL_AUTH_AUDIENCE);
  } catch {
    throw Object.assign(new Error("Invalid internal token"), { statusCode: 401 });
  }
}
