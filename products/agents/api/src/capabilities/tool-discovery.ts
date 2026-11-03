import { z } from "zod";
import { PlatformError, requestDigest } from "../contracts/contracts";
import type { ToolDefinition } from "../contracts/model-messages";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const alias = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const handle = z.string().min(1).max(512);
const metadataSchema = z.strictObject({ alias, qualifiedName: handle, handle: handle.optional(),
  description: z.string().max(4096), revision: z.string().min(1).max(128), digest });
const definitionSchema = z.strictObject({ type: z.literal("function"), function: z.strictObject({
  name: alias, description: z.string().max(65536), parameters: z.record(z.string(), z.unknown()),
}) });
export const toolDiscoveryV1OutputSchema = z.strictObject({ catalogDigest: digest, tools: z.array(metadataSchema).max(8),
  nextOffset: z.number().int().nonnegative().nullable() });
export const toolLoadV1InputSchema = z.strictObject({ tools: z.array(z.strictObject({ handle: handle.optional(), alias: alias.optional(), digest: digest.optional() })).min(1).max(8), replace: z.boolean().optional() });

export const toolPresentationSchema = z.strictObject({
  title: z.string().min(1).max(120), category: z.string().min(1).max(80), purpose: z.string().max(512),
  effect: z.string().min(1).max(64), source: z.string().min(1).max(128),
  readiness: z.literal("available"), schemaLoading: z.enum(["eager", "deferred", "auto"]),
});
const richMetadataSchema = metadataSchema.extend(toolPresentationSchema.shape);
const discoverV3Input = z.strictObject({ mode: z.enum(["browse", "search"]).optional(), query: z.string().max(256).optional(),
  queries: z.array(z.string().trim().min(1).max(256)).min(1).max(4).optional(), category: z.string().min(1).max(80).optional(),
  offset: z.number().int().nonnegative().optional() }).superRefine((value,context) => {
  if (value.query !== undefined && value.queries !== undefined) context.addIssue({code:"custom",message:"Use query or queries"});
  if (value.mode === "browse" && (value.query?.trim() || value.queries?.length)) context.addIssue({code:"custom",message:"Browse does not use search queries"});
  if (value.mode === "search" && !value.query?.trim() && !value.queries?.length) context.addIssue({code:"custom",message:"Search requires a query"});
});
const discoverV3Output = z.strictObject({catalogDigest:digest,tools:z.array(richMetadataSchema).max(8),
  nextOffset:z.number().int().nonnegative().nullable(),catalogueSize:z.number().int().nonnegative(),matchedCount:z.number().int().nonnegative(),
  returnedCount:z.number().int().nonnegative(),complete:z.boolean(),mode:z.enum(["browse","search"]),queryMatch:z.enum(["enumeration","ranked","no_match"]),
  queryResults:z.array(z.strictObject({query:z.string().max(256),matchedCount:z.number().int().nonnegative()})).max(4),
  recovery:z.literal("Browse the available catalogue with mode: browse.").optional()});
export const toolDiscoveryV3Contracts = {
  "tools.discover": {input:discoverV3Input,output:discoverV3Output},
  "tools.load": {input:z.strictObject({tools:z.array(z.strictObject({handle})).min(1).max(8),replace:z.boolean().optional()}),
    output:z.strictObject({catalogDigest:digest,replace:z.boolean(),tools:z.array(richMetadataSchema.extend({definition:definitionSchema})).max(8)})},
} as const;

export const toolDiscoveryContracts = {
  "tools.discover": {
    input: z.strictObject({ query: z.string().max(256).optional(), offset: z.number().int().nonnegative().optional() }),
    output: toolDiscoveryV1OutputSchema.extend({ catalogueSize: z.number().int().nonnegative(), matchedCount: z.number().int().nonnegative(),
      queryMatch: z.enum(["enumeration", "ranked", "no_match"]), recovery: z.literal("List available tools with an empty query.").optional() }),
    authority: ["model.reply"], resources: ["current_direct_callable_tools"], reconciliation: "not_applicable",
  },
  "tools.load": {
    input: z.strictObject({ tools: z.array(z.strictObject({ handle })).min(1).max(8), replace: z.boolean().optional() }),
    output: z.strictObject({ catalogDigest: digest, replace: z.boolean(), tools: z.array(metadataSchema.extend({ definition: definitionSchema })).max(8) }),
    authority: ["model.reply"], resources: ["current_direct_callable_tools", "exact_catalogue_schema_digests"], reconciliation: "idempotent_receipt",
  },
} as const;

