import {verifyHumanAssistanceEvidence} from "../product/inbox/human-assistance";
import { createCursorCodec, cursorKeysFromEnvironment, type CursorKeys } from "../infrastructure/read-pages";
import type { Pool, PoolClient } from "pg";
import { PlatformError, type AgentConfiguration } from "../contracts/contracts";
import { assertCurrentEvidence, taskEvidenceManifest } from "../execution/context/evidence-policy";
import { requestTreeCancellation } from "../execution/lifecycle/execution";
import { registerChannelPorts } from "../infrastructure/channel-ports";
import { PlatformStore } from "../product/agents/store";
import { inspectInboxOutput } from "../execution/lifecycle/state";
import { InboxStore } from "../product/inbox/inbox-store";
import { HANDOFF_RECEIPT_DEADLINE_MS } from "../product/inbox/handoff-pending-receipt";
import { followupAccess } from "../product/customer-followup/access";
import { verifiedVisitorLineage } from "../product/customer-followup/lineage";
import { enqueueCustomerFollowup,customerFollowupFailures } from "../product/customer-followup/notifications";
import { verifySupportStatusFacts,verifyHistoricalSupportStatusEvidence } from '../product/inbox/support-status-evidence';
import { projectRecipientText, taskRecipientTextScope } from "../execution/context/recipient-text";

