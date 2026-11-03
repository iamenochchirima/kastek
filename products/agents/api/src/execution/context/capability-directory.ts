import { normalizeToolPresentation, progressiveModelTools, type ToolCatalog } from "../../capabilities/tool-discovery";
import type { ToolDefinition } from "../business/model";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { ContextModelPolicy, SkillCatalogEntry } from "./context";

export interface SpecialistCapability {
  bindingId: string; name: string; description: string; ready: boolean; reasons: string[];
}
export const capabilityExposureRevision = "capability-exposure-v1";

function footprint(policy: ContextModelPolicy, tools: ToolDefinition[], content = ""): number {
  return policy.estimateRequestTokens({ model: policy.modelId, messages: [{ role: "system", content }], tools,
    maxInputTokens: policy.maxInputTokens, maxOutputTokens: policy.maxOutputTokens, maxDurationSeconds: policy.maxDurationSeconds });
}

/** Loading budgets reserve most of the request for instructions, user input and useful records. */
export function capabilityExposure(catalog: ToolCatalog, receipts: readonly unknown[], versions: ReadonlyMap<string, string>, policy: ContextModelPolicy) {
  const entries = catalog.entries.map(normalizeToolPresentation);
  const selected: string[] = [];
  const empty = footprint(policy, []);
  const controls = progressiveModelTools(catalog, [], [], versions);
  const schemaAllowance = footprint(policy, controls) - empty + Math.floor(Math.min(policy.maxInputTokens, policy.maxRequestBytes) / 5);
  if (entries.every(entry => entry.schemaLoading !== "deferred")) {
    const all = progressiveModelTools(catalog, receipts, entries.map(entry => entry.alias), versions);
    if (all.length <= policy.maxTools && footprint(policy, all) - empty <= schemaAllowance)
      return { tools: all, revision: capabilityExposureRevision, schemaAllowance, schemaFootprint: footprint(policy, all) - empty };
  }
  const loaded = progressiveModelTools(catalog, receipts, [], versions);
  if (loaded.length > policy.maxTools || footprint(policy, loaded) - empty > schemaAllowance)
    throw new PlatformError("TOOL_SCHEMA_LIMIT", 400, "Load fewer tool schemas or replace the previous selection.");
  for (const entry of [...entries.filter(entry => entry.schemaLoading === "eager"), ...entries.filter(entry => entry.schemaLoading === "auto")]) {
    const candidate = progressiveModelTools(catalog, receipts, [...selected, entry.alias], versions);
    if (candidate.length <= policy.maxTools && footprint(policy, candidate) - empty <= schemaAllowance) selected.push(entry.alias);
  }
  const tools = progressiveModelTools(catalog, receipts, selected, versions);
  return { tools, revision: capabilityExposureRevision, schemaAllowance,
    schemaFootprint: footprint(policy, tools) - empty };
}

