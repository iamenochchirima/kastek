import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { ActionScope } from "../../../contracts/connections";
import { transaction } from "../../../infrastructure/database";
import { setupFailure } from "./sessions";

export type MetaSetupClaim = { id: string; connectionId: string; revision: number; resource: string };
/** Expiry fences a stalled caller; it never grants permission to repeat an uncertain provider mutation. */
export class MetaSetupClaims {
  constructor(private readonly pool: Pool) {}
  async acquire(scope: ActionScope, connectionId: string, revision: number, appId: string, target: string): Promise<MetaSetupClaim> {
    const id = randomUUID(), resource = createHash("sha256").update(JSON.stringify([appId, target])).digest("hex");
    return transaction(this.pool, async db => {
      const owner = await db.query(`SELECT 1 FROM agents_platform.memberships m JOIN agents_platform.channel_connections c ON c.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND m.account_id=$2 AND m.revoked_at IS NULL AND m.role='owner'
        AND c.id=$3 AND c.revision=$4 AND c.state<>'removed' FOR SHARE OF m,c`, [scope.organizationId, scope.accountId, connectionId, revision]);
      if (!owner.rowCount) throw setupFailure("CHANNEL_SETUP_AUTHORITY_CHANGED", 409);
      const connection = await db.query(`INSERT INTO agents_platform.channel_setup_claims(organization_id,connection_id,claim_id,connection_revision,expires_at,state)
        VALUES($1,$2,$3,$4,clock_timestamp()+interval '120 seconds','started') ON CONFLICT(connection_id) DO UPDATE SET
        claim_id=excluded.claim_id,connection_revision=excluded.connection_revision,expires_at=excluded.expires_at,state='started'
        WHERE channel_setup_claims.state='complete' RETURNING claim_id`, [scope.organizationId, connectionId, id, revision]);
      if (!connection.rowCount) throw setupFailure("CHANNEL_SETUP_RECONCILIATION_REQUIRED", 409);
      const locked = await db.query(`INSERT INTO agents_platform.channel_setup_resource_claims(resource_digest,connection_id,claim_id,expires_at,state)
        VALUES($1,$2,$3,clock_timestamp()+interval '120 seconds','started') ON CONFLICT(resource_digest) DO UPDATE SET
        connection_id=excluded.connection_id,claim_id=excluded.claim_id,expires_at=excluded.expires_at,state='started'
        WHERE channel_setup_resource_claims.state='complete' RETURNING claim_id`, [resource, connectionId, id]);
      if (!locked.rowCount) throw setupFailure("CHANNEL_SETUP_RECONCILIATION_REQUIRED", 409);
      return { id, connectionId, revision, resource };
    });
  }
  async fence(scope: ActionScope, claim: MetaSetupClaim): Promise<void> {
    const result = await this.pool.query(`SELECT 1 FROM agents_platform.channel_setup_claims s
      JOIN agents_platform.channel_setup_resource_claims r ON r.claim_id=s.claim_id AND r.resource_digest=$5
      JOIN agents_platform.channel_connections c ON c.id=s.connection_id AND c.organization_id=s.organization_id
      JOIN agents_platform.memberships m ON m.organization_id=c.organization_id
      WHERE s.organization_id=$1 AND s.connection_id=$2 AND s.claim_id=$3 AND c.revision=$4
      AND s.state='started' AND r.state='started' AND s.expires_at>clock_timestamp() AND r.expires_at>clock_timestamp()
      AND m.account_id=$6 AND m.role='owner' AND m.revoked_at IS NULL`, [scope.organizationId, claim.connectionId, claim.id, claim.revision, claim.resource, scope.accountId]);
    if (!result.rowCount) throw setupFailure("CHANNEL_SETUP_RECONCILIATION_REQUIRED", 409);
  }
  async reconcile(scope: ActionScope, connectionId: string, revision: number, appId: string, target: string): Promise<MetaSetupClaim> {
    const id = randomUUID(), resource = createHash("sha256").update(JSON.stringify([appId, target])).digest("hex");
    return transaction(this.pool, async db => {
      const prior = (await db.query(`SELECT s.claim_id FROM agents_platform.channel_setup_claims s
        JOIN agents_platform.channel_setup_resource_claims r ON r.claim_id=s.claim_id AND r.connection_id=s.connection_id
        JOIN agents_platform.channel_connections c ON c.id=s.connection_id AND c.organization_id=s.organization_id
        JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.account_id=$3
        WHERE s.organization_id=$1 AND s.connection_id=$2 AND c.revision=$4 AND m.role='owner' AND m.revoked_at IS NULL
        AND s.state IN ('started','uncertain') AND r.state IN ('started','uncertain') AND r.resource_digest=$5
        AND s.expires_at<=clock_timestamp() AND r.expires_at<=clock_timestamp() FOR UPDATE OF s,r FOR SHARE OF c,m`,
      [scope.organizationId, connectionId, scope.accountId, revision, resource])).rows[0];
      if (!prior) throw setupFailure("CHANNEL_SETUP_RECONCILIATION_NOT_READY", 409);
      await db.query(`UPDATE agents_platform.channel_setup_claims SET claim_id=$3,connection_revision=$4,state='started',expires_at=clock_timestamp()+interval '120 seconds'
        WHERE organization_id=$1 AND connection_id=$2 AND claim_id=$5`, [scope.organizationId, connectionId, id, revision, prior.claim_id]);
      await db.query(`UPDATE agents_platform.channel_setup_resource_claims SET claim_id=$2,state='started',expires_at=clock_timestamp()+interval '120 seconds'
        WHERE resource_digest=$1 AND claim_id=$3`, [resource, id, prior.claim_id]);
      return { id, connectionId, revision, resource };
    });
  }
  async finish(scope: ActionScope, claim: MetaSetupClaim, state: "complete" | "uncertain"): Promise<void> {
    await transaction(this.pool, async db => {
      await db.query("UPDATE agents_platform.channel_setup_claims SET state=$4 WHERE organization_id=$1 AND connection_id=$2 AND claim_id=$3 AND state='started'", [scope.organizationId, claim.connectionId, claim.id, state]);
      await db.query("UPDATE agents_platform.channel_setup_resource_claims SET state=$3 WHERE resource_digest=$1 AND claim_id=$2 AND state='started'", [claim.resource, claim.id, state]);
    });
  }
}
