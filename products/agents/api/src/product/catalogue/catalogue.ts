import { defaultConnectorRegistry, type ConnectorConfiguration } from "../../adapters/providers/connector-registry";
import { missingSkillRequirements } from "../../capabilities/skills/requirement-authority";
import type { SkillRequirements } from "../../capabilities/skills/requirements";
import { z } from "zod";
import { requestDigest, type AgentConfiguration, type AgentExecutionKind, type Product } from "../../contracts/contracts";
import type { CapabilityBinding } from "../../contracts/capability-catalog";
import type { ConnectionDTO } from "../../contracts/connections";

export const catalogueRevision = "2026-10-20.3";
export const purposeSchema = z.enum(["faq", "customer-service", "research", "booking", "campaigns", "general"]);
export type CataloguePurpose = z.infer<typeof purposeSchema>;
export const catalogueQuerySchema = z.strictObject({
  agentId: z.uuid().optional(), purpose: purposeSchema.optional(),
  view: z.enum(["recommended", "available", "added"]).optional(), q: z.string().trim().max(200).optional(),
});
export type CatalogueQuery = z.infer<typeof catalogueQuerySchema>;
type ToolName = AgentConfiguration["tools"][number];
export interface CataloguePublisher { id: string; name: string; verified: boolean }
export interface CatalogueRequirements { connectionProfiles: string[]; permissions: string[] }
export interface CatalogueSkill {
  id: string; name: string; description: string; revision: number; digest: string;
  publisher: CataloguePublisher; state: "available" | "disabled" | "unavailable";
  reason?: string; requires?: CatalogueRequirements; purposes?: CataloguePurpose[];
  source?: {kind:"private"|"curated"|"repository";slug:string|null;repository?:string;commit?:string;path?:string;tree?:string}; installed?: boolean;
  familyId?:string;runtimeRequirements?:SkillRequirements;
}
export type CatalogueSelection = {kind:"bindings"} | {kind:"capability";capability:"businessActions";profileId:string;setup:"booking"};
interface Definition {
  selection?:CatalogueSelection;connectorId?:string;configuredEndpoint?:string;configurationRequired?:{code:string;message:string};providerUnavailable?:{code:string;message:string};
  id: string; revision: number; kind: "builtin" | "mcp" | "native_api" | "skill";
  name: string; description: string; publisher: CataloguePublisher; purposes: CataloguePurpose[];
  products: Product[]; executionKinds: AgentExecutionKind[]; requires: CatalogueRequirements;
  tools: ToolName[]; skillId?: string; unavailableReason?: string;
  source?: CatalogueSkill["source"];
  connectionId?: string;familyId?:string;runtimeRequirements?:SkillRequirements;
}
export interface CatalogueItemDTO {
  id: string; revision: number; digest: string; kind: Definition["kind"]; selection?:CatalogueSelection;connectorId?:string;
  name: string; description: string; publisher: CataloguePublisher; purposes: CataloguePurpose[];
  products: Product[]; executionKinds: AgentExecutionKind[]; requires: CatalogueRequirements;
  readiness: { state: "ready" | "needs_connection" | "needs_configuration" | "unavailable"; reasons: { code: string; message: string }[] };
  added: boolean; recommended: boolean;
  action: { kind: "add" | "connect" | "configure" | "none"; connectionProfileId?: string; connectionId?: string; configurationSection?: "configuration"; configurationSetup?:string };
  configuration: { tools: ToolName[]; connectedToolBindingIds: string[]; skillIds: string[] };
  source?: CatalogueSkill["source"];familyId?:string;
}
export interface CatalogueResponse { schemaVersion: 1; revision: string; agentId: string | null; entries: CatalogueItemDTO[] }

