import type { Pool } from "pg";
import { query } from "../pool";
import type { EvaluationAssertion } from "../../evaluations/deterministic";

export interface EvaluationScenarioRecord {
  id: string;
  organization_id: string;
  agent_definition_id: string | null;
  name: string;
  description: string | null;
  input: Record<string, unknown>;
  assertions: EvaluationAssertion[];
  rubric: Record<string, unknown>;
  tags: string[];
  status: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface EvaluationRunRecord {
  id: string;
  organization_id: string;
  scenario_id: string;
  agent_version_id: string | null;
  run_id: string | null;
  status: string;
  evaluator_version: string;
  result: Record<string, unknown>;
  started_at: string;
  finished_at: string | null;
  created_by: string;
}

export class EvaluationRepository {
  public constructor(private readonly pool: Pool) {}

  public async createScenario(input: {
    organizationId: string;
    actorId: string;
    agentDefinitionId?: string;
    name: string;
    description?: string;
    scenarioInput: Record<string, unknown>;
    assertions: EvaluationAssertion[];
    rubric?: Record<string, unknown>;
    tags?: string[];
  }): Promise<EvaluationScenarioRecord> {
    const result = await query<EvaluationScenarioRecord>(
      this.pool,
      `INSERT INTO evaluation_scenarios
        (organization_id, agent_definition_id, name, description, input, assertions, rubric, tags, created_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9)
       RETURNING *`,
      [input.organizationId, input.agentDefinitionId ?? null, input.name, input.description ?? null, JSON.stringify(input.scenarioInput), JSON.stringify(input.assertions), JSON.stringify(input.rubric ?? {}), input.tags ?? [], input.actorId],
    );
    return result.rows[0]!;
  }

  public async listScenarios(organizationId: string): Promise<EvaluationScenarioRecord[]> {
    const result = await query<EvaluationScenarioRecord>(this.pool, "SELECT * FROM evaluation_scenarios WHERE organization_id = $1 AND status = 'active' ORDER BY created_at DESC", [organizationId]);
    return result.rows;
  }

  public async getScenario(organizationId: string, scenarioId: string): Promise<EvaluationScenarioRecord | null> {
    const result = await query<EvaluationScenarioRecord>(this.pool, "SELECT * FROM evaluation_scenarios WHERE organization_id = $1 AND id = $2 AND status = 'active'", [organizationId, scenarioId]);
    return result.rows[0] ?? null;
  }

  public async recordRun(input: {
    organizationId: string;
    scenarioId: string;
    agentVersionId?: string;
    runId?: string;
    status: "pending" | "running" | "passed" | "failed" | "error";
    evaluatorVersion: string;
    result: Record<string, unknown>;
    actorId: string;
  }): Promise<EvaluationRunRecord> {
    const result = await query<EvaluationRunRecord>(
      this.pool,
      `INSERT INTO evaluation_runs
        (organization_id, scenario_id, agent_version_id, run_id, status, evaluator_version, result, finished_at, created_by)
       SELECT $1, es.id, $3, $4, $5, $6, $7::jsonb, now(), $8
       FROM evaluation_scenarios es WHERE es.id = $2 AND es.organization_id = $1 AND es.status = 'active'
       RETURNING *`,
      [input.organizationId, input.scenarioId, input.agentVersionId ?? null, input.runId ?? null, input.status, input.evaluatorVersion, JSON.stringify(input.result), input.actorId],
    );
    if (!result.rows[0]) throw new Error("Evaluation scenario not found");
    return result.rows[0];
  }

  public async listRuns(organizationId: string, scenarioId?: string): Promise<EvaluationRunRecord[]> {
    const result = await query<EvaluationRunRecord>(
      this.pool,
      `SELECT * FROM evaluation_runs WHERE organization_id = $1 AND ($2::uuid IS NULL OR scenario_id = $2) ORDER BY started_at DESC`,
      [organizationId, scenarioId ?? null],
    );
    return result.rows;
  }
}
