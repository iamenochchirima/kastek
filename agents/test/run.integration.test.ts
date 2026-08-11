import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunRepository } from "../src/db/repositories/run-repository";
import { RunStepRepository } from "../src/db/repositories/run-step-repository";
import { WorkflowStateRepository } from "../src/db/repositories/workflow-state-repository";
import { ModelCallRepository } from "../src/db/repositories/model-call-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("durable run invariants (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const runs = new RunRepository(pool);
  const steps = new RunStepRepository(pool);
  const workflowState = new WorkflowStateRepository(pool);
  const modelCalls = new ModelCallRepository(pool);
  const organizationId = `run-test-${randomUUID()}`;
  const agentId = randomUUID();
  const versionId = randomUUID();
  const installationId = randomUUID();
  let runId = "";

  beforeAll(async () => {
    await pool.query("INSERT INTO agent_definitions (id, organization_id, name, slug, created_by) VALUES ($1, $2, 'Run test', $3, 'test')", [agentId, organizationId, `run-${agentId}`]);
    await pool.query("INSERT INTO agent_versions (id, agent_definition_id, version_number, instructions, checksum, created_by, status) VALUES ($1, $2, 1, 'test', 'test', 'test', 'published')", [versionId, agentId]);
    await pool.query("INSERT INTO agent_installations (id, agent_definition_id, agent_version_id, organization_id, scope_type, scope_id, created_by) VALUES ($1, $2, $3, $4, 'organization', $4, 'test')", [installationId, agentId, versionId, organizationId]);
  });

  it("deduplicates an idempotent start and persists ordered steps", async () => {
    const first = await runs.createRun(organizationId, "test-user", { installationId, idempotencyKey: "same-request", input: { message: "hello" }, triggerType: "manual" });
    runId = first.id;
    const second = await runs.createRun(organizationId, "test-user", { installationId, idempotencyKey: "same-request", input: { message: "different retry payload" }, triggerType: "manual" });
    expect(second.id).toBe(first.id);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const context = await steps.startStep({ runId, organizationId, stepType: "context", input: { test: true } });
    const model = await steps.startStep({ runId, organizationId, stepType: "model" });
    expect(model.sequence_number).toBe(context.sequence_number + 1);
    await steps.finishStep({ stepId: context.id, status: "completed", output: { ok: true } });
    expect((await steps.listSteps(organizationId, runId)).map((step) => step.status)).toEqual(["completed", "started"]);
    const initialState = await workflowState.get(organizationId, runId);
    expect(initialState).toMatchObject({ revision: 0, state: {} });
    const updatedState = await workflowState.put({ organizationId, runId, expectedRevision: 0, state: { node: "model", attempt: 1 } });
    expect(updatedState).toMatchObject({ revision: 1, state: { node: "model", attempt: 1 } });
    await expect(workflowState.put({ organizationId, runId, expectedRevision: 0, state: { node: "stale" } })).rejects.toThrow("revision conflict");
    await pool.query("INSERT INTO model_calls (organization_id, run_id, provider, model, funding_source, total_tokens, estimated_cost_usd, status) VALUES ($1, $2, 'openai', 'test', 'kasitek', 10, 0.25, 'completed')", [organizationId, runId]);
    await expect(modelCalls.assertRunBudget({ organizationId, runId, maxRequests: 1 })).rejects.toThrow("REQUEST_BUDGET");
  });

  afterAll(async () => {
    await pool.query("DELETE FROM run_steps WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_workflow_state WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM model_calls WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM run_attempts WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_events WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_runs WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_installations WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_versions WHERE agent_definition_id = $1", [agentId]);
    await pool.query("DELETE FROM agent_definitions WHERE id = $1", [agentId]);
    await pool.end();
  });
});
