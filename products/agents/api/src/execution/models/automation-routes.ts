import type { PoolClient } from "pg";
import { PlatformError, requestDigest, type AdmissionAuthority, type ExecutionGrant } from "../../contracts/contracts";
import { acceptedModelRoutesSchema, type AcceptedModelRoutes } from "../../contracts/model-bindings";

function mismatch(): never { throw new PlatformError("AUTOMATION_MODEL_MISMATCH", 409, "The schedule model scope changed; edit the schedule to authorize a new route"); }

/** Internal revision persistence; never accepts a browser-supplied model snapshot. */
export async function saveAutomationModelRoutes(db: PoolClient, input: {
  automationId: string; revision: number; organizationId: string; versionId: string; routes: AcceptedModelRoutes;
}): Promise<void> {
  const routes = acceptedModelRoutesSchema.parse(input.routes);
  if (Object.values(routes).some(route => route.binding.organizationId !== input.organizationId ||
      requestDigest(route.definition) !== route.binding.providerDefinitionDigest)) mismatch();
  await db.query(`INSERT INTO agents_platform.automation_model_routes(automation_id,revision,organization_id,version_id,routes,snapshot_digest)
    VALUES($1,$2,$3,$4,$5,$6)`, [input.automationId, input.revision, input.organizationId, input.versionId, routes, requestDigest(routes)]);
}

/** Pausing and resuming carry the exact metadata and allowance forward, including revoked bindings. */
export async function loadAutomationModelRoutes(db: PoolClient, organizationId: string, automationId: string,
  revision: number, versionId: string): Promise<AcceptedModelRoutes> {
  const row = (await db.query(`SELECT routes,snapshot_digest FROM agents_platform.automation_model_routes
    WHERE organization_id=$1 AND automation_id=$2 AND revision=$3 AND version_id=$4 FOR SHARE`,
  [organizationId, automationId, revision, versionId])).rows[0];
  const parsed = acceptedModelRoutesSchema.safeParse(row?.routes);
  if (!parsed.success || requestDigest(parsed.data) !== row.snapshot_digest || Object.values(parsed.data).some(route =>
    route.binding.organizationId !== organizationId || requestDigest(route.definition) !== route.binding.providerDefinitionDigest)) mismatch();
  return parsed.data;
}

/** Normal principal and automation checks run first. No current default or discovery lookup occurs here. */
export async function automationModelRoutes(db: PoolClient, authority: AdmissionAuthority, versionId: string,
  grant: ExecutionGrant): Promise<AcceptedModelRoutes> {
  const principal = authority.principal;
  if (principal.kind !== "automation" || authority.product !== "agents" || authority.callerClientId !== "agents-automation" ||
      authority.resourceId !== principal.id) mismatch();
  const row = (await db.query(`SELECT a.revision,r.version_id FROM agents_platform.automations a
    JOIN agents_platform.automation_revisions r ON r.automation_id=a.id AND r.revision=a.revision
    WHERE a.id=$1 AND a.organization_id=$2 AND a.owner_account_id=$3 AND a.state='active' FOR SHARE OF a`,
  [principal.id, authority.organizationId, principal.ownerAccountId])).rows[0];
  if (!row || row.version_id !== versionId) mismatch();
  const routes = await loadAutomationModelRoutes(db, authority.organizationId, principal.id, row.revision, versionId);
  for (const route of Object.values(routes)) {
    const binding = route.binding;
    if (route.policy.maxRootTokens > grant.rootTokenLimit || route.policy.maxInputBytes > grant.maxInputBytes ||
        route.policy.maxInputTokens > grant.maxContextTokens || route.policy.maxOutputTokens > grant.maxOutputTokens) mismatch();
    const current = await db.query(`SELECT 1 FROM agents_platform.model_provider_connections c
      JOIN agents_platform.model_provider_use_grants g ON g.organization_id=c.organization_id AND g.connection_id=c.id
      WHERE c.id=$1 AND c.organization_id=$2 AND c.state='active' AND c.revision=$3 AND c.credential_revision=$4
        AND g.id=$5 AND g.revision=$6 AND g.state='active' AND g.consumer=$7::jsonb AND g.model_ids ? $8 AND g.roles ? $9
        AND c.endpoint=$10 AND c.provider_id=$11 AND c.protocol=$12 FOR SHARE OF c,g`,
    [binding.connectionId, authority.organizationId, binding.connectionRevision, binding.credentialRevision, binding.useGrantId,
      binding.useGrantRevision, JSON.stringify(route.consumer), binding.modelId, binding.role, binding.endpoint, binding.providerId, binding.protocol]);
    if (!current.rowCount) throw new PlatformError("MODEL_CONNECTION_CHANGED", 409, "The schedule model authorization changed; edit the schedule to authorize a new route");
  }
  return routes;
}
