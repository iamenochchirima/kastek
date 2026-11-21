import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { parseGrowthAgentProvisionRequest, parseGrowthAgentProvisionResult, parseProductAgentLifecycleCommand,
  type GrowthAgentProvisionRequest, type GrowthAgentProvisionResult } from "@kasitek-labs/contracts";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { growthAgentApiUrl, growthAgentDigest } from "./security.js";
import { outboundTraceHeaders } from "../observability/context.js";
import { providerSpan } from "../observability/operations.js";

export async function provisionGrowthAgents(config: CoreConfig, request: GrowthAgentProvisionRequest,
  options: { fetch?: typeof fetch; signal?: AbortSignal } = {}): Promise<GrowthAgentProvisionResult> {
  let body: GrowthAgentProvisionRequest;
  try { body = parseGrowthAgentProvisionRequest(request); }
  catch { throw new ApiError(503,"AGENT_SETUP_CONFIGURATION_INVALID","Agent setup target is not configured"); }
  let lifecycle;
  try { lifecycle = parseProductAgentLifecycleCommand({ version: "1", requestId: body.requestId, product: "growth", tenantId: body.tenantId,
    actor: { issuer: config.env.GROWTH_AGENTS_ISSUER ?? "https://growth.kasitek.co.za", subject: "growth-provisioner" },
    operation: "agents.applyPublication", input: { defaultsRevision: body.defaultsRevision, modelProfileId: body.modelProfileId,
      modelProfileRevision: body.modelProfileRevision, ...(body.publication === undefined ? {} : { publication: body.publication }),
      ...(body.upgradeDefaults === undefined ? {} : { upgradeDefaults: body.upgradeDefaults }) } }); }
  catch { throw new ApiError(503,"AGENT_SETUP_CONFIGURATION_INVALID","Agent setup target is not configured"); }
  const base = growthAgentApiUrl(config), key = config.env.GROWTH_AGENTS_PROVISION_PRIVATE_KEY;
  if (!base || !key) throw new ApiError(503, "AGENT_SETUP_CONFIGURATION_MISSING", "Agent setup is not configured");
  let token: string;
  try {
    token = await new SignJWT({ product: "growth", requestDigest: growthAgentDigest(lifecycle) })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.env.GROWTH_AGENTS_PROVISION_KEY_ID ?? "growth-provision-v1" })
      .setIssuer(config.env.GROWTH_AGENTS_ISSUER ?? "https://growth.kasitek.co.za")
      .setAudience("agents-product-provisioning").setSubject("growth-provisioner")
      .setIssuedAt().setExpirationTime("60s").setJti(randomUUID())
      .sign(await importPKCS8(key.replace(/\\n/g, "\n"), "RS256"));
  } catch { throw new ApiError(503, "AGENT_SETUP_CONFIGURATION_INVALID", "Agent setup authorization is not configured"); }
  const response = await providerSpan("kasitek-agents", "provision", () => (options.fetch ?? fetch)(base + "/internal/v1/products/growth/lifecycle", {
    method: "POST", redirect: "error", headers: { ...outboundTraceHeaders(), authorization: `Bearer ${token}`,
      "content-type": "application/json", "x-correlation-id": body.requestId }, body: JSON.stringify(lifecycle),
    signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000),
  }));
  if (!response.ok) {
    const permanent = [400,401,403,404,409,422].includes(response.status);
    throw new ApiError(permanent ? 403 : 503, permanent ? "AGENT_SETUP_AUTHORITY_DENIED" : "AGENT_SETUP_SERVICE_UNAVAILABLE", "Agent setup could not complete");
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 16384) throw new ApiError(502,"AGENT_SETUP_RESPONSE_INVALID","Agent setup response is invalid");
  let result: GrowthAgentProvisionResult;
  try { result = parseGrowthAgentProvisionResult(JSON.parse(text)); }
  catch { throw new ApiError(502,"AGENT_SETUP_RESPONSE_INVALID","Agent setup response is invalid"); }
  if (result.tenantId !== body.tenantId || result.defaultsRevision !== body.defaultsRevision ||
      result.modelProfileId !== body.modelProfileId || result.modelProfileRevision !== body.modelProfileRevision)
    throw new ApiError(403,"AGENT_SETUP_SCOPE_INVALID","Agent setup response is invalid");
  return result;
}
