import type { Pool, PoolClient } from "pg";
import { nextSupportOpening } from "../../capabilities/support-status";
export { nextSupportOpening } from "../../capabilities/support-status";
import { transaction } from "../../infrastructure/database";
import { recordSupportLifecycle } from "../reporting/support-lifecycle";

export const SUPPORT_WAITING_POLICY = Object.freeze({ version: "support-waiting-v1", customerMinutes: [5, 15], staffMinutes: [10, 30] });
export const SUPPORT_WAITING_NOTICE = "Your request is still waiting for a response from the support team. You can add details here while you wait.";
export interface WaitingNotice { conversationId: string; taskId: string; ownershipGeneration: string; stage: 1 | 2; body: string }
export type WaitingNoticePublisher = (db: PoolClient, notice: WaitingNotice) => Promise<boolean>;

async function alertStaff(db: PoolClient, input: { taskId: string; conversationId: string; stage: number; kind: string }) {
  const created = await db.query(`INSERT INTO agents_platform.support_staff_alerts(id,organization_id,account_id,task_id,conversation_id,stage,kind)
    SELECT gen_random_uuid(),c.organization_id,m.account_id,$1,c.id,$3,$4 FROM agents_platform.customer_conversations c
    JOIN agents_platform.memberships m ON m.organization_id=c.organization_id AND m.revoked_at IS NULL
    WHERE c.id=$2 AND NOT EXISTS (SELECT 1 FROM agents_platform.evaluation_trials trial
      WHERE (EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_channels f WHERE f.trial_id=trial.id AND f.session_id=c.session_id)
        OR EXISTS(SELECT 1 FROM agents_platform.evaluation_trial_messaging_channels f WHERE f.trial_id=trial.id AND f.deployment_id=c.channel_deployment_id))
      AND trial.account_id<>m.account_id)
    ON CONFLICT(task_id,account_id,stage) DO NOTHING RETURNING id`, [input.taskId, input.conversationId, input.stage, input.kind]);
  return Boolean(created.rowCount);
}

/** Called in the handoff transaction, after its command receipt exists. */
export async function recordHandoffWaiting(db: PoolClient, input: { taskId: string; conversationId: string; ownershipGeneration: string }): Promise<Date> {
  const inserted = await db.query<{ requested_at: Date }>(`INSERT INTO agents_platform.support_waiting(task_id,source_task_id,conversation_id,ownership_generation)
    VALUES($1,$1,$2,$3) ON CONFLICT DO NOTHING RETURNING requested_at`, [input.taskId, input.conversationId, input.ownershipGeneration]);
  const requestedAt = inserted.rows[0]?.requested_at ?? (await db.query<{ requested_at: Date }>(
    "SELECT requested_at FROM agents_platform.support_waiting WHERE task_id=$1", [input.taskId])).rows[0]?.requested_at;
  if (!requestedAt) throw new Error("SUPPORT_WAITING_EPISODE_MISSING");
  if (inserted.rowCount) await recordSupportLifecycle(db, { conversationId: input.conversationId, sourceKey: `handoff:${input.taskId}:requested`,
    action: "handoff_requested", outcome: "accepted", occurredAt: requestedAt });
  if (await alertStaff(db, { ...input, stage: 0, kind: "handoff_requested" })) await recordSupportLifecycle(db, {
    conversationId: input.conversationId, sourceKey: `handoff:${input.taskId}:staff-alert:0`, action: "staff_alert_created", outcome: "created", occurredAt: requestedAt,
  });
  return requestedAt;
}

