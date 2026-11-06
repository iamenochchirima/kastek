import { GROWTH_AGENT_PUBLICATION_MAX_BYTES, GrowthAgentContractError } from "./growth-agents.js";

export const GROWTH_AGENT_PROVISION_PATH = "/internal/v1/products/growth/provision";
export const GROWTH_AGENT_PROVISION_CHECK_PATH = "/internal/agents/provisioning-check";
export const GROWTH_AGENT_DEFAULTS_REVISION = "2" as const;
export interface GrowthAgentDelegationPolicy {
  maxChildren: number;
  maxDepth: number | null;
  policy: { maxTasks: number | null; maxStalls: number };
  childLimits: { maxTokens: number | null; maxActiveMs: number | null };
  delegates: Record<import("./growth-agents.js").GrowthAgentFeatureId, import("./growth-agents.js").GrowthAgentFeatureId[]>;
}
export interface GrowthAgentPublication {
  manifest: import("./product-capabilities.js").ProductCapabilityManifest;
  presets: readonly {id: import("./growth-agents.js").GrowthAgentFeatureId;name:string;description:string;instructions:string;operations:string[]}[];
  policy: {revision:string; optionalCapabilities:Record<"knowledge"|"skills"|"memory"|"delegation"|"sandbox"|"workflows"|"connections",boolean>;delegation?:GrowthAgentDelegationPolicy};
}
export interface GrowthAgentProvisionRequest {
  version: "1";
  requestId: string;
  tenantId: string;
  defaultsRevision: string;
  modelProfileId: string;
  modelProfileRevision: string;
  publication?: GrowthAgentPublication;
  upgradeDefaults?: boolean;
}
export interface GrowthAgentProvisionResult {
  version: "1";
  tenantId: string;
  defaultsRevision: string;
  modelProfileId: string;
  modelProfileRevision: string;
  state: "ready" | "blocked";
  code?: string;
}
export interface GrowthAgentSetupDto {
  state: "pending" | "running" | "ready" | "blocked" | "failed" | "cancelled";
  code: string | null;
  updatedAt: string;
}
const token = (value: unknown, max: number): string => {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw new GrowthAgentContractError("Invalid provisioning field");
  return value;
};
function object(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GrowthAgentContractError("Invalid provisioning request");
  const row = value as Record<string, unknown>;
  if (Object.keys(row).some(key => !fields.includes(key))) throw new GrowthAgentContractError("Unexpected provisioning field");
  return row;
}
export function parseGrowthAgentProvisionRequest(value: unknown): GrowthAgentProvisionRequest {
  const row = object(value, ["version", "requestId", "tenantId", "defaultsRevision", "modelProfileId", "modelProfileRevision", "publication", "upgradeDefaults"]);
  if (row.version !== "1" || typeof row.defaultsRevision !== "string" || typeof row.requestId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.requestId)) throw new GrowthAgentContractError("Invalid provisioning identity");
  if (row.upgradeDefaults !== undefined && typeof row.upgradeDefaults !== "boolean") throw new GrowthAgentContractError("Invalid upgrade mode");
  if (row.publication !== undefined) {
    const publication=object(row.publication,["manifest","presets","policy"]);
    if(!publication.manifest||!publication.policy||!Array.isArray(publication.presets)||publication.presets.length!==4||new TextEncoder().encode(JSON.stringify(publication)).byteLength>GROWTH_AGENT_PUBLICATION_MAX_BYTES)throw new GrowthAgentContractError("Invalid publication");
  }
  return {version: "1", requestId: row.requestId, tenantId: token(row.tenantId, 256), defaultsRevision: token(row.defaultsRevision,128), modelProfileId: token(row.modelProfileId, 128), modelProfileRevision: token(row.modelProfileRevision, 128),
    ...(row.publication===undefined?{}:{publication:row.publication as GrowthAgentPublication}),...(row.upgradeDefaults===undefined?{}:{upgradeDefaults:row.upgradeDefaults as boolean})};
}
export function parseGrowthAgentProvisionResult(value: unknown): GrowthAgentProvisionResult {
  const row = object(value, ["version", "tenantId", "defaultsRevision", "modelProfileId", "modelProfileRevision", "state", "code"]);
  if (row.version !== "1" || typeof row.defaultsRevision !== "string" || !["ready", "blocked"].includes(String(row.state))) throw new GrowthAgentContractError("Invalid provisioning result");
  if (row.code !== undefined && (typeof row.code !== "string" || !/^[A-Z][A-Z0-9_]{0,79}$/.test(row.code))) throw new GrowthAgentContractError("Invalid provisioning result code");
  if (row.state === "blocked" && !row.code || row.state === "ready" && row.code !== undefined) throw new GrowthAgentContractError("Invalid provisioning readiness");
  return {version: "1", tenantId: token(row.tenantId, 256), defaultsRevision: token(row.defaultsRevision,128), modelProfileId: token(row.modelProfileId, 128), modelProfileRevision: token(row.modelProfileRevision, 128), state: row.state as "ready" | "blocked", ...(row.code ? {code: row.code as string} : {})};
}