const publisher: CataloguePublisher = { id: "kasitek", name: "KasiTek", verified: true };
function define(input: Pick<Definition, "id" | "kind" | "name" | "description" | "purposes"> & Partial<Definition>): Definition {
  return { revision: 1, publisher, products: ["agents"], executionKinds: ["business"],
    requires: { connectionProfiles: [], permissions: ["agent.configure"] }, tools: [], ...input };
}
// Only local reviewed metadata establishes these identities. Remote descriptions never merge into it.
const reviewedDefinitions = [
  define({ id: "knowledge-search", kind: "builtin", name: "Search knowledge", description: "Find passages in approved knowledge.", purposes: ["faq", "customer-service", "research"], tools: ["knowledge.search"] }),
  define({ id: "knowledge-read", kind: "builtin", name: "Read knowledge", description: "Read approved knowledge passages.", purposes: ["faq", "customer-service", "research"], tools: ["knowledge.read"] }),
  define({ id: "human-handoff", kind: "builtin", name: "Human support", description: "Request human support in the shared inbox.", purposes: ["faq", "customer-service"], tools: ["channel.request_handoff", "support.request_handoff_v2"] }),

];
// Freeze nested metadata as well as the array so another module cannot replace reviewed identity.
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
freeze(reviewedDefinitions);
function connectorDefinitions(records:readonly ConnectorConfiguration[]):Definition[] {
  return records.map(record=>define({id:record.id,revision:record.revision,kind:record.kind,name:record.name,description:record.description,
    publisher:record.publisher,purposes:record.catalogue.purposes as CataloguePurpose[],products:record.catalogue.products,executionKinds:record.catalogue.executionKinds,
    requires:{connectionProfiles:[record.profileId],permissions:record.catalogue.permissions},selection:record.catalogue.selection,connectorId:record.id,
    configuredEndpoint:record.connectionDefaults?.endpoint??(record.adapterKey==="native-api"?record.apiBaseUrl:undefined),configurationRequired:record.catalogue.configurationRequired,providerUnavailable:record.catalogue.unavailable}));
}


export type CatalogueConnection = Omit<ConnectionDTO, "profileId"> & { profileId: string };
export interface CatalogueContext {
  agentId?: string; calendarProviderId?:string; configuration?: AgentConfiguration; purpose: CataloguePurpose;
  product: Product; permissions: readonly string[]; connections: readonly CatalogueConnection[];
  bindings: readonly CapabilityBinding[]; skills?: readonly CatalogueSkill[]; now?: Date; connectorReadiness?:Record<string,{available:boolean;reasons?:{code:string;message:string}[]}>;connectorRecords?:readonly ConnectorConfiguration[];
}

