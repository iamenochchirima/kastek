import type { ProductCapabilityManifest } from "./product-capabilities.js";
import type { ProductAgentObservation, ProductAgentTask, ProductAgentMessage } from "./product-agent-shared.js";
import { isMemoryAssertion, type MemoryAssertion } from "./agent-memory.js";

export const AGENCY_AGENT_COMMAND_PATH = "/internal/v1/products/agencies/commands";
export const AGENCY_AGENT_MODEL_PATH = "/internal/v1/products/agencies/model";
export interface AgencyAgentModelConfiguration {
  version:"1"; operation:"model.configure"; requestId:string; tenantId:string; clientId:string;
  actor:{issuer:string;subject:string}; input:{providerId:string;modelId:string;apiKey:string;endpoint?:string};
}
export type AgencyAgentTask = ProductAgentTask;
export type AgencyAgentObservation = ProductAgentObservation;
export interface AgencyAgentConversation {
  id: string; clientId: string; title: string; createdAt: string; updatedAt: string;
}
export interface AgencyAgentCommandInputs {
  "tenant.ensure": { mappingRef: string; manifest: ProductCapabilityManifest };
  "readiness.get": Record<string, never>;
  "conversations.create": { title?: string };
  "conversations.list": { cursor?: string; limit?: number };
  "conversations.get": { conversationId: string; cursor?: string; limit?: number };
  "turns.submit": { conversationId: string; text: string };
  "tasks.get": { taskId: string };
  "tasks.observe": { taskId: string; childTaskId?: string; cursor?: string; operationCursor?: string; limit?: number };
  "tasks.cancel": { taskId: string };
  "tasks.instructions": { taskId: string; instruction: string };
  "tasks.continue": { taskId: string };
  "artifacts.list": { taskId: string; childTaskId?: string };
  "artifacts.get": { taskId: string; artifactId: string; childTaskId?: string; offset?: number };
  "memory.list": { offset?: number; limit?: number };
  "memory.propose": { kind: "semantic" | "episodic"; content: string };
  "memory.mutate": { memoryId: string; expectedRevision: number; action: "accept" | "correct" | "forget"; content?: string; assertion?: MemoryAssertion };
  "memory.configure": { enabled: boolean; expectedRevision: number };
  "models.providers": Record<string,never>;
}
export type AgencyAgentOperation = keyof AgencyAgentCommandInputs;
export type AgencyAgentCommand<K extends AgencyAgentOperation = AgencyAgentOperation> = K extends AgencyAgentOperation ? {
  version: "1"; requestId: string; tenantId: string; clientId: string;
  actor: { issuer: string; subject: string }; operation: K; input: AgencyAgentCommandInputs[K];
} : never;
export interface AgencyAgentHistory {
  conversation: AgencyAgentConversation; messages: ProductAgentMessage[]; tasks: AgencyAgentTask[]; nextCursor: string | null;
}
export class AgencyAgentContractError extends Error {}

export function parseAgencyAgentCommand(input: unknown): AgencyAgentCommand {
  const fail = (): never => { throw new AgencyAgentContractError("Invalid Agency agent command"); };
  const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
  const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
  const uuid = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const root = object(input), actor = object(root.actor), args = object(root.input);
  if (Object.keys(root).some(key => !["version", "requestId", "tenantId", "clientId", "actor", "operation", "input"].includes(key)) ||
      root.version !== "1" || !uuid(root.requestId) || !text(root.tenantId) || !text(root.clientId) ||
      Object.keys(actor).some(key => !["issuer", "subject"].includes(key)) || !text(actor.issuer, 512) || !text(actor.subject, 512)) fail();
  try { const url = new URL(actor.issuer as string); if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) fail(); } catch { fail(); }
  const fields: Record<AgencyAgentOperation, string[]> = {
    "tenant.ensure": ["mappingRef", "manifest"], "readiness.get": [], "conversations.create": ["title"],
    "conversations.list": ["cursor", "limit"], "conversations.get": ["conversationId", "cursor", "limit"],
    "turns.submit": ["conversationId", "text"], "tasks.get": ["taskId"],
    "tasks.observe": ["taskId", "childTaskId", "cursor", "operationCursor", "limit"],
    "tasks.cancel": ["taskId"], "tasks.instructions": ["taskId", "instruction"], "tasks.continue": ["taskId"],
    "artifacts.list": ["taskId", "childTaskId"], "artifacts.get": ["taskId", "artifactId", "childTaskId", "offset"],
    "memory.list": ["offset", "limit"], "memory.propose": ["kind", "content"], "memory.mutate": ["memoryId", "expectedRevision", "action", "content", "assertion"],
    "memory.configure": ["enabled", "expectedRevision"],
    "models.providers": [],
  };
  if (typeof root.operation !== "string" || !Object.hasOwn(fields, root.operation)) fail();
  const operation = root.operation as AgencyAgentOperation;
  if (Object.keys(args).some(key => !fields[operation].includes(key))) fail();
  if (["conversations.get", "turns.submit"].includes(operation) && !uuid(args.conversationId)) fail();
  if ((operation.startsWith("tasks.") || operation.startsWith("artifacts.")) && !uuid(args.taskId)) fail();
  if (operation === "artifacts.get" && !uuid(args.artifactId)) fail();
  if (args.childTaskId !== undefined && !uuid(args.childTaskId)) fail();
  if (args.title !== undefined && !text(args.title, 200)) fail();
  for (const name of ["cursor", "operationCursor"]) if (args[name] !== undefined && !text(args[name], 4096)) fail();
  if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) fail();
  for (const name of ["text", "instruction"]) {
    if ((operation === "turns.submit" && name === "text" || operation === "tasks.instructions" && name === "instruction") &&
        (typeof args[name] !== "string" || !args[name].trim() || args[name].length > 32768)) fail();
  }
  if(operation==="tasks.instructions"&&(args.instruction as string).length>4000)fail();
  if (operation === "tenant.ensure" && (!text(args.mappingRef) || !args.manifest || typeof args.manifest !== "object" || Array.isArray(args.manifest))) fail();
  if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) fail();
  if (operation === "artifacts.get" && args.offset !== undefined && Number(args.offset) > 1048576) fail();
  if(operation==="memory.propose"&&(!["semantic","episodic"].includes(String(args.kind))||typeof args.content!=="string"||!args.content.trim()||args.content.length>8192))fail();
  if(operation==="memory.mutate"&&(!uuid(args.memoryId)||!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<1||!["accept","correct","forget"].includes(String(args.action))||
    (args.action==="correct"&&(typeof args.content!=="string"||!args.content.trim()||args.content.length>8192))))fail();
  if(operation==="memory.mutate"&&args.assertion!==undefined&&(args.action==="forget"||!isMemoryAssertion(args.assertion)))fail();
  if(operation==="memory.configure"&&(typeof args.enabled!=="boolean"||!Number.isSafeInteger(args.expectedRevision)||Number(args.expectedRevision)<1))fail();
  return root as unknown as AgencyAgentCommand;
}
