import type { Pool, PoolClient } from "pg";
import { PlatformError, type AgentConfiguration } from "../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../execution/context/evidence-policy";
import { requestTreeCancellation } from "../execution/lifecycle/execution";
import { registerChannelPorts } from "../infrastructure/channel-ports";
import { PlatformStore } from "../product/agents/store";
import { InboxStore } from "../product/inbox/inbox-store";

export function composeInbox(pool: Pool, options: { publicOrigin: string; assertServices(configuration: AgentConfiguration): Promise<void> }) {
  const store = new PlatformStore(pool);
  const inbox = new InboxStore(pool, {
    async admit(db, input) {
      const deployment = (await db.query(`SELECT d.*,s.origin AS session_origin FROM agents_platform.website_deployments d
        JOIN agents_platform.website_sessions s ON s.deployment_id=d.id WHERE d.id=$1 AND s.id=$2 AND d.revoked_at IS NULL AND s.expires_at>now() FOR SHARE OF d,s`,
      [input.deploymentId, input.sessionId])).rows[0];
      if (!deployment || deployment.version_id !== input.versionId) throw new PlatformError("DEPLOYMENT_SCOPE_DENIED", 403, "Customer channel is unavailable");
      const version = (await db.query("SELECT configuration FROM agents_platform.agent_versions WHERE id=$1 AND organization_id=$2", [input.versionId, deployment.organization_id])).rows[0];
      await options.assertServices(version.configuration);
      const grant = await store.createWebsiteGrantInTransaction(db, { deploymentId: deployment.id, sessionId: input.sessionId,
        origin: deployment.session_origin === options.publicOrigin ? deployment.allowed_origins[0] : deployment.session_origin });
      const result = await store.admitTaskInTransaction(db, { versionId: input.versionId, grantId: grant.id,
        authority: { product: "agents", organizationId: deployment.organization_id, resourceId: deployment.id, callerClientId: "agents-website",
          principal: { kind: "visitor", deploymentId: deployment.id, sessionId: input.sessionId } }, input: input.input,
        requestKey: input.requestKey, conversationId: input.executionConversationId ?? undefined, channelBinding: input.channelBinding });
      return result.task;
    },
    async readableOutput(db: Pool | PoolClient, taskId: string, body: string) {
      const task = (await db.query("SELECT output,state FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
      if (!task || task.output !== body || !["completed", "incomplete"].includes(task.state)) return null;
      try { await assertCurrentEvidence(db, taskId, await taskEvidenceManifest(db, taskId), { requireActiveTask: false }); return body; }
      catch (error) { if (error instanceof PlatformError) return null; throw error; }
    },
    cancelRoot: taskId => requestTreeCancellation(pool, taskId),
  });
  registerChannelPorts(pool, {
    assertBinding: (db, binding, task) => inbox.assertBinding(db, binding, task),
    requestHandoff: (db, binding, taskId) => inbox.requestHandoff(db, binding, taskId),
    publishAutomated: (db, input) => inbox.publishAutomated(db, input),
    context: (db, binding, beforeMessageId) => inbox.context(db, binding, beforeMessageId),
  });
  return inbox;
}
