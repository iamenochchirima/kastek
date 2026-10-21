import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { agentConfigurationSchema, parseAllowedOrigin, PlatformError, requestDigest } from "../../contracts/contracts";
import { effectiveCompositionSchema } from "../../contracts/programs";
import { transaction } from "../../infrastructure/database";
import { resolveAcceptedModelRoutes } from "../../execution/models/resolution";
import { executionModelLayers } from "../../execution/models/settings";
import { type AcceptedModelRoutes } from "../../contracts/model-bindings";
import { requestTreeCancellation } from "../../execution/lifecycle/execution";

export const prepareTrialSchema = z.strictObject({
  trialId: z.string().min(1).max(128), agentId: z.uuid(), versionId: z.uuid(),
  expectedCompositionDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedModelRoutesDigest: z.string().regex(/^[a-f0-9]{64}$/), rootTokenLimit: z.number().int().positive().max(2147483647),
  maxTokens: z.number().int().positive().max(2147483647), expiresAt: z.iso.datetime({ offset: true }),
});
interface TrialRow {
  id: string; trial_id: string; organization_id: string; account_id: string; agent_id: string; version_id: string;
  composition_digest: string; model_routes: AcceptedModelRoutes; model_routes_digest: string; root_token_limit: number; max_tokens: number; expires_at: Date; state: "active" | "revoked"; request_digest: string;
}
export function trialDto(row: TrialRow) {
  return { id: row.id, trialId: row.trial_id, organizationId: row.organization_id, agentId: row.agent_id,
    versionId: row.version_id, compositionDigest: row.composition_digest, modelRoutesDigest: row.model_routes_digest, rootTokenLimit: row.root_token_limit, maxTokens: row.max_tokens,
    expiresAt: row.expires_at.toISOString(), state: row.state };
}

