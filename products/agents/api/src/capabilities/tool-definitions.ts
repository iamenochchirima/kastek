import { z } from "zod";
import { PlatformError,requestDigest,type AgentConfiguration } from "../contracts/contracts";
import type { ToolDefinition } from "../execution/business/model";
import { REPORT_WORKFLOW_BINDING,toolDescriptor } from "./tool-descriptors";

export const BUILTIN_MODEL_ALIASES = Object.freeze({ knowledge_search: "knowledge.search", knowledge_read: "knowledge.read",
  memory_search: "memory.search", memory_propose: "memory.propose", skills_activate: "skills.activate", skills_read: "skills.read", agents_delegate: "agents.delegate", sandbox_analyze: "sandbox.analyze", channel_request_handoff: "channel.request_handoff" } as const);
export function builtinToolEnabled(config: AgentConfiguration, name: string): boolean {
  return name === "skills.activate" || name === "skills.read" ? config.skillIds.length > 0 : config.tools.includes(name as AgentConfiguration["tools"][number]);
}
export function builtinToolName(alias: string): string | undefined { return Object.hasOwn(BUILTIN_MODEL_ALIASES, alias) ? BUILTIN_MODEL_ALIASES[alias as keyof typeof BUILTIN_MODEL_ALIASES] : undefined; }
export function builtinModelAlias(name: string): string {
  const alias = Object.entries(BUILTIN_MODEL_ALIASES).find(([, operation]) => operation === name)?.[0];
  if (!alias) throw new PlatformError("TOOL_ALIAS_UNAVAILABLE", 403, "Tool alias is unavailable");
  return alias;
}

const modelDelegationRequestSchema = z.strictObject({requests:z.array(z.strictObject({
  bindingId:z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),brief:z.string().trim().min(1).max(8192),
})).min(1).max(2)});
export function parseModelDelegationRequest(input:unknown):z.infer<typeof modelDelegationRequestSchema>{
  try{return modelDelegationRequestSchema.parse(input);}catch{throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Select a specialist and provide a brief");}
}

export function publishedToolBindings(config:AgentConfiguration):{name:string;version:string;digest:string}[] {
  const bindings=toolsFor(config).map(tool=>{
    const name=builtinToolName(tool.function.name)!,descriptor=toolDescriptor(name)!;
    return {name,version:descriptor.version,digest:requestDigest({descriptor,definition:tool,outputSchema:descriptor.outputSchema})};
  });
  if(config.sourceRevisionIds.length) bindings.push({name:"knowledge.initial",version:"1",digest:requestDigest({descriptor:toolDescriptor("knowledge.initial"),
    inputSchema:{type:"object",properties:{query:{type:"string",maxLength:1024}},required:["query"],additionalProperties:false},outputContract:"knowledge-observation-v1"})});
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
    ["channel.request_handoff", "Request human support for the bound customer conversation and pause automation.", {}],
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
  if(config.skillIds.length) {
    const skillId={type:"string",enum:config.skillIds};
    result.push({type:"function",function:{name:"skills_activate",description:"Load a selected reviewed skill's complete instructions. Use the skill catalog to choose its ID. This grants no additional tools or permissions.",
      parameters:{type:"object",properties:{skillId},required:["skillId"],additionalProperties:false}}},
    {type:"function",function:{name:"skills_read",description:"Read one complete UTF-8 resource from an activated reviewed skill using its exact listed relative path. Scripts are text only and are not executed.",
      parameters:{type:"object",properties:{skillId,path:{type:"string",minLength:1,maxLength:256}},required:["skillId","path"],additionalProperties:false}}});
  }
  if(permitted.has("agents.delegate") && config.capabilities.delegation.enabled) result.push({type:"function",function:{
    name:"agents_delegate",description:"Delegate a brief to approved specialists and wait for their results. Each specialist uses its published scope and allocation. Available roles: "+JSON.stringify(config.capabilities.delegation.bindings.map(binding=>({
      bindingId:binding.id,name:binding.label??binding.id,purpose:(binding.description??"Published business specialist").slice(0,128)}))),
    parameters:{type:"object",properties:{requests:{type:"array",minItems:1,maxItems:2,items:{type:"object",properties:{
      bindingId:{type:"string",enum:config.capabilities.delegation.bindings.map(binding=>binding.id)},brief:{type:"string",minLength:1,maxLength:8192}},required:["bindingId","brief"],additionalProperties:false}}},required:["requests"],additionalProperties:false}}});
  if(permitted.has("sandbox.analyze") && config.capabilities.sandbox.enabled) result.push({type:"function",function:{
    name:"sandbox_analyze",description:"Run standard-library Python in the approved temporary no-network analysis environment. Read selected authorized inputs and write report files to the export directory.",
    parameters:{type:"object",properties:{code:{type:"string",minLength:1,maxLength:16384},inputArtifactIds:{type:"array",maxItems:32,items:{type:"string",format:"uuid"}}},required:["code"],additionalProperties:false}}});
  return [...result, ...connectedTools];
}