/** An attachment-only inbound message has its own episode identity and no execution task. */
export async function recordMessageHandoffWaiting(db: PoolClient, input: { messageId: string; conversationId: string; ownershipGeneration: string }): Promise<Date> {
  const inserted = await db.query<{ requested_at: Date }>(`INSERT INTO agents_platform.support_waiting(task_id,source_message_id,conversation_id,ownership_generation)
    VALUES($1,$1,$2,$3) ON CONFLICT DO NOTHING RETURNING requested_at`, [input.messageId, input.conversationId, input.ownershipGeneration]);
  const requestedAt = inserted.rows[0]?.requested_at ?? (await db.query<{ requested_at: Date }>(
    "SELECT requested_at FROM agents_platform.support_waiting WHERE task_id=$1", [input.messageId])).rows[0]?.requested_at;
  if (!requestedAt) throw new Error("SUPPORT_WAITING_EPISODE_MISSING");
  if (inserted.rowCount) await recordSupportLifecycle(db, { conversationId: input.conversationId, sourceKey: `handoff:${input.messageId}:requested`,
    action: "handoff_requested", outcome: "accepted", occurredAt: requestedAt });
  if (await alertStaff(db, { taskId:input.messageId, conversationId:input.conversationId, stage:0, kind:"handoff_requested" })) await recordSupportLifecycle(db, {
    conversationId: input.conversationId, sourceKey: `handoff:${input.messageId}:staff-alert:0`, action: "staff_alert_created", outcome: "created", occurredAt: requestedAt,
  });
  return requestedAt;
}

export class SupportWaitingService {
  constructor(readonly pool: Pool, readonly publishNotice?: WaitingNoticePublisher) {}

  async snapshot(taskId: string): Promise<Date | null> {
    return (await this.pool.query("SELECT next_action_at FROM agents_platform.support_waiting WHERE task_id=$1 AND completed_at IS NULL", [taskId])).rows[0]?.next_action_at ?? null;
  }

