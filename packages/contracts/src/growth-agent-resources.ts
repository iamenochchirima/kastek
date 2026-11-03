import type { GrowthAgentFeatureId } from "./growth-agents.js";

export type GrowthSkillImport = { source: "curated"; slug: string } | { source: "zip"; contentBase64: string }
  | { source: "files"; files: { path: string; content: string; encoding?: "utf8" | "base64" }[] };
export interface GrowthAgentResourceInputs {
  "resources.list": { featureId: GrowthAgentFeatureId };
  "resources.preview": { featureId: GrowthAgentFeatureId } & ({ kind: "source"; sourceId: string; revisionId: string } | { kind: "skill"; skillId: string; path?: string });
  "sources.import": { featureId: GrowthAgentFeatureId; title: string; text: string; contentType?: "text/plain" | "text/markdown" };
  "sources.review": { featureId: GrowthAgentFeatureId; sourceId: string; revisionId: string; expectedGeneration: number };
  "sources.state": { featureId: GrowthAgentFeatureId; sourceId: string; expectedGeneration: number; state: "withdrawn" };
  "skills.import": { featureId: GrowthAgentFeatureId; package: GrowthSkillImport };
  "skills.review": { featureId: GrowthAgentFeatureId; skillId: string; contentDigest: string };
  "skills.state": { featureId: GrowthAgentFeatureId; skillId: string; expectedGeneration: number; state: "enabled" | "disabled" | "removed" };
  "resources.select": { featureId: GrowthAgentFeatureId; expectedRevision: number; sourceRevisionIds: string[]; skillIds: string[] };
}
export interface GrowthAgentResourceInventory {
  featureId: GrowthAgentFeatureId; revision: number; sourceRevisionIds: string[]; skillIds: string[];
  sources: { id: string; title: string; generation: number; state: "active" | "withdrawn";
    revisions: { id: string; revision: number; state: "candidate" | "approved" | "withdrawn"; acquiredAt: string }[] }[];
  skills: { id: string; name: string; description: string; revision: number; contentDigest: string; reviewState: "pending" | "reviewed";
    state: "enabled" | "disabled" | "removed"; generation: number; files: { path: string; size: number; contentDigest: string }[];
    missing: { connectionProfiles: string[]; permissions: string[]; runtimes: string[] } }[];
  curatedSkills: { slug: string; name: string; description: string }[];
  supportedFormats: { sources: ("text/plain" | "text/markdown")[]; skills: ("files" | "zip" | "curated")[] };
}
export interface GrowthAgentResourcePreview { kind: "source" | "skill"; title: string; content: string; contentDigest: string; path?: string }
export interface GrowthAgentResourceOutputs {
  "resources.list": GrowthAgentResourceInventory;
  "resources.preview": GrowthAgentResourcePreview;
  "sources.import": GrowthAgentResourceInventory;
  "sources.review": GrowthAgentResourceInventory;
  "sources.state": GrowthAgentResourceInventory;
  "skills.import": GrowthAgentResourceInventory;
  "skills.review": GrowthAgentResourceInventory;
  "skills.state": GrowthAgentResourceInventory;
  "resources.select": GrowthAgentResourceInventory;
}
export const GROWTH_RESOURCE_FIELDS = {
  "resources.list": ["featureId"], "resources.preview": ["featureId", "kind", "sourceId", "revisionId", "skillId", "path"],
  "sources.import": ["featureId", "title", "text", "contentType"], "sources.review": ["featureId", "sourceId", "revisionId", "expectedGeneration"],
  "sources.state": ["featureId", "sourceId", "expectedGeneration", "state"], "skills.import": ["featureId", "package"],
  "skills.review": ["featureId", "skillId", "contentDigest"], "skills.state": ["featureId", "skillId", "expectedGeneration", "state"],
  "resources.select": ["featureId", "expectedRevision", "sourceRevisionIds", "skillIds"],
} as const;
export type GrowthAgentResourceOperation = keyof GrowthAgentResourceInputs;
export function isGrowthResourceOperation(value: unknown): value is GrowthAgentResourceOperation { return typeof value === "string" && Object.hasOwn(GROWTH_RESOURCE_FIELDS, value); }
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const uuid = (value: unknown) => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const positive = (value: unknown) => Number.isSafeInteger(value) && Number(value) > 0;
const object = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => keys.includes(key));

export function validGrowthResourceInput(operation: GrowthAgentResourceOperation, input: Record<string, unknown>): boolean {
  if (!text(input.featureId, 64)) return false;
  if (operation === "resources.list") return true;
  if (operation === "resources.select") return positive(input.expectedRevision) && [input.sourceRevisionIds, input.skillIds].every((value, index) => Array.isArray(value) && value.length <= (index === 0 ? 20 : 8) && value.every(uuid) && new Set(value).size === value.length);
  if (operation === "resources.preview") return input.kind === "source" ? uuid(input.sourceId) && uuid(input.revisionId) && input.skillId === undefined && input.path === undefined
    : input.kind === "skill" && uuid(input.skillId) && input.sourceId === undefined && input.revisionId === undefined && (input.path === undefined || text(input.path, 256));
  if (operation === "sources.import") return text(input.title, 200) && text(input.text, 262144) && (input.contentType === undefined || ["text/plain", "text/markdown"].includes(String(input.contentType)));
  if (operation === "sources.review") return uuid(input.sourceId) && uuid(input.revisionId) && positive(input.expectedGeneration);
  if (operation === "sources.state") return uuid(input.sourceId) && positive(input.expectedGeneration) && input.state === "withdrawn";
  if (operation === "skills.review") return uuid(input.skillId) && typeof input.contentDigest === "string" && /^[a-f0-9]{64}$/.test(input.contentDigest);
  if (operation === "skills.state") return uuid(input.skillId) && positive(input.expectedGeneration) && ["enabled", "disabled", "removed"].includes(String(input.state));
  const pkg = input.package;
  if (!object(pkg, ["source", "slug", "contentBase64", "files"])) return false;
  if (pkg.source === "curated") return text(pkg.slug, 80) && pkg.files === undefined && pkg.contentBase64 === undefined;
  if (pkg.source === "zip") return text(pkg.contentBase64, 2796204) && pkg.files === undefined && pkg.slug === undefined;
  return pkg.source === "files" && pkg.slug === undefined && pkg.contentBase64 === undefined && Array.isArray(pkg.files) && pkg.files.length >= 1 && pkg.files.length <= 128 && pkg.files.every(file =>
    object(file, ["path", "content", "encoding"]) && text(file.path, 256) && typeof file.content === "string" && file.content.length <= 1048576 && (file.encoding === undefined || ["utf8", "base64"].includes(String(file.encoding))));
}
