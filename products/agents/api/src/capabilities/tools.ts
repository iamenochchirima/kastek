import { supportStatusV2 } from "./support-status-v2";
import { executeTaskControlTool } from "./task-control";
import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError } from "../contracts/contracts";
import { loadExecution } from "../execution/lifecycle/execution";
import { channelPorts } from "../infrastructure/channel-ports";
import { transaction } from "../infrastructure/database";
import { builtinToolEnabled } from "./tool-definitions";
import { executeRecordTool } from "./enquiries/record-tools";
import { EnquiryStore } from "./enquiries/enquiries";
import { executeSkillTool, type SkillLoadResult } from "./skills/runtime";
import { executeMemoryTool } from "./memory-tools";
import { supportStatus } from "./support-status";
import { handoffBriefSchema } from "../contracts/channel";
import type { HandoffFeedbackRequest } from "../execution/lifecycle/handoff-feedback-contract";
export { BUILTIN_MODEL_ALIASES, builtinToolName, builtinModelAlias, builtinToolEnabled, parseModelDelegationRequest, publishedToolBindings, assertPublishedTools, fitUtf8, toolsFor } from "./tool-definitions";

export async function executeTool(pool: Pool, taskId: string, operationId: string, name: string, rawArguments: string, maxResultBytes?: number, handoffFeedback?: HandoffFeedbackRequest,
  skillFitsContext?: (value: SkillLoadResult) => boolean, acceptedVersion?: string): Promise<unknown> {
  const execution = await loadExecution(pool, taskId), config = execution.configuration;
  if(execution.task.execution_purpose==='support_status_v1')throw new PlatformError('TOOL_DENIED',403,'Tool is unavailable');
  if (!builtinToolEnabled(config, name)) throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Tool arguments must be JSON"); }
  try {
    if(name==="tasks.inspect"||name==="tasks.cancel")return executeTaskControlTool(pool,taskId,operationId,name,input);
    if(name==="enquiry.submit"||name==="enquiry.amend")return new EnquiryStore(pool).submit(taskId,operationId,input,name);
    if(name==="enquiry.read")return new EnquiryStore(pool).readOwn(taskId,input);
    if(name==="records.search"||name==="records.update")return executeRecordTool(pool,taskId,operationId,name,input);
    if(name === "support.get_status_v2") {
      z.strictObject({}).parse(input);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return supportStatusV2(pool,execution.task.organization_id,config.supportHours);
    }
    if(name === "support.get_status") {
      z.strictObject({}).parse(input);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return supportStatus(config.supportHours);
    }
    if (name === "skills.activate" || name === "skills.read") return executeSkillTool(pool, taskId, name, input, maxResultBytes, skillFitsContext, acceptedVersion);
    if (name === "support.request_handoff_v2") {
      const brief = handoffBriefSchema.parse(input);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return transaction(pool, db => {
        const port = channelPorts(db).requestHandoffV2;
        if (!port) throw new PlatformError("HANDOFF_RELEASE_UNAVAILABLE",503,"Human support is unavailable");
        return port(db,execution.task.channel_binding!,taskId,brief,handoffFeedback);
      });
    }
    if (name === "channel.request_handoff" || name === "support.request_handoff") {
      const brief = name === "support.request_handoff" ? handoffBriefSchema.parse(input) : (z.strictObject({}).parse(input), undefined);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return transaction(pool, db => channelPorts(db).requestHandoff(db, execution.task.channel_binding!, taskId, brief));
    }
    if (name.startsWith("knowledge.")) throw new PlatformError("KNOWLEDGE_RUNTIME_UNAVAILABLE", 503, "Grounded knowledge runtime is unavailable");
    if (name === "memory.search" || name === "memory.read" || name === "memory.propose") return executeMemoryTool(pool, taskId, operationId, name, input);
    throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  } catch (error) {
    if (error instanceof z.ZodError) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the tool arguments");
    throw error;
  }
}