  async advance(taskId: string, now: Date = new Date()): Promise<Date | null> {
    return transaction(this.pool, async db => {
      // Match Inbox lock ordering: conversation first, then the waiting episode.
      const target = (await db.query("SELECT conversation_id FROM agents_platform.support_waiting WHERE task_id=$1", [taskId])).rows[0];
      if (!target) return null;
      const conversation = (await db.query("SELECT * FROM agents_platform.customer_conversations WHERE id=$1 FOR UPDATE", [target.conversation_id])).rows[0];
      const row = (await db.query("SELECT * FROM agents_platform.support_waiting WHERE task_id=$1 FOR UPDATE", [taskId])).rows[0];
      if (!row || row.completed_at) return null;
      const stop = async (reason: string) => { await db.query("UPDATE agents_platform.support_waiting SET completed_at=$2,stopped_reason=$3 WHERE task_id=$1", [taskId, now, reason]); return null; };
      if (!conversation || !["handoff_pending", "human_owned"].includes(conversation.state)) return stop("ownership_changed");
      const newer = (await db.query(`SELECT 1 FROM agents_platform.customer_commands WHERE conversation_id=$1
        AND action IN ('request_handoff','return','resolve') AND command_id<>$2
        AND (result->>'ownership_generation')::bigint>$3 LIMIT 1`, [row.conversation_id, taskId, row.ownership_generation])).rowCount;
      if (newer) return stop("episode_superseded");
      const replied = (await db.query("SELECT 1 FROM agents_platform.customer_messages WHERE conversation_id=$1 AND author_kind='human' AND ownership_generation>=$2 LIMIT 1", [row.conversation_id, row.ownership_generation])).rowCount;
      if (replied) return stop("human_replied");
      const policy = (await db.query(`SELECT v.configuration FROM agents_platform.agents a
        JOIN agents_platform.customer_conversations c ON c.agent_id=a.id AND c.organization_id=a.organization_id
        LEFT JOIN agents_platform.website_deployments w ON w.id=c.deployment_id AND w.organization_id=c.organization_id AND w.revoked_at IS NULL AND w.paused=false
        LEFT JOIN agents_platform.channel_deployments d ON d.id=c.channel_deployment_id AND d.organization_id=c.organization_id AND d.state='active'
        LEFT JOIN agents_platform.channel_connections connection ON connection.id=d.connection_id AND connection.organization_id=c.organization_id AND connection.state='active'
        JOIN agents_platform.agent_versions v ON v.id=CASE WHEN c.channel_kind='website' THEN w.version_id ELSE d.version_id END
        WHERE c.id=$1 AND a.deleted_at IS NULL AND (c.channel_kind='website' OR connection.id IS NOT NULL) FOR SHARE OF a,v`, [row.conversation_id])).rows[0];
      if (!policy || (row.source_message_id === null && !policy.configuration?.tools?.includes("channel.request_handoff"))) return stop("support_authority_revoked");
      if (row.policy_version !== SUPPORT_WAITING_POLICY.version) return stop("policy_unavailable");
      if (row.next_action_at > now) return row.next_action_at;
      const opening = nextSupportOpening(policy.configuration.supportHours, now);
      if (opening > now) { await db.query("UPDATE agents_platform.support_waiting SET next_action_at=$2 WHERE task_id=$1", [taskId, opening]); return opening; }
      const elapsed = (now.getTime() - row.requested_at.getTime()) / 60000;
      const customerStage = SUPPORT_WAITING_POLICY.customerMinutes.filter(at => at <= elapsed).length;
      const staffStage = SUPPORT_WAITING_POLICY.staffMinutes.filter(at => at <= elapsed).length;
      if (staffStage > row.staff_stage) {
        const occurredAt = new Date(now);
        if (row.staff_stage === 0) await recordSupportLifecycle(db, { conversationId: row.conversation_id, sourceKey: `handoff:${taskId}:first-overdue`,
          action: "handoff_overdue", outcome: "created", occurredAt });
        if (await alertStaff(db, { taskId, conversationId: row.conversation_id, stage: staffStage, kind: conversation.assignee_account_id ? "awaiting_human_reply" : "unassigned" })) {
          await recordSupportLifecycle(db, { conversationId: row.conversation_id, sourceKey: `handoff:${taskId}:staff-alert:${staffStage}`,
            action: "staff_alert_created", outcome: "created", occurredAt });
        }
        row.staff_stage = staffStage;
      }
      if (customerStage > row.customer_stage) {
        await db.query("UPDATE agents_platform.support_waiting_notices SET state='suppressed',reason='coalesced' WHERE task_id=$1 AND stage<$2 AND state='pending'", [taskId, customerStage]);
        await db.query(`INSERT INTO agents_platform.support_waiting_notices(task_id,stage,ownership_generation,body)
          VALUES($1,$2,$3,$4) ON CONFLICT(task_id,stage) DO UPDATE SET ownership_generation=excluded.ownership_generation
          WHERE agents_platform.support_waiting_notices.state='pending'`, [taskId, customerStage, conversation.ownership_generation, SUPPORT_WAITING_NOTICE]);
        if (this.publishNotice && await this.publishNotice(db, { taskId, conversationId: row.conversation_id, ownershipGeneration: conversation.ownership_generation, stage: customerStage as 1 | 2, body: SUPPORT_WAITING_NOTICE })) {
          row.customer_stage = customerStage;
        }
      }
      const nextMinutes = [SUPPORT_WAITING_POLICY.customerMinutes[row.customer_stage], SUPPORT_WAITING_POLICY.staffMinutes[row.staff_stage]].filter((value): value is number => value !== undefined);
      if (!nextMinutes.length) {
        await db.query("UPDATE agents_platform.support_waiting SET customer_stage=$2,staff_stage=$3 WHERE task_id=$1", [taskId, row.customer_stage, row.staff_stage]);
        return stop("bounded_updates_complete");
      }
      // Failed/unavailable customer publication stays explicitly pending; retry without another notice identity.
      const next = nextSupportOpening(policy.configuration.supportHours, new Date(Math.max(now.getTime() + 60000, row.requested_at.getTime() + Math.min(...nextMinutes) * 60000)));
      await db.query("UPDATE agents_platform.support_waiting SET customer_stage=$2,staff_stage=$3,next_action_at=$4 WHERE task_id=$1", [taskId, row.customer_stage, row.staff_stage, next]);
      return next;
    });
  }
}
