import { describe,expect,it } from "vitest";
import { builtinArgumentFeedback, externalArgumentFeedback } from "../src/capabilities/tool-argument-feedback";
import { validateBuiltinArguments } from "../src/capabilities/tool-contracts";

const request=(bindingId:string)=>({bindingId,brief:"PRIVATE_BRIEF_DO_NOT_ECHO"});
describe("bounded builtin argument feedback",()=>{
 it("explains the real three-request failure and permits a model-authored corrected call",()=>{
  const input={requests:[request("research"),request("content"),request("review")]};
  expect(()=>validateBuiltinArguments("agents.start",input)).toThrowError(expect.objectContaining({code:"TOOL_ARGUMENTS_INVALID"}));
  const feedback=builtinArgumentFeedback("agents.start",JSON.stringify(input),"TOOL_ARGUMENTS_INVALID");
  expect(feedback).toEqual({argumentIssues:[{path:["requests"],code:"too_big",message:"Use at most 2 items.",maximum:2,type:"array"}]});
  expect(JSON.stringify(feedback)).not.toContain("PRIVATE_BRIEF");
  const corrected={requests:input.requests.slice(0,2)};
  expect(validateBuiltinArguments("agents.start",corrected)).toEqual(corrected);
  expect(builtinArgumentFeedback("agents.start",JSON.stringify(corrected),"TOOL_ARGUMENTS_INVALID")).toBeUndefined();
  // A restored tool call derives the same observation; no dispatch or auto-correction happens here.
  expect(builtinArgumentFeedback("agents.start",JSON.stringify(input),"TOOL_ARGUMENTS_INVALID")).toEqual(feedback);
 });
 it("returns known field paths and safe format/type constraints without submitted values",()=>{
  const input={requests:[{bindingId:"PRIVATE_INVALID_ID!",brief:42}]};
  const feedback=builtinArgumentFeedback("agents.start",JSON.stringify(input),"TOOL_ARGUMENTS_INVALID");
  expect(feedback?.argumentIssues).toContainEqual({path:["requests",0,"bindingId"],code:"invalid_format",message:"Use the required field format from the tool schema."});
  expect(feedback?.argumentIssues).toContainEqual({path:["requests",0,"brief"],code:"invalid_type",type:"string",message:"Expected string."});
  expect(JSON.stringify(feedback)).not.toContain("PRIVATE_INVALID_ID");expect(JSON.stringify(feedback)).not.toContain("42");
 });
 it("gives actionable contact format feedback without echoing private input",()=>{
  const base={requestId:crypto.randomUUID(),action:"save_contact",evidenceMessageId:crypto.randomUUID(),evidenceQuote:"PRIVATE_CUSTOMER_MESSAGE"};
  for(const [method,value,message] of [["email","PRIVATE_ADDRESS_WITHOUT_AT","Enter a valid email address. Ask the customer to confirm any correction."],["phone","123","Enter a valid phone number. Ask the customer to confirm any correction."]] as const){
   const feedback=builtinArgumentFeedback("support.update_assistance",JSON.stringify({...base,contact:{method,value}}),"TOOL_ARGUMENTS_INVALID");
   expect(feedback?.argumentIssues).toContainEqual({path:["contact","value"],code:"custom",message});
   expect(JSON.stringify(feedback)).not.toContain("PRIVATE_");
  }
 });
 it("never echoes unrecognized property names, enum values or malformed JSON",()=>{
  for(const [name,args]of [
    ["agents.start",JSON.stringify({requests:[request("research")],PRIVATE_KEY_CONTAINING_CONTENT:"PRIVATE_VALUE"})],
    ["memory.propose",JSON.stringify({content:"PRIVATE_VALUE",kind:"PRIVATE_ENUM_VALUE"})],
    ["agents.start",'{"PRIVATE_MALFORMED_VALUE":'],
  ]){
   const feedback=builtinArgumentFeedback(name!,args!,"TOOL_ARGUMENTS_INVALID");
   expect(feedback?.argumentIssues.length).toBeGreaterThan(0);expect(JSON.stringify(feedback)).not.toContain("PRIVATE_");
  }
  expect(builtinArgumentFeedback("agents.start",'{"PRIVATE_MALFORMED_VALUE":',"TOOL_ARGUMENTS_INVALID")).toEqual({argumentIssues:[{path:[],code:"invalid_json",message:"Use valid JSON matching the tool schema."}]});
 });
 it.each(["DELEGATION_SCOPE_DENIED","GRANT_REVOKED","ROOT_LIMIT","CAPABILITY_RESULT_INVALID","SPECIALIST_SCOPE_DENIED","MODEL_PROVIDER_UNAVAILABLE"])("does not relabel %s as a correctable argument failure",code=>{
  expect(builtinArgumentFeedback("agents.start",JSON.stringify({requests:[]}),code)).toBeUndefined();
 });
 it("bounds metadata and declines unknown or connected capability schemas",()=>{
  const feedback=builtinArgumentFeedback("agents.start",JSON.stringify({requests:Array.from({length:100},()=>({bindingId:"PRIVATE!",brief:42}))}),"TOOL_ARGUMENTS_INVALID");
  expect(feedback!.argumentIssues.length).toBeLessThanOrEqual(6);expect(Buffer.byteLength(JSON.stringify(feedback))).toBeLessThanOrEqual(2100);
  expect(JSON.stringify(feedback)).not.toContain("PRIVATE");
  expect(builtinArgumentFeedback("unknown.tool","{}","TOOL_ARGUMENTS_INVALID")).toBeUndefined();
  expect(builtinArgumentFeedback("t_"+"a".repeat(32),"{}","TOOL_ARGUMENTS_INVALID")).toBeUndefined();
 });
 it("provides bounded connected-tool feedback without provider content or customer data",()=>{
  expect(externalArgumentFeedback('{"secret":"PRIVATE"}',"MCP_ARGUMENTS_INVALID")).toEqual({argumentIssues:[{path:[],code:"invalid_arguments",message:"Check the supplied arguments against the tool schema. Ask the user to confirm any correction to their information."}]});
  expect(externalArgumentFeedback('{"PRIVATE":',"TOOL_ARGUMENTS_INVALID")).toEqual({argumentIssues:[{path:[],code:"invalid_json",message:"Use valid JSON matching the tool schema."}]});
  expect(externalArgumentFeedback('{}',"CONNECTED_OPERATION_UNCERTAIN")).toBeUndefined();
 });

});
