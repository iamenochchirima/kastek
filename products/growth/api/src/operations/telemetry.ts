import { metrics } from "@opentelemetry/api";
import type { CoreContext } from "../context.js";
import type { RequestContext } from "../identity/request-context.js";
import { ApiError } from "../error.js";
import { beginRequest, finishRequest, publicRateLimit } from "../services/public-api.js";
import { getGrowthOperation } from "./catalog.js";

const meter = metrics.getMeter("kasitek.growth.agent-access");
const count = meter.createCounter("growth.operation.count");
const duration = meter.createHistogram("growth.operation.duration", { unit: "s" });

/** Labels contain catalogue identities and bounded outcomes, never arguments or credentials. */
export function recordGrowthOperation(context: RequestContext, name: string, outcome: string, started: number, code?: string) {
  let operation = "unknown";
  try { operation = getGrowthOperation(name).name; } catch { /* Bound invalid operation cardinality. */ }
  const seconds = Math.max(0, performance.now() - started) / 1000;
  const attributes = { operation, outcome, actor_kind: context.principal.kind };
  count.add(1, attributes); duration.record(seconds, attributes);
  console.info(JSON.stringify({ event: "growth.operation.completed", service: "growth", operation,
    outcome, actor_kind: context.principal.kind, duration_ms: Math.round(seconds * 1000),
    correlation_id: context.correlationId, ...(code ? { error_code: code } : {}) }));
}

/** Discovery and receipt reads consume the same durable admission budget as tool invocation. */
export async function auditGrowthAccess<T>(core: CoreContext, context: RequestContext, action: string, read: () => Promise<T>): Promise<T> {
  const audit = await beginRequest(core.pool, publicRateLimit(core.config), context, "GET", `/operations/${action}`);
  audit.action = action;
  try { const result = await read(); await finishRequest(core.pool, audit, 200); return result; }
  catch (error) { await finishRequest(core.pool, audit, error instanceof ApiError ? error.status : 500); throw error; }
}
