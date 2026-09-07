import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { query, withTransaction } from "../pool";
import { assertRunTransition, type RunStatus, type StartRunInput } from "../../domain/types";
import { createScopedAgentEvent } from "../../runtime/execution-evidence";
import { executionScopeFromRun } from "../../runtime/execution-scope";
import {
  buildCompletedAgentRunEvent,
  buildFailedAgentRunEvent,
  enqueueAgentConversationMessage,
  loadAgentConversationAnalyticsContext,
  enqueueOutbox,
  type AgentRunTerminalInput,
} from "../../analytics";
import { parseAgentResponse } from "../../media/contracts";
import type { ConversationRecord } from "./conversation-repository";
import { recordConversationAdmission } from "../../telemetry/spans";
import { admissionDecision, sameSessionSerializationPolicy } from "../../runtime/admission";
import type { ExecutionJournalRead, PendingExecutionJournalEvent, PersistedExecutionJournalEvent } from "../../journal";
import { ExtensionSnapshotRepository } from "./extension-snapshot-repository";
import { SessionLeaseRepository } from "./session-lease-repository";

export interface ConversationTurnAdmission {
  acquired: boolean;
  sessionKey?: string;
  ownerId?: string;
  fencingToken?: string;
}

export interface RunRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  installation_id: string;
  conversation_id: string | null;
  trigger_type: "message" | "schedule" | "webhook" | "manual";
  status: RunStatus;
  input: Record<string, unknown>;
  output: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  correlation_id: string;
  causation_id: string | null;
  created_by: string;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  idempotency_key?: string | null;
  extension_snapshot_id?: string | null;
  reply_channel_type?: string | null;
  reply_binding_id?: string | null;
  resolved_model_provider?: string | null;
  resolved_model?: string | null;
  agent_name?: string | null;
  agent_description?: string | null;
  agent_slug?: string | null;
  agent_owner_type?: string | null;
  agent_protected?: boolean;
  execution_mode?: "system_hosted" | "kasitek_hosted" | "external_connected";
  creation_profile?: "general" | "custom" | "system";
  agent_audience?: "personal" | "customer_service";
  created?: boolean;
  admission?: ReturnType<typeof admissionDecision>;
}

export interface RuntimeRunRecord extends RunRecord {
  instructions: string;
  configuration: Record<string, unknown>;
  policy: Record<string, unknown>;
  installation_settings: Record<string, unknown>;
  installation_status: string;
}

export type ConversationRunSummary = Pick<RunRecord, "id" | "conversation_id" | "status" | "created_at" | "updated_at">;

export interface InstallationOperationRecord extends RunRecord {
  transport: "mcp" | "rest" | "unknown";
  tool_name: string | null;
  tool_invocation_count: number;
  model_call_count: number;
  approval_status: string | null;
}

export class RunRepository {
  private readonly extensionSnapshots: ExtensionSnapshotRepository;
  private readonly sessionLeases: SessionLeaseRepository;

  public constructor(private readonly pool: Pool) {
    this.extensionSnapshots = new ExtensionSnapshotRepository(pool);
    this.sessionLeases = new SessionLeaseRepository(pool);
  }

