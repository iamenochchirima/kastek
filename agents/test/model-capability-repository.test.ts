import { describe, expect, it, vi } from "vitest";
import { ModelCapabilityRepository } from "../src/db/repositories/model-capability-repository";
import type { ContextCapabilityRecord } from "../src/runtime/context-capability";

const organizationId = "org-capability-repository";

const record: ContextCapabilityRecord = {
  organizationId,
  provider: "openai",
  model: "gpt-test",
  endpointId: "https://api.example.test/v1",
  credentialRouteId: "byok-route-1",
  runtimeEnvironment: "playground",
  contextWindowTokens: 64_000,
  // Hermes keeps the context window and output cap as separate facts. The
  // planner will reserve only the requested output that can fit this window.
  maxOutputTokens: 128_000,
  source: "provider_metadata",
  resolvedAt: "2026-09-07T10:00:00.000Z",
  expiresAt: "2026-09-07T11:00:00.000Z",
};

function databaseRow(input: ContextCapabilityRecord): Record<string, unknown> {
  return {
    organization_id: input.organizationId,
    provider: input.provider,
    model: input.model,
    endpoint_id: input.endpointId,
    credential_route_id: input.credentialRouteId,
    runtime_environment: input.runtimeEnvironment,
    context_window_tokens: input.contextWindowTokens,
    max_output_tokens: input.maxOutputTokens,
    source: input.source,
    resolved_at: input.resolvedAt,
    expires_at: input.expiresAt,
  };
}

describe("ModelCapabilityRepository", () => {
  it("round-trips the complete route identity needed after a worker restart", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [databaseRow(record)] }) };
    const repository = new ModelCapabilityRepository(pool as never);

    await expect(repository.get({
      organizationId,
      provider: record.provider,
      model: record.model,
      endpointId: record.endpointId,
      credentialRouteId: record.credentialRouteId!,
      runtimeEnvironment: record.runtimeEnvironment!,
    })).resolves.toEqual(record);

    const [sql, values] = pool.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain("credential_route_id, runtime_environment");
    expect(values).toEqual([
      organizationId,
      record.provider,
      record.model,
      record.endpointId,
      record.credentialRouteId,
      record.runtimeEnvironment,
    ]);
  });

  it("persists normalized expiry and route values without dropping independent output limits", async () => {
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    const repository = new ModelCapabilityRepository(pool as never);

    await repository.upsert({
      ...record,
      endpointId: ` ${record.endpointId} `,
      credentialRouteId: ` ${record.credentialRouteId} `,
      runtimeEnvironment: ` ${record.runtimeEnvironment} `,
      resolvedAt: "2026-09-07T12:00:00+02:00",
      expiresAt: "2026-09-07T13:00:00+02:00",
    });

    const insertValues = clientQuery.mock.calls[1]?.[1] as unknown[];
    expect(insertValues).toEqual([
      organizationId,
      record.provider,
      record.model,
      record.endpointId,
      record.credentialRouteId,
      record.runtimeEnvironment,
      record.contextWindowTokens,
      record.maxOutputTokens,
      record.source,
      "2026-09-07T10:00:00.000Z",
      "2026-09-07T11:00:00.000Z",
    ]);
    expect(clientQuery.mock.calls[1]?.[0]).toContain("ON CONFLICT (organization_id, provider, model, endpoint_id, credential_route_id, runtime_environment)");
  });

  it("fails closed for corrupt persisted rows and rejects invalid expiry before opening a transaction", async () => {
    const getPool = { query: vi.fn().mockResolvedValue({ rows: [{ ...databaseRow(record), expires_at: "not-a-date" }] }) };
    const repository = new ModelCapabilityRepository(getPool as never);
    await expect(repository.get({
      organizationId,
      provider: record.provider,
      model: record.model,
      endpointId: record.endpointId,
      credentialRouteId: record.credentialRouteId!,
      runtimeEnvironment: record.runtimeEnvironment!,
    })).resolves.toBeUndefined();

    const connect = vi.fn();
    const invalidRepository = new ModelCapabilityRepository({ connect } as never);
    await expect(invalidRepository.upsert({
      ...record,
      expiresAt: "2026-09-07T09:59:59.000Z",
    })).rejects.toThrow("MODEL_CAPABILITY_EXPIRY_ORDER_INVALID");
    expect(connect).not.toHaveBeenCalled();
  });
});
