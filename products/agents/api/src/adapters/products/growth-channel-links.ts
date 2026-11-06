import { randomUUID } from "node:crypto";
import { importPKCS8, SignJWT } from "jose";
import { GROWTH_AGENT_CHANNELS_AUDIENCE, GROWTH_AGENT_CHANNELS_PATH,
  growthAgentChannelResponseSchema, type GrowthAgentChannelRequest, type GrowthAgentChannelResponse } from "@kasitek-labs/contracts";
import { PlatformError, requestDigest } from "../../contracts/contracts";

type Options = { origin: string; issuer: string; keyId: string; privateKey: string; environment?: string; fetch?: typeof fetch };
export class GrowthChannelLinkClient {
  private readonly endpoint: string;
  private readonly key: ReturnType<typeof importPKCS8>;
  constructor(private readonly options: Options) {
    const url = new URL(options.origin);
    if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      url.protocol !== "https:" && !(options.environment !== "production" && url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
      throw new Error("Invalid Growth channel API origin");
    }
    this.endpoint = new URL(GROWTH_AGENT_CHANNELS_PATH, url).href;
    this.key = importPKCS8(options.privateKey.replace(/\\n/g, "\n"), "RS256");
  }
  async request(body: GrowthAgentChannelRequest): Promise<GrowthAgentChannelResponse> {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({ product: "growth", requestDigest: requestDigest(body) })
      .setProtectedHeader({ alg: "RS256", kid: this.options.keyId })
      .setIssuer(this.options.issuer).setAudience(GROWTH_AGENT_CHANNELS_AUDIENCE)
      .setSubject("agents-worker").setJti(randomUUID()).setIssuedAt(now).setExpirationTime(now + 60)
      .sign(await this.key);
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)(this.endpoint, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15000),
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-correlation-id": body.requestId },
        body: JSON.stringify(body),
      });
    } catch {
      throw new PlatformError("GROWTH_CHANNEL_UNAVAILABLE", 503, "Growth could not confirm the channel operation");
    }
    const raw = await response.text();
    if (Buffer.byteLength(raw) > 131072) throw new PlatformError("GROWTH_CHANNEL_RESPONSE_LIMIT", 502, "Growth returned an invalid channel result");
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID", 502, "Growth returned an invalid channel result"); }
    if (!response.ok) {
      const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
      const detail = root.error && typeof root.error === "object" && !Array.isArray(root.error) ? root.error as Record<string, unknown> : root;
      const code = typeof detail.code === "string" && /^[A-Za-z0-9_]{1,80}$/.test(detail.code) ? detail.code.toUpperCase() : "GROWTH_CHANNEL_DENIED";
      throw new PlatformError(code, response.status >= 500 ? 503 : response.status, "Growth could not authorize the channel operation");
    }
    const parsed = growthAgentChannelResponseSchema.safeParse(value);
    if (!parsed.success || parsed.data.operation !== body.operation || parsed.data.requestId !== body.requestId) {
      throw new PlatformError("GROWTH_CHANNEL_RESPONSE_INVALID", 502, "Growth returned an invalid channel result");
    }
    return parsed.data;
  }
}

export function growthChannelLinkClientFromEnvironment(env: NodeJS.ProcessEnv = process.env): GrowthChannelLinkClient | undefined {
  const configured = [env.GROWTH_PRODUCT_API_URL, env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY];
  if (configured.every(value => !value)) return undefined;
  if (configured.some(value => !value)) throw new Error("Incomplete Growth channel service configuration");
  return new GrowthChannelLinkClient({ origin: env.GROWTH_PRODUCT_API_URL!, privateKey: env.AGENTS_PRODUCT_ACTION_PRIVATE_KEY!,
    issuer: env.AGENTS_PRODUCT_ACTION_ISSUER ?? "https://agents.kasitek.co.za", keyId: env.AGENTS_PRODUCT_ACTION_KEY_ID ?? "agents-v1",
    environment: env.NODE_ENV });
}
