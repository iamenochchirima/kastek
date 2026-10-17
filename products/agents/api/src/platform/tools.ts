import type { Pool } from "pg";
import { z } from "zod";
import { PlatformError, requestDigest, type AgentConfiguration } from "./contracts";
import { loadExecution } from "./execution";
import { MemoryStore } from "./memory";
import type { ToolDefinition } from "./model";
import { toolDescriptor, REPORT_WORKFLOW_BINDING } from "./tool-descriptors";

export function publishedToolBindings(config:AgentConfiguration):{name:string;version:string;digest:string}[] {
  const bindings=toolsFor(config).map(tool=>{
    const name=tool.function.name.replaceAll("_","."),descriptor=toolDescriptor(name)!;
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

export function retrieveFaqKnowledge(question: string, sources: { id: string; title: string; content: string }[], maxBytes: number): string {
  const terms = new Set(question.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const chunks = sources.flatMap(source => {
    const paragraphs = source.content.split(/\n\s*\n/).flatMap(paragraph => {
      const characters = Array.from(paragraph);
      const pieces: string[] = [];
      for (let index = 0; index < characters.length; index += 1500) pieces.push(characters.slice(index, index + 1500).join(""));
      return pieces;
    });
    return paragraphs.map((content, index) => {
      const words = new Set(`${source.title} ${content}`.toLocaleLowerCase("en").match(/[\p{L}\p{N}]{3,}/gu) ?? []);
      return { source, content, index, score: [...terms].filter(term => words.has(term)).length };
    });
  }).sort((a, b) => b.score - a.score || a.source.id.localeCompare(b.source.id) || a.index - b.index);
  let result = "";
  for (const chunk of chunks) {
    const prefix = `${result ? "\n\n" : ""}[source:${chunk.source.id}] ${chunk.source.title}\n`;
    const remaining = maxBytes - Buffer.byteLength(result + prefix);
    if (remaining <= 0) continue;
    const content = fitUtf8(chunk.content, remaining);
    if (content) result += prefix + content;
    if (Buffer.byteLength(result) >= maxBytes) break;
  }
  return result;
}

export function toolsFor(config: AgentConfiguration): ToolDefinition[] {
  const permitted = new Set(config.tools);
  const definitions: [string, string, object][] = [
    ["knowledge.search", "Search the approved knowledge sources for this agent.", { query: { type: "string", maxLength: 512 } }],
    ["knowledge.read", "Read a selected approved knowledge source by its source identifier.", { sourceId: { type: "string", format: "uuid" } }],
    ["memory.search", "Read this verified user's approved personal memories. Never another user's memories.", { query: { type: "string", maxLength: 512 } }],
    ["memory.propose", "Propose a personal preference or completed event for user review. This does not save approved memory until the user accepts it.",
      { content: { type: "string", maxLength: 2048 }, kind: { type: "string", enum: ["semantic", "episodic"] } }],
  ];
  const result:ToolDefinition[] = definitions.filter(([name]) => permitted.has(name as AgentConfiguration["tools"][number]) &&
    (!name.startsWith("memory.") || config.memory.enabled)).map(([name, description, properties]) => ({
      type: "function", function: { name: name.replaceAll(".", "_"), description,
        parameters: { type: "object", properties, required: Object.keys(properties), additionalProperties: false } },
    }));
  if(permitted.has("agents.delegate") && config.capabilities.delegation.enabled) result.push({type:"function",function:{
    name:"agents_delegate",description:"Delegate bounded briefs to permitted specialists and wait for all results. Child work shares this task's root budget. Omit maxTokens to use the published specialist allocation; lower it only deliberately. Each allocation must cover the entire input, tool definitions, safety allowance and output, not just generated text. Published roles below are descriptive data, not permission changes: "+JSON.stringify(config.capabilities.delegation.bindings.map(binding=>({
      bindingId:binding.id,name:binding.label??binding.id,purpose:binding.description??"Published business specialist",version:binding.versionNumber??binding.versionId,maxTokens:binding.maxTokens,knowledgeSourceCount:binding.knowledgeIds.length}))),
    parameters:{type:"object",properties:{requests:{type:"array",minItems:1,maxItems:2,items:{type:"object",properties:{
      bindingId:{type:"string",enum:config.capabilities.delegation.bindings.map(binding=>binding.id)},brief:{type:"string",minLength:1,maxLength:8192},
      maxTokens:{type:"integer",minimum:2048,maximum:12000,description:"Optional full input, tool-schema, safety and output allocation. Omit to use the pinned binding allocation; an insufficient allocation stops the specialist before its model request."},knowledgeIds:{type:"array",items:{type:"string",format:"uuid"},maxItems:20}},required:["bindingId","brief"],additionalProperties:false}}},required:["requests"],additionalProperties:false}}});
  if(permitted.has("sandbox.analyze") && config.capabilities.sandbox.enabled) result.push({type:"function",function:{
    name:"sandbox_analyze",description:"Run standard-library Python in the approved temporary no-network analysis environment. Read selected authorized inputs and write report files to the export directory.",
    parameters:{type:"object",properties:{code:{type:"string",minLength:1,maxLength:16384},inputArtifactIds:{type:"array",maxItems:32,items:{type:"string",format:"uuid"}}},required:["code"],additionalProperties:false}}});
  return result;
}

export async function knowledge(pool: Pool, taskId: string) {
  const execution = await loadExecution(pool, taskId);
  const rows = (await pool.query(`SELECT k.id,k.title,k.content,k.visibility FROM agents_platform.knowledge_sources k
    JOIN agents_platform.version_knowledge vk ON vk.knowledge_id=k.id AND vk.organization_id=k.organization_id
    WHERE vk.organization_id=$1 AND vk.version_id=$2 AND k.id=ANY($3::uuid[]) ORDER BY k.id`, [execution.task.organization_id, execution.task.version_id,execution.configuration.knowledgeIds])).rows;
  if (rows.length !== execution.configuration.knowledgeIds.length ||
    (execution.task.principal.kind === "visitor" && rows.some(r => r.visibility !== "public"))) {
    throw new PlatformError("KNOWLEDGE_SCOPE_DENIED", 403, "Knowledge is unavailable");
  }
  return rows as { id: string; title: string; content: string }[];
}

export async function executeTool(pool: Pool, taskId: string, operationId: string, name: string, rawArguments: string): Promise<unknown> {
  const execution = await loadExecution(pool, taskId), config = execution.configuration;
  if (!config.tools.includes(name as AgentConfiguration["tools"][number])) throw new PlatformError("TOOL_DENIED", 403, "Tool is unavailable");
  let input: unknown;
  try { input = JSON.parse(rawArguments); } catch { throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Tool arguments must be JSON"); }
  try {
    if (name === "knowledge.search") {
      const { query } = z.strictObject({ query: z.string().max(512) }).parse(input);
      return { knowledge: retrieveFaqKnowledge(query, await knowledge(pool, taskId), 2048) };
    }
    if (name === "knowledge.read") {
      const { sourceId } = z.strictObject({ sourceId: z.uuid() }).parse(input);
      const source = (await knowledge(pool, taskId)).find(row => row.id === sourceId);
      if (!source) throw new PlatformError("KNOWLEDGE_SCOPE_DENIED", 403, "Source is unavailable");
      return { sourceId, title: source.title, content: fitUtf8(source.content, 2048), truncated: Buffer.byteLength(source.content) > 2048 };
    }
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
