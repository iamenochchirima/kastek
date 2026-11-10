import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import type { ActionScope } from "../../../contracts/connections";
import { PlatformError } from "../../../contracts/contracts";
import { transaction } from "../../../infrastructure/database";
import { ConnectionVault } from "../../../infrastructure/vault";

export const setupFailure = (code: string, status = 400) => new PlatformError(code, status, "Channel setup could not be completed");
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export type SetupTicket = { connectionId: string; revision: number; payload: Record<string, unknown> };

/** Tickets are private server state; the browser receives only random, single-use handles. */
export class MetaSetupSessions {
  constructor(readonly pool: Pool, private readonly vault: ConnectionVault, private readonly ttlSeconds: number) {
    z.number().int().min(60).max(1800).parse(ttlSeconds);
  }
  private binding(sessionId: string): string { z.string().min(16).max(4096).parse(sessionId); return digest(sessionId); }
  async issue(scope: ActionScope, sessionId: string, connectionId: string, revision: number, phase: "authorization" | "selection", payload: Record<string, unknown>): Promise<string> {
    const id = randomUUID(), ticket = randomBytes(32).toString("base64url"), binding = this.binding(sessionId);
    const envelope = this.vault.seal(scope.organizationId, `channel-setup:${id}:${phase}`, revision, JSON.stringify({ payload }), 65536);
    return transaction(this.pool, async db => {
      const owner = await db.query(`SELECT 1 FROM agents_platform.memberships m JOIN agents_platform.channel_connections c ON c.organization_id=m.organization_id
        WHERE m.organization_id=$1 AND m.account_id=$2 AND m.role IN ('owner','admin') AND m.revoked_at IS NULL
        AND c.id=$3 AND c.revision=$4 AND c.state<>'removed' FOR SHARE OF m,c`, [scope.organizationId, scope.accountId, connectionId, revision]);
      if (!owner.rowCount) throw setupFailure("CHANNEL_SETUP_AUTHORITY_CHANGED", 409);
      await db.query(`INSERT INTO agents_platform.channel_setup_sessions(id,organization_id,account_id,connection_id,connection_revision,session_digest,ticket_digest,phase,envelope,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,now()+$10*interval '1 second')`, [id, scope.organizationId, scope.accountId, connectionId, revision, binding, digest(ticket), phase, envelope, this.ttlSeconds]);
      return ticket;
    });
  }
  async read(scope: ActionScope, sessionId: string, ticket: string, phase: "authorization" | "selection", consume = false): Promise<SetupTicket> {
    z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(ticket); const binding = this.binding(sessionId);
    return transaction(this.pool, async db => {
      const result = await db.query(`SELECT s.* FROM agents_platform.channel_setup_sessions s
        JOIN agents_platform.memberships m ON m.organization_id=s.organization_id AND m.account_id=s.account_id
        JOIN agents_platform.channel_connections c ON c.organization_id=s.organization_id AND c.id=s.connection_id
        WHERE s.organization_id=$1 AND s.account_id=$2 AND s.session_digest=$3 AND s.ticket_digest=$4 AND s.phase=$5
        AND s.consumed_at IS NULL AND s.expires_at>now() AND m.role IN ('owner','admin') AND m.revoked_at IS NULL
        AND c.revision=s.connection_revision AND c.state<>'removed' FOR UPDATE OF s FOR SHARE OF m,c`, [scope.organizationId, scope.accountId, binding, digest(ticket), phase]);
      const row = result.rows[0]; if (!row) throw setupFailure("CHANNEL_SETUP_EXPIRED_OR_CHANGED", 409);
      const secret = JSON.parse(this.vault.open(scope.organizationId, `channel-setup:${row.id}:${phase}`, row.connection_revision, row.envelope));
      if (consume) await db.query("UPDATE agents_platform.channel_setup_sessions SET consumed_at=now(),envelope=NULL WHERE id=$1", [row.id]);
      return { connectionId: row.connection_id, revision: row.connection_revision, payload: secret.payload };
    });
  }
  async expire(): Promise<number> {
    const result = await this.pool.query("DELETE FROM agents_platform.channel_setup_sessions WHERE expires_at<=now()"); return result.rowCount ?? 0;
  }
}