export interface ToolCatalogMetadata extends Partial<z.infer<typeof toolPresentationSchema>> { qualifiedName: string; revision: string; bindingDigest?: string }
export interface ToolCatalogEntry extends z.infer<typeof metadataSchema>, Partial<z.infer<typeof toolPresentationSchema>> { definition: ToolDefinition }
export interface ToolCatalog { version?: "3"; digest: string; entries: readonly ToolCatalogEntry[] }
export type ToolSchemaLoadResult = z.infer<typeof toolDiscoveryContracts["tools.load"]["output"]> | z.infer<typeof toolDiscoveryV3Contracts["tools.load"]["output"]>;

export const TOOL_DISCOVERY_ALIASES = ["tools_discover", "tools_load"] as const;
export function toolDiscoveryDefinitions(versions?: ReadonlyMap<string, string>): ToolDefinition[] {
  const discoveryV3 = versions === undefined || versions.get("tools.discover") === "3";
  const loadV3 = versions === undefined || versions.get("tools.load") === "3";
  const legacyDiscovery = versions !== undefined && (versions.get("tools.discover") ?? "1") === "1";
  const legacyLoad = versions !== undefined && (versions.get("tools.load") ?? "1") === "1";
  return [
    { type: "function", function: { name: "tools_discover", description: discoveryV3
      ? "Browse currently authorized tools with mode: browse, or search by purpose with mode: search and query or up to four queries. Read matchedCount, returnedCount, complete and nextOffset before claiming full coverage. Results include exact handles, readable titles and effect/loading hints. Discovery grants no permission. A known exact handle from the capability directory can be loaded directly with tools_load without search."
      : legacyDiscovery
      ? "Find currently authorized tools by name or purpose. Returns metadata and exact handles only. Discovery grants no permission. Use tools_load to add the selected exact schemas before calling them."
      : "Find currently authorized tools by name or purpose. Returns ranked metadata and exact handles only. Unmatched query terms do not imply missing capabilities. If no matches are found, check catalogueSize and list available tools with an empty query. Use tools_load to add selected exact schemas before calling them. Discovery grants no permission.", parameters: z.toJSONSchema(discoveryV3 ? toolDiscoveryV3Contracts["tools.discover"].input : toolDiscoveryContracts["tools.discover"].input) } },
    { type: "function", function: { name: "tools_load", description: loadV3
      ? "Load exact currently authorized handles from the visible capability directory or tools_discover. Prior search is unnecessary. Returned function names become callable on the next request. Set replace to discard previously loaded optional schemas. Loading never grants permission; current authority and review requirements still apply."
      : legacyLoad
      ? "Load tools by an exact handle returned by tools_discover. The server pins each current schema; copying a digest is optional. Tools become callable on the next request. Set replace to discard previously loaded optional schemas. Current permissions and reviews still apply."
      : "Load tools using the exact handles returned by tools_discover. The server pins the current authorized schemas. Use the returned function names on the next request. Set replace to discard previously loaded optional schemas. Current permissions and reviews still apply.", parameters: z.toJSONSchema(loadV3 ? toolDiscoveryV3Contracts["tools.load"].input : legacyLoad ? toolLoadV1InputSchema : toolDiscoveryContracts["tools.load"].input) } },
  ];
}

export function readableToolTitle(value: string): string {
  const words=value.replace(/([a-z0-9])([A-Z])/g,"$1 $2").replace(/[._:/-]+/g," ").trim();
  return (words ? words[0]!.toUpperCase()+words.slice(1) : "Tool").slice(0,120);
}