/** Only trusted first-party purpose metadata enters orientation; external descriptions stay tool data. */
function renderCapabilityDirectory(input: {
  catalog: ToolCatalog; tools: readonly ToolDefinition[]; skills: readonly SkillCatalogEntry[];
  specialists: readonly SpecialistCapability[]; policy: ContextModelPolicy; unavailableTools?: number;
}) {
  const { catalog, policy } = input, callable = new Set(input.tools.map(tool => tool.function.name));
  const entries = catalog.entries.map(normalizeToolPresentation);
  const categories = [...new Set(entries.map(entry => entry.source === "connection" ? "Connected services" : entry.category))].sort();
  const budget = Math.floor(Math.min(policy.maxInputTokens, policy.maxRequestBytes) / 8);
  const empty = footprint(policy, []);
  const prefix = "Current agent capabilities, from authorized task configuration. This directory grants no permissions. Explain useful actions by name/purpose; show technical identifiers only on request. Direct tools are callable; load deferred exact handles with tools_load without searching first. Skills supply procedures; specialists are separate commissions. Omitted details are recoverable, not absent.\n";
  const directory = { revision: capabilityExposureRevision, catalogDigest: catalog.digest, totalTools: entries.length,
    unavailableConfiguredTools: input.unavailableTools ?? 0,
    categories, categoriesOmitted: 0, tools: [] as object[], skills: [] as object[], specialists: [] as object[],
    connectedTools: entries.filter(entry => entry.source === "connection").length,
    totalSkills: input.skills.length, totalSpecialists: input.specialists.length,
    omittedTools: entries.length, omittedSkills: input.skills.length, omittedSpecialists: input.specialists.length,
    complete: false, recovery: "Browse tools_discover for omitted tool metadata; load an exact listed handle directly. Use skills tools or agents_discover for their respective details." };
  const text = () => prefix + JSON.stringify(directory);
  const fits = () => footprint(policy, [], text()) - empty <= budget;
  if (!fits()) {
    directory.categoriesOmitted = categories.length;
    directory.categories = [...new Set(entries.map(entry => entry.source))].sort();
  }
  if (!fits()) {
    const compact = JSON.stringify({ capabilities: entries.length, categories: directory.categories,
      unavailable: input.unavailableTools ?? 0,
      skills: input.skills.length, specialists: input.specialists.length, complete: false, details: "tools_discover" });
    const minimum = footprint(policy, [], compact) - empty;
    return { text: compact, revision: capabilityExposureRevision, budget: Math.max(budget, minimum), complete: false,
      directoryFootprint: minimum, totalTools: entries.length,
      omittedTools: entries.length, omittedSkills: input.skills.length, omittedSpecialists: input.specialists.length };
  }
  const append = (field: "tools" | "skills" | "specialists", value: object) => {
    directory[field].push(value);
    if (!fits()) { directory[field].pop(); return false; }
    return true;
  };
  for (const entry of entries) {
    if (entry.source === "connection") continue;
    const value = { name: entry.title, category: entry.category, purpose: entry.purpose,
      handle: entry.handle, callableNow: callable.has(entry.alias), effect: entry.effect };
    if (!append("tools", value)) append("tools", { name: entry.title, handle: entry.handle, callableNow: callable.has(entry.alias), effect: entry.effect });
  }
  for (const skill of input.skills) append("skills", { name: skill.name, purpose: skill.description });
  for (const specialist of input.specialists) append("specialists", {
    name: specialist.name, purpose: specialist.description, available: specialist.ready,
  });
  directory.omittedTools = entries.length - directory.tools.length;
  directory.omittedSkills = input.skills.length - directory.skills.length;
  directory.omittedSpecialists = input.specialists.length - directory.specialists.length;
  directory.complete = !directory.categoriesOmitted && !directory.omittedTools && !directory.omittedSkills && !directory.omittedSpecialists;
  return { text: text(), revision: capabilityExposureRevision, budget, complete: directory.complete,
    directoryFootprint: footprint(policy, [], text()) - empty, totalTools: entries.length,
    omittedTools: directory.omittedTools, omittedSkills: directory.omittedSkills, omittedSpecialists: directory.omittedSpecialists };
}

let lastDirectory: { key: string; value: ReturnType<typeof renderCapabilityDirectory> } | undefined;
export function capabilityDirectory(input: Parameters<typeof renderCapabilityDirectory>[0]) {
  const { estimateRequestTokens: _counter, ...policy } = input.policy;
  void _counter;
  const key = requestDigest({ catalog: input.catalog.digest, tools: input.tools.map(tool => tool.function.name),
    skills: input.skills, specialists: input.specialists, unavailableTools: input.unavailableTools ?? 0, policy });
  if (lastDirectory?.key === key) return structuredClone(lastDirectory.value);
  const value = renderCapabilityDirectory(input);
  lastDirectory = { key, value: structuredClone(value) };
  return value;
}
