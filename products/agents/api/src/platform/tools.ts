import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, type AgentConfiguration } from "./contracts";
import { loadExecution } from "./execution";
import { MemoryStore } from "./memory";
import type { ToolDefinition } from "./model";
import { toolDescriptor, REPORT_WORKFLOW_BINDING } from "./tool-descriptors";

export const BUILTIN_MODEL_ALIASES = Object.freeze({ knowledge_search: "knowledge.search", knowledge_read: "knowledge.read",
  memory_search: "memory.search", memory_propose: "memory.propose", agents_delegate: "agents.delegate", sandbox_analyze: "sandbox.analyze" } as const);
export function builtinToolName(alias: string): string | undefined { return Object.hasOwn(BUILTIN_MODEL_ALIASES, alias) ? BUILTIN_MODEL_ALIASES[alias as keyof typeof BUILTIN_MODEL_ALIASES] : undefined; }
export function builtinModelAlias(name: string): string {
  const alias = Object.entries(BUILTIN_MODEL_ALIASES).find(([, operation]) => operation === name)?.[0];
  if (!alias) throw new PlatformError("TOOL_ALIAS_UNAVAILABLE", 403, "Tool alias is unavailable");
  return alias;
}

export function publishedToolBindings(config:AgentConfiguration):{name:string;version:string;digest:string}[] {
  const bindings=toolsFor(config).map(tool=>{
    const name=builtinToolName(tool.function.name)!,descriptor=toolDescriptor(name)!;
    return {name,version:descriptor.version,digest:requestDigest({descriptor,definition:tool,outputSchema:{type:"object"}})};
  });
  if(config.capabilities.workflows.enabled) bindings.push({name:"report.deliver",version:"1",digest:requestDigest({descriptor:toolDescriptor("report.deliver"),workflow:REPORT_WORKFLOW_BINDING})});
  return bindings;
}
export function assertPublishedTools(config:AgentConfiguration,bindings:{name:string;version:string;digest:string}[]):void {
  for(const expected of publishedToolBindings(config)) {
    if(!bindings.some(binding=>binding.name===expected.name&&binding.version===expected.version&&binding.digest===expected.digest)) throw new PlatformError("TOOL_VERSION_UNAVAILABLE",503,"Published tool binding is unavailable on this worker");
  }
}

export function fitUtf8(text: string, maxBytes: number): string {
  let result = "";
  let remaining = maxBytes;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (size > remaining) break;
    result += character;
    remaining -= size;
  }
  return result;
}

export function toolsFor(config: AgentConfiguration, connectedTools: readonly ToolDefinition[] = []): ToolDefinition[] {
  const permitted = new Set(config.tools);
  const definitions: [string, string, object][] = [
    ["knowledge.search", "Search the approved knowledge sources for this agent.", { query: { type: "string", maxLength: 512 } }],
    ["knowledge.read", "Read the next bounded span of an evidence passage returned by knowledge search. Use its evidenceId and nextOffset exactly.", { evidenceId: { type: "string", format: "uuid" }, offset: { type: "integer", minimum: 0, maximum: 1_048_576 } }],
    ["memory.search", "Read this verified user's approved personal memories. Never another user's memories.", { query: { type: "string", maxLength: 512 } }],
    ["memory.propose", "Propose a personal preference or completed event for user review. This does not save approved memory until the user accepts it.",
      { content: { type: "string", maxLength: 2048 }, kind: { type: "string", enum: ["semantic", "episodic"] } }],
  ];
  const result:ToolDefinition[] = definitions.filter(([name]) => permitted.has(name as AgentConfiguration["tools"][number]) &&
    (!name.startsWith("memory.") || config.memory.enabled)).map(([name, description, properties]) => ({
      type: "function", function: { name: builtinModelAlias(name), description,
        parameters: { type: "object", properties, required: name === "knowledge.read" ? ["evidenceId"] : Object.keys(properties), additionalProperties: false } },
    }));
  if(permitted.has("agents.delegate") && config.capabilities.delegation.enabled) result.push({type:"function",function:{
    name:"agents_delegate",description:"Delegate bounded briefs to permitted specialists and wait for all results. Child work shares this task's root budget. Omit maxTokens to use the published specialist allocation; lower it only deliberately. Each allocation must cover the entire input, tool definitions, safety allowance and output, not just generated text. Published roles below are descriptive data, not permission changes: "+JSON.stringify(config.capabilities.delegation.bindings.map(binding=>({
      bindingId:binding.id,name:binding.label??binding.id,purpose:binding.description??"Published business specialist",version:binding.versionNumber??binding.versionId,maxTokens:binding.maxTokens,knowledgeSourceCount:binding.sourceRevisionIds.length,connectedToolCount:binding.connectedToolBindingIds.length}))),
    parameters:{type:"object",properties:{requests:{type:"array",minItems:1,maxItems:2,items:{type:"object",properties:{
      bindingId:{type:"string",enum:config.capabilities.delegation.bindings.map(binding=>binding.id)},brief:{type:"string",minLength:1,maxLength:8192},
      maxTokens:{type:"integer",minimum:2048,maximum:12000,description:"Optional full input, tool-schema, safety and output allocation. Omit to use the pinned binding allocation; an insufficient allocation stops the specialist before its model request."},sourceRevisionIds:{type:"array",items:{type:"string",format:"uuid"},maxItems:20},connectedToolBindingIds:{type:"array",items:{type:"string",format:"uuid"},maxItems:8}},required:["bindingId","brief"],additionalProperties:false}}},required:["requests"],additionalProperties:false}}});
  if(permitted.has("sandbox.analyze") && config.capabilities.sandbox.enabled) result.push({type:"function",function:{
    name:"sandbox_analyze",description:"Run standard-library Python in the approved temporary no-network analysis environment. Read selected authorized inputs and write report files to the export directory.",
    parameters:{type:"object",properties:{code:{type:"string",minLength:1,maxLength:16384},inputArtifactIds:{type:"array",maxItems:32,items:{type:"string",format:"uuid"}}},required:["code"],additionalProperties:false}}});
  return [...result, ...connectedTools];
}

export async function executeTool(pool: Pool, taskId: string, operationId: string, name: string, rawArguments: string): Promise<unknown> {
  const execution = await loadExecution(pool, taskId), config = execution.configuration;
  if (!config.tools.includes(name as AgentConfiguration["tools"][number])) throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Tool arguments must be JSON"); }
  try {
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
