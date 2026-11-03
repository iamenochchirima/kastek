import type { ProductCapabilityInvocation, ProductCapabilityResult } from "@kasitek-labs/contracts";
import type { TenantContext } from "../context.js";
import { transaction } from "../db.js";
import { forbidden, TenantError } from "../error.js";
import { AGENT_ROLES } from "../controllers/read-helpers.js";
import { agencyCapabilityManifest, capabilityDigest, workspaceAgentMetadataDescriptor } from "./manifest.js";

type Metadata = { id: string; name: string; status: string; created_at: Date; updated_at: Date };
export async function readWorkspaceAgentMetadata(context: TenantContext, call: ProductCapabilityInvocation): Promise<ProductCapabilityResult> {
  const a = call.authority;
  if (a.destinationProduct !== "agencies" || call.operation !== workspaceAgentMetadataDescriptor.operation ||
      a.manifestDigest !== agencyCapabilityManifest.digest || a.descriptorDigest !== capabilityDigest(workspaceAgentMetadataDescriptor) ||
      a.handlerRef !== workspaceAgentMetadataDescriptor.handlerRef) throw forbidden();
  return transaction(context.pool, async db => {
    // A read and its authorization share one database snapshot. Later model use reauthorizes.
    await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const grant = (await db.query<{ workspace_id: string; agent_ids: string[] }>(`
      SELECT m.workspace_id, g.agent_ids FROM product_capability_mappings m
      JOIN product_capability_grants g ON g.mapping_id=m.id
      JOIN workspaces w ON w.id=m.workspace_id AND w.status='active'
      JOIN tenant_users u ON u.id=m.tenant_user_id AND u.workspace_id=m.workspace_id AND u.status='active'
      WHERE m.id=$1 AND m.origin_product=$2 AND m.origin_tenant_id=$3 AND m.workspace_id=$14
        AND m.actor_issuer=$4 AND m.actor_subject=$5
        AND m.tenant_client_id IS NOT DISTINCT FROM $15::text
        AND m.origin_client_id IS NOT DISTINCT FROM $16::text
        AND (m.tenant_client_id IS NULL OR EXISTS(SELECT 1 FROM shared_agent_client_setups s
          WHERE s.mapping_id=m.id AND s.workspace_id=m.workspace_id AND s.tenant_client_id=m.tenant_client_id
            AND s.tenant_user_id=m.tenant_user_id AND s.enabled))
        AND ($15::text IS NULL OR EXISTS(SELECT 1 FROM tenant_clients tc WHERE tc.id=$15 AND tc.workspace_id=m.workspace_id AND tc.status='active'))
        AND ($15::text IS NULL OR EXISTS(SELECT 1 FROM tenant_user_roles r WHERE r.tenant_user_id=u.id AND r.role IN ('owner','admin'))
          OR EXISTS(SELECT 1 FROM tenant_client_assignments ca WHERE ca.workspace_id=m.workspace_id AND ca.tenant_client_id=$15 AND ca.tenant_user_id=u.id AND ca.status='active'))
        AND m.revoked_at IS NULL AND m.expires_at>NOW()
        AND g.operation=$6 AND g.manifest_digest=$7 AND g.descriptor_digest=$8
        AND g.handler_ref=$9 AND g.policy_revision=$10 AND g.binding_id=$11 AND g.binding_digest=$12
        AND g.revoked_at IS NULL AND g.expires_at>NOW()
        AND EXISTS(SELECT 1 FROM tenant_user_roles r WHERE r.tenant_user_id=u.id AND r.role=ANY($13::text[]))`,
      [a.mappingRef, a.originProduct, a.originTenantId, call.actor.issuer, call.actor.subject, call.operation,
        a.manifestDigest, a.descriptorDigest, a.handlerRef, a.policyRevision, call.bindingId, call.bindingDigest, AGENT_ROLES, a.tenantId,a.clientId??null,a.originClientId??null])).rows[0];
    if (!grant || !Array.isArray(grant.agent_ids) || !grant.agent_ids.every(id => typeof id === "string")) throw forbidden();
    if (call.control === "authorize") return { value: { authorized: true } };
    let input = call.input as { agentId?: string; after?: string; limit?: number };
    let expectedRevision: string | undefined;
    if (call.control === "evidence") {
      const source = (call.input as { source: { id: string; revision: string } }).source;
      if (!source.id.startsWith("agency:workspace-agent:")) throw forbidden();
      input = { agentId: source.id.slice("agency:workspace-agent:".length) };
      expectedRevision = source.revision;
    }
    if (input.agentId && !grant.agent_ids.includes(input.agentId)) throw forbidden();
    const rows = (await db.query<Metadata>(`SELECT id,left(name,512) AS name,left(status,64) AS status,created_at,updated_at
      FROM workspace_agents WHERE workspace_id=$1 AND id=ANY($2::text[])
      AND ($3::text IS NULL OR id=$3) AND ($4::text IS NULL OR id>$4)
      AND ($6::text IS NULL OR tenant_client_id=$6)
      ORDER BY id LIMIT $5`, [grant.workspace_id, grant.agent_ids, input.agentId ?? null, input.after ?? null, (input.limit ?? 20) + 1,a.clientId??null])).rows;
    const page = rows.slice(0, input.limit ?? 20);
    if (call.control === "evidence") {
      const row = page[0];
      if (!row || capabilityDigest({ workspaceId: grant.workspace_id, ...row }) !== expectedRevision) throw forbidden();
      return { value: { authorized: true, revision: expectedRevision } };
    }
    const acquiredAt = new Date().toISOString();
    const result = (): ProductCapabilityResult => ({
      value: { workspaceId: grant.workspace_id, agents: page, next: rows.length > page.length ? page.at(-1)?.id ?? null : null },
      sources: page.map(row => ({ id: `agency:workspace-agent:${row.id}`, revision: capabilityDigest({ workspaceId: grant.workspace_id, ...row }),
        title: row.name, text: JSON.stringify(row), acquiredAt, continuation: null })),
    });
    while (page.length && Buffer.byteLength(JSON.stringify(result())) > workspaceAgentMetadataDescriptor.limits.maxModelResultBytes) page.pop();
    if (!page.length && rows.length) throw new TenantError(503, "product metadata record exceeds response limit");
    return result();
  });
}
