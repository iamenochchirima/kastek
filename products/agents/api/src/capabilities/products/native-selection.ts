import type { Pool, PoolClient } from "pg";
import { PlatformError, sourceAuthorityIds, type AgentConfiguration } from "../../contracts/contracts";
import { loadSkillRevisions } from "../../execution/memory/memory";
import { assertSkillRequirements, configurationSkillAuthority } from "../skills/requirement-authority";
import { requireProductResourceAccess, resourceMatchesScope, type ProductResourceScope } from "./resource-scope";

export async function validateProductNativeSelection(db: Pool | PoolClient, scope: ProductResourceScope, configuration: AgentConfiguration, manage = true) {
  await requireProductResourceAccess(db, scope, manage);
  const sources = configuration.sourceRevisionIds.length ? (await db.query(`SELECT r.id,r.source_id,s.importer_service,r.embedding_release
    FROM agents_platform.source_revisions r JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
    JOIN agents_platform.source_revision_policy p ON p.revision_id=r.id AND p.source_id=s.id AND p.organization_id=s.organization_id
    WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[]) AND s.state='active' AND p.state='approved' FOR SHARE OF s,p`, [scope.organizationId, configuration.sourceRevisionIds])).rows : [];
  if (sources.length !== configuration.sourceRevisionIds.length || sources.some(source => !resourceMatchesScope(source.importer_service, scope))) {
    throw new PlatformError("SOURCE_SCOPE_DENIED", 403, "Select an approved source revision belonging to this product agent");
  }
  if (new Set(sources.map(source => source.source_id)).size !== sources.length) throw new PlatformError("SOURCE_SCOPE_DENIED", 409, "Select one revision per knowledge source");
  if (configuration.retrievalProfile.kind !== "lexical-v1") throw new PlatformError("RETRIEVAL_PROFILE_UNAVAILABLE", 409, "The selected product retrieval profile is unavailable");
  const skills = await loadSkillRevisions(db, scope.organizationId, scope.agentId, configuration.skillIds);
  const owners = skills.length ? (await db.query("SELECT id,created_by_service FROM agents_platform.skill_revisions WHERE organization_id=$1 AND agent_id=$2 AND id=ANY($3::uuid[])", [scope.organizationId, scope.agentId, configuration.skillIds])).rows : [];
  if (owners.some(skill => !resourceMatchesScope(skill.created_by_service, scope))) throw new PlatformError("SKILL_SCOPE_DENIED", 403, "Select a reviewed skill belonging to this product agent");
  const permissions = [...configurationSkillAuthority(configuration), "product.read", ...(configuration.productBindings.some(binding => binding.policy.effect === "reviewed_write") ? ["product.write"] : [])];
  for (const skill of skills) if (skill.package) assertSkillRequirements(skill.package.requirements, configuration, [], permissions);
  return { sources, skills };
}

export async function pinProductNativeSources(db: Pool | PoolClient, organizationId: string, versionId: string, sources: readonly { source_id: string; id: string }[]) {
  for (const source of sources) await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) VALUES($1,$2,$3,$4)", [organizationId, versionId, source.source_id, source.id]);
}

/** Pin commissioned source ceilings without turning them into the parent's direct retrieval selection. */
export async function pinProductCompositionSources(db: Pool | PoolClient, scope: Pick<ProductResourceScope, "product" | "tenantId" | "organizationId">, versionId: string, configuration: AgentConfiguration) {
  const ids = sourceAuthorityIds(configuration);
  if (!ids.length) return;
  const sources = (await db.query(`SELECT r.id,r.source_id,s.importer_service FROM agents_platform.source_revisions r
    JOIN agents_platform.sources s ON s.id=r.source_id AND s.organization_id=r.organization_id
    JOIN agents_platform.source_revision_policy p ON p.source_id=s.id AND p.revision_id=r.id AND p.organization_id=s.organization_id
    WHERE r.organization_id=$1 AND r.id=ANY($2::uuid[]) AND s.state='active' AND p.state='approved'
      AND s.importer_service->>'product'=$3 AND s.importer_service->>'tenantId'=$4
      AND EXISTS(SELECT 1 FROM agents_platform.product_execution_features f JOIN agents_platform.agent_versions v ON v.id=f.version_id
        WHERE f.product=$3 AND f.tenant_id=$4 AND f.organization_id=$1
          AND f.agent_id::text=s.importer_service->>'agentId' AND v.configuration->'sourceRevisionIds' ? r.id::text)
    FOR SHARE OF s,p`, [scope.organizationId, ids, scope.product, scope.tenantId])).rows;
  if (sources.length !== ids.length || new Set(sources.map(source => source.source_id)).size !== sources.length) {
    throw new PlatformError("SOURCE_SCOPE_DENIED", 403, "A commissioned source revision is no longer selected or approved");
  }
  await pinProductNativeSources(db, scope.organizationId, versionId, sources);
}
