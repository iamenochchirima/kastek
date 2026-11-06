import { growthCapabilityBaseline, growthDefaultCommissions } from "./growth-capability-upgrade";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { agentConfigurationSchema, requestDigest, sourceAuthorityIds } from "../../contracts/contracts";
import { pinProductCompositionSources } from "../../capabilities/products/native-selection";
import { publishedToolBindings } from "../../capabilities/tool-definitions";
import { compilePublishedComposition } from "../../execution/programs/publication";
import { growthConnectedPins,pinGrowthConnectedTools } from "./growth-connected-pins";
import { PlatformError } from "../../contracts/contracts";

/** Only a coordinator whose configuration remains product-managed follows the product's selected specialist versions. */
export async function refreshGrowthManagedRoster(db: PoolClient, tenantId: string, provenance: Record<string, unknown>) {
  const parent = (await db.query(`SELECT f.*,v.configuration,a.draft FROM agents_platform.product_execution_features f
    JOIN agents_platform.agent_versions v ON v.id=f.version_id JOIN agents_platform.agents a ON a.id=f.agent_id
    WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id='assistant' FOR UPDATE OF f`, [tenantId])).rows[0];
  if (!parent?.managed_configuration_digest || parent.managed_configuration_digest !== requestDigest(parent.configuration) || requestDigest(parent.draft) !== requestDigest(parent.configuration)) return;
  const configuration = agentConfigurationSchema.parse(parent.configuration);
  if (!configuration.capabilities.delegation.enabled) return;
  const children = (await db.query(`SELECT f.feature_id,f.version_id,v.configuration FROM agents_platform.product_execution_features f
    JOIN agents_platform.agent_versions v ON v.id=f.version_id WHERE f.product='growth' AND f.tenant_id=$1 AND f.feature_id IN ('research','content','campaigns')`, [tenantId])).rows;
  configuration.capabilities.delegation.bindings = configuration.capabilities.delegation.bindings.map(binding => {
    const child = children.find(row => row.feature_id === binding.id);
    if (!child) return binding;
    const selected = agentConfigurationSchema.parse(child.configuration);
    return { ...binding, versionId: child.version_id, sourceRevisionIds: sourceAuthorityIds(selected),
      tools: selected.tools.filter(tool => ["knowledge.search", "knowledge.read", "memory.search", "memory.read", "memory.propose", "artifact.create", "sandbox.analyze"].includes(tool)) };
  });
  growthDefaultCommissions(configuration,new Map(children.map(child=>[child.version_id,agentConfigurationSchema.parse(child.configuration)])));
  if (requestDigest(configuration) === requestDigest(parent.configuration)) return;
  const connected=await growthConnectedPins(db,parent.organization_id,parent.version_id,configuration);
  const versionId = randomUUID(), number = parent.revision + 1;
  const updated=await db.query("UPDATE agents_platform.agents SET draft=$2,draft_revision=$3,updated_at=now() WHERE id=$1 AND draft=$4::jsonb", [parent.agent_id, configuration, number,parent.configuration]);
  if(!updated.rowCount)throw new PlatformError("CONFIGURATION_CHANGED",409,"Agent settings changed. Refresh and try again.");
  await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by_service,tool_bindings,effective_composition)
    VALUES($1,$2,$3,$4,$4,'business',$5,$6,$7,$8)`, [versionId, parent.organization_id, parent.agent_id, number, configuration, provenance, JSON.stringify(publishedToolBindings(configuration)), compilePublishedComposition(configuration, connected.direct)]);
  await pinProductCompositionSources(db, { product: "growth", tenantId, organizationId: parent.organization_id }, versionId, configuration);
  await pinGrowthConnectedTools(db,parent.organization_id,versionId,connected.ids);
  await db.query("UPDATE agents_platform.product_execution_features SET version_id=$2,revision=$3,managed_configuration_digest=$4,managed_capability_baseline=$5,updated_at=now() WHERE product='growth' AND tenant_id=$1 AND feature_id='assistant'", [tenantId, versionId, number, requestDigest(configuration),growthCapabilityBaseline(configuration)]);
}
