import type { PoolClient } from "pg";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { GrowthAgentPublication } from "@kasitek-labs/contracts";
import { agentConfigurationSchema, PlatformError, requestDigest } from "../../contracts/contracts";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { capabilityBindingSchema } from "../../contracts/capability-catalog";
import { registerProductManifest } from "../../capabilities/products/product-capabilities";
import { planGrowthRuntimeBindingClones, type BindingPlanVersion } from "./growth-runtime-binding-plan";
import { growthCapabilityBaseline } from "./growth-capability-upgrade";

// This digest pins the exact descriptor set and adapter behavior reviewed for this rollout.
const targetDigest = "7cc062cbb44e4d1a2b9aba149706c4c3ab0e13b6c9c425581d5ad44e7ba28d8d";

/** Called under ensureTenant's transaction and tenant advisory lock. */
export async function rolloutGrowthConnectionBindings(db: PoolClient, tenantId: string, organizationId: string, publication: GrowthAgentPublication): Promise<number> {
  if (publication.manifest.digest !== targetDigest || publication.policy.revision !== "13") return 0;
  return rolloutGrowthConnectionBindingsForTarget(db,tenantId,organizationId,publication);
}

/** Call only after the caller has pinned and authenticated the target publication. */
export async function rolloutGrowthConnectionBindingsForTarget(db: PoolClient, tenantId: string, organizationId: string, publication: GrowthAgentPublication): Promise<number> {
  const tenantCorrelation=createHash("sha256").update(tenantId).digest("hex").slice(0,16);
  const targets = (await db.query(`SELECT f.feature_id,f.agent_id,f.version_id,f.revision,a.draft_revision,a.draft FROM agents_platform.product_execution_features f
    JOIN agents_platform.agents a ON a.id=f.agent_id AND a.organization_id=f.organization_id
    WHERE f.product='growth' AND f.tenant_id=$1 AND f.organization_id=$2 AND f.enabled AND a.deleted_at IS NULL
    ORDER BY f.feature_id FOR UPDATE OF f,a`, [tenantId, organizationId])).rows;
  if (!targets.length) return 0;
  const rows = (await db.query(`SELECT v.id,v.organization_id,v.agent_id,v.number,v.draft_revision,v.execution_kind,v.configuration,v.created_by,v.created_by_service
    FROM agents_platform.agent_versions v WHERE v.organization_id=$1 AND v.agent_id=ANY($2::uuid[]) ORDER BY v.agent_id,v.number FOR SHARE`,
    [organizationId, targets.map(row => row.agent_id)])).rows;
  const rawPublications = (await db.query("SELECT publication FROM agents_platform.growth_capability_publications WHERE tenant_id=$1 AND revision=ANY($2::text[])", [tenantId, ["11", "12"]])).rows;
  const previous = rawPublications.flatMap(row => {
    try {
      const value=z.object({manifest:z.unknown(),policy:z.object({revision:z.enum(["11","12"])})}).parse(row.publication);
      const manifest=registerProductManifest(value.manifest as GrowthAgentPublication["manifest"]);
      if(manifest.revision!==value.policy.revision||manifest.product!=="growth")throw new PlatformError("PRODUCT_MANIFEST_INVALID",409,"The retained publication is unavailable");
      return [{manifest,policyRevision:value.policy.revision}];
    }
    catch (error) {
      if (!(error instanceof PlatformError) && !(error instanceof z.ZodError)) throw error;
      console.warn(JSON.stringify({event:"growth.runtime_binding_upgrade.deferred",tenantCorrelation,reason:"prior_publication_unavailable"}));
      return [];
    }
  });
  const versions: BindingPlanVersion[] = rows.map(row => ({ id: row.id, organizationId: row.organization_id, product: "growth", tenantId, configuration: row.configuration }));
  const plans = targets.flatMap(feature => {
    try {
      return [{feature, plan: planGrowthRuntimeBindingClones({ roots: [feature.version_id], versions, organizationId, tenantId, previous, next: publication.manifest, nextPolicy: publication.policy.revision })}];
    } catch (error) {
      if (!(error instanceof PlatformError) || error.code !== "GROWTH_RUNTIME_UPGRADE_UNAVAILABLE") throw error;
      console.warn(JSON.stringify({event:"growth.runtime_binding_upgrade.deferred",tenantCorrelation,feature:feature.feature_id,reason:"unsupported_authority_or_version"}));
      return [];
    }
  });
  // Reuse a single derived version for a source pinned by several coordinators.
  const clones: typeof plans[number]["plan"]["clones"] = [], canonical=new Map<string,string>(), aliases=new Map<string,string>();
  for(const {plan} of plans){
    for(const clone of plan.clones){
      const prior=canonical.get(clone.sourceVersionId);
      if(prior){aliases.set(clone.versionId,prior);continue;}
      if(clone.configuration.capabilities.delegation.enabled)for(const role of clone.configuration.capabilities.delegation.bindings)role.versionId=aliases.get(role.versionId)??role.versionId;
      canonical.set(clone.sourceVersionId,clone.versionId);clones.push(clone);
    }
    for(const key of Object.keys(plan.roots))plan.roots[key]=aliases.get(plan.roots[key]!)??plan.roots[key]!;
  }
  if (!clones.length) return 0;
  const byId = new Map(rows.map(row => [row.id, row]));
  const nextNumbers = new Map<string,number>();
  const cloneNumbers = new Map<string,number>();
  for (const row of rows) nextNumbers.set(row.agent_id, Math.max(nextNumbers.get(row.agent_id) ?? 0, Number(row.number)));
  for (const clone of clones) {
    const source = byId.get(clone.sourceVersionId); if (!source) throw new PlatformError("GROWTH_RUNTIME_UPGRADE_UNAVAILABLE", 409, "The agent version is unavailable");
    const number = (nextNumbers.get(source.agent_id) ?? 0) + 1; nextNumbers.set(source.agent_id, number);
    cloneNumbers.set(clone.versionId, number);
    if (clone.configuration.capabilities.delegation.enabled) for (const role of clone.configuration.capabilities.delegation.bindings) {
      if (role.versionNumber !== undefined && cloneNumbers.has(role.versionId)) role.versionNumber=cloneNumbers.get(role.versionId)!;
    }
    const selected=(await db.query("SELECT b.binding FROM agents_platform.version_connected_tools v JOIN agents_platform.capability_bindings b ON b.organization_id=v.organization_id AND b.id=v.binding_id WHERE v.organization_id=$1 AND v.version_id=$2 AND b.id=ANY($3::uuid[]) ORDER BY b.alias",[organizationId,source.id,clone.configuration.connectedToolBindingIds])).rows.map(row=>capabilityBindingSchema.parse(row.binding));
    if(selected.length!==clone.configuration.connectedToolBindingIds.length)throw new PlatformError("GROWTH_RUNTIME_UPGRADE_UNAVAILABLE",409,"Published connected tools are unavailable");
    await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by,created_by_service,tool_bindings,effective_composition,runtime_derived_from)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [clone.versionId, organizationId, source.agent_id, number, source.draft_revision, source.execution_kind, clone.configuration,
      source.created_by,source.created_by_service, JSON.stringify(publishedToolBindings(clone.configuration)), compilePublishedComposition(clone.configuration, selected),source.id]);
    await db.query("INSERT INTO agents_platform.version_sources(organization_id,version_id,source_id,revision_id) SELECT organization_id,$2,source_id,revision_id FROM agents_platform.version_sources WHERE version_id=$1", [source.id, clone.versionId]);
    await db.query("INSERT INTO agents_platform.version_connected_tools(organization_id,version_id,binding_id) SELECT organization_id,$2,binding_id FROM agents_platform.version_connected_tools WHERE version_id=$1", [source.id, clone.versionId]);
  }
  for (const {feature,plan} of plans) {
    const replacement = plan.roots[feature.version_id]; if (!replacement || replacement === feature.version_id) continue;
    const source=byId.get(feature.version_id), clone=clones.find(item=>item.versionId===replacement);
    if (!source || !clone) throw new PlatformError("GROWTH_RUNTIME_UPGRADE_UNAVAILABLE",409,"The agent version is unavailable");
    if (requestDigest(feature.draft)===requestDigest(source.configuration)) {
      const updated=await db.query("UPDATE agents_platform.agents SET draft=$3,updated_at=now() WHERE id=$1 AND draft_revision=$2 AND draft=$4::jsonb",[feature.agent_id,feature.draft_revision,clone.configuration,source.configuration]);
      if(!updated.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed during the runtime update");
    }
    const oldBaseline=growthCapabilityBaseline(agentConfigurationSchema.parse(source.configuration)),newBaseline=growthCapabilityBaseline(clone.configuration);
    const changed = await db.query(`UPDATE agents_platform.product_execution_features SET version_id=$4,revision=$6,
      managed_configuration_digest=CASE WHEN managed_configuration_digest=$7 THEN $8 ELSE managed_configuration_digest END,
      managed_capability_baseline=CASE WHEN managed_capability_baseline=$9::jsonb THEN $10::jsonb ELSE managed_capability_baseline END,updated_at=now()
      WHERE product='growth' AND tenant_id=$1 AND feature_id=$2 AND version_id=$3 AND revision=$5`, [tenantId, feature.feature_id, feature.version_id, replacement, feature.revision, nextNumbers.get(feature.agent_id),requestDigest(source.configuration),requestDigest(clone.configuration),JSON.stringify(oldBaseline),JSON.stringify(newBaseline)]);
    if (!changed.rowCount) throw new PlatformError("CONFIGURATION_CHANGED", 409, "Agent settings changed during the runtime update");
  }
  for (const feature of targets) {
    if (plans.some(item=>item.feature.feature_id===feature.feature_id && item.plan.roots[feature.version_id]!==feature.version_id)) continue;
    const latest=nextNumbers.get(feature.agent_id);
    if (latest===undefined||latest<=feature.revision)continue;
    const changed=await db.query("UPDATE agents_platform.product_execution_features SET revision=$4,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id=$2 AND version_id=$3 AND revision=$5",[tenantId,feature.feature_id,feature.version_id,latest,feature.revision]);
    if(!changed.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed during the runtime update");
  }
  // Dirty drafts, accepted tasks, grants and original versions remain untouched.
  return clones.length;
}
