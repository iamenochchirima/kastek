import type { GrowthAgentRuntime } from "./growth-agent-runtime.js";
import { isMemoryAssertion, type MemoryAssertion } from "./agent-memory.js";
import { GROWTH_RESOURCE_FIELDS, isGrowthResourceOperation, validGrowthResourceInput, type GrowthAgentResourceInputs, type GrowthAgentResourceOutputs } from "./growth-agent-resources.js";
/** Growth product contracts. No standalone Agents membership or installation is implied. */
export const GROWTH_AGENT_CONTRACT_VERSION = "1" as const;
export const GROWTH_AGENT_COMMAND_PATH = "/internal/v1/products/growth/commands";
export const GROWTH_AGENT_ACTION_PATH = "/internal/agents/actions";
export const GROWTH_AGENT_FEATURE_IDS = ["assistant", "research", "content", "campaigns"] as const;
export type GrowthAgentFeatureId = typeof GROWTH_AGENT_FEATURE_IDS[number];
export type GrowthAgentContext = {
  kind: "workspace" | "content_post" | "whatsapp_campaign" | "analytics_report";
  resourceId?: string;
  range?: { from: string; to: string; timezone: string };
  report?: { metrics: string[]; breakdowns: string[]; filters: Record<string,string[]> };
};
export interface GrowthAgentActor { issuer: string; subject: string }
export interface GrowthAgentSpecialist {
  id: string; name: string; state: "configured" | "disabled" | "unavailable";
  memory?: { enabled: boolean; availableToAssistant: boolean };
}
export interface GrowthAgentFeature {
  revision?: number; memory?: { enabled: boolean };
  id: GrowthAgentFeatureId; name: string; description: string;
  ready: boolean; reasons: { code: string; message: string; route?: string }[];
  specialists?: GrowthAgentSpecialist[];
  model?: { label: string; provider: string; modelId: string } | null;
}
export type GrowthAgentCapabilityUpgradeResolution = "keep_current" | "use_update";
export interface GrowthAgentCapabilityUpgradeChange {
  id: string; kind: "operation" | "specialist" | "runtime"; action: "add" | "remove" | "change";
  label: string; before?: string; after?: string; conflict: boolean;
}
export interface GrowthAgentCapabilityUpgradePreview {
  featureId: GrowthAgentFeatureId; targetPublicationRevision: string; targetPublicationDigest: string; diffDigest: string;
  expectedRevisions: Partial<Record<GrowthAgentFeatureId, number>>;
  features: { featureId: GrowthAgentFeatureId; name: string; revision: number; enabled: boolean;
    changes: GrowthAgentCapabilityUpgradeChange[]; preserved: string[] }[];
  conflicts: { id: string; featureId: GrowthAgentFeatureId; label: string }[];
  unavailable: { code: string; message: string }[];
  /** True when changes exist and prerequisites pass. Every conflict additionally needs an explicit resolution. */
  canApply: boolean;
}
export interface GrowthAgentCapabilityUpgradeApply {
  targetPublicationDigest: string; diffDigest: string; expectedRevisions: Partial<Record<GrowthAgentFeatureId, number>>;
  resolutions: Record<string, GrowthAgentCapabilityUpgradeResolution>;
}
export interface GrowthAgentBootstrap {
  setup?: import("./growth-agent-provisioning.js").GrowthAgentSetupDto;
  features: GrowthAgentFeature[]; defaultFeatureId: "assistant";
  scope: { businessId: string; userId: string; businessName: string; canConfigureAgents?: boolean };
  model: { label: string; ready: boolean } | null;
}
export interface GrowthAgentConversation {
  id: string; featureId: GrowthAgentFeatureId; title: string;
  context: GrowthAgentContext | null; contextDisplay?: { title: string; route?: string }; createdAt: string; updatedAt: string;
}
export interface GrowthAgentSource { id: string; title: string; citationLabel?: string; url?: string; route?: string; revision?: string }
export interface GrowthAgentMessage {
  id: string; role: "user" | "assistant"; text: string; createdAt: string;
  taskId?: string; sources?: GrowthAgentSource[];
}
export type GrowthAgentTaskState = "accepted" | "queued" | "working" | "waiting_review" | "waiting_authority" |
  "completed" | "incomplete" | "failed" | "cancel_requested" | "cancelled" | "uncertain" | "refused";