function item(definition: Definition, context: CatalogueContext, pinnedDigest?: string): CatalogueItemDTO {
  const { configuration } = context;
  const capability = definition.selection?.kind === "capability" ? definition.selection : undefined;
  const connections = context.connections.filter(connection => (!definition.connectionId || connection.id===definition.connectionId) && (!definition.configuredEndpoint || connection.resource===definition.configuredEndpoint) && definition.requires.connectionProfiles.includes(connection.profileId)
    && connection.state === "active" && Date.parse(connection.expiresAt) > (context.now ?? new Date()).getTime());
  const bindings = capability ? [] : context.bindings.filter(binding => binding.connection && connections.some(connection => connection.id === binding.connection!.id
    && connection.profileId === binding.connection!.profileId && connection.policyRevision === binding.connection!.policyRevision));
  const selectedBindings = capability ? [] : context.bindings.filter(binding => binding.connection && (!definition.connectionId || binding.connection.id===definition.connectionId) && definition.requires.connectionProfiles.includes(binding.connection.profileId)
    && (!definition.configuredEndpoint || context.connections.some(connection=>connection.id===binding.connection!.id && connection.resource===definition.configuredEndpoint))
    && configuration?.connectedToolBindingIds.includes(binding.id));
  const newestRevision=definition.connectionId?Math.max(0,...bindings.map(binding=>binding.catalog.revision)):0;
  const availableBindings=definition.connectionId?bindings.filter(binding=>binding.catalog.revision===newestRevision):bindings;
  const selection = { tools: [...definition.tools], connectedToolBindingIds: (selectedBindings.length ? selectedBindings : connections.length === 1 ? availableBindings : []).map(binding => binding.id), skillIds: definition.skillId ? [definition.skillId] : [] };
  const added = !!configuration && (capability ? configuration.capabilities.businessActions.enabled && configuration.capabilities.businessActions.profileId === capability.profileId && context.calendarProviderId === definition.connectorId : definition.skillId ? configuration.skillIds.includes(definition.skillId)
    : definition.tools.length ? definition.tools.every(tool => configuration.tools.includes(tool)) : selectedBindings.length > 0);
  const reasons: CatalogueItemDTO["readiness"]["reasons"] = [];
  if (!definition.products.includes(context.product)) reasons.push({ code: "PRODUCT_UNSUPPORTED", message: "Unavailable for this product." });
  if (configuration && !definition.executionKinds.includes(configuration.executionKind)) reasons.push({ code: "RUNTIME_UNSUPPORTED", message: "Unavailable for this agent runtime." });
  if (definition.requires.permissions.some(permission => !context.permissions.includes(permission))) reasons.push({ code: "PERMISSION_REQUIRED", message: "Agent configuration permission is required." });
  if(configuration&&definition.runtimeRequirements) {
    const selected=context.bindings.filter(binding=>configuration.connectedToolBindingIds.includes(binding.id)).flatMap(binding=>binding.connection?[binding.connection.profileId]:[]);
    const missing=missingSkillRequirements(definition.runtimeRequirements,configuration,selected);
    if(Object.values(missing).some(values=>values.length))reasons.push({code:"SKILL_REQUIREMENTS_UNAVAILABLE",message:"Configure the connections and runtime required by this skill."});
  }
  const provider=definition.connectorId?context.connectorReadiness?.[definition.connectorId]:undefined;
  if(definition.connectorId && provider && !provider.available) reasons.push(...(provider.reasons?.length?provider.reasons:[{code:"CONNECTOR_UNAVAILABLE",message:"This integration is not configured on the server."}]));
  const connectorAuth=(context.connectorRecords??defaultConnectorRegistry.connectors).find(record=>record.id===definition.connectorId)?.auth.kind;
  if(definition.connectorId && !provider && connectorAuth && ["oidc","oauth2"].includes(connectorAuth)) reasons.push(definition.providerUnavailable??{code:"CONNECTOR_UNAVAILABLE",message:"This integration is not configured on the server."});
  if (definition.unavailableReason) reasons.push({ code: "DEPENDENCY_UNAVAILABLE", message: definition.unavailableReason });
  let state: CatalogueItemDTO["readiness"]["state"] = reasons.length ? "unavailable" : "ready";
  if (state === "ready" && definition.requires.connectionProfiles.length && !connections.length) {
    state = "needs_connection"; reasons.push({ code: "CONNECTION_REQUIRED", message: "Connect an account and select approved resources." });
  } else if (state === "ready" && capability) {
    state = "needs_configuration"; reasons.push(definition.configurationRequired??{code:"CAPABILITY_CONFIGURATION_REQUIRED",message:"Configure the permitted actions for this agent."});
  } else if (state === "ready" && definition.requires.connectionProfiles.length && !bindings.length) {
    state = "needs_configuration"; reasons.push({ code: "TOOL_SELECTION_REQUIRED", message: "Select permitted operations and resources." });
  } else if (state === "ready" && selectedBindings.some(selected => !bindings.some(current => current.id === selected.id))) {
    state = "needs_configuration"; reasons.push({ code: "BINDING_CHANGED", message: "Review changed connection permissions." });
  } else if (state === "ready" && connections.length > 1 && !selectedBindings.length) {
    state = "needs_configuration"; reasons.push({ code: "ACCOUNT_SELECTION_REQUIRED", message: "Select an account." });
  }
  if (state === "ready" && definition.tools.some(tool => tool.startsWith("knowledge.")) && !configuration?.sourceRevisionIds.length) {
    state = "needs_configuration"; reasons.push({ code: "KNOWLEDGE_REQUIRED", message: "Select approved knowledge." });
  }
  const action: CatalogueItemDTO["action"] = { kind: state === "unavailable" || added && !capability ? "none" : state === "needs_connection" ? "connect" : state === "needs_configuration" ? "configure" : "add" };
  if (capability && state === "needs_configuration") {
    action.configurationSection = "configuration"; action.configurationSetup = capability.setup;
    if (connections.length === 1) action.connectionId = connections[0]!.id;
  }
  if(definition.connectionId)action.connectionId=definition.connectionId;
  if (definition.requires.connectionProfiles[0]) action.connectionProfileId = definition.requires.connectionProfiles[0];
  return { id: definition.id, revision: definition.revision, digest: pinnedDigest ?? requestDigest(definition), kind: definition.kind,
    ...(definition.selection?{selection:definition.selection}:{}),...(definition.connectorId?{connectorId:definition.connectorId}:{}),
    name: definition.name, description: definition.description, publisher: { ...definition.publisher }, purposes: [...definition.purposes],
    products: [...definition.products], executionKinds: [...definition.executionKinds], requires: { connectionProfiles: [...definition.requires.connectionProfiles], permissions: [...definition.requires.permissions] },
    readiness: { state, reasons }, added, recommended: state !== "unavailable" && definition.purposes.includes(context.purpose), action, configuration: selection };
}

