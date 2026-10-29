import { z } from "zod";
import { PlatformError,requestDigest,type AgentConfiguration } from "../contracts/contracts";
import type { ToolDefinition } from "../execution/business/model";
import { REPORT_WORKFLOW_BINDING,toolDescriptor } from "./tool-descriptors";

export const BUILTIN_MODEL_ALIASES = Object.freeze({ knowledge_search: "knowledge.search", knowledge_read: "knowledge.read",
  memory_search: "memory.search", memory_propose: "memory.propose", skills_activate: "skills.activate", skills_read: "skills.read", skills_run:"skills.run", agents_delegate: "agents.delegate", sandbox_analyze: "sandbox.analyze", booking_availability:"booking.availability",booking_reserve:"booking.reserve",enquiry_submit:"enquiry.submit",enquiry_read:"enquiry.read",enquiry_amend:"enquiry.amend",records_search:"records.search",records_update:"records.update",channel_request_handoff: "channel.request_handoff", support_get_status: "support.get_status" } as const);
export function builtinToolEnabled(config: AgentConfiguration, name: string): boolean {
  if(name==="enquiry.submit"||name==="enquiry.read"||name==="enquiry.amend")return config.capabilities.enquiries?.enabled===true&&config.tools.includes(name);
  if(name==="skills.run")return config.skillIds.length>0&&config.capabilities.sandbox.enabled&&config.tools.includes("sandbox.analyze");
  if(name==="booking.availability"||name==="booking.reserve")return config.capabilities.businessActions.enabled&&config.capabilities.businessActions.permittedOperations.includes(name==="booking.availability"?"calendar.availability":"calendar.book");
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
  const bindings:{name:string;version:string;digest:string}[]=toolsFor(config).map(tool=>{
    const name=builtinToolName(tool.function.name)!,descriptor=toolDescriptor(name)!;
    return {name,version:descriptor.version,digest:requestDigest({descriptor,definition:tool,outputSchema:descriptor.outputSchema})};
  });
  for(const binding of config.productBindings)bindings.push({name:binding.alias,version:binding.definition.product!.revision,digest:binding.digest});
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
    ["support.get_status", "Read the configured support hours and current schedule status. Hours do not establish staff availability or response time.", {}],
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
  if(builtinToolEnabled(config,"enquiry.submit")){
    const fields=config.capabilities.enquiries!.enabled?config.capabilities.enquiries!.fields:[];
    const properties=Object.fromEntries(fields.map(field=>[field,{type:"string",minLength:1,maxLength:field==="message"?4000:field==="email"?320:field==="phone"?80:200}]));
    result.push({type:"function",function:{name:"enquiry_submit",description:"Submit the selected enquiry details to the business. The user must confirm the exact details in the interface before saving. Only a submitted receipt means the enquiry was saved.",parameters:{type:"object",properties:{fields:{type:"object",properties,required:fields,additionalProperties:false}},required:["fields"],additionalProperties:false}}});
  }
  if(builtinToolEnabled(config,"enquiry.read"))result.push({type:"function",function:{name:"enquiry_read",description:"Read submitted enquiries from this verified participant in this conversation. Never searches by name, email or another person's identity.",parameters:{type:"object",properties:{},additionalProperties:false}}});
  if(builtinToolEnabled(config,"enquiry.amend")){
    const fields=config.capabilities.enquiries?.enabled?config.capabilities.enquiries.fields:[];
    result.push({type:"function",function:{name:"enquiry_amend",description:"Propose replacement enquiry details for an enquiry returned by enquiry_read. Customer must confirm the exact changed values before saving. Original submission is retained.",parameters:{type:"object",properties:{enquiryId:{type:"string",format:"uuid"},fields:{type:"object",properties:Object.fromEntries(fields.map(field=>[field,{type:"string",minLength:1,maxLength:field==="message"?4000:field==="email"?320:field==="phone"?80:200}])),required:fields,additionalProperties:false}},required:["enquiryId","fields"],additionalProperties:false}}});
  }
  if(builtinToolEnabled(config,"records.search"))result.push({type:"function",function:{name:"records_search",description:"Search business enquiry records authorized for this signed-in staff member. Excludes private notes and contact directory.",parameters:{type:"object",properties:{search:{type:"string",maxLength:200},limit:{type:"integer",minimum:1,maximum:10}},additionalProperties:false}}});
  if(builtinToolEnabled(config,"records.update"))result.push({type:"function",function:{name:"records_update",description:"Update an authorized enquiry follow-up status or due date using its current revision. Does not send messages or change appointments.",parameters:{type:"object",properties:{enquiryId:{type:"string",format:"uuid"},expectedRevision:{type:"string",pattern:"^[1-9][0-9]*$"},action:{type:"string",enum:["set-status","reopen","set-due"]},status:{type:"string",enum:["new","in_progress","waiting_on_customer","closed"]},dueAt:{type:["string","null"],format:"date-time"}},required:["enquiryId","expectedRevision","action"],additionalProperties:false}}});
  if(config.skillIds.length) {
    const skillId={type:"string",enum:config.skillIds};
    result.push({type:"function",function:{name:"skills_activate",description:"Load a selected reviewed skill's complete instructions. Use the skill catalog to choose its ID. This grants no additional tools or permissions.",
      parameters:{type:"object",properties:{skillId},required:["skillId"],additionalProperties:false}}},
    {type:"function",function:{name:"skills_read",description:"Read one complete UTF-8 resource from an activated reviewed skill using its exact listed relative path. Scripts are text only and are not executed.",
      parameters:{type:"object",properties:{skillId,path:{type:"string",minLength:1,maxLength:256}},required:["skillId","path"],additionalProperties:false}}});
  }
  if(builtinToolEnabled(config,"skills.run"))result.push({type:"function",function:{name:"skills_run",description:"Run an exact reviewed Python script from an activated selected skill in the approved isolated no-network sandbox. Script source need not be loaded into context. Uses only approved artifact inputs and package files; no extra dependencies.",parameters:{type:"object",properties:{skillId:{type:"string",enum:config.skillIds},path:{type:"string",minLength:1,maxLength:256},inputArtifactIds:{type:"array",maxItems:32,items:{type:"string",format:"uuid"}}},required:["skillId","path"],additionalProperties:false}}});
  if(permitted.has("agents.delegate") && config.capabilities.delegation.enabled) result.push({type:"function",function:{
    name:"agents_delegate",description:"Delegate a brief to approved specialists and wait for their results. Each specialist uses its published scope and allocation. Available roles: "+JSON.stringify(config.capabilities.delegation.bindings.map(binding=>({
      bindingId:binding.id,name:binding.label??binding.id,purpose:(binding.description??"Published business specialist").slice(0,128)}))),
    parameters:{type:"object",properties:{requests:{type:"array",minItems:1,maxItems:2,items:{type:"object",properties:{
      bindingId:{type:"string",enum:config.capabilities.delegation.bindings.map(binding=>binding.id)},brief:{type:"string",minLength:1,maxLength:8192}},required:["bindingId","brief"],additionalProperties:false}}},required:["requests"],additionalProperties:false}}});
  if(permitted.has("sandbox.analyze") && config.capabilities.sandbox.enabled) result.push({type:"function",function:{
    name:"sandbox_analyze",description:"Run standard-library Python in the approved temporary no-network analysis environment. Read selected authorized inputs and write report files to the export directory.",
    parameters:{type:"object",properties:{code:{type:"string",minLength:1,maxLength:16384},inputArtifactIds:{type:"array",maxItems:32,items:{type:"string",format:"uuid"}}},required:["code"],additionalProperties:false}}});
  if(config.capabilities.businessActions.enabled){result.push(
    {type:"function",function:{name:"booking_availability",description:"Find open appointment times using the selected business calendar and booking rules. Returns slots only, never private calendar events.",parameters:{type:"object",properties:{start:{type:"string",format:"date-time"},end:{type:"string",format:"date-time"}},required:["start","end"],additionalProperties:false}}});
    if(config.capabilities.businessActions.permittedOperations.includes("calendar.book"))result.push({type:"function",function:{name:"booking_reserve",description:"Propose one appointment at an available start time. The customer must confirm the exact appointment in the interface. Only a confirmed provider receipt means it is booked.",parameters:{type:"object",properties:{start:{type:"string",format:"date-time"}},required:["start"],additionalProperties:false}}});
  }
  return [...result, ...connectedTools];
}