export interface GrowthAgentResult {
  id: string; kind: "draft" | "report" | "artifact"; title: string;
  route?: string; artifactId?: string; revision?: string;
}
export interface GrowthAgentTask {
  updates?: GrowthAgentPublicUpdate[]; updatesTruncated?: boolean;
  runtime?: GrowthAgentRuntime;
  observedAt?: string;
  id: string; conversationId: string; featureId: GrowthAgentFeatureId; state: GrowthAgentTaskState;
  input: string; output: string | null; errorCode: string | null;
  createdAt: string; updatedAt: string; reviewIds?: string[];
  results?: GrowthAgentResult[]; sources?: GrowthAgentSource[];
  canSteer?: boolean; canContinue?: boolean;
  workId?: string; priorTaskId?: string | null;
  boundary?: {
    reason: string;
    scope: "agent" | "work" | "organization" | "authority" | "provider" | "context" | "runtime";
    policyRevision: string | null; limit: number | null; used: number | null;
    policySource?: { kind: string; reference: string } | null;
    retryable: boolean; action: "continue" | "wait" | "reconcile" | "change_policy" | null;
  };
  orchestration?: { revision: number; record: { objective: string; steps: { id: string; title: string; state: "pending" | "in_progress" | "completed" | "blocked" }[]; questions: string[]; evidenceTaskIds: string[] } | null };
  children?: { id: string; name: string; state: GrowthAgentTaskState; errorCode?: string | null; assignment?: string; createdAt?: string }[];
}
export interface GrowthAgentPublicUpdate { id: string; text: string; createdAt: string }
/** Owner-authorized public activity. No private model reasoning or raw execution export. */
export interface GrowthAgentObservation {
  task: GrowthAgentTask; rootTaskId: string; parentTaskId: string | null; agentName: string;
  events: GrowthAgentEvent[]; nextCursor: string | null;
  operations: import("./growth-agent-runtime.js").GrowthAgentRuntimeOperation[]; nextOperationCursor: string | null;
  updates: GrowthAgentPublicUpdate[]; updatesTruncated: boolean;
}
export interface GrowthAgentEvent { id: string; taskId: string; type: string; createdAt: string; message?: string; state?: GrowthAgentTaskState }
export interface GrowthAgentPage<T> { nextCursor: string | null; items: T[] }
export interface GrowthDraftProposal {
  title: string; content: string; channels: string[]; channelSelections: Record<string, string>;
  variants?: { platform: string; content: string }[];
}
export interface GrowthDraftReceipt {
  operationId: string; reviewId: string; payloadDigest: string; recordId: string;
  revision: string; route: string; state: "saved"; actorId: string;
}
export interface GrowthDraftReview {
  id: string; taskId: string; conversationId: string; featureId: GrowthAgentFeatureId;
  kind: "content_draft"; payloadDigest: string;
  state: "proposed" | "approved" | "rejected" | "executing" | "saved" | "failed" | "uncertain" | "expired";
  draft: GrowthDraftProposal; createdAt: string; expiresAt: string;
  result: GrowthDraftReceipt | null;
}
export interface GrowthOperationReview {
  id: string; taskId: string; conversationId: string; featureId: GrowthAgentFeatureId;
  kind: "operation"; operation: string; payloadDigest: string;
  state: "proposed" | "approved" | "rejected" | "executing" | "succeeded" | "failed" | "uncertain" | "expired";
  input: Record<string, unknown>; reviewUrl: string; createdAt: string; expiresAt: string;
  result: null;
}
export type GrowthAgentReview = GrowthDraftReview | GrowthOperationReview;
export interface GrowthAgentArtifact { id: string; title: string; mediaType: string; text?: string; downloadPath?: string; chunk?: { offset: number; nextOffset: number | null; bytes: number; digest: string; base64: string } }
export interface GrowthAgentModelOption {
  connectionId: string; modelId: string; label: string; provider: string;
  contextWindowTokens: number | null; maxOutputTokens: number | null;
  pricing: { currency: "USD"; inputMicrosPerMillionTokens: number | null; outputMicrosPerMillionTokens: number | null } | null;
}
export type GrowthAgentModelSelection = { kind: "organization_default" } | { kind: "connection"; connectionId: string; modelId: string };
export interface GrowthAgentCommandInputs extends GrowthAgentResourceInputs {
  "models.list": { featureId: GrowthAgentFeatureId };
  "models.select": { featureId: GrowthAgentFeatureId; expectedRevision: number; selection: GrowthAgentModelSelection };
  "memory.list": { featureId: GrowthAgentFeatureId; offset?: number; limit?: number };
  "memory.mutate": { featureId: GrowthAgentFeatureId; memoryId: string; expectedRevision: number; action: "accept" | "correct" | "forget"; content?: string; assertion?: MemoryAssertion };
  "memory.configure": { featureId: GrowthAgentFeatureId; expectedRevision: number; enabled: boolean };
  "features.list": { publication?: import("./growth-agent-provisioning.js").GrowthAgentPublication };
  "features.upgrade.preview": { featureId: GrowthAgentFeatureId; publication: import("./growth-agent-provisioning.js").GrowthAgentPublication };
  "features.upgrade.apply": GrowthAgentCapabilityUpgradeApply & { featureId: GrowthAgentFeatureId; publication: import("./growth-agent-provisioning.js").GrowthAgentPublication };
  "features.configure": { featureId: GrowthAgentFeatureId; configuration: Record<string, unknown> };
  "conversations.create": { featureId: GrowthAgentFeatureId; title?: string; context?: GrowthAgentContext | null };
  "conversations.list": { featureId?: GrowthAgentFeatureId; search?: string; cursor?: string; limit?: number };
  "conversations.get": { conversationId: string; cursor?: string; limit?: number };
  "conversations.context": { conversationId: string; context: GrowthAgentContext | null };
  "turns.submit": { conversationId: string; text: string; context?: GrowthAgentContext | null };
  "tasks.list": { conversationId?: string; state?: string; search?: string; cursor?: string; limit?: number };
  "tasks.get": { taskId: string };
  "tasks.export": { taskId: string };
  "tasks.observe": { taskId: string; childTaskId?: string; cursor?: string; operationCursor?: string; limit?: number };
  "tasks.events": { taskId: string; cursor?: string; limit?: number };
  "tasks.cancel": { taskId: string };
  "tasks.instructions": { taskId: string; instruction: string };
  "tasks.continue": { taskId: string };
  "reviews.list": { taskId: string };
  "reviews.decide": { taskId: string; reviewId: string; payloadDigest: string; decision: "approve" | "reject" };
  "artifacts.list": { taskId: string; childTaskId?: string };
  "artifacts.get": { taskId: string; artifactId: string; childTaskId?: string; offset?: number };
}
export type GrowthAgentCommandOperation = keyof GrowthAgentCommandInputs;
export type GrowthAgentCommand<K extends GrowthAgentCommandOperation = GrowthAgentCommandOperation> = {
  version: "1"; requestId: string; tenantId: string; actor: GrowthAgentActor;
} & { [P in K]: { operation: P; input: GrowthAgentCommandInputs[P] } }[K];
export interface GrowthAgentCommandOutputs extends GrowthAgentResourceOutputs {
  "models.list": { defaultModel?: GrowthAgentModelOption | null; revision: number; inherited: boolean; current: {connectionId: string; modelId: string} | null; models: GrowthAgentModelOption[] };
  "models.select": { revision: number };
  "memory.list": { memories: GrowthAgentMemory[]; candidates: GrowthAgentMemory[]; nextOffset?: number | null; generation: number };
  "memory.mutate": GrowthAgentMemory;
  "memory.configure": { enabled: boolean; revision: number };
  "features.list": { features: GrowthAgentFeature[]; model: { label: string; ready: boolean } | null };
  "features.upgrade.preview": GrowthAgentCapabilityUpgradePreview;
  "features.upgrade.apply": { revisions: Partial<Record<GrowthAgentFeatureId, number>> };
  "features.configure": { feature: GrowthAgentFeature };
  "conversations.create": { conversation: GrowthAgentConversation };
  "conversations.list": { conversations: GrowthAgentConversation[]; nextCursor: string | null };
  "conversations.get": { conversation: GrowthAgentConversation; messages: GrowthAgentMessage[]; nextCursor: string | null };
  "conversations.context": { conversation: GrowthAgentConversation };
  "turns.submit": { task: GrowthAgentTask; replayed: boolean };
  "tasks.list": { tasks: GrowthAgentTask[]; nextCursor: string | null };
  "tasks.get": { task: GrowthAgentTask };
  "tasks.export": { capture: unknown };
  "tasks.observe": GrowthAgentObservation;
  "tasks.events": { events: GrowthAgentEvent[]; nextCursor: string | null };
  "tasks.cancel": { task: GrowthAgentTask };
  "tasks.instructions": { accepted: true };
  "tasks.continue": { task: GrowthAgentTask };
  "reviews.list": { reviews: GrowthAgentReview[] };
  "reviews.decide": { reviewId: string; state: string };
  "artifacts.list": { artifacts: GrowthAgentArtifact[] };
  "artifacts.get": { artifact: GrowthAgentArtifact };
}
export interface GrowthAgentMemory { id: string; revision: number; content: string; status: "candidate" | "accepted" | "forgotten"; origin: "user_supplied" | "model_candidate"; assertion: MemoryAssertion; verified: false; createdAt: string; updatedAt: string; expiresAt: string | null }
export interface GrowthAgentActionInputs {
  "authorization.check": { context?: GrowthAgentContext | null; manage?: boolean };
  "workspace.read": Record<string, never>;
  "context.read": { context: GrowthAgentContext };
  "draft.prepare": { draft: GrowthDraftProposal };
  "draft.commit": { reviewId: string; payloadDigest: string };
  "draft.reconcile": { reviewId: string };
  "operation.review.read": { reviewId: string };
}
export type GrowthAgentActionOperation = keyof GrowthAgentActionInputs;
export type GrowthAgentAction<K extends GrowthAgentActionOperation = GrowthAgentActionOperation> = {
  version: "1"; requestId: string; tenantId: string; actor: GrowthAgentActor;
  taskId: string; conversationId: string; featureId: GrowthAgentFeatureId;
  operationId: string; context: GrowthAgentContext | null; contextRevision?: string | null;
} & { [P in K]: { operation: P; input: GrowthAgentActionInputs[P] } }[K];
export interface GrowthAgentContextEvidence {
  context: GrowthAgentContext; revision: string; data: unknown; sources: GrowthAgentSource[];
}
export interface GrowthAgentActionOutputs {
  "authorization.check": { authorized: true };
  "workspace.read": GrowthAgentContextEvidence;
  "context.read": GrowthAgentContextEvidence;
  "draft.prepare": { review: GrowthDraftReview };
  "draft.commit": { review: GrowthDraftReview; result: GrowthDraftReceipt | null };
  "draft.reconcile": { review: GrowthDraftReview; result: GrowthDraftReceipt | null };
  "operation.review.read": { review: GrowthOperationReview; result: null };
}