  public async createRun(
    organizationId: string,
    actorId: string,
    input: StartRunInput,
  ): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      if (input.idempotencyKey) {
        const existing = await client.query<RunRecord>(
          `SELECT * FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [organizationId, input.idempotencyKey],
        );
        if (existing.rows[0]) {
          recordConversationAdmission({ outcome: "idempotent", channel: "run" });
          return { ...existing.rows[0], created: false };
        }
      }
      const installation = await client.query<{
        agent_definition_id: string;
        agent_version_id: string;
        extension_snapshot_id: string | null;
        status: string;
        execution_mode: "system_hosted" | "kasitek_hosted" | "external_connected";
        policy: Record<string, unknown>;
      }>(
        `SELECT ai.agent_definition_id, ai.agent_version_id, av.extension_snapshot_id,
                ai.status, ai.execution_mode, av.policy
         FROM agent_installations ai
         JOIN agent_versions av ON av.id = ai.agent_version_id
         WHERE ai.id = $1 AND ai.organization_id = $2
         FOR UPDATE OF ai`,
        [input.installationId, organizationId],
      );
      const target = installation.rows[0];
      if (!target || target.status !== "active") throw new Error("Active installation not found");
      let extensionSnapshotId = target.extension_snapshot_id;
      if (!extensionSnapshotId) {
        // Versions created before extension snapshots were introduced are
        // initialized once, inside the same admission transaction. After this
        // point every run still admits only the immutable pinned snapshot.
        const snapshot = await this.extensionSnapshots.ensureSnapshotForVersion(client, organizationId, actorId, target.agent_version_id);
        const pinned = await client.query<{ extension_snapshot_id: string }>(
          `UPDATE agent_versions
           SET extension_snapshot_id = $2
           WHERE id = $1 AND extension_snapshot_id IS NULL
           RETURNING extension_snapshot_id`,
          [target.agent_version_id, snapshot.id],
        );
        extensionSnapshotId = pinned.rows[0]?.extension_snapshot_id
          ?? (await client.query<{ extension_snapshot_id: string | null }>(
            "SELECT extension_snapshot_id FROM agent_versions WHERE id = $1 FOR SHARE",
            [target.agent_version_id],
          )).rows[0]?.extension_snapshot_id
          ?? snapshot.id;
      }
      const admissionSnapshot = await this.extensionSnapshots.getVersionAdmissionSnapshot(
        client,
        organizationId,
        target.agent_version_id,
        extensionSnapshotId,
      );
      if (!admissionSnapshot) {
        throw new Error("EXTENSION_SNAPSHOT_RUN_ADMISSION_INVALID");
      }
      const capabilityInvocation = Boolean(
        input.input
        && typeof input.input === "object"
        && input.input.mcpTool
        && typeof input.input.mcpTool === "object",
      );
      if (target.execution_mode === "external_connected" && !capabilityInvocation) {
        throw new Error("External-connected installations are invoked through MCP or REST capabilities");
      }
      let conversationHasActiveRun = false;
      if (input.conversationId) {
        const conversation = await client.query<{
          conversation_kind: ConversationRecord["conversation_kind"];
          handoff_state: ConversationRecord["handoff_state"];
          status: string;
        }>(
          `SELECT conversation_kind, handoff_state, status
           FROM conversations
           WHERE organization_id = $1 AND id = $2
           FOR UPDATE`,
          [organizationId, input.conversationId],
        );
        const currentConversation = conversation.rows[0];
        if (!currentConversation || currentConversation.status !== "active") {
          throw new Error("Active conversation not found");
        }
        if (currentConversation.conversation_kind === "customer" && currentConversation.handoff_state !== "agent_active") {
          throw Object.assign(new Error("Agent execution is paused while this conversation is owned by a human"), {
            statusCode: 409,
            code: "conversation_handoff_active",
          });
        }
        const activeConversationRun = await client.query<{ id: string; status: RunStatus }>(
          `SELECT id, status
           FROM agent_runs
           WHERE organization_id = $1 AND conversation_id = $2
             AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
           ORDER BY created_at ASC
           LIMIT 1`,
          [organizationId, input.conversationId],
        );
        conversationHasActiveRun = Boolean(activeConversationRun.rows[0]);
      }
      const maxConcurrentRuns = typeof target.policy.maxConcurrentRuns === "number"
        ? Math.trunc(target.policy.maxConcurrentRuns)
        : Number(target.policy.maxConcurrentRuns);
      if (Number.isSafeInteger(maxConcurrentRuns) && maxConcurrentRuns > 0) {
        const active = await client.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count
           FROM agent_runs
           WHERE organization_id = $1 AND installation_id = $2
             AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')`,
          [organizationId, input.installationId],
        );
        if (Number(active.rows[0]?.count ?? 0) >= maxConcurrentRuns && !conversationHasActiveRun) {
          recordConversationAdmission({ outcome: "limited", channel: "run" });
          throw new Error("AGENT_CONCURRENCY_LIMIT");
        }
      }
      const flag = await client.query<{ enabled: boolean }>(
        `SELECT enabled
         FROM agent_operator_feature_flags
         WHERE flag_key = 'agent_execution_enabled' AND expires_at > now()
           AND ((scope_type = 'global')
             OR (scope_type = 'organization' AND scope_id = $1)
             OR (scope_type = 'installation' AND scope_id = $2 AND organization_id = $1))
         ORDER BY CASE scope_type WHEN 'installation' THEN 3 WHEN 'organization' THEN 2 ELSE 1 END DESC
         LIMIT 1`,
        [organizationId, input.installationId],
      );
      if (flag.rows[0] && !flag.rows[0].enabled) throw new Error("AGENT_EXECUTION_FLAG_DISABLED");
      const hold = await client.query<{ held: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM agent_operator_holds
           WHERE organization_id = $1 AND status = 'active' AND hold_type = 'execution' AND expires_at > now()
             AND ((scope_type = 'organization' AND scope_id = $1) OR (scope_type = 'installation' AND scope_id = $2))
         ) AS held`,
        [organizationId, input.installationId],
      );
      if (hold.rows[0]?.held) throw new Error("AGENT_EXECUTION_HOLD_ACTIVE");
      const created = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by,
           idempotency_key, extension_snapshot_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'received', $7::jsonb, gen_random_uuid(), $8, $9, $10)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [
          organizationId,
          target.agent_definition_id,
          target.agent_version_id,
          input.installationId,
          input.conversationId ?? null,
          input.triggerType,
          JSON.stringify(input.input),
          actorId,
          input.idempotencyKey ?? null,
          extensionSnapshotId,
        ],
      );
      const run = created.rows[0] ?? (input.idempotencyKey
        ? (await client.query<RunRecord>(
          `SELECT * FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [organizationId, input.idempotencyKey],
        )).rows[0]
        : undefined);
      if (!run) {
        throw new Error("Run could not be created");
      }
      if (created.rows.length === 0) return { ...run, created: false };
      const admission = conversationHasActiveRun
        ? admissionDecision({ outcome: "queued", reasonCode: "conversation_run_active", policy: sameSessionSerializationPolicy })
        : admissionDecision({ outcome: "accepted" });
      recordConversationAdmission({ outcome: admission.outcome, channel: "run" });
      await client.query(
        `INSERT INTO run_attempts (run_id, organization_id, attempt_number, status, trigger)
         VALUES ($1, $2, 1, 'started', 'workflow')`,
        [run.id, organizationId],
      );
      await client.query(
        `INSERT INTO run_workflow_state (run_id, organization_id, state, revision)
         VALUES ($1, $2, '{}'::jsonb, 0)
         ON CONFLICT (run_id) DO NOTHING`,
        [run.id, organizationId],
      );
      await client.query(
        `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, actor_id, correlation_id)
         VALUES ($1, $2, $3, 'run.received', $4::jsonb, $5, $6)`,
        [organizationId, run.id, input.installationId, JSON.stringify({ triggerType: input.triggerType }), actorId, run.correlation_id],
      );
      return { ...run, created: true, admission };
    });
  }

  /**
   * Return true only for the oldest active run in a conversation. The row lock
   * makes competing Temporal workflows re-check the same ordering atomically;
   * no process-local mutex is involved.
   */
  public async acquireConversationTurn(organizationId: string, runId: string): Promise<ConversationTurnAdmission> {
    const turn = await withTransaction(this.pool, async (client) => {
      const current = await client.query<{ conversation_id: string | null; installation_id: string }>(
        `SELECT conversation_id
                , installation_id
         FROM agent_runs
         WHERE organization_id = $1 AND id = $2
         FOR UPDATE`,
        [organizationId, runId],
      );
      const run = current.rows[0];
      const conversationId = run?.conversation_id;
      if (!run || !conversationId) return { canAcquire: true, conversationId: null, installationId: undefined };
      const oldest = await client.query<{ id: string }>(
        `SELECT id
         FROM agent_runs
         WHERE organization_id = $1
           AND conversation_id = $2
           AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
         ORDER BY created_at ASC, id ASC
         LIMIT 1`,
        [organizationId, conversationId],
      );
      return {
        canAcquire: oldest.rows[0]?.id === runId,
        conversationId,
        installationId: run.installation_id,
      };
    });
    if (!turn.canAcquire || !turn.conversationId || !turn.installationId) return { acquired: turn.canAcquire };
    const sessionKey = `conversation:${turn.installationId}:${turn.conversationId}`;
    const ownerId = `agent-run:${runId}`;
    const lease = await this.sessionLeases.acquire({
      organizationId,
      sessionKey,
      ownerId,
      runId,
      leaseDurationMs: 10 * 60 * 1_000,
    });
    return lease.outcome === "acquired"
      ? { acquired: true, sessionKey, ownerId, fencingToken: lease.lease.fencing_token }
      : { acquired: false, sessionKey, ownerId, fencingToken: lease.lease.fencing_token };
  }

  public async canAcquireConversationTurn(organizationId: string, runId: string): Promise<boolean> {
    return (await this.acquireConversationTurn(organizationId, runId)).acquired;
  }

  public async assertConversationLease(input: {
    organizationId: string;
    sessionKey: string;
    ownerId: string;
    runId: string;
    fencingToken: string;
  }): Promise<boolean> {
    const result = await this.sessionLeases.assertCurrent({ ...input });
    return result.outcome === "current";
  }

  public async finishOpenAttempt(
    runId: string,
    status: "completed" | "failed" | "cancelled",
    error?: Record<string, unknown>,
  ): Promise<void> {
    await query(
      this.pool,
      `UPDATE run_attempts
       SET status = $2, error = $3::jsonb, finished_at = now()
       WHERE run_id = $1 AND status = 'started'`,
      [runId, status, error ? JSON.stringify(error) : null],
    );
  }

  public async transitionRun(
    runId: string,
    expectedStatus: RunStatus,
    nextStatus: RunStatus,
    payload: Record<string, unknown> = {},
  ): Promise<RunRecord> {
    assertRunTransition(expectedStatus, nextStatus);
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (run.status !== expectedStatus) {
        if (run.status === nextStatus) return run;
        throw new Error(`Run status changed: expected ${expectedStatus}, found ${run.status}`);
      }
      const terminal = ["completed", "failed", "cancelled", "expired"].includes(nextStatus);
      const updated = await client.query<RunRecord>(
        `UPDATE agent_runs
         SET status = $2,
             started_at = CASE WHEN $2 = 'running' AND started_at IS NULL THEN now() ELSE started_at END,
             finished_at = CASE WHEN $3::boolean THEN now() ELSE finished_at END,
             updated_at = now()
         WHERE id = $1
         RETURNING *`,
        [runId, nextStatus, terminal],
      );
      await client.query(
        `INSERT INTO agent_events
          (organization_id, run_id, installation_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [run.organization_id, runId, run.installation_id, `run.${nextStatus}`, JSON.stringify(payload), run.correlation_id],
      );
      if (terminal) {
        const attemptStatus = nextStatus === "cancelled" ? "cancelled" : nextStatus === "failed" ? "failed" : "completed";
        await client.query(
          `UPDATE run_attempts SET status = $2, finished_at = now()
           WHERE run_id = $1 AND status = 'started'`,
          [runId, attemptStatus],
        );
        await this.sessionLeases.releaseForRun(client, run.organization_id, runId);
      }
      return updated.rows[0]!;
    });
  }

  public async completeRun(runId: string, output: Record<string, unknown>): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>(
        `SELECT ar.*, ai.execution_mode, ad.creation_profile, ad.agent_audience
         FROM agent_runs ar
         JOIN agent_installations ai ON ai.id = ar.installation_id
         JOIN agent_definitions ad ON ad.id = ar.agent_definition_id
         WHERE ar.id = $1
         FOR UPDATE OF ar`,
        [runId],
      );
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (run.status === "completed") return run;
      assertRunTransition(run.status, "completed");
      let replySuppressed = false;
      if (run.conversation_id) {
        const response = parseAgentResponse(output.response ?? { text: typeof output.message === "string" ? output.message : "" });
        const responseMessage = response.text;
        const conversation = await client.query<{
          id: string;
          status: string;
          conversation_kind: ConversationRecord["conversation_kind"];
          handoff_state: ConversationRecord["handoff_state"];
        }>(
          `SELECT id, status, conversation_kind, handoff_state
           FROM conversations
           WHERE id = $1 AND organization_id = $2
           FOR UPDATE`,
          [run.conversation_id, run.organization_id],
        );
        if (!conversation.rows[0] || conversation.rows[0].status !== "active") {
          throw new Error("Active conversation not found");
        }
        replySuppressed = conversation.rows[0].conversation_kind === "customer"
          && conversation.rows[0].handoff_state !== "agent_active";
        if (!replySuppressed && !responseMessage && !response.media.length) throw new Error("Conversation run cannot complete without an assistant response");
        const participant = replySuppressed ? null : await client.query<{ id: string }>(
          `INSERT INTO participants
            (conversation_id, organization_id, participant_type, external_id, display_name)
           SELECT $1, $2, 'agent', $3, name
           FROM agent_definitions WHERE id = $4
           ON CONFLICT (conversation_id, participant_type, external_id)
           DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [run.conversation_id, run.organization_id, run.agent_definition_id, run.agent_definition_id],
        );
        const nextSequence = replySuppressed ? null : await client.query<{ sequence_number: string }>(
          `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
           FROM messages WHERE conversation_id = $1`,
          [run.conversation_id],
        );
        const inboundRoute = replySuppressed ? null : await client.query<{ external_conversation_id: string | null }>(
          `SELECT external_conversation_id FROM messages
           WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        const outbound = replySuppressed ? { rows: [] as Array<{ id: string }> } : await client.query<{ id: string }>(
          `INSERT INTO messages
            (conversation_id, organization_id, participant_id, direction, message_type, content,
             provider, provider_message_id, sequence_number, run_id, source_channel,
             source_binding_id, external_conversation_id, occurred_at, delivery_status)
           VALUES ($1, $2, $3, 'outbound', $4, $5::jsonb, COALESCE($9, 'platform'), $6, $7, $8,
                   COALESCE($9, 'platform'), $10, $11, now(),
                   CASE WHEN COALESCE($9, 'platform') = 'platform' THEN 'local' ELSE 'queued' END)
           ON CONFLICT (run_id, direction)
           WHERE run_id IS NOT NULL AND direction IN ('inbound', 'outbound')
           DO NOTHING
           RETURNING id`,
          [
            run.conversation_id,
            run.organization_id,
            participant!.rows[0]!.id,
            response.media.length ? "attachment" : "text",
            JSON.stringify(response),
            run.id,
            nextSequence!.rows[0]!.sequence_number,
            run.id,
            run.reply_channel_type ?? "platform",
            run.reply_binding_id ?? null,
            inboundRoute!.rows[0]?.external_conversation_id ?? null,
          ],
        );
        if (outbound.rows[0] && run.reply_channel_type && run.reply_channel_type !== "platform") {
          await client.query(
            `INSERT INTO delivery_attempts
              (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
             VALUES ($1, $2, $3, $4, 'queued', 1)
             ON CONFLICT (message_id, attempt_number) DO NOTHING`,
            [run.organization_id, run.conversation_id, outbound.rows[0].id, run.reply_channel_type],
          );
        }
        if (outbound.rows[0]) {
          await client.query(
            `UPDATE conversations
             SET updated_at = now(), last_message_at = now(), last_message_direction = 'outbound',
                 last_message_preview = LEFT($2, 500), message_count = message_count + 1
             WHERE id = $1`,
            [run.conversation_id, responseMessage || "Attachment"],
          );
          const outboundMessage = await client.query<{
            id: string;
            conversation_id: string;
            participant_id: string | null;
            direction: "inbound" | "outbound" | "system";
            message_type: string;
            provider: string | null;
            run_id: string | null;
            source_channel: string | null;
            occurred_at: string;
            delivery_status: string | null;
          }>("SELECT * FROM messages WHERE id = $1", [outbound.rows[0].id]);
          const context = await loadAgentConversationAnalyticsContext(client, run.organization_id, run.conversation_id);
          await enqueueAgentConversationMessage(client, context, outboundMessage.rows[0]!, "created");
        }
        if (replySuppressed) {
          await client.query(
            `INSERT INTO agent_events
              (organization_id, run_id, installation_id, event_type, payload, correlation_id)
             VALUES ($1, $2, $3, 'agent.reply.suppressed', $4::jsonb, $5)`,
            [
              run.organization_id,
              run.id,
              run.installation_id,
              JSON.stringify({ conversationId: run.conversation_id, reason: "conversation_handoff_active", handoffState: conversation.rows[0].handoff_state }),
              run.correlation_id,
            ],
          );
        }
      }
      const persistedOutput = replySuppressed
        ? { ...output, replySuppressed: true, replySuppressionReason: "conversation_handoff_active" }
        : output;
      const updated = await client.query<RunRecord>(
        `UPDATE agent_runs SET status = 'completed', output = $2::jsonb, finished_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, JSON.stringify(persistedOutput)],
      );
      await client.query(
        `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, 'run.completed', $4::jsonb, $5)`,
        [run.organization_id, runId, run.installation_id, JSON.stringify(persistedOutput), run.correlation_id],
      );
      await client.query(
        `UPDATE run_attempts SET status = 'completed', finished_at = now()
         WHERE run_id = $1 AND status = 'started'`,
        [runId],
      );
      await enqueueOutbox(client, buildCompletedAgentRunEvent({
        ...terminalAnalyticsInput(run, updated.rows[0]!.finished_at ?? new Date().toISOString()),
        output: persistedOutput,
      }));
      return updated.rows[0]!;
    });
  }

  public async pauseRun(
    runId: string,
    status: "awaiting_approval" | "awaiting_human" | "awaiting_external_event",
    output: Record<string, unknown>,
  ): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (run.status === status) return run;
      assertRunTransition(run.status, status);
      const updated = await client.query<RunRecord>(
        `UPDATE agent_runs SET status = $2, output = $3::jsonb, updated_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, status, JSON.stringify(output)],
      );
      await client.query(
        `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
        [run.organization_id, runId, run.installation_id, `run.${status}`, JSON.stringify(output), run.correlation_id],
      );
      return updated.rows[0]!;
    });
  }

  public async getRuntimeRun(organizationId: string, runId: string): Promise<RuntimeRunRecord | null> {
    const result = await query<RuntimeRunRecord>(
      this.pool,
      `SELECT ar.*, ad.name AS agent_name, ad.description AS agent_description, ad.slug AS agent_slug,
              ad.owner_type AS agent_owner_type, ad.protected AS agent_protected,
              ai.execution_mode, av.instructions, av.configuration, av.policy,
              ai.settings AS installation_settings, ai.status AS installation_status
       FROM agent_runs ar
       JOIN agent_definitions ad ON ad.id = ar.agent_definition_id
       JOIN agent_versions av ON av.id = ar.agent_version_id
       JOIN agent_installations ai ON ai.id = ar.installation_id
       WHERE ar.organization_id = $1 AND ar.id = $2`,
      [organizationId, runId],
    );
    return result.rows[0] ?? null;
  }

  public async getRuntimeRunById(runId: string): Promise<RuntimeRunRecord | null> {
    const result = await query<RuntimeRunRecord>(
      this.pool,
      `SELECT ar.*, ad.name AS agent_name, ad.description AS agent_description, ad.slug AS agent_slug,
              ad.owner_type AS agent_owner_type, ad.protected AS agent_protected,
              ai.execution_mode, av.instructions, av.configuration, av.policy,
              ai.settings AS installation_settings, ai.status AS installation_status
       FROM agent_runs ar
       JOIN agent_definitions ad ON ad.id = ar.agent_definition_id
       JOIN agent_versions av ON av.id = ar.agent_version_id
       JOIN agent_installations ai ON ai.id = ar.installation_id
       WHERE ar.id = $1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  public async getRunById(runId: string): Promise<RunRecord | null> {
    const result = await query<RunRecord>(
      this.pool,
      `SELECT * FROM agent_runs WHERE id = $1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  public async listActiveConversationRuns(organizationId: string, conversationId: string, limit = 10): Promise<ConversationRunSummary[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 20);
    const result = await query<ConversationRunSummary>(
      this.pool,
      `SELECT id, conversation_id, status, created_at, updated_at
       FROM agent_runs
       WHERE organization_id = $1 AND conversation_id = $2
         AND status IN ('received', 'queued', 'running', 'awaiting_approval', 'awaiting_human', 'awaiting_external_event')
       ORDER BY created_at DESC
       LIMIT $3`,
      [organizationId, conversationId, boundedLimit],
    );
    return result.rows;
  }

  public async failRun(runId: string, error: Record<string, unknown>): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>(
        `SELECT ar.*, ai.execution_mode, ad.creation_profile, ad.agent_audience
         FROM agent_runs ar
         JOIN agent_installations ai ON ai.id = ar.installation_id
         JOIN agent_definitions ad ON ad.id = ar.agent_definition_id
         WHERE ar.id = $1
         FOR UPDATE OF ar`,
        [runId],
      );
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (["failed", "completed", "cancelled", "expired"].includes(run.status)) return run;
      assertRunTransition(run.status, "failed");
      const userMessage = typeof error.userMessage === "string" ? error.userMessage.trim() : "";
      if (run.conversation_id && userMessage) {
        const participant = await client.query<{ id: string }>(
          `INSERT INTO participants
            (conversation_id, organization_id, participant_type, external_id, display_name)
           SELECT $1, $2, 'agent', $3, name
           FROM agent_definitions WHERE id = $4
           ON CONFLICT (conversation_id, participant_type, external_id)
           DO UPDATE SET display_name = EXCLUDED.display_name
           RETURNING id`,
          [run.conversation_id, run.organization_id, run.agent_definition_id, run.agent_definition_id],
        );
        const nextSequence = await client.query<{ sequence_number: string }>(
          `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
           FROM messages WHERE conversation_id = $1`,
          [run.conversation_id],
        );
        const inboundRoute = await client.query<{ external_conversation_id: string | null }>(
          `SELECT external_conversation_id FROM messages
           WHERE run_id = $1 AND direction = 'inbound' LIMIT 1`,
          [run.id],
        );
        const outbound = await client.query<{ id: string }>(
          `INSERT INTO messages
            (conversation_id, organization_id, participant_id, direction, message_type, content,
             provider, provider_message_id, sequence_number, run_id, source_channel,
             source_binding_id, external_conversation_id, occurred_at, delivery_status)
           VALUES ($1, $2, $3, 'outbound', 'text', $4::jsonb, COALESCE($8, 'platform'), $5, $6, $7,
                   COALESCE($8, 'platform'), $9, $10, now(),
                   CASE WHEN COALESCE($8, 'platform') = 'platform' THEN 'local' ELSE 'queued' END)
           ON CONFLICT (run_id, direction)
           WHERE run_id IS NOT NULL AND direction IN ('inbound', 'outbound')
           DO NOTHING
           RETURNING id`,
          [run.conversation_id, run.organization_id, participant.rows[0]!.id, JSON.stringify({ text: userMessage }), run.id, nextSequence.rows[0]!.sequence_number, run.id, run.reply_channel_type ?? "platform", run.reply_binding_id ?? null, inboundRoute.rows[0]?.external_conversation_id ?? null],
        );
        if (outbound.rows[0] && run.reply_channel_type && run.reply_channel_type !== "platform") {
          await client.query(
            `INSERT INTO delivery_attempts
              (organization_id, conversation_id, message_id, channel_type, status, attempt_number)
             VALUES ($1, $2, $3, $4, 'queued', 1)
             ON CONFLICT (message_id, attempt_number) DO NOTHING`,
            [run.organization_id, run.conversation_id, outbound.rows[0].id, run.reply_channel_type],
          );
        }
        if (outbound.rows[0]) {
          await client.query(
            `UPDATE conversations
             SET updated_at = now(), last_message_at = now(), last_message_direction = 'outbound',
                 last_message_preview = LEFT($2, 500), message_count = message_count + 1
             WHERE id = $1`,
            [run.conversation_id, userMessage],
          );
        }
      }
      const updated = await client.query<RunRecord>(
        `UPDATE agent_runs SET status = 'failed', error = $2::jsonb, finished_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, JSON.stringify(error)],
      );
      await client.query(
        `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, 'run.failed', $4::jsonb, $5)`,
        [run.organization_id, runId, run.installation_id, JSON.stringify(error), run.correlation_id],
      );
      await client.query(
        `UPDATE run_attempts SET status = 'failed', error = $2::jsonb, finished_at = now()
         WHERE run_id = $1 AND status = 'started'`,
        [runId, JSON.stringify(error)],
      );
      await enqueueOutbox(client, buildFailedAgentRunEvent({
        ...terminalAnalyticsInput(run, updated.rows[0]!.finished_at ?? new Date().toISOString()),
        error,
      }));
      return updated.rows[0]!;
    });
  }

  public async getRun(organizationId: string, runId: string): Promise<RunRecord | null> {
    const result = await query<RunRecord>(
      this.pool,
      "SELECT * FROM agent_runs WHERE organization_id = $1 AND id = $2",
      [organizationId, runId],
    );
    return result.rows[0] ?? null;
  }

  public async listInstallationRuns(organizationId: string, installationId: string, limit = 50): Promise<RunRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const result = await query<RunRecord>(
      this.pool,
      `SELECT * FROM agent_runs
       WHERE organization_id = $1 AND installation_id = $2
       ORDER BY created_at DESC LIMIT $3`,
      [organizationId, installationId, boundedLimit],
    );
    return result.rows;
  }

  /**
   * Lists external-client operations without treating them as conversations.
   * Capability calls are durable runs with no conversation_id; the projection
   * adds transport/tool/approval counters without exposing raw arguments.
   */
  public async listInstallationOperations(
    organizationId: string,
    installationId: string,
    limit = 50,
  ): Promise<InstallationOperationRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const result = await query<InstallationOperationRecord>(
      this.pool,
      `SELECT ar.*,
              COALESCE(ar.input->'mcpTool'->>'transport', 'unknown') AS transport,
              ar.input->'mcpTool'->>'name' AS tool_name,
              COALESCE(ti.tool_invocation_count, 0)::integer AS tool_invocation_count,
              COALESCE(mc.model_call_count, 0)::integer AS model_call_count,
              approval.approval_status
       FROM agent_runs ar
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS tool_invocation_count
         FROM tool_invocations ti
         WHERE ti.run_id = ar.id AND ti.organization_id = ar.organization_id
       ) ti ON true
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::integer AS model_call_count
         FROM model_calls mc
         WHERE mc.run_id = ar.id AND mc.organization_id = ar.organization_id
       ) mc ON true
       LEFT JOIN LATERAL (
         SELECT aar.status AS approval_status
         FROM agent_approval_records aar
         WHERE aar.run_id = ar.id AND aar.organization_id = ar.organization_id
         ORDER BY aar.created_at DESC
         LIMIT 1
       ) approval ON true
       WHERE ar.organization_id = $1 AND ar.installation_id = $2
         AND ar.conversation_id IS NULL
       ORDER BY ar.created_at DESC, ar.id DESC
       LIMIT $3`,
      [organizationId, installationId, boundedLimit],
    );
    return result.rows;
  }

  public async installationOperationSummary(organizationId: string, installationId: string): Promise<{
    total: number;
    byStatus: Record<string, number>;
    toolInvocations: number;
    modelCalls: number;
    estimatedCostUsd: string;
  }> {
    const [statuses, counts, cost] = await Promise.all([
      query<{ status: string; count: string }>(
        this.pool,
        `SELECT status, COUNT(*)::text AS count
         FROM agent_runs
         WHERE organization_id = $1 AND installation_id = $2 AND conversation_id IS NULL
         GROUP BY status ORDER BY status`,
        [organizationId, installationId],
      ),
      query<{ tool_invocations: string; model_calls: string }>(
        this.pool,
        `SELECT
           (SELECT COUNT(*)::text FROM tool_invocations ti JOIN agent_runs ar ON ar.id = ti.run_id
            WHERE ar.organization_id = $1 AND ar.installation_id = $2 AND ar.conversation_id IS NULL) AS tool_invocations,
           (SELECT COUNT(*)::text FROM model_calls mc JOIN agent_runs ar ON ar.id = mc.run_id
            WHERE ar.organization_id = $1 AND ar.installation_id = $2 AND ar.conversation_id IS NULL) AS model_calls`,
        [organizationId, installationId],
      ),
      query<{ total: string }>(
        this.pool,
        `SELECT COALESCE(SUM(mc.estimated_cost_usd), 0)::text AS total
         FROM model_calls mc JOIN agent_runs ar ON ar.id = mc.run_id
         WHERE ar.organization_id = $1 AND ar.installation_id = $2 AND ar.conversation_id IS NULL`,
        [organizationId, installationId],
      ),
    ]);
    const byStatus = Object.fromEntries(statuses.rows.map((row) => [row.status, Number(row.count)]));
    return {
      total: Object.values(byStatus).reduce((sum, count) => sum + count, 0),
      byStatus,
      toolInvocations: Number(counts.rows[0]?.tool_invocations ?? 0),
      modelCalls: Number(counts.rows[0]?.model_calls ?? 0),
      estimatedCostUsd: cost.rows[0]?.total ?? "0",
    };
  }

  public async listOrganizationRuns(organizationId: string, limit = 50): Promise<RunRecord[]> {
    const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
    const result = await query<RunRecord>(
      this.pool,
      `SELECT ar.*, ad.name AS agent_name, ad.slug AS agent_slug
       FROM agent_runs ar
       LEFT JOIN agent_definitions ad ON ad.id = ar.agent_definition_id
       WHERE ar.organization_id = $1
       ORDER BY ar.created_at DESC, ar.id DESC LIMIT $2`,
      [organizationId, boundedLimit],
    );
    return result.rows;
  }

  public async listEvents(organizationId: string, runId: string): Promise<Array<Record<string, unknown>>> {
    const result = await query(this.pool, "SELECT * FROM agent_events WHERE organization_id = $1 AND run_id = $2 ORDER BY sequence_number", [organizationId, runId]);
    return result.rows as Array<Record<string, unknown>>;
  }

  public async listEventsAfter(
    organizationId: string,
    runId: string,
    afterSequence = 0,
  ): Promise<Array<Record<string, unknown>>> {
    const result = await query(
      this.pool,
      `SELECT * FROM agent_events
       WHERE organization_id = $1 AND run_id = $2 AND sequence_number > $3
       ORDER BY sequence_number ASC LIMIT 200`,
      [organizationId, runId, afterSequence],
    );
    return result.rows as Array<Record<string, unknown>>;
  }

  public async appendEvent(input: {
    organizationId: string;
    runId: string;
    installationId: string;
    eventType: string;
    operationId?: string;
    payload: Record<string, unknown>;
  }): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const runResult = await client.query<Pick<RunRecord, "id" | "organization_id" | "agent_definition_id" | "agent_version_id" | "installation_id" | "conversation_id" | "created_by" | "correlation_id" | "causation_id">>(
        `SELECT id, organization_id, agent_definition_id, agent_version_id, installation_id,
                conversation_id, created_by, correlation_id, causation_id
         FROM agent_runs
         WHERE organization_id = $1 AND id = $2 AND installation_id = $3
         FOR UPDATE`,
        [input.organizationId, input.runId, input.installationId],
      );
      const run = runResult.rows[0];
      if (!run) return;
      const scope = executionScopeFromRun(run);
      const event = createScopedAgentEvent({
        scope,
        type: input.eventType,
        ...(input.operationId ? { operationId: input.operationId } : {}),
        data: input.payload,
      });
      await client.query(
        `INSERT INTO agent_events
          (organization_id, run_id, installation_id, event_type, payload, spec_version, source, subject, data_content_type, correlation_id)
         SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, agent_runs.correlation_id
         FROM agent_runs
         WHERE agent_runs.id = $2 AND agent_runs.organization_id = $1 AND agent_runs.installation_id = $3`,
        [input.organizationId, input.runId, input.installationId, input.eventType, JSON.stringify(event.data), event.specversion, event.source, event.subject, event.datacontenttype],
      );
      await this.appendJournalEventWithClient(client, {
        id: randomUUID(),
        scope: {
          ...scope,
          ...(input.operationId ? { operationId: input.operationId } : {}),
        },
        event: {
          kind: "runtime.fact",
          data: { type: input.eventType, payload: input.payload },
        },
        occurredAt: new Date().toISOString(),
      });
    });
  }

  /** Persist one canonical typed execution fact with a run-scoped cursor. */
  public async appendJournalEvent(input: PendingExecutionJournalEvent): Promise<PersistedExecutionJournalEvent> {
    return withTransaction(this.pool, (client) => this.appendJournalEventWithClient(client, input));
  }

  private async appendJournalEventWithClient(
    client: PoolClient,
    input: PendingExecutionJournalEvent,
  ): Promise<PersistedExecutionJournalEvent> {
    const run = await client.query<{ id: string }>(
        `SELECT id
         FROM agent_runs
         WHERE id = $1::uuid AND organization_id = $2 AND installation_id = $3::uuid
         FOR UPDATE`,
        [input.scope.runId, input.scope.organizationId, input.scope.installationId],
    );
    if (!run.rows[0]) throw new Error("EXECUTION_JOURNAL_SCOPE_CONFLICT");
    const next = await client.query<{ sequence_number: string }>(
        `SELECT COALESCE(MAX(sequence_number), 0) + 1 AS sequence_number
         FROM agent_execution_journal_events
         WHERE organization_id = $1 AND run_id = $2::uuid`,
        [input.scope.organizationId, input.scope.runId],
    );
    const sequence = Number(next.rows[0]?.sequence_number ?? 1);
    const inserted = await client.query<{ sequence_number: string; occurred_at: string }>(
        `INSERT INTO agent_execution_journal_events
          (id, organization_id, installation_id, run_id, operation_id, correlation_id,
           causation_id, sequence_number, event_kind, event, occurred_at)
         VALUES ($1::uuid, $2, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10::jsonb, $11::timestamptz)
         RETURNING sequence_number, occurred_at`,
        [
          input.id,
          input.scope.organizationId,
          input.scope.installationId,
          input.scope.runId,
          input.scope.operationId ?? null,
          input.scope.correlationId ?? null,
          input.scope.causationId ?? null,
          sequence,
          input.event.kind,
          JSON.stringify(input.event),
          input.occurredAt,
        ],
    );
    const persisted = inserted.rows[0];
    if (!persisted) throw new Error("EXECUTION_JOURNAL_INSERT_FAILED");
    return {
      ...input,
      sequence: Number(persisted.sequence_number),
      occurredAt: new Date(persisted.occurred_at).toISOString(),
    };
  }

  public async listJournalEvents(
    organizationId: string,
    runId: string,
    afterSequence = 0,
    limit = 200,
  ): Promise<ReadonlyArray<PersistedExecutionJournalEvent>> {
    const result = await query<{
      id: string;
      organization_id: string;
      installation_id: string;
      run_id: string;
      operation_id: string | null;
      correlation_id: string | null;
      causation_id: string | null;
      sequence_number: string | number;
      event: PersistedExecutionJournalEvent["event"];
      occurred_at: string;
    }>(
      this.pool,
      `SELECT id, organization_id, installation_id, run_id, operation_id,
              correlation_id, causation_id, sequence_number, event, occurred_at
       FROM agent_execution_journal_events
       WHERE organization_id = $1 AND run_id = $2::uuid
         AND sequence_number > $3
       ORDER BY sequence_number ASC LIMIT $4`,
      [organizationId, runId, afterSequence, Math.min(Math.max(Math.trunc(limit), 1), 200)],
    );
    return result.rows.map((row) => ({
      id: row.id,
      sequence: Number(row.sequence_number),
      occurredAt: new Date(row.occurred_at).toISOString(),
      scope: {
        organizationId: row.organization_id,
        installationId: row.installation_id,
        runId: row.run_id,
        ...(row.operation_id ? { operationId: row.operation_id } : {}),
        ...(row.correlation_id ? { correlationId: row.correlation_id } : {}),
        ...(row.causation_id ? { causationId: row.causation_id } : {}),
      },
      event: row.event,
    }));
  }

  public async operationalSummary(organizationId: string): Promise<{
    runsByStatus: Array<{ status: string; count: number }>;
    oldestQueuedAt: string | null;
  }> {
    const statuses = await query<{ status: string; count: string }>(
      this.pool,
      `SELECT status, COUNT(*)::text AS count FROM agent_runs
       WHERE organization_id = $1 GROUP BY status ORDER BY status`,
      [organizationId],
    );
    const oldest = await query<{ oldest_queued_at: string | null }>(
      this.pool,
      `SELECT MIN(created_at) AT TIME ZONE 'UTC' AS oldest_queued_at
       FROM agent_runs WHERE organization_id = $1 AND status = 'queued'`,
      [organizationId],
    );
    return {
      runsByStatus: statuses.rows.map((row) => ({ status: row.status, count: Number(row.count) })),
      oldestQueuedAt: oldest.rows[0]?.oldest_queued_at ?? null,
    };
  }
}

function terminalAnalyticsInput(run: RunRecord, finishedAt: Date | string): AgentRunTerminalInput {
  return {
    runId: run.id,
    organizationId: run.organization_id,
    agentDefinitionId: run.agent_definition_id,
    agentVersionId: run.agent_version_id,
    installationId: run.installation_id,
    conversationId: run.conversation_id,
    triggerType: run.trigger_type,
    executionMode: run.execution_mode ?? "kasitek_hosted",
    creationProfile: run.creation_profile ?? "custom",
    agentAudience: run.agent_audience ?? "personal",
    input: run.input,
    correlationId: run.correlation_id,
    causationId: run.causation_id,
    createdAt: run.created_at,
    startedAt: run.started_at,
    finishedAt,
  };
}
