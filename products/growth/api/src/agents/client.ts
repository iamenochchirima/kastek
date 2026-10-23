import { randomUUID } from "node:crypto";
import { GROWTH_AGENT_COMMAND_PATH, parseGrowthAgentCommand, type GrowthAgentActor, type GrowthAgentCommand, type GrowthAgentCommandInputs, type GrowthAgentCommandOperation, type GrowthAgentCommandOutputs } from "@kasitek-labs/contracts";
import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { outboundTraceHeaders } from "../observability/context.js";
import { providerSpan } from "../observability/operations.js";
import { growthAgentApiUrl, signGrowthAgentCommand } from "./security.js";
export interface GrowthAgentTransport { fetch?: typeof fetch }
export class GrowthAgentClient {
  constructor(private readonly config: CoreConfig, private readonly transport: GrowthAgentTransport = {}) {}
  configured(): boolean { return Boolean(growthAgentApiUrl(this.config) && this.config.env.GROWTH_AGENTS_SIGNING_PRIVATE_KEY); }
  async command<K extends GrowthAgentCommandOperation>(scope: { tenantId: string; actor: GrowthAgentActor }, operation: K,
    input: GrowthAgentCommandInputs[K], requestId: string = randomUUID()): Promise<GrowthAgentCommandOutputs[K]> {
    const base = growthAgentApiUrl(this.config);
    if (!base) throw new ApiError(503, "agent_service_unavailable", "Agents is not configured");
    const body = parseGrowthAgentCommand(JSON.parse(JSON.stringify({ version: "1", requestId, ...scope, operation, input }))) as GrowthAgentCommand;
    const token = await signGrowthAgentCommand(this.config, body);
    let response: Response;
    try {
      response = await providerSpan("kasitek-agents", "http.request", () => {
        const traceHeaders = outboundTraceHeaders();
        return (this.transport.fetch ?? fetch)(base + GROWTH_AGENT_COMMAND_PATH, {
          method: "POST", headers: { ...traceHeaders, authorization: `Bearer ${token}`, "content-type": "application/json",
            "x-correlation-id": traceHeaders["x-correlation-id"] ?? requestId },
          body: JSON.stringify(body), signal: AbortSignal.timeout(15000), redirect: "error",
        });
      });
    } catch { throw new ApiError(503, "agent_service_unavailable", "Agents is temporarily unavailable"); }
    const text = await response.text();
    if (Buffer.byteLength(text) > 2097152) throw new ApiError(502, "agent_response_invalid", "Agent response is unavailable");
    let value: unknown;
    try { value = JSON.parse(text); } catch { throw new ApiError(502, "agent_response_invalid", "Agent response is unavailable"); }
    if (!response.ok) {
      const error = value && typeof value === "object" ? value as Record<string, unknown> : {};
      throw new ApiError(response.status >= 500 ? 503 : response.status,
        typeof error.code === "string" ? error.code : "agent_request_failed",
        typeof error.error === "string" ? error.error : "Agent request could not be completed");
    }
    return value as GrowthAgentCommandOutputs[K];
  }
}
