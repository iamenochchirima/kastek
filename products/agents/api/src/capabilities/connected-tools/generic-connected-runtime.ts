import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { PoolClient } from "pg";
import { REMOTE_MCP_LIMITS, REMOTE_MCP_RELEASE, executeRemoteMcpTool, type RemoteMcpEndpoint,
  type RemoteMcpHooks, type RemoteMcpInventory, type RemoteMcpTool } from "../../adapters/providers/remote-mcp";
import { createCatalog, digestToolSchema, type AdapterManifest, type CapabilityBinding, type CapabilityCatalog } from "../../contracts/capability-catalog";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { OpenApiImport,OpenApiSchema,RequestTemplate } from "../../adapters/providers/openapi";
import { NATIVE_API_RELEASE,NATIVE_API_LIMITS,executeNativeApiOperation,type NativeApiOperationRuntime,type NativeApiOptions } from "../../adapters/providers/native-api";

export interface GenericToolReviewInput {
  taskId: string; operationId: string; binding: CapabilityBinding; arguments: Record<string, unknown>; requestDigest: string;
}
export interface GenericToolReviewPort {
  assertApproved(db: PoolClient, input: GenericToolReviewInput): Promise<void>;
  claim(db: PoolClient, input: GenericToolReviewInput): Promise<void>;
  completed?(db: PoolClient, input: GenericToolReviewInput, resultDigest: string): Promise<void>;
  failed?(db: PoolClient, input: GenericToolReviewInput, result: { uncertain: boolean }): Promise<void>;
}
export function genericToolReviewDigest(binding: CapabilityBinding, args: unknown): string {
  return requestDigest({ bindingDigest: binding.digest, arguments: args });
}
export function remoteMcpAdapterManifest(): AdapterManifest {
  const extension = extname(__filename), hash = createHash("sha256");
  const files = ["./generic-connected-runtime", "./connected-executor", "./connected-tool-schema", "./connected-catalog-store",
    "../../adapters/providers/remote-mcp", "../../adapters/providers/native-api", "../../adapters/providers/openapi",
    "../../contracts/capability-catalog", "../../contracts/connections", "../../infrastructure/connected-network"];
  for (const path of files) hash.update(path).update(readFileSync(join(__dirname, path + extension)));
  // Pin the installed executable SDK and validator chunks, not only a package-version string.
  const sdk = dirname(require.resolve("@modelcontextprotocol/client"));
  for (const name of readdirSync(sdk).filter(name => name.endsWith(".cjs")).sort()) hash.update(name).update(readFileSync(join(sdk, name)));
  return { schemaVersion: 1, id: "remote-mcp", release: REMOTE_MCP_RELEASE, executableDigest: hash.digest("hex"), transports: ["mcp_http"],
    protocolVersions: ["2026-07-28", "2025-11-25"], boundedSchemaValidation: true };
}
export function remoteMcpAdapterReference(): CapabilityCatalog["adapter"] {
  const manifest = remoteMcpAdapterManifest(); return { id: manifest.id, release: manifest.release, manifestDigest: requestDigest(manifest) };
}
export function createRemoteMcpCapabilityCatalog(inventory: RemoteMcpInventory, input: {
  id: string; organizationId: string; connectionId: string; revision: number;
}): CapabilityCatalog {
  return createCatalog({ schemaVersion: 1, ...input, transport: "mcp_http", protocolVersion: inventory.protocolVersion,
    adapter: remoteMcpAdapterReference(), tools: inventory.tools.filter(tool => tool.compatible).map(tool => ({ providerOperation: tool.name,
      description: tool.description.slice(0, 4096), inputSchema: tool.inputSchema as CapabilityCatalog["tools"][number]["inputSchema"],
      inputDigest: digestToolSchema(tool.inputSchema), outputSchema: tool.outputSchema as CapabilityCatalog["tools"][number]["outputSchema"] ?? null,
      outputDigest: tool.outputSchema ? digestToolSchema(tool.outputSchema) : null,
      remote: { definitionDigest: tool.definitionDigest, transport: inventory.transport } })) });
}
export function nativeApiAdapterManifest():AdapterManifest {
  const extension=extname(__filename),hash=createHash("sha256");
  for(const path of ["./generic-connected-runtime","./connected-executor","./connected-tool-schema","./connected-catalog-store",
    "../../adapters/providers/native-api","../../adapters/providers/openapi","../../contracts/capability-catalog","../../contracts/connections","../../infrastructure/connected-network"])
    hash.update(path).update(readFileSync(join(__dirname,path+extension)));
  return {schemaVersion:1,id:"native-api",release:NATIVE_API_RELEASE,executableDigest:hash.digest("hex"),transports:["native_http"],protocolVersions:[],boundedSchemaValidation:true};
}
export function nativeApiAdapterReference():CapabilityCatalog["adapter"]{
  const manifest=nativeApiAdapterManifest();return{id:manifest.id,release:manifest.release,manifestDigest:requestDigest(manifest)};
}
function nativeSchema(input:OpenApiSchema):OpenApiSchema{
  if(typeof input==="boolean")return input;
  const result:Record<string,unknown>={};
  for(const [key,value]of Object.entries(input)){
    if(["nullable","readOnly","writeOnly","example","deprecated"].includes(key)||key.startsWith("x-"))continue;
    if(key==="properties")result[key]=Object.fromEntries(Object.entries(value as object).map(([name,schema])=>[name,nativeSchema(schema as OpenApiSchema)]));
    else if(["items","additionalProperties"].includes(key))result[key]=nativeSchema(value as OpenApiSchema);
    else if(["exclusiveMinimum","exclusiveMaximum"].includes(key)&&typeof value==="boolean"){
      const bound=input[key==="exclusiveMinimum"?"minimum":"maximum"];if(value&&typeof bound==="number")result[key]=bound;
    }else if(key==="format"&&["int32","int64","float","double"].includes(String(value)))continue;
    else result[key]=value;
  }
  if(input.nullable===true&&typeof input.type==="string")result.type=[input.type,"null"];
  if(["int32","int64"].includes(String(input.format))&&(input.type==="integer"||input.type==="number")){
    const maximum=input.format==="int32"?2147483647:Number.MAX_SAFE_INTEGER,minimum=input.format==="int32"?-2147483648:-Number.MAX_SAFE_INTEGER;
    result.type=input.nullable===true?["integer","null"]:"integer";
    result.minimum=Math.max(typeof input.minimum==="number"?input.minimum:minimum,minimum);
    result.maximum=Math.min(typeof input.maximum==="number"?input.maximum:maximum,maximum);
  }
  return result as OpenApiSchema;
}
export function nativeApiRequestSchema(template:RequestTemplate):Record<string,unknown>{
  const properties:Record<string,unknown>={},required:string[]=[];
  for(const [location,key]of [["path","path"],["query","query"],["header","headers"]]as const){
    const selected=template.parameters.filter(parameter=>parameter.in===location);if(!selected.length)continue;
    const groupRequired=selected.filter(parameter=>parameter.required).map(parameter=>parameter.name);
    properties[key]={type:"object",properties:Object.fromEntries(selected.map(parameter=>[parameter.name,nativeSchema(parameter.schema)])),required:groupRequired,additionalProperties:false};
    if(groupRequired.length)required.push(key);
  }
  if(template.requestBody){properties.body=nativeSchema(template.requestBody.schema);if(template.requestBody.required)required.push("body");}
  return {type:"object",properties,required,additionalProperties:false};
}
export function createNativeApiCapabilityCatalog(imported:OpenApiImport,input:{id:string;organizationId:string;connectionId:string;revision:number}):CapabilityCatalog{
  const importDigest=requestDigest(imported);
  return createCatalog({schemaVersion:1,...input,transport:"native_http",protocolVersion:null,adapter:nativeApiAdapterReference(),
    tools:imported.operations.filter(operation=>operation.compatible&&operation.template&&operation.security?.type!=="oauth2").map(operation=>{
      const inputSchema=nativeApiRequestSchema(operation.template!);
      return {providerOperation:operation.alias,description:operation.summary.slice(0,4096),inputSchema:inputSchema as CapabilityCatalog["tools"][number]["inputSchema"],
        inputDigest:digestToolSchema(inputSchema),outputSchema:null,outputDigest:null,nativeApi:{templateDigest:operation.template!.digest,importDigest}};
    })});
}
export async function executeGenericNativeApi(binding:CapabilityBinding,operation:NativeApiOperationRuntime,args:Record<string,unknown>,options:NativeApiOptions){
  const pin=binding.definition.nativeApi;
  if(binding.connection?.profileId!=="custom-api-v1"||!pin||pin.templateDigest!==operation.template.digest||pin.importDigest!==operation.importDigest
    ||binding.connection.policyRevision!==operation.policyRevision||binding.resources.length!==1||binding.resources[0]?.kind!=="api.origin"||binding.resources[0]?.id!==operation.serverOrigin
    ||(binding.policy.effect==="read")!==(operation.effectPolicy==="owner_reviewed_read")
    ||requestDigest(nativeApiRequestSchema(operation.template))!==binding.definition.inputDigest)throw new PlatformError("API_OPERATION_CHANGED",403,"Selected API operation no longer matches the authorized binding");
  return executeNativeApiOperation(operation,args,{...options,deadlineAt:Math.min(options.deadlineAt,Date.now()+NATIVE_API_LIMITS.wallMs)});
}
export function genericConnectedArguments(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new PlatformError("CONNECTED_ARGUMENTS_INVALID", 400, "Expected tool arguments");
  const pending: { value: unknown; depth: number; ancestors: Set<object> }[] = [{ value: input, depth: 0, ancestors: new Set() }]; let count = 0;
  while (pending.length) {
    const { value, depth, ancestors } = pending.pop()!;
    if (++count > 4096 || depth > 16) throw new PlatformError("CONNECTED_ARGUMENTS_LIMIT", 413, "Tool arguments exceed structural limits");
    if (value === null || ["string", "boolean"].includes(typeof value) || typeof value === "number" && Number.isFinite(value)) continue;
    if (!value || typeof value !== "object" || ancestors.has(value) || !Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new PlatformError("CONNECTED_ARGUMENTS_INVALID", 400, "Expected plain JSON tool arguments");
    const next = new Set(ancestors).add(value);
    for (const [name, property] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
      if (Array.isArray(value) && name === "length") continue;
      if (!property.enumerable || !("value" in property) || ["__proto__", "constructor", "prototype"].includes(name)) throw new PlatformError("CONNECTED_ARGUMENTS_INVALID", 400, "Unsafe tool argument property");
      pending.push({ value: property.value, depth: depth + 1, ancestors: next });
    }
  }
  const text = JSON.stringify(input);
  if (Buffer.byteLength(text) > REMOTE_MCP_LIMITS.argumentsBytes) throw new PlatformError("CONNECTED_ARGUMENTS_LIMIT", 413, "Tool arguments exceed byte limit");
  return JSON.parse(text);
}
export function genericToolFromBinding(binding: CapabilityBinding): RemoteMcpTool {
  const remote = binding.definition.remote;
  if (binding.connection?.profileId !== "remote-mcp-v1" || !remote) throw new PlatformError("CONNECTED_OPERATION_UNAVAILABLE", 403, "Remote operation is not pinned");
  return { name: binding.definition.providerOperation, alias: binding.alias, description: binding.definition.description,
    inputSchema: binding.definition.inputSchema as Record<string, unknown>,
    ...(binding.definition.outputSchema ? { outputSchema: binding.definition.outputSchema as Record<string, unknown> } : {}),
    definitionDigest: remote.definitionDigest, schemaDigest: requestDigest({ inputSchema: binding.definition.inputSchema, outputSchema: binding.definition.outputSchema }),
    effect: "unknown", reviewRequired: true, compatible: true, diagnostics: [] };
}
export async function executeGenericConnectedTool(binding: CapabilityBinding, endpoint: RemoteMcpEndpoint, args: Record<string, unknown>,
  signal: AbortSignal | undefined, hooks: RemoteMcpHooks) {
  if (binding.resources.length !== 1 || binding.resources[0]?.kind !== "mcp.endpoint" || binding.resources[0].id !== endpoint.endpoint) throw new PlatformError("CONNECTED_SCOPE_DENIED", 403, "Remote destination does not match the authorized endpoint");
  return executeRemoteMcpTool({ ...endpoint, adapterManifestDigest:binding.adapter.manifestDigest, protocolVersion: binding.protocolVersion!, transport: binding.definition.remote!.transport,
    maxRequests: Math.min(endpoint.maxRequests ?? REMOTE_MCP_LIMITS.requests, binding.limits.maxPhysicalRequests ?? REMOTE_MCP_LIMITS.requests) },
  genericToolFromBinding(binding), args, signal, hooks);
}