/** The product wire protocol hashes this JSON form before signing either boundary. */
export function growthAgentCanonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(growthAgentCanonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${growthAgentCanonicalJson(object[key])}`).join(",")}}`;
  }
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value);
  throw new Error("Growth agent wire values must be JSON");
}
export class GrowthAgentContractError extends Error {}
const invalidGrowthContract = (): never => { throw new GrowthAgentContractError("Invalid Growth agent request"); };
function growthObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidGrowthContract();
  const item = value as Record<string, unknown>;
  if (Object.keys(item).some(key => !fields.includes(key))) return invalidGrowthContract();
  return item;
}
function growthString(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || value.includes("\u0000")) return invalidGrowthContract();
  return value;
}
export function parseGrowthAgentContext(value: unknown): GrowthAgentContext {
  const item = growthObject(value, ["kind", "resourceId", "range", "report"]);
  if (!["workspace", "content_post", "whatsapp_campaign", "analytics_report"].includes(String(item.kind))) return invalidGrowthContract();
  if (item.resourceId !== undefined) growthString(item.resourceId);
  if ((item.kind === "content_post" || item.kind === "whatsapp_campaign") && !item.resourceId) return invalidGrowthContract();
  if (item.range !== undefined) {
    const range = growthObject(item.range, ["from", "to", "timezone"]);
    for (const field of ["from", "to", "timezone"]) growthString(range[field]);
    if (!Number.isFinite(Date.parse(String(range.from))) || !Number.isFinite(Date.parse(String(range.to))) || Date.parse(String(range.from)) >= Date.parse(String(range.to))) return invalidGrowthContract();
    try { new Intl.DateTimeFormat("en", { timeZone: String(range.timezone) }); } catch { return invalidGrowthContract(); }
  }
  if(item.report!==undefined) {
    if(item.kind!=="analytics_report")return invalidGrowthContract();
    const report=growthObject(item.report,["metrics","breakdowns","filters"]);
    const names=(value:unknown):string[]=>{if(!Array.isArray(value)||value.length>20)return invalidGrowthContract();for(const entry of value)growthString(entry,128);return value as string[];};
    names(report.metrics);names(report.breakdowns);
    if(!report.filters||typeof report.filters!=="object"||Array.isArray(report.filters)||Object.keys(report.filters).length>20)return invalidGrowthContract();
    for(const [key,values] of Object.entries(report.filters)){growthString(key,128);names(values);}
  }
  return item as unknown as GrowthAgentContext;
}
export function parseGrowthDraftProposal(value: unknown): GrowthDraftProposal {
  const item = growthObject(value, ["title", "content", "channels", "channelSelections", "variants"]);
  growthString(item.title, 240); growthString(item.content, 100000);
  if (!Array.isArray(item.channels) || item.channels.length > 7 || new Set(item.channels).size !== item.channels.length) return invalidGrowthContract();
  const platforms = ["FACEBOOK", "INSTAGRAM", "THREADS", "TIKTOK", "BLUESKY", "LINKEDIN", "X"];
  for (const platform of item.channels) if (!platforms.includes(String(platform))) return invalidGrowthContract();
  const selected = growthObject(item.channelSelections, item.channels as string[]);
  for (const value of Object.values(selected)) growthString(value);
  if (item.variants !== undefined) {
    if (!Array.isArray(item.variants) || item.variants.length > 7) return invalidGrowthContract();
    const seen = new Set<string>();
    for (const value of item.variants) {
      const variant = growthObject(value, ["platform", "content"]);
      if (!(item.channels as string[]).includes(String(variant.platform)) || seen.has(String(variant.platform))) return invalidGrowthContract();
      seen.add(String(variant.platform)); growthString(variant.content, 100000);
    }
  }
  return item as unknown as GrowthDraftProposal;
}
export function parseGrowthAgentCommand(value: unknown): GrowthAgentCommand {
  const item = growthObject(value, ["version", "requestId", "tenantId", "actor", "operation", "input"]);
  if (item.version !== "1") return invalidGrowthContract();
  for (const key of ["requestId", "tenantId"]) growthString(item[key]);
  const actor = growthObject(item.actor, ["issuer", "subject"]); growthString(actor.issuer, 512); growthString(actor.subject, 512);
  if (isGrowthResourceOperation(item.operation)) {
    const input = growthObject(item.input, GROWTH_RESOURCE_FIELDS[item.operation]);
    if (!GROWTH_AGENT_FEATURE_IDS.includes(input.featureId as GrowthAgentFeatureId) || !validGrowthResourceInput(item.operation, input)) return invalidGrowthContract();
    return item as unknown as GrowthAgentCommand;
  }
  const operations: Partial<Record<GrowthAgentCommandOperation, readonly string[]>> = {
    "models.list": ["featureId"], "models.select": ["featureId", "expectedRevision", "selection"],
    "memory.list": ["featureId", "offset", "limit"],
    "memory.mutate": ["featureId", "memoryId", "expectedRevision", "action", "content", "assertion"],
    "memory.configure": ["featureId", "expectedRevision", "enabled"],
    "features.upgrade.preview": ["featureId", "publication"], "features.upgrade.apply": ["featureId", "publication", "targetPublicationDigest", "diffDigest", "expectedRevisions", "resolutions"],
    "features.list": ["publication"], "features.configure": ["featureId", "configuration"],
    "conversations.create": ["featureId", "title", "context"], "conversations.list": ["featureId", "search", "cursor", "limit"],
    "conversations.get": ["conversationId", "cursor", "limit"], "conversations.context": ["conversationId", "context"],
    "turns.submit": ["conversationId", "text", "context"], "tasks.list": ["conversationId", "state", "search", "cursor", "limit"],
    "tasks.get": ["taskId"], "tasks.export": ["taskId"], "tasks.observe": ["taskId", "childTaskId", "cursor", "operationCursor", "limit"], "tasks.events": ["taskId", "cursor", "limit"], "tasks.cancel": ["taskId"], "tasks.instructions": ["taskId", "instruction"], "tasks.continue": ["taskId"],
    "reviews.list": ["taskId"], "reviews.decide": ["taskId", "reviewId", "payloadDigest", "decision"],
    "artifacts.list": ["taskId", "childTaskId"], "artifacts.get": ["taskId", "artifactId", "childTaskId", "offset"],
  };
  const fields = Object.hasOwn(operations, String(item.operation)) ? operations[item.operation as GrowthAgentCommandOperation] : undefined; if (!fields) return invalidGrowthContract();
  const input = growthObject(item.input, fields);
  for (const [key, value] of Object.entries(input)) {
    if (["context", "configuration", "publication", "limit", "offset", "expectedRevision", "enabled", "selection", "expectedRevisions", "resolutions"].includes(key)) continue;
    growthString(value, key === "text" ? 131072 : key === "content" ? 8192 : key === "instruction" ? 4000 : key === "search" ? 200 : ["cursor", "operationCursor"].includes(key) ? 2048 : 256);
  }
  const required: Partial<Record<GrowthAgentCommandOperation, string[]>> = {
    "models.list": ["featureId"], "models.select": ["featureId", "expectedRevision", "selection"],
    "memory.list": ["featureId"], "memory.mutate": ["featureId", "memoryId", "expectedRevision", "action"], "memory.configure": ["featureId", "expectedRevision", "enabled"],
    "features.upgrade.preview": ["featureId", "publication"], "features.upgrade.apply": ["featureId", "publication", "targetPublicationDigest", "diffDigest", "expectedRevisions", "resolutions"],
    "features.configure": ["featureId", "configuration"], "conversations.create": ["featureId"],
    "conversations.get": ["conversationId"], "conversations.context": ["conversationId", "context"],
    "turns.submit": ["conversationId", "text"], "tasks.get": ["taskId"], "tasks.export": ["taskId"], "tasks.observe": ["taskId"], "tasks.events": ["taskId"],
    "tasks.cancel": ["taskId"], "tasks.instructions": ["taskId", "instruction"], "tasks.continue": ["taskId"], "reviews.list": ["taskId"],
    "reviews.decide": ["taskId", "reviewId", "payloadDigest", "decision"],
    "artifacts.list": ["taskId"], "artifacts.get": ["taskId", "artifactId"],
  };
  for (const key of required[item.operation as GrowthAgentCommandOperation] ?? []) if (input[key] === undefined) return invalidGrowthContract();
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)) return invalidGrowthContract();
  if (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || Number(input.offset) < 0)) return invalidGrowthContract();
  if (String(item.operation).startsWith("artifacts.") && input.childTaskId !== undefined && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(String(input.childTaskId))) return invalidGrowthContract();
  if (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1)) return invalidGrowthContract();
  if (item.operation === "features.upgrade.apply") {
    if (![input.targetPublicationDigest,input.diffDigest].every(value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value))) return invalidGrowthContract();
    const revisions = growthObject(input.expectedRevisions, GROWTH_AGENT_FEATURE_IDS);
    if (!Object.keys(revisions).length || Object.values(revisions).some(value => !Number.isSafeInteger(value) || Number(value)<1)) return invalidGrowthContract();
    if (!input.resolutions || typeof input.resolutions !== "object" || Array.isArray(input.resolutions) || Object.keys(input.resolutions).length>256 || Object.entries(input.resolutions).some(([key,value])=>key.length>256 || !["keep_current","use_update"].includes(String(value)))) return invalidGrowthContract();
  }
  if (item.operation === "models.select") {
    const selection = growthObject(input.selection, ["kind", "connectionId", "modelId"]);
    if (selection.kind === "organization_default") { if (Object.keys(selection).length !== 1) return invalidGrowthContract(); }
    else if (selection.kind === "connection") {
      if (typeof selection.connectionId !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(selection.connectionId)) return invalidGrowthContract();
      growthString(selection.modelId, 512);
    } else return invalidGrowthContract();
  }
  if (item.operation === "memory.configure" && typeof input.enabled !== "boolean") return invalidGrowthContract();
  if (item.operation === "memory.mutate" && (!["accept", "correct", "forget"].includes(String(input.action)) ||
    !/^[0-9a-f-]{36}$/i.test(String(input.memoryId)) || input.action === "correct" && (typeof input.content !== "string" || !input.content.trim()))) return invalidGrowthContract();
  if (item.operation === "memory.mutate" && input.assertion !== undefined && (input.action === "forget" || !isMemoryAssertion(input.assertion))) return invalidGrowthContract();
  if (input.context !== undefined && input.context !== null) parseGrowthAgentContext(input.context);
  if(input.publication!==undefined){
    const publication=growthObject(input.publication,["manifest","presets","policy"]);
    if(!publication.manifest||!publication.policy||!Array.isArray(publication.presets)||publication.presets.length!==4||JSON.stringify(publication).length>131072)return invalidGrowthContract();
  }
  if (input.featureId !== undefined && !GROWTH_AGENT_FEATURE_IDS.includes(input.featureId as GrowthAgentFeatureId)) return invalidGrowthContract();
  if (["conversations.create", "features.configure"].includes(String(item.operation)) && input.featureId === undefined) return invalidGrowthContract();
  if (item.operation === "conversations.context" && input.context === undefined) return invalidGrowthContract();
  if (item.operation === "reviews.decide" && !["approve", "reject"].includes(String(input.decision))) return invalidGrowthContract();
  if (item.operation === "features.configure") {
    if (!input.configuration || typeof input.configuration !== "object" || Array.isArray(input.configuration)) return invalidGrowthContract();
  }
  return item as unknown as GrowthAgentCommand;
}
export function parseGrowthAgentAction(value: unknown): GrowthAgentAction {
  const item = growthObject(value, ["version", "requestId", "tenantId", "actor", "taskId", "conversationId", "featureId", "operationId", "context", "contextRevision", "operation", "input"]);
  if (item.version !== "1" || !GROWTH_AGENT_FEATURE_IDS.includes(item.featureId as GrowthAgentFeatureId)) return invalidGrowthContract();
  for (const key of ["requestId", "tenantId", "taskId", "conversationId", "operationId"]) growthString(item[key]);
  const actor = growthObject(item.actor, ["issuer", "subject"]); growthString(actor.issuer, 512); growthString(actor.subject, 512);
  if (item.context === undefined) return invalidGrowthContract();
  if (item.context !== null) parseGrowthAgentContext(item.context);
  if (item.contextRevision !== undefined && item.contextRevision !== null) growthString(item.contextRevision);
  const fields: Record<GrowthAgentActionOperation, readonly string[]> = {
    "authorization.check": ["context", "manage"], "workspace.read": [], "context.read": ["context"],
    "draft.prepare": ["draft"], "draft.commit": ["reviewId", "payloadDigest"], "draft.reconcile": ["reviewId"], "operation.review.read": ["reviewId"],
  };
  const accepted = Object.hasOwn(fields, String(item.operation)) ? fields[item.operation as GrowthAgentActionOperation] : undefined; if (!accepted) return invalidGrowthContract();
  const input = growthObject(item.input, accepted);
  if (input.context !== undefined && input.context !== null) parseGrowthAgentContext(input.context);
  if (item.operation === "authorization.check" && input.manage !== undefined && typeof input.manage !== "boolean") return invalidGrowthContract();
  if (item.operation === "context.read" && !input.context) return invalidGrowthContract();
  if (item.operation === "draft.prepare") parseGrowthDraftProposal(input.draft);
  if (["draft.commit", "draft.reconcile", "operation.review.read"].includes(String(item.operation))) growthString(input.reviewId);
  if (item.operation === "draft.commit" && !/^[a-f0-9]{64}$/.test(String(input.payloadDigest))) return invalidGrowthContract();
  return item as unknown as GrowthAgentAction;
}
