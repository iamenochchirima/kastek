import { createHash,randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { extname,join } from "node:path";
import { z } from "zod";
import { createBinding,createCatalog,capabilityBindingSchema,capabilityCatalogSchema,digestToolSchema,type AdapterManifest,type CapabilityBinding,type CapabilityCatalog } from "../../contracts/capability-catalog";
import { PlatformError,requestDigest,canonicalJson } from "../../contracts/contracts";
import { connectorConfiguration,connectorExecutionDigest,type NativeConnectorConfiguration } from "../../adapters/providers/connector-registry";
import { HubSpotContactsClient } from "../../adapters/providers/hubspot-contacts";
import type { NetworkAttempt } from "../../infrastructure/connected-network";

export function nativeProviderAdapterManifest():AdapterManifest {
  const extension=extname(__filename),hash=createHash("sha256");
  for(const path of ["./native-provider-tools","./connected-executor","./connected-tool-schema","../../product/connections/provider-connections","../../adapters/providers/hubspot-contacts","../../adapters/providers/connector-registry","../../contracts/capability-catalog","./customer-native-policy","../reviews/tool-reviews","../../product/channels/channel-tool-reviews","../../contracts/channel","../../execution/context/evidence-policy","../../infrastructure/connected-network"])
    hash.update(path).update(readFileSync(join(__dirname,path+extension)));
  return {schemaVersion:1,id:"native-provider",release:"1",executableDigest:hash.digest("hex"),transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true};
}
function reference():CapabilityCatalog["adapter"] {
  const manifest=nativeProviderAdapterManifest();return {id:manifest.id,release:manifest.release,manifestDigest:requestDigest(manifest)};
}
const emailParameter={type:"string",minLength:3,maxLength:254};
const nameParameter={type:"string",minLength:1,maxLength:256};
function schema(operation:string):Record<string,any> {
  if(!["contacts.search","contacts.create"].includes(operation))throw new PlatformError("NATIVE_PROVIDER_OPERATION_UNAVAILABLE",403,"Provider operation is unavailable");
  return {type:"object",properties:{email:emailParameter,...(operation==="contacts.create"?{firstName:nameParameter,lastName:nameParameter}:{})},required:["email"],additionalProperties:false};
}
function assertProvider(definition:NativeConnectorConfiguration):void {
  if(definition.adapterKey!=="hubspot-contacts-v1"||definition.profileId!=="hubspot-contacts-v1")throw new PlatformError("NATIVE_PROVIDER_UNAVAILABLE",403,"Provider handler is unavailable");
}
export function createNativeProviderCatalog(definition:NativeConnectorConfiguration,input:{id:string;organizationId:string;connectionId:string;revision:number}):CapabilityCatalog {
  assertProvider(definition);
  return createCatalog({schemaVersion:1,...input,transport:"native_http",protocolVersion:null,adapter:reference(),tools:definition.operations.map(operation=>{
    const inputSchema=schema(operation.id);
    return {providerOperation:operation.id,description:operation.description,inputSchema,inputDigest:digestToolSchema(inputSchema),outputSchema:null,outputDigest:null,
      managed:{providerId:definition.id,connectorDigest:connectorExecutionDigest(definition)}};
  })});
}
export function nativeProviderBindings(catalog:CapabilityCatalog,options:{accountId?:string;policyRevision:number;resource:{kind:"provider.account";id:string}}):CapabilityBinding[] {
  const pinned=capabilityCatalogSchema.parse(catalog);
  z.strictObject({kind:z.literal("provider.account"),id:z.string().min(1).max(4096)}).parse(options.resource);
  return pinned.tools.map(tool=>{
    const managed=tool.managed;if(!managed)throw new PlatformError("NATIVE_PROVIDER_DEFINITION_INVALID",403,"Provider operation is not pinned");
    const definition=connectorConfiguration(managed.providerId) as NativeConnectorConfiguration;assertProvider(definition);
    if(managed.connectorDigest!==connectorExecutionDigest(definition))throw new PlatformError("NATIVE_PROVIDER_DEFINITION_CHANGED",409,"Provider configuration has changed");
    return createBinding({schemaVersion:1,id:randomUUID(),organizationId:pinned.organizationId,catalog:{id:pinned.id,revision:pinned.revision,digest:pinned.digest},definition:tool,adapter:pinned.adapter,
      transport:"native_http",protocolVersion:null,connection:{id:pinned.connectionId!,profileId:definition.profileId,policyRevision:options.policyRevision},resources:[options.resource],
      policy:tool.providerOperation==="contacts.create"?{effect:"reviewed_write",retry:"status_only",approval:"exact_single_use",disclosure:"exact_reviewed_payload",cancel:"reconcile_claimed"}:
        {effect:"read",retry:"never",approval:"none",disclosure:"approved_resource_identifiers",cancel:"stop_admission"},
      limits:{timeoutMs:30000,maxPhysicalAttempts:1,maxPhysicalRequests:3,maxResponseBytes:65536,maxModelResultBytes:8192}},pinned);
  });
}
export interface NativeProviderExecutionOptions {
  organizationId:string;operationId:string;deadlineAt:number;signal?:AbortSignal;testBaseUrl?:string;
  beforeAttempt?(phase:"read"|"effect"|"reconcile"):Promise<void>;
  onAttempt?(attempt:NetworkAttempt):Promise<void>;
}
export async function executeNativeProviderTool(rawBinding:CapabilityBinding,token:string,args:unknown,options:NativeProviderExecutionOptions):Promise<{result:unknown;resultDigest:string;isError:boolean}> {
  const binding=capabilityBindingSchema.parse(rawBinding),managed=binding.definition.managed;
  if(binding.organizationId!==options.organizationId||!managed||!binding.connection||binding.resources.length!==1||binding.resources[0]?.kind!=="provider.account")throw new PlatformError("NATIVE_PROVIDER_SCOPE_DENIED",403,"Provider account authority is unavailable");
  const definition=connectorConfiguration(managed.providerId) as NativeConnectorConfiguration;assertProvider(definition);
  if(managed.connectorDigest!==connectorExecutionDigest(definition)||canonicalJson(binding.adapter)!==canonicalJson(reference())||binding.connection.profileId!==definition.profileId)throw new PlatformError("NATIVE_PROVIDER_DEFINITION_CHANGED",409,"Provider configuration has changed");
  const expectedCatalog=createNativeProviderCatalog(definition,{id:binding.catalog.id,organizationId:binding.organizationId,connectionId:binding.connection.id,revision:binding.catalog.revision});
  const expected=expectedCatalog.tools.find(tool=>tool.providerOperation===binding.definition.providerOperation);
  if(expectedCatalog.digest!==binding.catalog.digest)throw new PlatformError("NATIVE_PROVIDER_DEFINITION_INVALID",403,"Provider catalog does not match its installed definition");
  if(!expected||canonicalJson(expected)!==canonicalJson(binding.definition))throw new PlatformError("NATIVE_PROVIDER_DEFINITION_INVALID",403,"Provider operation definition is unavailable");
  const name=z.string().trim().min(1).max(256).refine(value=>!/[\x00-\x1f\x7f]/.test(value));
  const fields=binding.definition.providerOperation==="contacts.create"?
    z.strictObject({email:z.email().max(254),firstName:name.optional(),lastName:name.optional()}).parse(args):z.strictObject({email:z.email().max(254)}).parse(args);
  const client=new HubSpotContactsClient(token,{deadlineAt:Math.min(options.deadlineAt,Date.now()+binding.limits.timeoutMs),signal:options.signal,testBaseUrl:options.testBaseUrl,apiBaseUrl:definition.apiBaseUrl,onAttempt:options.onAttempt,
    beforeAttempt:operation=>options.beforeAttempt?.(operation==="create"?"effect":operation==="reconcile"?"reconcile":"read")??Promise.resolve()});
  const result=binding.definition.providerOperation==="contacts.search"?await client.searchContacts(fields):await client.createContact({...fields,organizationId:options.organizationId,requestId:options.operationId,requestDigest:requestDigest(fields)});
  const isError=!Array.isArray(result)&&result.state==="uncertain";
  if(Buffer.byteLength(JSON.stringify(result))>binding.limits.maxModelResultBytes)throw new PlatformError("NATIVE_PROVIDER_RESULT_LIMIT",502,"Provider result exceeds its bound");
  return {result,resultDigest:requestDigest(result),isError};
}
