import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { cancellationSignal } from "@temporalio/activity";
import { Client } from "@temporalio/client";
import { NativeConnection, Worker } from "@temporalio/worker";
import { afterEach, describe, expect, it } from "vitest";
import { ContextCompactionRepository } from "../src/db/repositories/context-compaction-repository";
import { compactDurableContext, type DurableContextAdapter } from "../src/runtime/context-compaction";
import type {
  ContextCompactionPausePoint,
  ContextCompactionWorkflowInput,
  ContextCompactionWorkflowResult,
} from "./fixtures/context-compaction-workflow";
import { contextCompactionReplayWorkflow } from "./fixtures/context-compaction-workflow";

const temporalAddress = process.env.TEMPORAL_TEST_ADDRESS;
const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(
  temporalAddress
  && databaseUrl
  && process.env.RUN_TEMPORAL_INTEGRATION_TESTS === "true"
  && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true",
);

describe.skipIf(!runIntegration)("Temporal context compaction recovery (integration)", () => {
  const workers: Worker[] = [];
  const runs: Promise<void>[] = [];
  const connections: NativeConnection[] = [];

  afterEach(async () => {
    for (const worker of workers.splice(0)) {
      if (worker.getState() === "INITIALIZED" || worker.getState() === "RUNNING") worker.shutdown();
    }
    await Promise.all(runs.splice(0));
    for (const connection of connections.splice(0)) await connection.close();
  });

  it.each<ContextCompactionPausePoint>(["before_persist", "after_persist"])("replays safely when the worker is lost %s", async (pausePoint) => {
    const organizationId = `temporal-context-${randomUUID()}`;
    const contextId = `context-${randomUUID()}`;
    const operationId = `${contextId}:operation:1`;
    const taskQueue = `context-compaction-${pausePoint}-${randomUUID()}`;
    const workflowId = `context-compaction-${randomUUID()}`;
    const pool = new Pool({ connectionString: databaseUrl });
    let resolvePhase: (() => void) | undefined;
    const phaseReached = new Promise<void>((resolve) => { resolvePhase = resolve; });
    const executions: number[] = [];
    let firstWorker: Worker | undefined;

    const pauseAfterPhase = async (execution: number, point: ContextCompactionPausePoint): Promise<void> => {
      if (execution !== 1 || point !== pausePoint) return;
      resolvePhase?.();
      const signal = cancellationSignal();
      await new Promise<void>((_resolve, reject) => {
        if (signal.aborted) {
          reject(new Error("worker lost"));
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("worker lost")), { once: true });
      });
    };

    const executeContextCompaction = async (input: ContextCompactionWorkflowInput): Promise<ContextCompactionWorkflowResult> => {
      const execution = executions.push(executions.length + 1);
      const repository = new ContextCompactionRepository(pool, input.organizationId);
      const adapter: DurableContextAdapter = {
        read: (operation) => repository.read(operation),
        readLatest: (context) => repository.readLatest(context),
        persist: async (persistence) => {
          await pauseAfterPhase(execution, "before_persist");
          const result = await repository.persist(persistence);
          await pauseAfterPhase(execution, "after_persist");
          return result;
        },
      };
      const result = await compactDurableContext({
        operationId: input.operationId,
        contextId: input.contextId,
        revision: 1,
        messages: [
          { role: "system", content: "runtime policy" },
          { role: "user", content: "older durable evidence" },
          { role: "assistant", content: "older answer" },
          { role: "user", content: "current task" },
        ],
        policy: { maxRetainedMessageUnits: 1 },
        adapter,
      });
      return { generation: result.diagnostics.generation, replayed: result.diagnostics.replayed, projectionDigest: result.diagnostics.projectionDigest };
    };

    const activities = { executeContextCompaction };
    const startWorker = async (): Promise<Worker> => {
      const worker = await Worker.create({
        connection: await NativeConnection.connect({ address: temporalAddress! }).then((connection) => {
          connections.push(connection);
          return connection;
        }),
        namespace: "default",
        taskQueue,
        workflowsPath: new URL("./fixtures/context-compaction-workflow.ts", import.meta.url).pathname,
        activities,
      });
      workers.push(worker);
      runs.push(worker.run());
      return worker;
    };

    try {
      firstWorker = await startWorker();
      const client = new Client({ connection: connections[0], namespace: "default" });
      const handle = await client.workflow.start(contextCompactionReplayWorkflow, {
        taskQueue,
        workflowId,
        args: [{ organizationId, contextId, operationId, pausePoint }],
      });

      await Promise.race([
        phaseReached,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`compaction did not reach ${pausePoint}`)), 15_000)),
      ]);
      firstWorker.shutdown();
      const workerIndex = workers.indexOf(firstWorker);
      if (workerIndex >= 0) workers.splice(workerIndex, 1);
      firstWorker = undefined;
      await startWorker();
      const result = await handle.result();

      expect(executions.length).toBeGreaterThanOrEqual(2);
      expect(result.replayed).toBe(pausePoint === "after_persist");
      expect(result.generation).toBe(1);
      expect(result.projectionDigest).toMatch(/^[a-f0-9]{64}$/);
      const persistedProjection = await pool.query<{ projection_digest: string | null }>(
        "SELECT compaction->>'projectionDigest' AS projection_digest FROM agent_context_compaction_revisions WHERE organization_id = $1 AND operation_id = $2",
        [organizationId, operationId],
      );
      expect(persistedProjection.rows[0]?.projection_digest).toBe(result.projectionDigest);
      expect((await pool.query("SELECT count(*)::int AS count FROM agent_context_compaction_revisions WHERE organization_id = $1 AND operation_id = $2", [organizationId, operationId])).rows[0]?.count).toBe(1);
    } finally {
      await pool.query("DELETE FROM agent_context_compaction_revisions WHERE organization_id = $1", [organizationId]);
      await pool.end();
    }
  }, 60_000);
});