export class EvaluationTrials {
  constructor(private readonly pool: Pool) {}
  private async membership(db: PoolClient, accountId: string, organizationId: string) {
    if (!(await db.query(`SELECT 1 FROM agents_platform.memberships WHERE account_id=$1 AND organization_id=$2
      AND revoked_at IS NULL FOR SHARE`, [accountId, organizationId])).rowCount) throw new PlatformError("ACCESS_DENIED", 403, "Access denied");
  }
  private async resolveModels(db: PoolClient, organizationId: string, agentId: string, versionId: string, rootTokenLimit: number) {
    const row = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 AND id=$3 FOR SHARE", [organizationId, agentId, versionId])).rows[0];
    if (!row) throw new PlatformError("NOT_FOUND", 404, "Configuration not found");
    const configuration = agentConfigurationSchema.parse(row.configuration);
    const modelRoutes = await resolveAcceptedModelRoutes(db, { organizationId, agentId, product: "agents", selection: configuration.model.selection, generation: configuration.model.generation,
      layers: executionModelLayers(configuration, { id: `evaluation:${versionId}`, rootTokenLimit, maxInputBytes: configuration.model.maxInputBytes,
        maxOutputTokens: configuration.model.maxOutputTokens, maxContextTokens: configuration.context.maxInputTokens }),
      requiresTools: configuration.tools.length > 0 || configuration.connectedToolBindingIds.length > 0 || configuration.skillIds.length > 0 });
    if (modelRoutes.primary.policy.maxRootTokens !== rootTokenLimit) throw new PlatformError("EVALUATION_BUDGET_EXCEEDED", 422, "Choose a root allocation within the effective service allowance");
    return { modelRoutes, modelRoutesDigest: requestDigest(modelRoutes), rootTokenLimit };
  }
  async preview(accountId: string, organizationId: string, agentId: string, raw: unknown) {
    const input = z.strictObject({ versionId: z.uuid(), rootTokenLimit: z.number().int().positive().max(2147483647) }).parse(raw);
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      await this.membership(db, accountId, organizationId);
      return this.resolveModels(db, organizationId, z.uuid().parse(agentId), input.versionId, input.rootTokenLimit);
    });
  }
  async prepare(accountId: string, organizationId: string, raw: unknown) {
    const input = prepareTrialSchema.parse(raw), digest = requestDigest(input);
    if (input.rootTokenLimit > input.maxTokens) throw new PlatformError("EVALUATION_BUDGET_EXCEEDED", 422, "Root allocation exceeds the trial allowance");
    if (new Date(input.expiresAt).getTime() > Date.now() + 30 * 60_000 || new Date(input.expiresAt).getTime() <= Date.now()) {
      throw new PlatformError("EVALUATION_DEADLINE_INVALID", 400, "Use a trial deadline within thirty minutes");
    }
    return transaction(this.pool, async db => {
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE", [organizationId]);
      await this.membership(db, accountId, organizationId);
      const agent = (await db.query(`SELECT id FROM agents_platform.agents WHERE id=$1 AND organization_id=$2 FOR UPDATE`, [input.agentId, organizationId])).rows[0];
      if (!agent) throw new PlatformError("NOT_FOUND", 404, "Agent not found");
      const existing = (await db.query<TrialRow>(`SELECT * FROM agents_platform.evaluation_trials WHERE organization_id=$1 AND account_id=$2 AND trial_id=$3`, [organizationId, accountId, input.trialId])).rows[0];
      if (existing) {
        if (existing.request_digest !== digest) throw new PlatformError("IDEMPOTENCY_CONFLICT", 409, "The trial identifier was used for another scope");
        return trialDto(existing);
      }
      const version = (await db.query(`SELECT effective_composition FROM agents_platform.agent_versions WHERE organization_id=$1 AND agent_id=$2 AND id=$3 FOR SHARE`, [organizationId, input.agentId, input.versionId])).rows[0];
      const composition = effectiveCompositionSchema.safeParse(version?.effective_composition);
      if (!composition.success || composition.data.digest !== input.expectedCompositionDigest) throw new PlatformError("EVALUATION_COMPOSITION_MISMATCH", 409, "The prepared version does not match the evaluation composition");
      const models = await this.resolveModels(db, organizationId, input.agentId, input.versionId, input.rootTokenLimit);
      if (models.modelRoutesDigest !== input.expectedModelRoutesDigest) throw new PlatformError("EVALUATION_MODEL_MISMATCH", 409, "The model route or policy changed; prepare a new evaluation scope");
      const used = await db.query(`SELECT 1 FROM agents_platform.tasks t JOIN agents_platform.agent_versions v ON v.id=t.version_id WHERE v.agent_id=$1
        UNION ALL SELECT 1 FROM agents_platform.memory_scopes WHERE agent_id=$1
        UNION ALL SELECT 1 FROM agents_platform.evaluation_trials WHERE agent_id=$1 LIMIT 1`, [input.agentId]);
      if (used.rowCount) throw new PlatformError("EVALUATION_SCOPE_NOT_FRESH", 409, "Prepare a dedicated unused agent for this trial");
      const row = (await db.query<TrialRow>(`INSERT INTO agents_platform.evaluation_trials
        (id,trial_id,organization_id,account_id,agent_id,version_id,composition_digest,max_tokens,expires_at,request_digest,model_routes,model_routes_digest,root_token_limit)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`, [randomUUID(), input.trialId, organizationId, accountId,
        input.agentId, input.versionId, input.expectedCompositionDigest, input.maxTokens, input.expiresAt, digest, models.modelRoutes, models.modelRoutesDigest, input.rootTokenLimit])).rows[0]!;
      return trialDto(row);
    });
  }
  async get(accountId: string, organizationId: string, selector: { id: string } | { trialId: string }) {
    return transaction(this.pool, async db => {
      await this.membership(db, accountId, organizationId);
      const row = (await db.query<TrialRow>(`SELECT * FROM agents_platform.evaluation_trials
        WHERE organization_id=$1 AND account_id=$2 AND ${"id" in selector ? "id" : "trial_id"}=$3`,
      [organizationId, accountId, "id" in selector ? z.uuid().parse(selector.id) : z.string().min(1).max(128).parse(selector.trialId)])).rows[0];
      if (!row) return { trial: null, rootTaskIds: [] as string[] };
      const roots = (await db.query<{ id: string }>("SELECT id FROM agents_platform.tasks WHERE evaluation_trial_id=$1 AND parent_task_id IS NULL ORDER BY created_at,id", [row.id])).rows;
      return { trial: trialDto(row), rootTaskIds: roots.map(root => root.id) };
    });
  }
  async revoke(accountId: string, organizationId: string, id: string) {
    await transaction(this.pool, async db => {
      await this.membership(db, accountId, organizationId);
      const result = await db.query(`UPDATE agents_platform.evaluation_trials SET state='revoked',revoked_at=coalesce(revoked_at,now())
        WHERE id=$1 AND account_id=$2 AND organization_id=$3 RETURNING id`, [z.uuid().parse(id), accountId, organizationId]);
      if (!result.rowCount) throw new PlatformError("NOT_FOUND", 404, "Trial not found");
      await db.query(`UPDATE agents_platform.website_sessions SET expires_at=least(expires_at,now())
        WHERE id IN (SELECT session_id FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1)`,[id]);
    });
    // The committed revocation fences new effects even if cancellation dispatch is interrupted.
    const result = await this.get(accountId, organizationId, { id });
    for (const root of result.rootTaskIds) await requestTreeCancellation(this.pool, root);
    return { ...result, cancellationRequested: true };
  }
  async authorizeVisitorRoot(db:Pool|PoolClient,accountId:string,organizationId:string,rootTaskId:string) {
    const row=(await db.query(`SELECT e.id FROM agents_platform.tasks t
      JOIN agents_platform.evaluation_trials e ON e.id=t.evaluation_trial_id AND e.organization_id=t.organization_id AND e.version_id=t.version_id
      JOIN agents_platform.agent_versions v ON v.id=t.version_id AND v.agent_id=e.agent_id
      JOIN agents_platform.evaluation_trial_channels c ON c.trial_id=e.id AND c.deployment_id::text=(t.principal->>'deploymentId') AND c.session_id::text=(t.principal->>'sessionId')
      JOIN agents_platform.memberships m ON m.organization_id=e.organization_id AND m.account_id=e.account_id AND m.revoked_at IS NULL
      WHERE t.id=$1 AND t.organization_id=$2 AND e.account_id=$3 AND t.parent_task_id IS NULL
        AND t.product='agents' AND t.caller_client_id='agents-website' AND t.principal->>'kind'='visitor' FOR SHARE OF t,e,c,m`,[rootTaskId,organizationId,accountId])).rows[0];
    return row?{evaluationTrialId:row.id as string,accountId}:null;
  }
  async channelSession(accountId:string,organizationId:string,id:string,raw:unknown,signingSecret:string) {
    const input=z.strictObject({deploymentId:z.uuid(),origin:z.string().min(1).max(2048)}).parse(raw);
    input.origin=parseAllowedOrigin(input.origin);
    const digest=requestDigest(input);
    return transaction(this.pool,async db=>{
      await db.query("SELECT id FROM agents_platform.organizations WHERE id=$1 FOR UPDATE",[organizationId]);
      await this.membership(db,accountId,organizationId);
      const trial=(await db.query<TrialRow>("SELECT * FROM agents_platform.evaluation_trials WHERE id=$1 AND organization_id=$2 AND account_id=$3 FOR UPDATE",[id,organizationId,accountId])).rows[0];
      if(!trial||trial.state!=="active"||trial.expires_at.getTime()<=Date.now())throw new PlatformError("EVALUATION_TRIAL_INACTIVE",403,"The evaluation trial is unavailable");
      const deployment=(await db.query(`SELECT * FROM agents_platform.website_deployments WHERE id=$1 AND organization_id=$2 AND agent_id=$3 AND version_id=$4 AND revoked_at IS NULL FOR SHARE`,[input.deploymentId,organizationId,trial.agent_id,trial.version_id])).rows[0];
      if(!deployment||!deployment.allowed_origins.includes(input.origin))throw new PlatformError("EVALUATION_CHANNEL_SCOPE_DENIED",403,"The publication does not authorize this trial channel");
      const existing=(await db.query("SELECT * FROM agents_platform.evaluation_trial_channels WHERE trial_id=$1",[id])).rows[0];
      if(existing&&existing.request_digest!==digest)throw new PlatformError("IDEMPOTENCY_CONFLICT",409,"The trial channel was prepared for another publication or origin");
      const sessionId=existing?.session_id??randomUUID();
      const token=createHmac("sha256",signingSecret).update(JSON.stringify(["evaluation-channel-v1",id,sessionId])).digest("base64url");
      if(!existing){
        await db.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin,expires_at) VALUES($1,$2,$3,$4,$5)",[sessionId,input.deploymentId,createHash("sha256").update(token).digest("hex"),input.origin,trial.expires_at]);
        await db.query(`INSERT INTO agents_platform.evaluation_trial_channels(trial_id,deployment_id,session_id,origin,request_digest,root_token_limit)
          VALUES($1,$2,$3,$4,$5,$6)`,[id,input.deploymentId,sessionId,input.origin,digest,trial.root_token_limit]);
      }
      return {trialId:id,deploymentId:input.deploymentId,origin:input.origin,token};
    });
  }
}