/** Input is the direct, currently authorized catalogue. Specialist-only tools never belong here. */
export function createToolCatalog(definitions: readonly ToolDefinition[], metadata: ReadonlyMap<string, ToolCatalogMetadata> = new Map(), version = "2"): ToolCatalog {
  const names = new Set<string>(), qualifiedNames = new Set<string>();
  const entries = definitions.map(definition => {
    const parsed = definitionSchema.safeParse(definition);
    if (!parsed.success) throw new PlatformError("TOOL_CATALOG_INVALID", 409, "A tool definition is invalid");
    const name = parsed.data.function.name, identity = metadata.get(name);
    const qualifiedName = identity?.qualifiedName ?? `runtime:${name}`;
    if (TOOL_DISCOVERY_ALIASES.includes(name as typeof TOOL_DISCOVERY_ALIASES[number]) || names.has(name) || qualifiedNames.has(qualifiedName)) {
      throw new PlatformError("TOOL_CATALOG_COLLISION", 409, "Tool catalogue identities must be distinct");
    }
    names.add(name); qualifiedNames.add(qualifiedName);
    const revision = identity?.revision ?? requestDigest(parsed.data);
    const presentation = version === "3" ? toolPresentationSchema.parse({
      title: identity?.title ?? readableToolTitle(qualifiedName.split(":").at(-1) ?? name), category: identity?.category ?? "Tools",
      purpose: identity?.purpose ?? parsed.data.function.description.slice(0,512), effect: identity?.effect ?? "unknown",
      source: identity?.source ?? "runtime", readiness: identity?.readiness ?? "available", schemaLoading: identity?.schemaLoading ?? "auto",
    }) : undefined;
    const entry = { alias: name, qualifiedName, description: parsed.data.function.description.slice(0, 4096), revision,
      digest: requestDigest({ qualifiedName, revision, bindingDigest: identity?.bindingDigest ?? null, definition: parsed.data, ...(presentation ? {presentation,handle:`tool:${name}`} : {}) }),
      ...(presentation ? {...presentation,handle:`tool:${name}`} : {}), definition: structuredClone(parsed.data) as ToolDefinition };
    (version === "3" ? richMetadataSchema : metadataSchema).parse(catalogMetadata(entry));
    return entry;
  }).sort((a, b) => a.qualifiedName.localeCompare(b.qualifiedName) || a.alias.localeCompare(b.alias));
  return { ...(version === "3" ? {version:"3" as const} : {}), digest: requestDigest(entries), entries };
}

function catalogMetadata(entry: ToolCatalogEntry) {
  const { definition: _definition, ...value } = entry;
  void _definition;
  return value;
}

function legacyEntry(entry: ToolCatalogEntry) {
  return {alias:entry.alias,qualifiedName:entry.qualifiedName,description:entry.description,revision:entry.revision,digest:entry.digest,definition:entry.definition};
}
export function normalizeToolPresentation(entry: ToolCatalogEntry) {
  return {...entry,...toolPresentationSchema.parse({title:entry.title??readableToolTitle(entry.qualifiedName.split(":").at(-1)??entry.alias),
    category:entry.category??"Tools",purpose:entry.purpose??entry.description.slice(0,512),effect:entry.effect??"unknown",source:entry.source??"runtime",
    readiness:entry.readiness??"available",schemaLoading:entry.schemaLoading??"auto"})};
}
const genericSearchWords=new Set(["a","an","the","all","available","tool","tools","capability","capabilities","please","can","i","do","for","to","and","of"]);
function stem(word:string):string {
  if(word.length<4)return word;
  let root=word.replace(/ies$/,"y").replace(/(?:ing|ed)$/," ").trim();
  if(root.length>3&&/([bdfgmnprt])\1$/.test(root))root=root.slice(0,-1);
  if(root===word)root=root.replace(/s$/," ").trim();
  return root.length>4?root.replace(/e$/," ").trim():root;
}
function rankedTokens(value:string):string[]{return searchTokens(value).filter(word=>!genericSearchWords.has(word)).map(stem);}
/** Schema terms aid lexical discovery only; they never enter privileged orientation. */
function parameterSearchText(parameters:Record<string,unknown>):string {
  const parts:string[]=[];let remaining=8192,visited=0;
  const append=(value:unknown)=>{if(typeof value!=="string"||remaining<=0)return;const part=value.slice(0,remaining);parts.push(part);remaining-=part.length+1;};
  const walk=(value:unknown,depth:number)=>{
    if(remaining<=0||depth>8||!value||typeof value!=="object"||Array.isArray(value)||++visited>256)return;
    const schema=value as Record<string,unknown>;append(schema.title);append(schema.description);
    for(const keyword of ["properties","patternProperties"]){
      const properties=schema[keyword];if(!properties||typeof properties!=="object"||Array.isArray(properties))continue;
      for(const name of Object.keys(properties).sort()){
        if(remaining<=0||visited>=256)break;
        append(name);walk((properties as Record<string,unknown>)[name],depth+1);
      }
    }
    for(const keyword of ["items","additionalProperties","contains","not","if","then","else"])walk(schema[keyword],depth+1);
    for(const keyword of ["allOf","anyOf","oneOf","prefixItems"]){
      const branches=schema[keyword];if(Array.isArray(branches))for(const branch of branches){if(remaining<=0||visited>=256)break;walk(branch,depth+1);}
    }
  };
  walk(parameters,0);return parts.join(" ");
}
function discoverToolCatalogV3(catalog:ToolCatalog,input:unknown) {
  const args=discoverV3Input.safeParse(input);if(!args.success)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Choose browse or bounded search queries");
  const queries=args.data.queries??(args.data.query?.trim()?[args.data.query.trim()]:[]),mode=args.data.mode??(queries.length?"search":"browse");
  const candidates=catalog.entries.filter(entry=>!args.data.category||entry.category===args.data.category),counts=queries.map(()=>0);
  const ranked=candidates.map((entry,index)=>{
    const identity=rankedTokens(`${entry.qualifiedName} ${entry.alias} ${entry.title??""}`),purpose=rankedTokens(`${entry.purpose??""} ${entry.description} ${entry.category??""} ${parameterSearchText(entry.definition.function.parameters)}`);
    let score=0,matched=0;
    for(const [queryIndex,query]of queries.entries()){
      const words=rankedTokens(query),matches=words.map(word=>({identity:tokenScore(word,identity),purpose:tokenScore(word,purpose)}));
      const hits=matches.filter(match=>match.identity||match.purpose).length;
      if(hits){counts[queryIndex]=(counts[queryIndex]??0)+1;matched++;score+=hits*16+matches.reduce((sum,match)=>sum+match.identity*2+match.purpose,0);}
    }
    return {entry,index,score,matched};
  }).filter(value=>mode==="browse"||value.matched>0).sort((a,b)=>mode==="browse"?a.index-b.index:b.matched-a.matched||b.score-a.score||a.index-b.index);
  const start=args.data.offset??0,page=ranked.slice(start,start+8),nextOffset=start+page.length<ranked.length?start+page.length:null;
  return {catalogDigest:catalog.digest,tools:page.map(({entry})=>({...catalogMetadata(normalizeToolPresentation(entry)),handle:entry.handle??entry.qualifiedName})),
    catalogueSize:catalog.entries.length,matchedCount:ranked.length,returnedCount:page.length,complete:nextOffset===null&&start===0,
    nextOffset,mode,queryMatch:mode==="browse"?"enumeration" as const:ranked.length?"ranked" as const:"no_match" as const,
    queryResults:queries.map((query,index)=>({query,matchedCount:counts[index]!})),
    ...(mode==="search"&&!ranked.length&&catalog.entries.length?{recovery:"Browse the available catalogue with mode: browse." as const}:{})};
}

