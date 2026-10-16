import type { Pool } from "pg";
import { query } from "../pool";
import {
  approvalSessionGrantMatches,
  type ApprovalSessionGrantMatchInput,
  type ApprovalSessionGrantRecord,
} from "../../approval/session-grants";

function normalize(row: {
  id: string;
  organization_id: string;
  installation_id: string;
  conversation_id: string;
  session_key: string;
  actor_id: string;
  capability: string;
  capability_version: string;
  policy_revision: string;
  resource_type: string;
  resource_argument: string;
  resource_value: string;
  granted_by: string;
  expires_at: string;
  created_at: string;
  revoked_at: string | null;
}): ApprovalSessionGrantRecord {
  return {
    id: row.id,
    organizationId: row.organization_id,
    installationId: row.installation_id,
    conversationId: row.conversation_id,
    sessionKey: row.session_key,
    actorId: row.actor_id,
    capability: row.capability,
    capabilityVersion: row.capability_version,
    policyRevision: row.policy_revision,
    resourceSelector: {
      type: row.resource_type,
      argument: row.resource_argument,
      value: row.resource_value,
    },
    grantedBy: row.granted_by,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
  };
}

type SessionGrantRow = Parameters<typeof normalize>[0];

export class SessionApprovalGrantRepository {
  public constructor(private readonly pool: Pool) {}

  public async findMatching(input: ApprovalSessionGrantMatchInput): Promise<ApprovalSessionGrantRecord | null> {
    const result = await query<SessionGrantRow>(this.pool, `
      SELECT *
      FROM agent_approval_session_grants
      WHERE organization_id = $1
        AND installation_id = $2
        AND conversation_id = $3
        AND session_key = $4
        AND actor_id = $5
        AND capability = $6
        AND capability_version = $7
        AND policy_revision = $8
        AND resource_type = $9
        AND resource_argument = $10
        AND resource_value = $11
        AND revoked_at IS NULL
        AND expires_at > now()
      ORDER BY expires_at DESC, created_at DESC, id DESC
      LIMIT 1`, [
      input.organizationId,
      input.installationId,
      input.conversationId,
      input.sessionKey,
      input.actorId,
      input.capability,
      input.capabilityVersion,
      input.policyRevision,
      input.resourceSelector.type,
      input.resourceSelector.argument,
      input.resourceSelector.value,
    ]);
    const row = result.rows[0];
    if (!row) return null;
    const grant = normalize(row);
    return approvalSessionGrantMatches(grant, input) ? grant : null;
  }

  public async getUsable(id: string, input: ApprovalSessionGrantMatchInput): Promise<ApprovalSessionGrantRecord | null> {
    const result = await query<SessionGrantRow>(this.pool, `
      SELECT *
      FROM agent_approval_session_grants
      WHERE id = $1
        AND organization_id = $2
        AND revoked_at IS NULL
        AND expires_at > now()
      LIMIT 1`, [id, input.organizationId]);
    const row = result.rows[0];
    if (!row) return null;
    const grant = normalize(row);
    return approvalSessionGrantMatches(grant, input) ? grant : null;
  }

  public async listForSession(input: {
    organizationId: string;
    installationId: string;
    conversationId: string;
    sessionKey: string;
    actorId: string;
  }): Promise<ApprovalSessionGrantRecord[]> {
    const result = await query<SessionGrantRow>(this.pool, `
      SELECT *
      FROM agent_approval_session_grants
      WHERE organization_id = $1
        AND installation_id = $2
        AND conversation_id = $3
        AND session_key = $4
        AND actor_id = $5
      ORDER BY created_at DESC, id DESC`, [
      input.organizationId,
      input.installationId,
      input.conversationId,
      input.sessionKey,
      input.actorId,
    ]);
    return result.rows.map(normalize);
  }

  public async revoke(input: { organizationId: string; id: string; actorId: string }): Promise<boolean> {
    const result = await query(this.pool, `
      UPDATE agent_approval_session_grants
      SET revoked_at = now()
      WHERE organization_id = $1 AND id = $2 AND (actor_id = $3 OR granted_by = $3) AND revoked_at IS NULL`, [input.organizationId, input.id, input.actorId]);
    return (result.rowCount ?? 0) > 0;
  }
}
