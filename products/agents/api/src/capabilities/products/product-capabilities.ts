import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { ProductCapabilityDescriptor,ProductCapabilityManifest,ProductCapabilityInvocation,ProductCapabilityResult } from "@kasitek-labs/contracts";
import { canonicalJson,PlatformError,requestDigest } from "../../contracts/contracts";
import { adapterReferenceSchema,capabilityBindingSchema,capabilityPolicySchema,catalogToolSchema,createModelAlias,
  ExecutableAdapterRegistry,preflightToolSchema,type AdapterManifest,type CapabilityBinding } from "../../contracts/capability-catalog";
import type { ToolDefinition } from "../../execution/business/model";
const digest=z.string().regex(/^[a-f0-9]{64}$/),id=z.string().min(1).max(128);
const descriptorSchema=z.strictObject({operation:id,revision:id,description:z.string().min(1).max(4096),inputSchema:z.record(z.string(),z.unknown()),
  outputSchema:z.record(z.string(),z.unknown()).nullable(),handlerRef:id,policy:capabilityPolicySchema,requiredAuthority:z.array(id).min(1).max(16),
  evidence:z.enum(["none","versioned_sources"]),limits:z.strictObject({timeoutMs:z.number().int().min(1).max(240000),maxPhysicalAttempts:z.number().int().min(1).max(3),maxResponseBytes:z.number().int().min(1).max(2097152),maxModelResultBytes:z.number().int().min(1).max(8192)})});
