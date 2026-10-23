import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import type { ProductCapabilityInvocation } from "@kasitek-labs/contracts";
import type { TenantContext } from "../context.js";
import { TenantError, unauthorized } from "../error.js";
import { capabilityDigest } from "./manifest.js";

export async function verifyCapabilityService(context: TenantContext, authorization: string | undefined, body: unknown): Promise<void> {
  const env = context.config.env;
  if (!env.AGENTS_PRODUCT_ACTION_PUBLIC_KEY && !env.AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON)
    throw new TenantError(503, "product capability service unavailable");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 16391) throw unauthorized();
  try {
    const token = authorization.slice(7), header = decodeProtectedHeader(token);
    let key: string | undefined;
    if (env.AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON) {
      const keys: unknown = JSON.parse(env.AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON);
      if (!keys || typeof keys !== "object" || Array.isArray(keys) || typeof header.kid !== "string") throw unauthorized();
      const selected = (keys as Record<string, unknown>)[header.kid];
      if (typeof selected === "string") key = selected;
    } else if (header.kid === undefined || header.kid === (env.AGENTS_PRODUCT_ACTION_KEY_ID ?? "agents-v1")) key = env.AGENTS_PRODUCT_ACTION_PUBLIC_KEY;
    if (!key) throw unauthorized();
    const { payload } = await jwtVerify(token, await importSPKI(key.replace(/\\n/g, "\n"), "RS256"), {
      algorithms: ["RS256"], issuer: env.AGENTS_PRODUCT_ACTION_ISSUER ?? "https://agents.kasitek.co.za",
      audience: "product-capability-actions", subject: "agents-worker", requiredClaims: ["iat", "exp", "jti", "requestDigest"], clockTolerance: 5,
    });
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp! - payload.iat! > 120 ||
      payload.exp! <= payload.iat! || payload.iat! > Date.now() / 1000 + 5 || typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 256 ||
      payload.requestDigest !== capabilityDigest(body)) throw unauthorized();
  } catch { throw unauthorized(); }
}

export function capabilityInvocation(value: unknown): ProductCapabilityInvocation {
  const bad = () => new TenantError(400, "invalid product capability invocation");
  if (!value || typeof value !== "object" || Array.isArray(value)) throw bad();
  const body = value as ProductCapabilityInvocation;
  const text = (v: unknown) => typeof v === "string" && v.length > 0 && v.length <= 256;
  if (body.version !== "1" || !["requestId", "operationId", "taskId", "conversationId", "bindingId", "bindingDigest", "operation"].every(key => text((value as Record<string, unknown>)[key])) ||
      !body.actor || !text(body.actor.issuer) || !text(body.actor.subject) || !body.authority || body.authority.kind !== "product" ||
      !["originProduct", "destinationProduct", "originTenantId", "tenantId", "mappingRef", "policyRevision", "manifestDigest", "descriptorDigest", "handlerRef"].every(key => text((body.authority as unknown as Record<string, unknown>)[key])) ||
      !["invoke", "authorize", "evidence"].includes(body.control) || !body.input || typeof body.input !== "object" || Array.isArray(body.input) || body.review !== undefined) throw bad();
  const input = body.input as Record<string, unknown>;
  if (body.control === "evidence") {
    const source = input.source as Record<string, unknown> | undefined;
    if (Object.keys(input).length !== 1 || !source || typeof source !== "object" || !text(source.id) || !text(source.revision)) throw bad();
    return body;
  }
  if (Object.keys(input).some(key => !["agentId", "after", "limit"].includes(key)) ||
      (input.agentId !== undefined && !text(input.agentId)) || (input.after !== undefined && !text(input.after)) ||
      (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 50))) throw bad();
  return body;
}
