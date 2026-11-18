import type { Pool } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { SkillRevision } from "../../contracts/memory";
import { skillSourceMessage, type ContextGroup, type ContextModelPolicy, type ContextSource, type SkillCatalogEntry } from "./context";
import type { HarnessMessage, ModelRequest } from "../business/model";
import { validateBuiltinResult } from "../../capabilities/tool-contracts";
import { skillLoadResult, type SkillLoadResult } from "../../capabilities/skills/runtime";

export function skillLoadContextSource(result: SkillLoadResult, name: string): ContextSource {
  return { id: result.skillId, revision: result.revision, kind: "skill",
    content: name === "skills.activate" ? JSON.stringify({ instructions: result.content, compatibility: result.compatibility, resources: result.resources }) : result.content,
    skillFile: result.evidence, ...(result.range ? { skillRange: result.range, ...(result.range.complete ? {} : { excerpt: true as const }) } : {}) };
}

function skillReceipt(result: SkillLoadResult) {
  return { skillId: result.skillId, revision: result.revision, loaded: true, evidence: result.evidence,
    ...(result.range ? { loadedRange: result.range } : {}),
    contentNote: "Content is carried separately and may be excerpted or omitted. Use the content source's range for visible bytes." };
}

/** Measure the loaded source and its compact receipt in the pending model request. */
export function skillFitsRequest(result: SkillLoadResult, name: string, request: ModelRequest, pending: HarnessMessage[],
  toolCallId: string, policy: ContextModelPolicy): boolean {
  const source = skillSourceMessage(skillLoadContextSource(result, name));
  const existing = request.messages.some(message => message.role === source.role && message.content === source.content);
  const receipt: HarnessMessage = { role: "tool", tool_call_id: toolCallId, content: JSON.stringify(skillReceipt(result)) };
  const candidate = { ...request, messages: [...request.messages, ...(existing ? [] : [source]), ...pending, receipt] };
  const estimated = policy.estimateRequestTokens(candidate);
  return candidate.messages.length <= policy.maxMessages && Buffer.byteLength(JSON.stringify(candidate), "utf8") <= policy.maxRequestBytes &&
    estimated + policy.safetyTokens <= policy.maxInputTokens &&
    BigInt(estimated) + BigInt(candidate.maxOutputTokens) + BigInt(policy.safetyTokens) <= BigInt(policy.contextWindowTokens);
}

/** Completed load receipts restore full influencing files after compaction and worker replay. */
export async function skillContext(pool: Pool, taskId: string, selected: SkillRevision[]) {
  const catalog: SkillCatalogEntry[] = selected.filter(skill => skill.package).map(skill => ({ id: skill.id, revision: skill.revision,
    name: skill.name, description: skill.description, packageDigest: skill.contentDigest }));
  const legacy: ContextSource[] = selected.filter(skill => !skill.package).map(skill => ({ id: skill.id, revision: skill.revision, kind: "skill", content: skill.body }));
  const operations = selected.some(skill => skill.package) ? (await pool.query(`SELECT id,name,output FROM agents_platform.operations
    WHERE task_id=$1 AND name IN ('skills.activate','skills.read') AND state='completed' ORDER BY started_at,id`, [taskId])).rows : [];
  const sources = new Map<string, ContextSource>();
  for (const operation of operations) {
    const saved = validateBuiltinResult(operation.name, operation.output) as SkillLoadResult;
    const skill = selected.find(skill => skill.id === saved.skillId);
    if (!skill) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Loaded skill is outside the current version");
    const current = skillLoadResult(skill, operation.name, saved.evidence.path,
      saved.range ? { offset: saved.range.start, maxBytes: Math.max(1, saved.range.end - saved.range.start) } : undefined);
    if (requestDigest(current) !== requestDigest(saved)) throw new PlatformError("SKILL_RECEIPT_INTEGRITY", 409, "Skill load receipt does not match its immutable package");
    const key = skill.id + ":" + current.evidence.path + (current.range ? ":" + current.range.start : "");
    // The main instruction body is restored once, even if SKILL.md was also requested as a resource.
    if (!sources.has(key) || operation.name === "skills.activate") sources.set(key, skillLoadContextSource(current, operation.name));
  }
  return { catalog, sources: [...legacy, ...sources.values()] };
}

/** Full loaded content lives in mandatory skill sources; keep complete assistant/tool pair receipts compact. */
export function skillReceiptGroups(groups: ContextGroup[]): ContextGroup[] {
  return groups.map(group => {
    const calls = new Set(group.messages.flatMap(message => message.tool_calls?.filter(call => ["skills_activate", "skills_read"].includes(call.function.name)).map(call => call.id) ?? []));
    return { ...group, messages: group.messages.map(message => {
      if (message.role !== "tool" || !message.tool_call_id || !calls.has(message.tool_call_id) || !message.content) return message;
      let content: unknown; try { content = JSON.parse(message.content); } catch { return message; }
      if (!content || typeof content !== "object" || !("evidence" in content) || !("skillId" in content)) return message;
      const result = content as SkillLoadResult;
      return { ...message, content: JSON.stringify(skillReceipt(result)) };
    }) };
  });
}