export function queryCatalogue(kind: "tools" | "skills", query: CatalogueQuery, context: CatalogueContext): CatalogueResponse {
  const definitions: { definition: Definition; digest?: string }[] = kind === "tools" ? [...reviewedDefinitions,...connectorDefinitions(context.connectorRecords??defaultConnectorRegistry.connectors),...context.connections.filter(connection=>["remote-mcp-v1","custom-api-v1"].includes(connection.profileId)).map(connection=>define({
      id:`connection:${connection.id}`,connectionId:connection.id,kind:connection.profileId==="remote-mcp-v1"?"mcp":"native_api",
      name:connection.name,description:connection.profileId==="remote-mcp-v1"?"Selected tools from your MCP server.":"Selected operations from your API.",
      publisher:{id:context.product,name:"Private connection",verified:false},purposes:["general"],
      requires:{connectionProfiles:[connection.profileId],permissions:["agent.configure"]},
    }))].map(definition => ({ definition }))
    : (context.skills ?? []).map(skill => ({ definition: define({ id: `skill:${skill.id}`, revision: skill.revision, kind: "skill", name: skill.name,
      description: skill.description, publisher: skill.publisher, source:skill.source,familyId:skill.familyId,runtimeRequirements:skill.runtimeRequirements, purposes: skill.purposes ?? ["general"], skillId: skill.installed===false?undefined:skill.id,
      requires: skill.requires ?? { connectionProfiles: [], permissions: ["agent.configure"] },
      unavailableReason: skill.state === "available" ? undefined : skill.reason ?? "This skill is disabled or unavailable." }), digest: skill.digest }));
  const search = (query.q ?? "").toLocaleLowerCase();
  const entries = definitions.map(({ definition, digest }) => ({...item(definition, context, digest),...(definition.source?{source:definition.source}:{}),...(definition.familyId?{familyId:definition.familyId}:{})})).filter(entry =>
    (!search || [entry.name, entry.description, entry.publisher.name, ...entry.purposes].join(" ").toLocaleLowerCase().includes(search))
    && (query.view !== "recommended" || entry.recommended) && (query.view !== "available" || entry.readiness.state !== "unavailable")
    && (query.view !== "added" || entry.added));
  return { schemaVersion: 1, revision: catalogueRevision, agentId: context.agentId ?? null, entries };
}
