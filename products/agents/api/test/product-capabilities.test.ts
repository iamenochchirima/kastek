import {randomUUID} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import type {ProductCapabilityManifest,ProductCapabilityDescriptor} from "@kasitek-labs/contracts";
import {registerProductAdapter,registerProductManifest,createProductBindings,productModelTools,productDescriptor} from "../src/capabilities/products/product-capabilities";
import {requestDigest,defaultBusinessConfiguration,executionGrantSchema,assertGrantAuthority,PlatformError} from "../src/contracts/contracts";
import {createDependencyManifest} from "../src/contracts/source-contracts";
import {ProductRuntime,validateProductArguments} from "../src/execution/products/product-runtime";
import {capabilityBindingSchema,capabilityPolicySchema} from "../src/contracts/capability-catalog";
import {compilePublishedComposition} from "../src/execution/programs/publication";
function fixture(effect: "read" | "draft_write" | "authorized_write" = "read"){
 const adapter=registerProductAdapter({schemaVersion:1,id:"neutral-test-"+randomUUID(),release:"1",executableDigest:"a".repeat(64),transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true},{handlers:["records.read@1","records.other@1"],invoke:async()=>({value:{}})});
 const descriptor:ProductCapabilityDescriptor={operation:"records.read",revision:"1",handlerRef:"records.read@1",description:"Read records available to the current destination actor",inputSchema:{type:"object",properties:{id:{type:"string",minLength:1,maxLength:128}},required:["id"],additionalProperties:false},outputSchema:null,policy:effect==="read"?{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"}:{effect,disclosure:"exact_requested_payload",retry:"status_only",approval:"none",cancel:"reconcile_claimed"},requiredAuthority:["records.read"],evidence:"versioned_sources",limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxResponseBytes:32768,maxModelResultBytes:8192}};
 const content={schemaVersion:1 as const,product:"fixture-product",revision:"1",adapter,operations:[descriptor]},manifest:ProductCapabilityManifest={...content,digest:requestDigest(content)};
 const bindings=createProductBindings(manifest,randomUUID(),{originProduct:"growth",originTenantId:"origin-business",tenantId:"destination-workspace",mappingRef:"explicit-destination-map",policyRevision:"1"},[descriptor.operation]);
 return {manifest,descriptor,bindings};
}
describe("installed product capability composition",()=>{
 it("adds an installed operation without native aliases or shared purpose dispatch",()=>{const {bindings}=fixture(),config=defaultBusinessConfiguration();config.program={id:"tool-directed",version:"3"};config.productBindings=bindings;
 const composition=compilePublishedComposition(config,[]);expect(composition.productBindings).toEqual(bindings.map(({id,digest})=>({id,digest})));expect(productModelTools(bindings)[0]!.function.name).toBe(bindings[0]!.alias);expect(config.tools).toEqual([]);});
 it("keeps destination mappings distinct and pins all descriptor and policy inputs",()=>{const {bindings}=fixture(),binding=bindings[0]!;expect(binding.connection).toBeNull();expect(binding.authority!.originTenantId).not.toBe(binding.authority!.tenantId);const config=defaultBusinessConfiguration();config.program={id:"tool-directed",version:"3"};config.productBindings=bindings;const first=compilePublishedComposition(config,[]);
 const changed={...binding,authority:{...binding.authority!,mappingRef:"other-map"}};const {digest:_,...content}=changed;const next={...content,digest:requestDigest(content)};expect(compilePublishedComposition({...config,productBindings:[next]},[]).digest).not.toBe(first.digest);});
 it("rejects unknown handlers, edited schema, aliases and undescribed installed operations",()=>{const {manifest,bindings}=fixture();const content={...manifest,operations:[{...manifest.operations[0]!,handlerRef:"uninstalled@1"}]};const {digest:_,...payload}=content;expect(()=>registerProductManifest({...payload,digest:requestDigest(payload)})).toThrow();
 const binding=bindings[0]!;expect(()=>productDescriptor({...binding,alias:"pretend_read"})).toThrow();const descriptor={...manifest.operations[0]!,operation:"records.other",handlerRef:"records.other@1"};const {digest:__,...base}=binding;const forged={...base,definition:{...base.definition,providerOperation:descriptor.operation,product:{...base.definition.product!,handlerRef:descriptor.handlerRef}},authority:{...base.authority!,handlerRef:descriptor.handlerRef,descriptorDigest:requestDigest(descriptor)}};expect(()=>productDescriptor({...forged,digest:requestDigest(forged)})).toThrow();});
 it("validates recoverable arguments from the exact canonical schema",async()=>{const {bindings}=fixture();await expect(validateProductArguments(bindings[0]!,{})).rejects.toMatchObject({code:"TOOL_ARGUMENTS_INVALID"});await expect(validateProductArguments(bindings[0]!,{id:"one",sql:"select"})).rejects.toMatchObject({code:"TOOL_ARGUMENTS_INVALID"});await expect(validateProductArguments(bindings[0]!,{id:"one"})).resolves.toBeUndefined();});
 it("reconciles an interrupted reviewed effect without issuing another commit",async()=>{const {bindings}=fixture(),taskId=randomUUID(),operationId="tool:"+taskId+":0:0",review={id:"opaque-review",product:"fixture-product",taskId,operationId,payloadDigest:"a".repeat(64),state:"approved" as const,expiresAt:new Date(Date.now()+60000).toISOString()};
 const runtime=Object.create(ProductRuntime.prototype) as ProductRuntime,receipt={id:"domain-record",operationId,payloadDigest:review.payloadDigest,state:"saved" as const};
 runtime.review=vi.fn(async()=>({value:{},review:{...review,state:"saved" as const},receipt}));runtime.project=vi.fn(async()=>{});
 await expect(runtime.commit(taskId,operationId,bindings[0]!,review,undefined,true)).resolves.toMatchObject({receipt});expect(runtime.review).toHaveBeenCalledOnce();
 runtime.review=vi.fn(async()=>({value:{},review}));await expect(runtime.commit(taskId,operationId,bindings[0]!,review,undefined,true)).rejects.toMatchObject({code:"PRODUCT_EFFECT_UNCERTAIN"});});
 it("refuses conflicting revisions for the same bound product source",()=>{
 const {bindings}=fixture(),dependency={kind:"product" as const,product:"fixture-product",tenantId:"destination-workspace",taskId:randomUUID(),bindingId:bindings[0]!.id,bindingDigest:bindings[0]!.digest,sourceId:"record-one",contextRevision:"a".repeat(64)};
 expect(()=>createDependencyManifest([dependency,{...dependency,contextRevision:"b".repeat(64)}])).toThrowError(expect.objectContaining({code:"EVIDENCE_POLICY_CONFLICT"}));
 });
 it("pins the prepared review identity and payload before approval too",async()=>{
 const {bindings}=fixture(),taskId=randomUUID(),operationId="tool:"+taskId+":0:0";
 const review={id:"original-review",product:"fixture-product",taskId,operationId,payloadDigest:"a".repeat(64),state:"proposed" as const,expiresAt:new Date(Date.now()+60000).toISOString()};
 const runtime=Object.create(ProductRuntime.prototype) as ProductRuntime;runtime.project=vi.fn(async()=>{});
 for(const changed of [{...review,id:"substituted-review"},{...review,payloadDigest:"b".repeat(64)}]){
   Object.assign(runtime,{dispatch:vi.fn(async()=>({value:{},review:changed}))});
   await expect(runtime.review(taskId,operationId,bindings[0]!,review)).rejects.toMatchObject({code:"PRODUCT_AUTHORITY_INACTIVE"});
 }
 expect(runtime.project).not.toHaveBeenCalled();
 });
 it("does not allow product tools in an incompatible program",()=>{const {bindings}=fixture(),config=defaultBusinessConfiguration();config.productBindings=bindings;expect(()=>compilePublishedComposition(config,[])).toThrowError(expect.objectContaining({code:"PROGRAM_COMPOSITION_DENIED"}));});
});


describe("direct private product writes", () => {
 it("requires installed product authority and rejects unsafe policy combinations", () => {
  const {bindings} = fixture("draft_write"), binding = bindings[0]!;
  expect(binding.policy.effect).toBe("draft_write");
  for(const patch of [{retry:"safe_read"},{approval:"exact_single_use"},{disclosure:"approved_resource_identifiers"},{cancel:"stop_admission"}])
    expect(capabilityPolicySchema.safeParse({...binding.policy,...patch}).success).toBe(false);
  const {authority:_,digest:__,...rest}=binding, forged={...rest,digest:requestDigest(rest)};
  const parsed=capabilityBindingSchema.safeParse(forged);
  expect(parsed.success).toBe(false);
  if(!parsed.success)expect(parsed.error.issues.some(issue=>issue.message==="Direct product writes require installed product authority")).toBe(true);
 });
 it("requires product.write even though no separate draft review is needed", () => {
  const {bindings}=fixture("draft_write"),config=defaultBusinessConfiguration();config.program={id:"tool-directed",version:"3"};config.productBindings=bindings;
  const authority={product:"growth" as const,organizationId:bindings[0]!.organizationId,resourceId:"business",callerClientId:"growth-api",principal:{kind:"human" as const,issuer:"https://identity.example",subject:"person"}};
  const versionId=randomUUID(),grant=executionGrantSchema.parse({...authority,id:randomUUID(),versionId,operations:["model.reply","product.read"],sourceRevisionIds:[],maxInputBytes:config.model.maxInputBytes,maxOutputTokens:config.model.maxOutputTokens,maxContextTokens:config.context.maxInputTokens,rootTokenLimit:32000,expiresAt:new Date(Date.now()+60000).toISOString(),revokedAt:null});
  expect(()=>assertGrantAuthority(grant,authority,versionId,config)).toThrowError(expect.objectContaining({code:"GRANT_PRODUCT_DENIED"}));
  expect(()=>assertGrantAuthority({...grant,operations:[...grant.operations,"product.write"]},authority,versionId,config)).not.toThrow();
 });
 function runtimeFixture(effect: "draft_write" | "authorized_write" = "draft_write") {
  const {bindings}=fixture(effect),binding=bindings[0]!,operationId="tool:"+randomUUID(),args={id:"one"};
  const receipt={id:randomUUID(),operationId,payloadDigest:requestDigest({operation:binding.definition.providerOperation,version:"1",input:args}),state:"saved" as const};
  const runtime=Object.create(ProductRuntime.prototype) as ProductRuntime;
  Object.assign(runtime,{observe:vi.fn(async(_task:unknown,_operation:unknown,_binding:unknown,value:unknown)=>value)});
  return {runtime,binding,operationId,args,receipt,taskId:randomUUID()};
 }
 it("executes delegated public writes directly and reconciles interrupted calls without a second mutation", async () => {
  const {runtime,binding,operationId,args,receipt,taskId}=runtimeFixture("authorized_write");
  expect(binding.policy.effect).toBe("authorized_write");
  const dispatch=vi.fn(async(..._input:unknown[])=>({value:{state:"succeeded"},receipt}));Object.assign(runtime,{dispatch});
  await expect(runtime.invoke(taskId,operationId,binding,args)).resolves.toMatchObject({receipt});
  expect(dispatch.mock.calls.map(call=>call[4])).toEqual(["invoke"]);
  dispatch.mockReset();dispatch.mockRejectedValueOnce(new PlatformError("PRODUCT_UNAVAILABLE",503,"Unavailable")).mockResolvedValueOnce({value:{state:"succeeded"},receipt});
  await expect(runtime.invoke(taskId,operationId,binding,args)).resolves.toMatchObject({receipt});
  expect(dispatch.mock.calls.map(call=>call[4])).toEqual(["invoke","review"]);
 });
 it("invokes requested private writes directly and requires their exact saved receipt", async () => {
  const {runtime,binding,operationId,args,receipt,taskId}=runtimeFixture();
  const dispatch=vi.fn(async(..._input:unknown[])=>({value:{postId:"saved-post"},receipt}));Object.assign(runtime,{dispatch});
  await expect(runtime.invoke(taskId,operationId,binding,args)).resolves.toMatchObject({receipt});
  expect(dispatch).toHaveBeenCalledOnce();expect(dispatch.mock.calls[0]?.[4]).toBe("invoke");
  for(const wrong of [{...receipt,operationId:"another"},{...receipt,payloadDigest:"f".repeat(64)}]){
    Object.assign(runtime,{dispatch:vi.fn(async()=>({value:{},receipt:wrong}))});
    await expect(runtime.invoke(taskId,operationId,binding,args)).rejects.toMatchObject({code:"PRODUCT_EFFECT_UNCERTAIN"});
  }
 });
 it("uses observation only after interruption and never repeats an uncertain draft mutation", async () => {
  const {runtime,binding,operationId,args,receipt,taskId}=runtimeFixture();
  const dispatch=vi.fn(async(..._input:unknown[])=>({value:{},receipt}));Object.assign(runtime,{dispatch});
  await expect(runtime.invoke(taskId,operationId,binding,args,undefined,true)).resolves.toMatchObject({receipt});
  expect(dispatch).toHaveBeenCalledOnce();expect(dispatch.mock.calls[0]?.[4]).toBe("review");
  dispatch.mockReset();dispatch.mockRejectedValueOnce(new PlatformError("PRODUCT_UNAVAILABLE",503,"Unavailable")).mockResolvedValueOnce({value:{},receipt});
  await expect(runtime.invoke(taskId,operationId,binding,args)).resolves.toMatchObject({receipt});
  expect(dispatch.mock.calls.map(call=>call[4])).toEqual(["invoke","review"]);
  dispatch.mockReset();dispatch.mockResolvedValueOnce({value:{}} as never);
  await expect(runtime.invoke(taskId,operationId,binding,args,undefined,true)).rejects.toMatchObject({code:"PRODUCT_EFFECT_UNCERTAIN"});
  expect(dispatch.mock.calls.map(call=>call[4])).toEqual(["review"]);
 });
});
