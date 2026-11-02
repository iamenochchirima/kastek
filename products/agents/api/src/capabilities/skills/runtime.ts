import type { Pool } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { assertCurrentAuthority, loadExecution } from "../../execution/lifecycle/execution";
import { loadSkillRevisions, type SkillRevision } from "../../execution/memory/memory";
import { transaction } from "../../infrastructure/database";
import { validateBuiltinArguments, validateBuiltinResult } from "../tool-contracts";
import { activateSkillPackage, readSkillPackageFile, type SkillFileEvidence } from "./package";

export interface SkillLoadResult {
  skillId: string; revision: number; name: string; content: string; evidence: SkillFileEvidence;
  compatibility?: string | null; resources?: { path: string; size: number; contentDigest: string }[];
}
export function skillLoadResult(skill: SkillRevision, name: string, path?: string): SkillLoadResult {
  if (!skill.package || !skill.reviewedDigest) throw new PlatformError("SKILL_PACKAGE_REQUIRED", 409, "Legacy skill instructions are already loaded");
  if (name === "skills.activate") {
    const active = activateSkillPackage(skill.package, skill.reviewedDigest);
    return { skillId: skill.id, revision: skill.revision, name: skill.name, content: active.body, compatibility: active.compatibility,
      resources: active.resources, evidence: active.evidence };
  }
  const file = readSkillPackageFile(skill.package, path!, skill.reviewedDigest);
  return { skillId: skill.id, revision: skill.revision, name: skill.name, content: file.content, evidence: file.evidence };
}
export async function executeSkillTool(pool: Pool, taskId: string, name: "skills.activate" | "skills.read", input: unknown, maxResultBytes = 6144): Promise<SkillLoadResult> {
  const args = validateBuiltinArguments(name, input) as { skillId: string; path?: string };
  return transaction(pool, async db => {
    const execution = await loadExecution(db, taskId);
    await assertCurrentAuthority(db, execution);
    if (!execution.configuration.skillIds.includes(args.skillId)) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Skill is not selected for this agent version");
    const skill = (await loadSkillRevisions(db, execution.task.organization_id, execution.agentId, [args.skillId]))[0]!;
    if (name === "skills.read") {
      const active = await db.query(`SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='skills.activate' AND state='completed'
        AND output->>'skillId'=$2 AND output->'evidence'->>'packageDigest'=$3`, [taskId, skill.id, skill.contentDigest]);
      if (!active.rowCount) throw new PlatformError("SKILL_ACTIVATION_REQUIRED", 409, "Activate the skill before reading its resources");
    }
    const result = skillLoadResult(skill, name, args.path);
    if (Buffer.byteLength(result.content) > 4096 || Buffer.byteLength(JSON.stringify(result)) > maxResultBytes) {
      throw new PlatformError("SKILL_CONTEXT_LIMIT", 413, "The complete skill file cannot fit the current context budget");
    }
    validateBuiltinResult(name, result);
    return result;
  });
}