export function composeInbox(pool: Pool, options: { publicOrigin: string; cursorKeys?: CursorKeys; followupEnabled?: boolean; followupAccessEnabled?:boolean; supportStatusEnabled?:boolean; assertServices(configuration: AgentConfiguration): Promise<void> }) {
  const store = new PlatformStore(pool);
  const inbox = new InboxStore(pool, {
    ...(options.supportStatusEnabled ? {verifySupportStatus:verifySupportStatusFacts,verifyHistoricalSupportStatus:verifyHistoricalSupportStatusEvidence} : {}),
    ...(options.followupEnabled||options.followupAccessEnabled ? { followupAccess,followupFailures:customerFollowupFailures } : {}),
    ...(options.followupEnabled ? { enqueueFollowup:enqueueCustomerFollowup } : {}),
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
    ...(options.supportStatusEnabled ? {async admitSupportStatus(db,input) {
      const binding=input.channelBinding;
      if(input.sessionId) {
        const deployment=(await db.query(`SELECT d.*,s.origin AS session_origin FROM agents_platform.website_deployments d
          JOIN agents_platform.website_sessions s ON s.deployment_id=d.id WHERE d.id=$1 AND s.id=$2
            AND d.revoked_at IS NULL AND d.paused=false AND s.expires_at>now() FOR SHARE OF d,s`,[input.deploymentId,input.sessionId])).rows[0];
        if(!deployment || deployment.version_id!==input.versionId)throw new PlatformError('DEPLOYMENT_SCOPE_DENIED',403,'Customer channel is unavailable');
        const grant=await store.createWebsiteGrantInTransaction(db,{deploymentId:deployment.id,sessionId:input.sessionId,
          origin:deployment.session_origin===options.publicOrigin?deployment.allowed_origins[0]:deployment.session_origin});
        return (await store.admitPendingSupportStatusInTransaction(db,{versionId:input.versionId,grantId:grant.id,
          authority:{product:'agents',organizationId:deployment.organization_id,resourceId:deployment.id,callerClientId:'agents-website',
            principal:{kind:'visitor',deploymentId:deployment.id,sessionId:input.sessionId}},input:input.input,requestKey:input.requestKey,
          conversationId:input.executionConversationId ?? undefined,channelBinding:binding,configurationMode:'current',episodeCommandId:input.episodeCommandId})).task;
      }
      const deployment=(await db.query(`SELECT d.* FROM agents_platform.channel_deployments d JOIN agents_platform.channel_connections c
        ON c.id=d.connection_id AND c.organization_id=d.organization_id WHERE d.id=$1 AND d.state='active' AND c.state='active' FOR SHARE OF d,c`,[input.deploymentId])).rows[0];
      if(!deployment || deployment.version_id!==input.versionId || input.participantId!==binding.customerConversationId)throw new PlatformError('DEPLOYMENT_SCOPE_DENIED',403,'Customer channel is unavailable');
      const grant=await store.createPendingSupportStatusGrantInTransaction(db,{deploymentId:deployment.id,participantId:input.participantId});
      return (await store.admitPendingSupportStatusInTransaction(db,{versionId:input.versionId,grantId:grant.id,
        authority:{product:'agents',organizationId:deployment.organization_id,resourceId:deployment.id,callerClientId:'agents-channel',
          principal:{kind:'channel_customer',deploymentId:deployment.id,participantId:input.participantId}},input:input.input,requestKey:input.requestKey,
        conversationId:input.executionConversationId ?? undefined,channelBinding:binding,configurationMode:'current',episodeCommandId:input.episodeCommandId})).task;
    }} : {}),
    async readableOutput(db: Pool | PoolClient, taskId: string, body: string) {
      const task = (await db.query("SELECT output,state FROM agents_platform.tasks WHERE id=$1", [taskId])).rows[0];
      if (!task || typeof task.output!=="string" || !["completed", "incomplete"].includes(task.state)) return null;
      const projected=projectRecipientText(task.output,await taskRecipientTextScope(db,taskId,[task.output]));
      if(projected!==body&&task.output!==body)return null;
      try { return await inspectInboxOutput(async () => { await assertCurrentEvidence(db, taskId, await taskEvidenceManifest(db, taskId), { requireActiveTask: false }); return projected; }); }
      catch (error) { if (error instanceof PlatformError) return null; throw error; }
    },
    async verifyPendingHandoffReceipt(db, {receipt,origin,text}) {
      const visitor=(await db.query(`SELECT c.organization_id,c.agent_id,c.execution_conversation_id,c.deployment_id,c.session_id,t.principal
        FROM agents_platform.customer_conversations c JOIN agents_platform.tasks t ON t.id=$1
        WHERE c.id=$2 AND c.channel_kind='website'`,[receipt.task_id,receipt.conversation_id])).rows[0];
      if(visitor && (visitor.principal?.kind!=="visitor" || !await verifiedVisitorLineage(db,{
        customerConversationId:receipt.conversation_id,organizationId:visitor.organization_id,agentId:visitor.agent_id,
        executionConversationId:visitor.execution_conversation_id,
        origin:{deploymentId:visitor.deployment_id,sessionId:visitor.session_id},
        current:{deploymentId:visitor.principal.deploymentId,sessionId:visitor.principal.sessionId},
      }))) return false;
      if(origin === "fallback") return true;
      if(!receipt.feedback_request_digest || !receipt.evidence_manifest) return false;
      const operation=(await db.query(`SELECT output FROM agents_platform.operations
        WHERE id=$1 AND task_id=$2 AND name='model.handoff_feedback' AND state='completed'
          AND request_digest=$3 FOR SHARE`,[`handoff-feedback:${receipt.task_id}`,receipt.task_id,receipt.feedback_request_digest])).rows[0];
      if(!operation || operation.output?.finishReason!=="stop" || typeof operation.output?.message?.content!=="string"
        || operation.output.message.content.trim()!==text) return false;
      try {
        await assertCurrentEvidence(db,receipt.task_id,receipt.evidence_manifest,{requireActiveTask:false});
        return true;
      } catch(error) { if(error instanceof PlatformError) return false; throw error; }
    },
    cancelRoot: taskId => requestTreeCancellation(pool, taskId),
  }, createCursorCodec(options.cursorKeys ?? cursorKeysFromEnvironment()));
  registerChannelPorts(pool, {
    ...(options.followupEnabled||options.followupAccessEnabled ? { visitorLineage:verifiedVisitorLineage } : {}),
    assertBinding: (db, binding, task) => inbox.assertBinding(db, binding, task),
    requestHandoff: (db, binding, taskId, brief, cause) => inbox.requestHandoff(db, binding, taskId, brief, cause),
    procedureSnapshot:(...args)=>inbox.procedureSnapshot(...args),
    verifyProcedureEvidence:verifyHumanAssistanceEvidence,
    requestHumanAssistance:(...args)=>inbox.requestHumanAssistance(...args),
    updateHumanAssistance:(...args)=>inbox.updateHumanAssistance(...args),
    requestHandoffV2: (db, binding, taskId, brief, feedback) => inbox.requestHandoffV2(db, binding, taskId, brief, HANDOFF_RECEIPT_DEADLINE_MS, feedback),
    publishAutomated: (db, input) => inbox.publishAutomated(db, input),
    publishEnquiryReview:(db,input)=>inbox.publishEnquiryReview(db,input),
    publishToolReview:(db,input)=>inbox.publishToolReview(db,input),
    context: (db, binding, beforeMessageId) => inbox.context(db, binding, beforeMessageId),
  });
  return inbox;
}
