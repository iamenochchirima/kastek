import { skillPackageCodec } from "./package";
import type { Pool } from "pg";
import { PlatformError } from "../../contracts/contracts";
import { assertCurrentAuthority, loadExecution } from "../../execution/lifecycle/execution";
import { loadSkillRevisions } from "../../execution/memory/skills";
import type { SkillRevision } from "../../contracts/memory";
import { transaction } from "../../infrastructure/database";
import { validateBuiltinArguments, validateBuiltinResult } from "../tool-contracts";
import { activateSkillPackage, readSkillPackageFile, SKILL_PACKAGE_LIMITS, type SkillFileEvidence, type SkillFileRange } from "./package";
export type { SkillFileRange } from "./package";

export interface SkillLoadResult {
  skillId: string; revision: number; name: string; content: string; evidence: SkillFileEvidence;
  compatibility?: string | null; resources?: { path: string; size: number; contentDigest: string }[];
  range?: SkillFileRange;
}
export function skillLoadResult(skill: SkillRevision, name: string, path?: string, range?: { offset: number; maxBytes: number }): SkillLoadResult {
  if (!skill.package || !skill.reviewedDigest) throw new PlatformError("SKILL_PACKAGE_REQUIRED", 409, "Legacy skill instructions are already loaded");
  if (name === "skills.activate") {
    const active = activateSkillPackage(skill.package, skill.reviewedDigest);
    return { skillId: skill.id, revision: skill.revision, name: skill.name, content: active.body, compatibility: active.compatibility,
      resources: active.resources, evidence: active.evidence };
  }
  const file = readSkillPackageFile(skill.package, path!, skill.reviewedDigest);
  const result = { skillId: skill.id, revision: skill.revision, name: skill.name, content: file.content, evidence: file.evidence };
  return range ? skillResultPage(result, range.offset, range.maxBytes) : result;
}

function skillResultPage(result: SkillLoadResult, offset: number, maxBytes: number): SkillLoadResult {
  const bytes = Buffer.from(result.content, "utf8");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) {
    throw new PlatformError("SKILL_RANGE_INVALID", 400, "Use the exact nextOffset returned by the skill resource");
  }
  let end = Math.min(bytes.length, offset + maxBytes);
  while (end < bytes.length && end > offset && (bytes[end]! & 0xc0) === 0x80) end--;
  return { ...result, content: bytes.subarray(offset, end).toString("utf8"),
    range: { start: offset, end, totalBytes: bytes.length, nextOffset: end < bytes.length ? end : null,
      complete: offset === 0 && end === bytes.length } };
}

/** Procedures remain complete; large reference files expose exact recoverable UTF-8 pages. */
export function fitSkillLoadResult(result: SkillLoadResult, maxResultBytes: number, requested?: { offset?: number; maxBytes?: number },
  fitsContext: (value: SkillLoadResult) => boolean = () => true): SkillLoadResult {
  const fits = (value: SkillLoadResult) => Buffer.byteLength(JSON.stringify(value), "utf8") <= maxResultBytes && fitsContext(value);
  const paged = requested?.offset !== undefined || requested?.maxBytes !== undefined;
  if (result.evidence.path === "SKILL.md") {
    if (paged) throw new PlatformError("SKILL_PROCEDURE_INCOMPLETE", 400, "Load the complete reviewed procedure with skills.activate");
    if (fits(result)) return result;
  } else {
    if (!paged && fits(result)) return result;
    const offset = requested?.offset ?? 0;
    const requestedBytes = Math.min(requested?.maxBytes ?? SKILL_PACKAGE_LIMITS.fileBytes, SKILL_PACKAGE_LIMITS.fileBytes);
    const initial = skillResultPage(result, offset, requestedBytes);
    if (fits(initial)) return initial;
    let low = 0, high = initial.range!.end - offset;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2), candidate = skillResultPage(result, offset, Math.max(1, mid));
      if (fits(candidate)) low = mid; else high = mid - 1;
    }
    const candidate = skillResultPage(result, offset, Math.max(1, low));
    if (fits(candidate) && (candidate.range!.end > offset || offset === candidate.range!.totalBytes)) return candidate;
  }
  throw new PlatformError("SKILL_CONTEXT_LIMIT", 413, "The complete procedure or a resource page cannot fit the current context budget");
}

export async function executeSkillTool(pool: Pool, taskId: string, name: "skills.activate" | "skills.read", input: unknown, maxResultBytes = 524288,
  fitsContext?: (value: SkillLoadResult) => boolean, acceptedVersion?: string): Promise<SkillLoadResult> {
  const args = validateBuiltinArguments(name, input, acceptedVersion) as { skillId: string; path?: string; offset?: number; maxBytes?: number };
  return transaction(pool, async db => {
    const execution = await loadExecution(db, taskId);
    await assertCurrentAuthority(db, execution);
    if (!execution.configuration.skillIds.includes(args.skillId)) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Skill is not selected for this agent version");
    const skill = (await loadSkillRevisions(db, execution.task.organization_id, execution.agentId, [args.skillId], skillPackageCodec))[0]!;
    if (name === "skills.read") {
      const active = await db.query(`SELECT 1 FROM agents_platform.operations WHERE task_id=$1 AND name='skills.activate' AND state='completed'
        AND output->>'skillId'=$2 AND output->'evidence'->>'packageDigest'=$3`, [taskId, skill.id, skill.contentDigest]);
      if (!active.rowCount) throw new PlatformError("SKILL_ACTIVATION_REQUIRED", 409, "Activate the skill before reading its resources");
    }
    const loaded = skillLoadResult(skill, name, args.path);
    let result: SkillLoadResult;
    if (acceptedVersion === "1") {
      if (Buffer.byteLength(loaded.content, "utf8") > 4096 || Buffer.byteLength(JSON.stringify(loaded), "utf8") > Math.min(maxResultBytes,6144) ||
          fitsContext && !fitsContext(loaded)) throw new PlatformError("SKILL_CONTEXT_LIMIT", 413, "The complete skill file cannot fit the current context budget");
      result = loaded;
    } else result = fitSkillLoadResult(loaded, maxResultBytes, name === "skills.read" ? args : undefined, fitsContext);
    validateBuiltinResult(name, result, acceptedVersion);
    return result;
  });
}
