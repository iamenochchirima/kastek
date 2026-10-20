import type { Pool } from "pg";
import { PlatformError, requestDigest } from "../../contracts/contracts";
import type { SkillRevision } from "../memory/memory";
import type { ContextGroup, ContextSource, SkillCatalogEntry } from "./context";
import { validateBuiltinResult } from "../../capabilities/tool-contracts";
import { skillLoadResult, type SkillLoadResult } from "../../capabilities/skills/runtime";

export function skillLoadContextSource(result: SkillLoadResult, name: string): ContextSource {
  return { id: result.skillId, revision: result.revision, kind: "skill",
    content: name === "skills.activate" ? JSON.stringify({ instructions: result.content, compatibility: result.compatibility, resources: result.resources }) : result.content,
    skillFile: result.evidence };
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
    const current = skillLoadResult(skill, operation.name, saved.evidence.path);
    if (requestDigest(current) !== requestDigest(saved)) throw new PlatformError("SKILL_RECEIPT_INTEGRITY", 409, "Skill load receipt does not match its immutable package");
    const key = skill.id + ":" + current.evidence.path;
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
      return { ...message, content: JSON.stringify({ skillId: result.skillId, revision: result.revision, loaded: true, evidence: result.evidence }) };
    }) };
  });
}