const manifestSchema=z.strictObject({schemaVersion:z.literal(1),product:id,revision:id,adapter:adapterReferenceSchema,operations:z.array(descriptorSchema).min(1).max(24),digest});
export interface InstalledProductAdapter { handlers:readonly string[]; invoke(command:ProductCapabilityInvocation,signal?:AbortSignal):Promise<ProductCapabilityResult> }
export const productAdapterRegistry=new ExecutableAdapterRegistry<InstalledProductAdapter>();
const manifests=new Map<string,ProductCapabilityManifest>();
const installedMetadata=new Map<string,InstalledProductAdapter>();
export function registerProductAdapter(manifest:AdapterManifest,adapter:InstalledProductAdapter){
  const key=canonicalJson([manifest.id,manifest.release]),prior=installedMetadata.get(key),handlers=[...adapter.handlers].sort();
  if(prior&&canonicalJson(prior.handlers)!==canonicalJson(handlers))throw new PlatformError("ADAPTER_RELEASE_CONFLICT",409,"The installed handler release changed");
  const metadata=prior??Object.freeze({handlers:Object.freeze(handlers),invoke:async()=>{throw new PlatformError("PRODUCT_RUNTIME_UNAVAILABLE",503,"The runtime has no destination adapter");}});
  const reference=productAdapterRegistry.register(manifest,metadata);installedMetadata.set(key,metadata);return reference;
}
export function registerProductManifest(input:ProductCapabilityManifest):ProductCapabilityManifest {
  const parsed=manifestSchema.parse(input),{digest:hash,...content}=parsed;
  if(requestDigest(content)!==hash||new Set(parsed.operations.map(op=>op.operation)).size!==parsed.operations.length)throw invalid();
  const adapter=productAdapterRegistry.resolve({adapter:parsed.adapter,transport:"native_http",protocolVersion:null});
  for(const operation of parsed.operations){
    if(!adapter.handlers.includes(operation.handlerRef)||!["read","reviewed_write"].includes(operation.policy.effect))throw invalid();
    preflightToolSchema(operation.inputSchema);if(operation.outputSchema)preflightToolSchema(operation.outputSchema);
    if(operation.inputSchema.type!=="object")throw invalid();
  }
  const prior=manifests.get(hash);if(prior&&canonicalJson(prior)!==canonicalJson(parsed))throw invalid();
  const frozen=structuredClone(parsed) as ProductCapabilityManifest;deepFreeze(frozen);manifests.set(hash,frozen);return frozen;
}
function deepFreeze(value:unknown):void{if(value&&typeof value==="object"){Object.values(value).forEach(deepFreeze);Object.freeze(value);}}
function invalid(){return new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The installed product capability release does not match");}
export function productDescriptor(binding:CapabilityBinding):ProductCapabilityDescriptor {
  const parsed=capabilityBindingSchema.parse(binding),authority=parsed.authority;if(!authority)throw invalid();
  const metadata=binding.definition.product;
  if(!metadata)throw invalid();
  const descriptor={operation:binding.definition.providerOperation,revision:metadata.revision,description:binding.definition.description,inputSchema:binding.definition.inputSchema,outputSchema:binding.definition.outputSchema,handlerRef:metadata.handlerRef,requiredAuthority:metadata.requiredAuthority,evidence:metadata.evidence,policy:binding.policy,limits:binding.limits} as ProductCapabilityDescriptor;
  const manifest=manifests.get(authority.manifestDigest);
  if(!manifest||!manifest.operations.some(value=>canonicalJson(value)===canonicalJson(descriptor))||manifest.product!==authority.destinationProduct||binding.catalog.digest!==authority.manifestDigest||requestDigest(descriptor)!==authority.descriptorDigest||descriptor.handlerRef!==authority.handlerRef||(manifest&&canonicalJson(manifest.adapter)!==canonicalJson(binding.adapter))||canonicalJson(descriptor.policy)!==canonicalJson(binding.policy)||canonicalJson(descriptor.limits)!==canonicalJson(binding.limits)||requestDigest(descriptor.inputSchema)!==binding.definition.inputDigest||requestDigest(descriptor.outputSchema)!==requestDigest(binding.definition.outputSchema)||descriptor.description!==binding.definition.description)throw invalid();
  const installed=productAdapterRegistry.resolve(binding);if(!installed.handlers.includes(descriptor.handlerRef))throw invalid();
  return descriptor;
}
export function assertProductBindings(bindings:readonly CapabilityBinding[]):void {
  if(bindings.length>24||new Set(bindings.map(binding=>binding.alias)).size!==bindings.length)throw invalid();
  for(const binding of bindings)productDescriptor(binding);
}
export function createProductBindings(manifestInput:ProductCapabilityManifest,organizationId:string,scope:{originProduct:string;originTenantId:string;tenantId:string;mappingRef:string;policyRevision:string},operations:readonly string[]):CapabilityBinding[] {
  const manifest=registerProductManifest(manifestInput);if(new Set(operations).size!==operations.length)throw invalid();
  return operations.map(operation=>{const descriptor=manifest.operations.find(op=>op.operation===operation);if(!descriptor)throw invalid();
    const bindingId=randomUUID();const definition=catalogToolSchema.parse({product:{revision:descriptor.revision,handlerRef:descriptor.handlerRef,requiredAuthority:descriptor.requiredAuthority,evidence:descriptor.evidence},providerOperation:operation,description:descriptor.description,inputSchema:descriptor.inputSchema,outputSchema:descriptor.outputSchema,inputDigest:requestDigest(descriptor.inputSchema),outputDigest:descriptor.outputSchema?requestDigest(descriptor.outputSchema):null});
    const content={schemaVersion:1 as const,id:bindingId,organizationId,alias:createModelAlias(bindingId),catalog:{id:organizationId,revision:1,digest:manifest.digest},definition,
      adapter:manifest.adapter,transport:"native_http" as const,protocolVersion:null,connection:null,resources:[],policy:descriptor.policy,limits:descriptor.limits,
      authority:{kind:"product" as const,...scope,destinationProduct:manifest.product,manifestDigest:manifest.digest,descriptorDigest:requestDigest(descriptor),handlerRef:descriptor.handlerRef}};
    return capabilityBindingSchema.parse({...content,digest:requestDigest(content)});
  });
}
export function productModelTools(bindings:readonly CapabilityBinding[]):ToolDefinition[]{assertProductBindings(bindings);return bindings.map(binding=>({type:"function",function:{name:binding.alias,description:binding.definition.description,parameters:binding.definition.inputSchema as Record<string,unknown>}}));}
export function productAdapter(binding:CapabilityBinding):InstalledProductAdapter{productDescriptor(binding);return productAdapterRegistry.resolve(binding);}

/** Binding identities are publication-local; authority requires identical validated descriptors and scope. */
export function sameProductAuthority(left:CapabilityBinding,right:CapabilityBinding):boolean {
  productDescriptor(left);productDescriptor(right);
  const scope=(binding:CapabilityBinding)=>{const {id,alias,digest,...authority}=binding;return authority;};
  return canonicalJson(scope(left))===canonicalJson(scope(right));
}
