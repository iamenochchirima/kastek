import { createCursorCodec, cursorKeysFromEnvironment, type CursorKeys } from "../infrastructure/read-pages";
import type { Pool, PoolClient } from "pg";
import { PlatformError, type AgentConfiguration } from "../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../execution/context/evidence-policy";
import { requestTreeCancellation } from "../execution/lifecycle/execution";
import { registerChannelPorts } from "../infrastructure/channel-ports";
import { PlatformStore } from "../product/agents/store";
import { inspectInboxOutput } from "../execution/lifecycle/state";
import { InboxStore } from "../product/inbox/inbox-store";

export function composeInbox(pool: Pool, options: { publicOrigin: string; cursorKeys?: CursorKeys; assertServices(configuration: AgentConfiguration): Promise<void> }) {
  const store = new PlatformStore(pool);
  const inbox = new InboxStore(pool, {
    async admit(db, input) {
      const deployment = (await db.query(`SELECT d.*,s.origin AS session_origin FROM agents_platform.website_deployments d
        JOIN agents_platform.website_sessions s ON s.deployment_id=d.id WHERE d.id=$1 AND s.id=$2 AND d.revoked_at IS NULL AND d.paused=false AND s.expires_at>now() FOR SHARE OF d,s`,
      [input.deploymentId, input.sessionId])).rows[0];
      if (!deployment || deployment.version_id !== input.versionId) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel is unavailable");
      const version = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$2", [input.versionId, deployment.organization_id])).rows[0];
      await options.assertServices(version.configuration);
      const trial=(await db.query("SELECT trial_id,root_token_limit FROM agents_platform.evaluation_trial_channels WHERE deployment_id=$1 AND session_id=$2",[deployment.id,input.sessionId])).rows[0];
      const grant = await store.createWebsiteGrantInTransaction(db, { deploymentId: deployment.id, sessionId: input.sessionId,
        ...(trial?{rootTokenLimit:trial.root_token_limit}:{}),
        origin: deployment.session_origin === options.publicOrigin ? deployment.allowed_origins[0] : deployment.session_origin });
      const result = await store.admitTaskInTransaction(db, { versionId: input.versionId, grantId: grant.id,
        authority: { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id, callerClientId: "agents-website",
          principal: { kind: "visitor", deploymentId: deployment.id, sessionId: input.sessionId } }, input: input.input,
        requestKey: input.requestKey, conversationId: input.executionConversationId ?? undefined, channelBinding: input.channelBinding,
        ...(trial?{evaluationTrialId:trial.trial_id}:{configurationMode:"current" as const}),
      });
      return result.task;
    },
    async admitChannel(db, input) {
      const deployment = (await db.query(`SELECT d.* FROM agents_platform.channel_deployments d
        JOIN agents_platform.channel_connections c ON c.organization_id=d.organization_id AND c.id=d.connection_id
        WHERE d.id=$1 AND d.state='active' AND c.state='active' AND c.kind<>'website' FOR SHARE OF d,c`, [input.deploymentId])).rows[0];
      if (!deployment || deployment.version_id !== input.versionId || input.channelBinding.customerConversationId !== input.participantId) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel is unavailable");
      const version = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$2", [input.versionId, deployment.organization_id])).rows[0];
      if (!version) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel is unavailable");
      await options.assertServices(version.configuration);
      const trial=(await db.query(`SELECT e.trial_id,t.root_token_limit FROM agents_platform.evaluation_trial_messaging_channels e
        JOIN agents_platform.evaluation_trials t ON t.id=e.trial_id WHERE e.deployment_id=$1`,[deployment.id])).rows[0];
      const grant = await store.createChannelGrantInTransaction(db, { deploymentId: deployment.id, participantId: input.participantId,
        ...(trial?{rootTokenLimit:trial.root_token_limit}:{}) });
      const result = await store.admitTaskInTransaction(db, { versionId: input.versionId, grantId: grant.id,
        authority: { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id, callerClientId: "agents-channel",
          principal: { kind: "channel_customer", deploymentId: deployment.id, participantId: input.participantId } },
        input: input.input, requestKey: input.requestKey, conversationId: input.executionConversationId ?? undefined,
        channelBinding: input.channelBinding,...(trial?{evaluationTrialId:trial.trial_id}:{configurationMode:"current" as const}) });
      return result.task;
    },
    async readableOutput(db: Pool | PoolClient, taskId: string, body: string) {
      const task = (await db.query("SELECT output,state FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
      if (!task || task.output !== body || !["completed", "incomplete"].includes(task.state)) return null;
      try { return await inspectInboxOutput(async () => { await assertCurrentEvidence(db, taskId, await taskEvidenceManifest(db, taskId), { requireActiveTask: false }); return body; }); }
      catch (error) { if (error instanceof PlatformError) return null; throw error; }
    },
    cancelRoot: taskId => requestTreeCancellation(pool, taskId),
  }, createCursorCodec(options.cursorKeys ?? cursorKeysFromEnvironment()));
  registerChannelPorts(pool, {
    assertBinding: (db, binding, task) => inbox.assertBinding(db, binding, task),
    requestHandoff: (db, binding, taskId, brief) => inbox.requestHandoff(db, binding, taskId, brief),
    publishAutomated: (db, input) => inbox.publishAutomated(db, input),
    publishEnquiryReview:(db,input)=>inbox.publishEnquiryReview(db,input),
    publishToolReview:(db,input)=>inbox.publishToolReview(db,input),
    context: (db, binding, beforeMessageId) => inbox.context(db, binding, beforeMessageId),
  });
  return inbox;
}
