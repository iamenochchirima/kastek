import type { CapabilityOperationHandler } from "../../execution/capabilities/operation-handlers";
import { runRequiredReport } from "./program";

/**
 * Report delivery finishes a completed turn. It is registered as a capability handler so the
 * business loop does not import or branch on the report workflow directly.
 */
export function reportDeliveryHandler(): CapabilityOperationHandler {
  return {
    capability: "workflows",
    operations: ["report.deliver"],
    async afterTurn(call) {
      return runRequiredReport(call.ctx, call.pool, call.taskId, call.options, call.outcome, call.memoryFence, call.ports);
    },
  };
}
