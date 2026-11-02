import type { Pool, PoolClient } from "pg";
import { PlatformError, type InitiatingPrincipal } from "../../contracts/contracts";

/** A channel participant is its canonical Inbox conversation, never a fabricated website session. */
export async function assertChannelCustomerAuthority(db: Pool | PoolClient, input: {
  organizationId: string; principal: Extract<InitiatingPrincipal, { kind: "channel_customer" }>;
  agentId: string; versionId: string; currentDeployment?: boolean; inspectionOnly?:boolean;
}): Promise<void> {
  const allowed = await db.query(`SELECT 1 FROM agents_platform.channel_deployments d
    JOIN agents_platform.channel_connections c ON c.organization_id=d.organization_id AND c.id=d.connection_id
    JOIN agents_platform.customer_conversations p ON p.organization_id=d.organization_id AND p.channel_deployment_id=d.id
    JOIN agents_platform.agent_versions v ON v.organization_id=d.organization_id AND v.agent_id=d.agent_id AND v.id=$5
    WHERE d.organization_id=$1 AND d.id=$2 AND p.id=$3 AND d.agent_id=$4 AND p.agent_id=d.agent_id
      AND p.channel_kind=c.kind AND p.channel_kind<>'website' AND ($7::boolean=true OR (d.state='active' AND c.state='active'))
      AND ($6::boolean=false OR d.version_id=v.id) FOR SHARE OF d,c,p,v`,
  [input.organizationId, input.principal.deploymentId, input.principal.participantId, input.agentId, input.versionId, input.currentDeployment ?? false,input.inspectionOnly??false]);
  if (!allowed.rowCount) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel execution access is unavailable");
}
