import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { websiteAppearanceSchema } from "../../adapters/channels/website/appearance";
import type { ActionScope } from "../../contracts/connections";
import { canonicalJson, PlatformError } from "../../contracts/contracts";
import { requireActionMember } from "../../infrastructure/action-authority";
import { transaction } from "../../infrastructure/database";
export const websiteAppearanceUpdateSchema = z.strictObject({ appearance: websiteAppearanceSchema, paused: z.boolean(), expectedAppearanceDigest: z.string().regex(/^[a-f0-9]{64}$/) });
function dto(row: Record<string, any>) {
  const appearance = websiteAppearanceSchema.parse(row.appearance), paused = Boolean(row.paused);
  return { deploymentId: String(row.id), appearance, paused, allowedOrigins: row.allowed_origins as string[],
    appearanceDigest: createHash("sha256").update(canonicalJson({ appearance, paused })).digest("hex") };
}
export class WebsiteAppearanceStore {
  constructor(private readonly pool: Pool) {}
  private async row(db: PoolClient, scope: ActionScope, agentId: string, deploymentId: string, lock = false) {
    z.uuid().parse(agentId); z.uuid().parse(deploymentId);
    await requireActionMember(db, scope);
    const row = (await db.query(`SELECT * FROM agents_platform.website_deployments WHERE organization_id=$1 AND agent_id=$2 AND id=$3 AND revoked_at IS NULL ${lock ? "FOR UPDATE" : "FOR SHARE"}`, [scope.organizationId, agentId, deploymentId])).rows[0];
    if (!row) throw new PlatformError("NOT_FOUND",404,"Website not found"); return row;
  }
  async get(scope: ActionScope, agentId: string, deploymentId: string) { return transaction(this.pool, async db => dto(await this.row(db, scope, agentId, deploymentId))); }
  async update(scope: ActionScope, agentId: string, deploymentId: string, raw: unknown) {
    const input = websiteAppearanceUpdateSchema.parse(raw);
    return transaction(this.pool, async db => {
      await requireActionMember(db, scope);
      if (!(await db.query("SELECT 1 FROM agents_platform.memberships WHERE organization_id=$1 AND account_id=$2 AND role='owner' AND revoked_at IS NULL FOR SHARE", [scope.organizationId, scope.accountId])).rowCount) throw new PlatformError("ACCESS_DENIED",403,"An owner must manage website settings");
      const current = dto(await this.row(db, scope, agentId, deploymentId, true));
      if (current.appearanceDigest !== input.expectedAppearanceDigest) throw new PlatformError("WEBSITE_SETTINGS_CHANGED",409,"Website settings changed; refresh and try again");
      return dto((await db.query("UPDATE agents_platform.website_deployments SET appearance=$4,paused=$5 WHERE organization_id=$1 AND agent_id=$2 AND id=$3 RETURNING *", [scope.organizationId, agentId, deploymentId, input.appearance, input.paused])).rows[0]!);
    });
  }
}
