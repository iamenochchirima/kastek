import type { Pool } from "pg";
import { query, withTransaction } from "../pool";
import { assertRunTransition, type RunStatus, type StartRunInput } from "../../domain/types";
import { createAgentEvent } from "../../events/envelope";

export interface RunRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string;
  agent_version_id: string;
  installation_id: string;
  conversation_id: string | null;
  trigger_type: string;
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
  reply_channel_type?: string | null;
  reply_binding_id?: string | null;
  created?: boolean;
}

export interface RuntimeRunRecord extends RunRecord {
  instructions: string;
  configuration: Record<string, unknown>;
  policy: Record<string, unknown>;
  installation_settings: Record<string, unknown>;
}

export class RunRepository {
  public constructor(private readonly pool: Pool) {}

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
        if (existing.rows[0]) return { ...existing.rows[0], created: false };
      }
      const installation = await client.query<{
        agent_definition_id: string;
        agent_version_id: string;
        status: string;
      }>(
        `SELECT agent_definition_id, agent_version_id, status
         FROM agent_installations
         WHERE id = $1 AND organization_id = $2`,
        [input.installationId, organizationId],
      );
      const target = installation.rows[0];
      if (!target || target.status !== "active") throw new Error("Active installation not found");
      const created = await client.query<RunRecord>(
        `INSERT INTO agent_runs
          (organization_id, agent_definition_id, agent_version_id, installation_id,
           conversation_id, trigger_type, status, input, correlation_id, created_by, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, 'received', $7::jsonb, gen_random_uuid(), $8, $9)
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
        ],
      );
      const run = created.rows[0] ?? (input.idempotencyKey
        ? (await client.query<RunRecord>(
          `SELECT * FROM agent_runs WHERE organization_id = $1 AND idempotency_key = $2 LIMIT 1`,
          [organizationId, input.idempotencyKey],
        )).rows[0]
        : undefined);
      if (!run) throw new Error("Run could not be created");
      if (created.rows.length === 0) return { ...run, created: false };
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
      return { ...run, created: true };
    });
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
      }
      return updated.rows[0]!;
    });
  }

  public async completeRun(runId: string, output: Record<string, unknown>): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (run.status === "completed") return run;
      assertRunTransition(run.status, "completed");
      const responseMessage = typeof output.message === "string" ? output.message.trim() : "";
      if (run.conversation_id) {
        if (!responseMessage) throw new Error("Conversation run cannot complete without an assistant message");
        const conversation = await client.query<{ id: string; status: string }>(
          `SELECT id, status FROM conversations
           WHERE id = $1 AND organization_id = $2
           FOR UPDATE`,
          [run.conversation_id, run.organization_id],
        );
        if (!conversation.rows[0] || conversation.rows[0].status !== "active") {
          throw new Error("Active conversation not found");
        }
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
        const outbound = await client.query<{ id: string }>(
          `INSERT INTO messages
            (conversation_id, organization_id, participant_id, direction, message_type, content,
             provider, provider_message_id, sequence_number, run_id, source_channel,
             source_binding_id, occurred_at, delivery_status)
           VALUES ($1, $2, $3, 'outbound', 'text', $4::jsonb, COALESCE($8, 'platform'), $5, $6, $7,
                   COALESCE($8, 'platform'), $9, now(),
                   CASE WHEN COALESCE($8, 'platform') = 'platform' THEN 'local' ELSE 'queued' END)
           ON CONFLICT (run_id, direction)
           WHERE run_id IS NOT NULL AND direction IN ('inbound', 'outbound')
           DO NOTHING
           RETURNING id`,
          [
            run.conversation_id,
            run.organization_id,
            participant.rows[0]!.id,
            JSON.stringify({ text: responseMessage }),
            run.id,
            nextSequence.rows[0]!.sequence_number,
            run.id,
            run.reply_channel_type ?? "platform",
            run.reply_binding_id ?? null,
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
        await client.query("UPDATE conversations SET updated_at = now() WHERE id = $1", [run.conversation_id]);
      }
      const updated = await client.query<RunRecord>(
        `UPDATE agent_runs SET status = 'completed', output = $2::jsonb, finished_at = now(), updated_at = now()
         WHERE id = $1 RETURNING *`,
        [runId, JSON.stringify(output)],
      );
      await client.query(
        `INSERT INTO agent_events (organization_id, run_id, installation_id, event_type, payload, correlation_id)
         VALUES ($1, $2, $3, 'run.completed', $4::jsonb, $5)`,
        [run.organization_id, runId, run.installation_id, JSON.stringify(output), run.correlation_id],
      );
      await client.query(
        `UPDATE run_attempts SET status = 'completed', finished_at = now()
         WHERE run_id = $1 AND status = 'started'`,
        [runId],
      );
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
      `SELECT ar.*, av.instructions, av.configuration, av.policy, ai.settings AS installation_settings
       FROM agent_runs ar
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
      `SELECT ar.*, av.instructions, av.configuration, av.policy, ai.settings AS installation_settings
       FROM agent_runs ar
       JOIN agent_versions av ON av.id = ar.agent_version_id
       JOIN agent_installations ai ON ai.id = ar.installation_id
       WHERE ar.id = $1`,
      [runId],
    );
    return result.rows[0] ?? null;
  }

  public async failRun(runId: string, error: Record<string, unknown>): Promise<RunRecord> {
    return withTransaction(this.pool, async (client) => {
      const current = await client.query<RunRecord>("SELECT * FROM agent_runs WHERE id = $1 FOR UPDATE", [runId]);
      const run = current.rows[0];
      if (!run) throw new Error("Run not found");
      if (["failed", "completed", "cancelled", "expired"].includes(run.status)) return run;
      assertRunTransition(run.status, "failed");
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
    payload: Record<string, unknown>;
  }): Promise<void> {
    const event = createAgentEvent({ type: input.eventType, subject: `run:${input.runId}`, data: input.payload });
    await query(
      this.pool,
      `INSERT INTO agent_events
        (organization_id, run_id, installation_id, event_type, payload, spec_version, source, subject, data_content_type, correlation_id)
       SELECT $1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, agent_runs.correlation_id
       FROM agent_runs
       WHERE agent_runs.id = $2 AND agent_runs.organization_id = $1`,
      [input.organizationId, input.runId, input.installationId, input.eventType, JSON.stringify(event.data), event.specversion, event.source, event.subject, event.datacontenttype],
    );
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
