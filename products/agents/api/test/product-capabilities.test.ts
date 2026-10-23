import {randomUUID} from "node:crypto";
import {describe,it,expect,vi} from "vitest";
import type {ProductCapabilityManifest,ProductCapabilityDescriptor} from "@kasitek-labs/contracts";
import {registerProductAdapter,registerProductManifest,createProductBindings,productModelTools,productDescriptor} from "../src/capabilities/products/product-capabilities";
import {requestDigest,defaultBusinessConfiguration} from "../src/contracts/contracts";
import {createDependencyManifest} from "../src/contracts/source-contracts";
import {ProductRuntime,validateProductArguments} from "../src/execution/products/product-runtime";
import {compilePublishedComposition} from "../src/execution/programs/publication";
function fixture(){
 const adapter=registerProductAdapter({schemaVersion:1,id:"neutral-test-"+randomUUID(),release:"1",executableDigest:"a".repeat(64),transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true},{handlers:["records.read@1","records.other@1"],invoke:async()=>({value:{}})});
 const descriptor:ProductCapabilityDescriptor={operation:"records.read",revision:"1",handlerRef:"records.read@1",description:"Read records available to the current destination actor",inputSchema:{type:"object",properties:{id:{type:"string",minLength:1,maxLength:128}},required:["id"],additionalProperties:false},outputSchema:null,policy:{effect:"read",disclosure:"approved_resource_identifiers",retry:"safe_read",approval:"none",cancel:"stop_admission"},requiredAuthority:["records.read"],evidence:"versioned_sources",limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxResponseBytes:32768,maxModelResultBytes:8192}};
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
