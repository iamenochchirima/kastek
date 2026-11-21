import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { PlatformError } from "../../contracts/contracts";
import { skillFamilyId, type SkillPackageCodec } from "../../contracts/skills";
import type { SkillRevision } from "../../contracts/memory";

const idSchema = z.uuid();
export const skillSelection = `SELECT s.*,p.files AS package_files,r.content_digest AS reviewed_digest,p.source_kind,p.source_slug,rs.repository,rs.package_path,coalesce(st.state,'enabled') AS installation_state
  FROM agents_platform.skill_revisions s LEFT JOIN agents_platform.skill_packages p ON p.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_package_reviews r ON r.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_installation_states st ON st.skill_revision_id=s.id
  LEFT JOIN agents_platform.skill_repository_sources rs ON rs.skill_revision_id=s.id
  WHERE s.organization_id=$1 AND s.agent_id=$2`;
export function skill(row: Record<string, any>, codec: SkillPackageCodec, requireReview = false): SkillRevision {
  const result: SkillRevision = { id: row.id, name: row.name, description: row.description, body: row.body,
    familyId:skillFamilyId({organizationId:row.organization_id,name:row.name,sourceKind:row.source_kind,sourceSlug:row.source_slug,repository:row.repository,packagePath:row.package_path}),state:row.installation_state,revision: row.revision, contentDigest: row.content_digest, createdAt: row.created_at.toISOString() };
  if(requireReview&&row.installation_state!=="enabled")throw new PlatformError("SKILL_DISABLED",409,"Selected skill installation is unavailable");
  if (row.package_files) {
    const pkg = codec.parse({ files: row.package_files.map((file: any) => ({ path: file.path, content: file.content, encoding: file.encoding })) });
    if (pkg.contentDigest !== row.content_digest) throw new PlatformError("SKILL_PACKAGE_CORRUPT", 409, "Skill package content has changed");
    const reviewed = row.reviewed_digest === pkg.contentDigest;
    if (requireReview) codec.activate(pkg, row.reviewed_digest ?? "");
    return { ...result, name: pkg.name, description: pkg.description, body: pkg.body, package: pkg,
      reviewState: reviewed ? "reviewed" : "pending", ...(reviewed ? { reviewedDigest: row.reviewed_digest as string } : {}) };
  }
  return result;
}

/** Scope authorization belongs to the caller; both publication and task loading use this integrity check. */
export async function loadSkillRevisions(db: Pool | PoolClient, organizationId: string, agentId: string, skillIds: string[], codec: SkillPackageCodec): Promise<SkillRevision[]> {
  idSchema.parse(organizationId); idSchema.parse(agentId); z.array(idSchema).max(8).parse(skillIds);
  if (!skillIds.length) return [];
  const rows = (await db.query(skillSelection + " AND s.id=ANY($3::uuid[]) ORDER BY s.id", [organizationId, agentId, skillIds])).rows;
  if (rows.length !== new Set(skillIds).size) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Skill is unavailable");
  const revisions=rows.map(row => skill(row,codec,true));
  if(new Set(revisions.map(revision=>revision.familyId)).size!==revisions.length)throw new PlatformError("SKILL_FAMILY_CONFLICT",409,"Select one revision per skill family");
  return revisions;
}