function searchTokens(value: string): string[] {
  return [...new Set(value.normalize("NFKC").replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLocaleLowerCase("en-US").match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function tokenScore(query: string, words: readonly string[]) {
  if (words.includes(query)) return 4;
  return query.length >= 3 && words.some(word => word.startsWith(query)) ? 2 : 0;
}

export function discoverToolCatalog(catalog: ToolCatalog, input: unknown, version = catalog.version ?? "2") {
  if (version === "3") return discoverToolCatalogV3(catalog,input);
  const args = toolDiscoveryContracts["tools.discover"].input.safeParse(input);
  if (!args.success) throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Check the catalogue query");
  const words = searchTokens(args.data.query ?? "");
  const entries = words.length ? catalog.entries.map((entry, index) => {
    const identity = searchTokens(`${entry.qualifiedName} ${entry.alias}`), description = searchTokens(entry.description);
    const matches = words.map(word => ({ identity: tokenScore(word, identity), description: tokenScore(word, description) }));
    return { entry, index, matched: matches.filter(match => match.identity || match.description).length,
      score: matches.reduce((score, match) => score + match.identity * 2 + match.description, 0) };
  }).filter(value => value.matched > 0).sort((a, b) => b.matched - a.matched || b.score - a.score || a.index - b.index)
    .map(value => value.entry) : catalog.entries;
  const start = args.data.offset ?? 0, page = entries.slice(start, start + 8);
  return { catalogDigest: catalog.digest, tools: page.map(entry=>({...catalogMetadata(legacyEntry(entry)),handle:entry.qualifiedName})), nextOffset: start + page.length < entries.length ? start + page.length : null,
    ...(version === "1" ? {} : { catalogueSize: catalog.entries.length, matchedCount: entries.length,
      queryMatch: !words.length ? "enumeration" as const : entries.length ? "ranked" as const : "no_match" as const,
      ...(words.length && !entries.length && catalog.entries.length ? { recovery: "List available tools with an empty query." as const } : {}) }) };
}

export function loadToolSchemas(catalog: ToolCatalog, input: unknown, version = catalog.version ?? "2"): ToolSchemaLoadResult {
  const args = toolLoadV1InputSchema.safeParse(input);
  const currentInvalid = version !== "1" && !toolDiscoveryContracts["tools.load"].input.safeParse(input).success;
  if (currentInvalid || !args.success || args.data.tools.some(tool=>!tool.handle&&!tool.alias)) {
    throw new PlatformError("TOOL_ARGUMENTS_INVALID", 400, "Select distinct exact catalogue handles");
  }
  const tools = args.data.tools.map(handle => {
    const entry = catalog.entries.find(candidate => (handle.handle===undefined||candidate.qualifiedName===handle.handle||version==="3"&&candidate.handle===handle.handle)&&
      (handle.alias===undefined||candidate.alias===handle.alias));
    if (!entry || handle.digest!==undefined&&entry.digest!==handle.digest) throw new PlatformError("TOOL_SCHEMA_STALE", 409, "Discover the current authorized tool schema before loading it");
    return structuredClone(version === "3" ? normalizeToolPresentation(entry) : legacyEntry(entry));
  });
  if(new Set(tools.map(tool=>tool.alias)).size!==tools.length)throw new PlatformError("TOOL_ARGUMENTS_INVALID",400,"Select distinct exact catalogue handles");
  return { catalogDigest: catalog.digest, replace: args.data.replace ?? false, tools };
}

/** Error recovery exposes only current direct catalogue identifiers, never guessed aliases or schemas. */
export function toolSchemaFailureFeedback(catalog:ToolCatalog,code:string){
  if(!["TOOL_SCHEMA_STALE","TOOL_SCHEMA_NOT_LOADED","TOOL_ARGUMENTS_INVALID","TOOL_SCHEMA_LIMIT"].includes(code))return undefined;
  const availableTools=catalog.entries.slice(0,8).map(entry=>({handle:entry.handle??entry.qualifiedName,alias:entry.alias}));
  while(availableTools.length&&Buffer.byteLength(JSON.stringify(availableTools))>4096)availableTools.pop();
  return {availableTools,nextOffset:availableTools.length<catalog.entries.length?availableTools.length:null,
    recovery:code==="TOOL_SCHEMA_LIMIT"?"Load fewer schemas, or use replace: true to replace earlier optional schemas.":"Choose an exact current handle with tools_load, then use the returned function name."};
}

/** Durable successful load receipts select schemas, never authority. Current catalogue wins. */
export function progressiveToolSelection(catalog: ToolCatalog, receipts: readonly unknown[], alwaysAliases: readonly string[] = [], versions?: ReadonlyMap<string, string>) {
  const loaded = new Map<string, string>(), invalidated = new Set<string>();
  for (const value of receipts) {
    const result = z.union([toolDiscoveryV3Contracts["tools.load"].output, toolDiscoveryContracts["tools.load"].output]).safeParse(value);
    if (!result.success) throw new PlatformError("TOOL_LOAD_RECEIPT_INVALID", 409, "The recorded tool schema load is invalid");
    if (result.data.replace) { loaded.clear(); invalidated.clear(); }
    for (const entry of result.data.tools) {
      const current = catalog.entries.find(candidate => candidate.alias === entry.alias && candidate.digest === entry.digest);
      if (!current) { loaded.delete(entry.alias); invalidated.add(entry.alias); continue; }
      if (requestDigest("title" in entry ? normalizeToolPresentation(current) : legacyEntry(current)) !== requestDigest(entry)) throw new PlatformError("TOOL_LOAD_RECEIPT_INVALID", 409, "The recorded schema does not match its exact catalogue digest");
      loaded.set(entry.alias, entry.digest);
      invalidated.delete(entry.alias);
    }
  }
  const optionalSchemas = catalog.entries.some(entry => !alwaysAliases.includes(entry.alias));
  return { tools: [...(optionalSchemas ? toolDiscoveryDefinitions(versions) : []), ...catalog.entries.filter(entry => alwaysAliases.includes(entry.alias) || loaded.get(entry.alias) === entry.digest).map(entry => structuredClone(entry.definition))],
    invalidatedAliases: [...invalidated] };
}

export function progressiveModelTools(catalog: ToolCatalog, receipts: readonly unknown[], alwaysAliases: readonly string[] = [], versions?: ReadonlyMap<string, string>): ToolDefinition[] {
  return progressiveToolSelection(catalog, receipts, alwaysAliases, versions).tools;
}

/** A forged model call cannot invoke a hidden schema or restore an obsolete loaded schema. */
export function assertLoadedTool(catalog: ToolCatalog, snapshotDefinitions: readonly ToolDefinition[], toolAlias: string, versions?: ReadonlyMap<string, string>): void {
  const current = catalog.entries.find(entry => entry.alias === toolAlias)?.definition
    ?? toolDiscoveryDefinitions(versions).find(definition => definition.function.name === toolAlias);
  const exposed = snapshotDefinitions.find(definition => definition.function.name === toolAlias);
  if (!current || !exposed || requestDigest(current) !== requestDigest(exposed)) {
    throw new PlatformError("TOOL_SCHEMA_NOT_LOADED", 403, "Load the current authorized tool schema before invoking it");
  }
}
