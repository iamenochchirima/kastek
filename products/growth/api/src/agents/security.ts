import { createHash, randomUUID } from "node:crypto";
import { importPKCS8, importSPKI, jwtVerify, SignJWT, decodeProtectedHeader } from "jose";
import { growthAgentCanonicalJson, type GrowthAgentActor } from "@kasitek-labs/contracts";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";

export const growthAgentDigest = (value: unknown): string => createHash("sha256").update(growthAgentCanonicalJson(value)).digest("hex");
const pem = (value: string) => value.replace(/\\n/g, "\n");
export function growthAgentIdentityIssuer(config: CoreConfig): string {
  return config.env.GROWTH_IDENTITY_ISSUER ?? `${(config.env.GROWTH_AGENTS_ISSUER ?? "https://growth.kasitek.co.za").replace(/\/$/, "")}/identity`;
}
export function growthAgentActor(config: CoreConfig, userId: string): GrowthAgentActor {
  return { issuer: growthAgentIdentityIssuer(config), subject: userId };
}
export function growthAgentApiUrl(config: CoreConfig): string | null {
  const value = config.env.AGENTS_PRODUCT_API_URL ?? config.env.AGENTS_API_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.username || url.password || url.hash || url.search || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(["development", "dev", "local", "test"].includes(config.environment.toLowerCase()) && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) throw Error();
    return url.origin;
  } catch { throw new ApiError(503, "agent_configuration_invalid", "Agent service configuration is invalid"); }
}
export async function signGrowthAgentCommand(config: CoreConfig, body: unknown): Promise<string> {
  const privateKey = config.env.GROWTH_AGENTS_SIGNING_PRIVATE_KEY;
  if (!privateKey) throw new ApiError(503, "agent_service_unavailable", "Agents is not configured");
  try {
    return await new SignJWT({ product: "growth", requestDigest: growthAgentDigest(body) })
      .setProtectedHeader({ alg: "RS256", typ: "JWT", kid: config.env.GROWTH_AGENTS_KEY_ID ?? "growth-v1" })
      .setIssuer(config.env.GROWTH_AGENTS_ISSUER ?? "https://growth.kasitek.co.za")
      .setAudience("agents-product-api").setSubject("growth-api")
      .setIssuedAt().setExpirationTime("60s").setJti(randomUUID())
      .sign(await importPKCS8(pem(privateKey), "RS256"));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "agent_configuration_invalid", "Agent authorization is not configured");
  }
}
export async function verifyGrowthAgentAction(config: CoreConfig, authorization: string | undefined, body: unknown): Promise<void> {
  const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : null;
  const unauthorized = () => new ApiError(401, "agent_action_unauthorized", "Agent action is unauthorized");
  if (!token || token.length > 16384) throw unauthorized();
  try {
    const header = decodeProtectedHeader(token);
    let key: string | undefined;
    if (config.env.AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON) {
      const keys: unknown = JSON.parse(config.env.AGENTS_PRODUCT_ACTION_PUBLIC_KEYS_JSON);
      if (!keys || typeof keys !== "object" || Array.isArray(keys) || typeof header.kid !== "string") throw unauthorized();
      const selected = (keys as Record<string, unknown>)[header.kid];
      if (typeof selected === "string") key = selected;
    } else if (header.kid === undefined || header.kid === (config.env.AGENTS_PRODUCT_ACTION_KEY_ID ?? "agents-v1")) {
      key = config.env.AGENTS_PRODUCT_ACTION_PUBLIC_KEY;
    }
    if (!key) throw unauthorized();
    const { payload } = await jwtVerify(token, await importSPKI(pem(key), "RS256"), {
      algorithms: ["RS256"], issuer: config.env.AGENTS_PRODUCT_ACTION_ISSUER ?? "https://agents.kasitek.co.za",
      audience: "growth-agent-actions", subject: "agents-worker", requiredClaims: ["iat", "exp", "jti", "requestDigest"], clockTolerance: 5,
    });
    if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp! - payload.iat! > 120 ||
      payload.exp! <= payload.iat! || payload.iat! > Date.now() / 1000 + 5 || (typeof payload.jti !== "string" || !payload.jti || payload.jti.length > 256) ||
      payload.requestDigest !== growthAgentDigest(body)) throw unauthorized();
  } catch { throw unauthorized(); }
}
