import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError,type AgentConfiguration } from "../contracts/contracts";
import { loadExecution } from "../execution/lifecycle/execution";
import { MemoryStore } from "../execution/memory/memory";
import { fitUtf8 } from "./tool-definitions";
import { channelPorts } from "../infrastructure/channel-ports";
import { transaction } from "../infrastructure/database";
import { builtinToolEnabled } from "./tool-definitions";
import { executeRecordTool } from "./enquiries/record-tools";
import { EnquiryStore } from "./enquiries/enquiries";
import { executeSkillTool } from "./skills/runtime";
import { supportStatus } from "./support-status";
export { BUILTIN_MODEL_ALIASES, builtinToolName, builtinModelAlias, builtinToolEnabled, parseModelDelegationRequest, publishedToolBindings, assertPublishedTools, fitUtf8, toolsFor } from "./tool-definitions";

export async function executeTool(pool: Pool, taskId: string, operationId: string, name: string, rawArguments: string, maxResultBytes?: number): Promise<unknown> {
  const execution = await loadExecution(pool, taskId), config = execution.configuration;
  if (!builtinToolEnabled(config, name)) throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Tool arguments must be JSON"); }
  try {
    if(name==="enquiry.submit"||name==="enquiry.amend")return new EnquiryStore(pool).submit(taskId,operationId,input,name);
    if(name==="enquiry.read")return new EnquiryStore(pool).readOwn(taskId,input);
    if(name==="records.search"||name==="records.update")return executeRecordTool(pool,taskId,operationId,name,input);
    if(name === "support.get_status") {
      z.strictObject({}).parse(input);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return supportStatus(config.supportHours);
    }
    if (name === "skills.activate" || name === "skills.read") return executeSkillTool(pool, taskId, name, input, maxResultBytes);
    if (name === "channel.request_handoff") {
      z.strictObject({}).parse(input);
      if (!execution.task.channel_binding || execution.task.parent_task_id) throw new PlatformError("CHANNEL_SCOPE_DENIED", 403, "Human support requires a customer conversation");
      return transaction(pool, db => channelPorts(db).requestHandoff(db, execution.task.channel_binding!, taskId));
    }
    if (name.startsWith("knowledge.")) throw new PlatformError("KNOWLEDGE_RUNTIME_UNAVAILABLE", 503, "Grounded knowledge runtime is unavailable");
    if (!config.memory.enabled || execution.task.principal.kind !== "human") throw new PlatformError("MEMORY_SCOPE_DENIED", 403, "Memory is unavailable");
    const memory = new MemoryStore(pool), scope = { organizationId: execution.task.organization_id, agentId: execution.agentId, principal: execution.task.principal };
    if (name === "memory.search") {
      const { query } = z.strictObject({ query: z.string().max(512) }).parse(input);
      const result = await memory.read(scope, query);
      return { generation: result.generation, memories: result.memories.map(item => ({ id: item.id, revision: item.revision, content: fitUtf8(item.content, 512) })).slice(0, 4) };
    }
    if (name === "memory.propose") {
      const parsed = z.strictObject({ content: z.string().min(1).max(2048), kind: z.enum(["semantic", "episodic"]) }).parse(input);
      const candidate = await memory.propose(scope, { ...parsed, operationId, sourceTaskId: taskId });
      return { candidateId: candidate.id, status: "pending_review" };
    }
    throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  } catch (error) {
    if (error instanceof z.ZodError) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the tool arguments");
    throw error;
  }
}
