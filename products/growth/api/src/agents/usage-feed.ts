import type { CoreConfig } from "../config.js";
import { ApiError } from "../error.js";
import { growthAgentActor, growthAgentApiUrl, signGrowthAgentCommand } from "./security.js";

export interface GrowthUsageItem {
  taskId: string;
  accountedTokens: number;
  managedCostMicros: string;
  outcome: string;
  settledAt: string;
}

const usagePath = "/internal/v1/products/growth/usage";

/**
 * Read settled task usage for a Growth tenant. Usage is billed because the task settled,
 * not because a client later opened it.
 */
export async function readGrowthUsageFeed(
  config: CoreConfig,
  tenantId: string,
  since: string | null,
  limit = 100,
): Promise<{ items: GrowthUsageItem[]; nextSince: string | null }> {
  const base = growthAgentApiUrl(config);
  if (!base) throw new ApiError(503, "agent_service_unavailable", "Agents is not configured");
  const body = {
    version: "1",
    operation: "usage.read",
    tenantId,
    since,
    limit,
    actor: growthAgentActor(config, "growth-billing"),
  };
  const token = await signGrowthAgentCommand(config, body);
  let response: Response;
  try {
    response = await fetch(base + usagePath, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
      redirect: "error",
    });
  } catch {
    throw new ApiError(503, "agent_service_unavailable", "Agents is temporarily unavailable");
  }
  const text = await response.text();
  if (!response.ok) throw new ApiError(502, "agent_usage_unavailable", "Agent usage is unavailable");
  if (Buffer.byteLength(text) > 1_048_576) throw new ApiError(502, "agent_usage_invalid", "Agent usage is invalid");
  const value = JSON.parse(text) as { items?: GrowthUsageItem[]; nextSince?: string | null };
  if (!Array.isArray(value.items)) throw new ApiError(502, "agent_usage_invalid", "Agent usage is invalid");
  return { items: value.items, nextSince: typeof value.nextSince === "string" ? value.nextSince : null };
}
