import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { ModelOperationError } from "../../execution/business/model";
import type { CapabilityOperationHandler } from "../../execution/capabilities/operation-handlers";

/** Skills script runs, owned by the skills capability. */
export function skillsOperationHandler(executeSandbox?: (taskId: string, operationId: string,
  args: { skillId: string; path: string; inputArtifactIds?: string[] }) => Promise<unknown>): CapabilityOperationHandler {
  return {
    capability: "skills",
    operations: ["skills.run"],
    async invoke(call) {
      if (!executeSandbox) throw new PlatformError("SANDBOX_UNAVAILABLE", 503, "Analysis is unavailable");
      const parsed = z.strictObject({ skillId: z.uuid(), path: z.string().min(1).max(256),
        inputArtifactIds: z.array(z.uuid()).max(32).optional() }).safeParse(call.arguments);
      if (!parsed.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the analysis arguments");
      const value = await executeSandbox(call.taskId, call.operationId, parsed.data);
      if (value && typeof value === "object" && "state" in value && value.state === "uncertain")
        throw new ModelOperationError("SANDBOX_OUTCOME_UNCERTAIN", "uncertain");
      return value;
    },
  };
}
