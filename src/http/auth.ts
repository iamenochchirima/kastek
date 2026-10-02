import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AppConfig } from "../config";

const claimsSchema = z.object({
  organizationId: z.string().min(1),
  actorId: z.string().min(1),
  correlationId: z.string().uuid().optional(),
  audience: z.string().min(1),
  expiresAt: z.number().int(),
  scopes: z.array(z.string()).default([]),
  operator: z.boolean().optional(),
});

export type InternalAuthClaims = z.infer<typeof claimsSchema>;
export interface AuthContext {
  organizationId: string;
  actorId: string;
  correlationId?: string;
  scopes: string[];
  operator?: boolean;
  source?: "browser";
}

// Only backend session admission can populate these contexts. Browser headers
// and internal token claims cannot select this authentication path.
const browserContexts = new WeakMap<object, AuthContext>();
const browserRechecks = new WeakMap<object, () => Promise<void>>();
export function admitBrowserRequest(request: object, context: AuthContext, recheck: () => Promise<void>): void {
  browserContexts.set(request, { ...context, source: "browser", operator: false });
  browserRechecks.set(request, recheck);
}
export function browserAuthContext(request: object): AuthContext | undefined { return browserContexts.get(request); }
export async function recheckBrowserRequest(request: object): Promise<void> { await browserRechecks.get(request)?.(); }

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
  return { organizationId: claims.organizationId, actorId: claims.actorId, correlationId: claims.correlationId, scopes: claims.scopes, operator: claims.operator };
}

export function authenticateRequest(
  headers: { authorization?: string; organizationId?: string; actorId?: string; correlationId?: string; operator?: string },
  config: AppConfig,
): AuthContext {
  if (config.AUTH_MODE === "headers") {
    if (!headers.organizationId || !headers.actorId) throw Object.assign(new Error("x-organization-id and x-actor-id are required"), { statusCode: 401 });
    return { organizationId: headers.organizationId, actorId: headers.actorId, correlationId: headers.correlationId, scopes: [], operator: headers.operator === "true" };
  }
  const authorization = headers.authorization;
  if (!authorization?.startsWith("Bearer ")) throw Object.assign(new Error("Bearer internal token required"), { statusCode: 401 });
  try {
    return verifyInternalToken(authorization.slice("Bearer ".length), config.INTERNAL_AUTH_SECRET!, config.INTERNAL_AUTH_AUDIENCE);
  } catch {
    throw Object.assign(new Error("Invalid internal token"), { statusCode: 401 });
  }
}
