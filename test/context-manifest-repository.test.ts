import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ContextManifestRepository, type ContextManifestRecord } from "../src/db/repositories/context-manifest-repository";

const organizationId = "org-context-manifest";
const digest = (value: string) => value.repeat(64).slice(0, 64);

function input(overrides: Partial<Parameters<ContextManifestRepository["record"]>[0]> = {}) {
  return {
    requestManifestId: "manifest-1",
    runId: "run-1",
    turnId: "turn-1",
    modelAttemptId: "attempt-1",
    sourceCursor: 42,
    sourceGeneration: 3,
    sourceProjectionDigest: digest("d"),
    sourceBoundaryDigest: digest("a"),
    sourceDigest: digest("b"),
    manifestDigest: digest("c"),
    sourceMessageCount: 8,
    selectedMessageCount: 5,
    sourceToolCount: 4,
    selectedToolCount: 2,
    estimatedInputTokens: 1_200,
    reservedOutputTokens: 800,
    safetyMarginTokens: 256,
    providerContextWindowTokens: 8_192,
    inputBudgetTokens: 7_136,
    softThresholdTokens: 5_700,
    hardLimitTokens: 7_136,
    estimatedRequestBytes: 12_400,
    components: [
      { kind: "system" as const, selectedCount: 1, estimatedTokens: 100, estimatedBytes: 400 },
      { kind: "history" as const, selectedCount: 3, estimatedTokens: 700, estimatedBytes: 7_000 },
      { kind: "current_message" as const, selectedCount: 1, estimatedTokens: 100, estimatedBytes: 400 },
      { kind: "tool_results" as const, selectedCount: 0, estimatedTokens: 0, estimatedBytes: 0 },
      { kind: "tool_schemas" as const, selectedCount: 2, estimatedTokens: 300, estimatedBytes: 4_600 },
    ],
    fitDecision: "ready" as const,
    status: "fits" as const,
    ...overrides,
  };
}

function row(overrides: Partial<ContextManifestRecord> = {}): ContextManifestRecord {
  return {
    organizationId,
    ...input(),
    schemaVersion: "v1",
    compactionGeneration: 0,
    components: input().components,
    createdAt: "2026-09-07T00:00:00.000Z",
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

function transactionalPool(responses: Array<{ rows?: unknown[]; rowCount?: number }>) {
  const clientQuery = vi.fn(async (sql: string) => {
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    return responses.shift() ?? { rows: [], rowCount: 0 };
  });
  const client = { query: clientQuery, release: vi.fn() };
  const pool = { connect: vi.fn(async () => client), query: vi.fn() };
  return { pool, clientQuery };
}

function databaseRow(record: ContextManifestRecord): Record<string, unknown> {
  return {
    organization_id: record.organizationId,
    request_manifest_id: record.requestManifestId,
    run_id: record.runId,
    turn_id: record.turnId,
    model_attempt_id: record.modelAttemptId ?? null,
    provider_request_id: record.providerRequestId ?? null,
    schema_version: record.schemaVersion,
    compaction_generation: record.compactionGeneration,
    source_cursor: record.sourceCursor ?? null,
    source_generation: record.sourceGeneration ?? null,
    source_projection_digest: record.sourceProjectionDigest ?? null,
    source_boundary_digest: record.sourceBoundaryDigest,
    source_digest: record.sourceDigest,
    manifest_digest: record.manifestDigest,
    source_message_count: record.sourceMessageCount,
    selected_message_count: record.selectedMessageCount,
    source_tool_count: record.sourceToolCount,
    selected_tool_count: record.selectedToolCount,
    estimated_input_tokens: record.estimatedInputTokens,
    reserved_output_tokens: record.reservedOutputTokens,
    safety_margin_tokens: record.safetyMarginTokens,
    provider_context_window_tokens: record.providerContextWindowTokens,
    input_budget_tokens: record.inputBudgetTokens,
    soft_threshold_tokens: record.softThresholdTokens,
    hard_limit_tokens: record.hardLimitTokens,
    estimated_request_bytes: record.estimatedRequestBytes,
    component_accounting: record.components,
    fit_decision: record.fitDecision,
    status: record.status,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
  };
}

describe("ContextManifestRepository", () => {
  it("stores only bounded accounting fields and sanitizes component properties", async () => {
    const expected = row();
    const { pool, clientQuery } = transactionalPool([{ rows: [databaseRow(expected)] }]);
    const repository = new ContextManifestRepository(pool as never, organizationId);
    const unsafeComponents = input().components.map((component, index) => ({
      ...component,
      content: index === 0 ? "secret prompt" : "tool output",
      schema: { credential: "secret" },
    }));

    const result = await repository.record(input({ components: unsafeComponents as never }));
    const insertValues = clientQuery.mock.calls[1]?.[1] as unknown[];

    expect(result).toEqual({ status: "created", manifest: expected });
    expect(clientQuery.mock.calls[1]?.[0]).toContain("agent_context_request_manifests");
    expect(insertValues?.[8]).toBe(42);
    expect(insertValues?.[9]).toBe(3);
    expect(insertValues?.[26]).toBe(JSON.stringify(expected.components));
    expect(String(insertValues?.[26])).not.toContain("secret prompt");
    expect(String(insertValues?.[26])).not.toContain("credential");
  });

  it("replays the same manifest id only when its digest is unchanged", async () => {
    const expected = row();
    const { pool, clientQuery } = transactionalPool([{ rows: [] }, { rows: [databaseRow(expected)] }]);
    const repository = new ContextManifestRepository(pool as never, organizationId);

    await expect(repository.record(input())).resolves.toEqual({ status: "replayed", manifest: expected });
    expect(clientQuery.mock.calls[2]?.[0]).toContain("FOR UPDATE");

    const conflictPool = transactionalPool([{ rows: [] }, { rows: [databaseRow(expected)] }]);
    const conflictRepository = new ContextManifestRepository(conflictPool.pool as never, organizationId);
    await expect(conflictRepository.record(input({ manifestDigest: digest("d") })))
      .rejects.toThrow("CONTEXT_MANIFEST_DIGEST_CONFLICT");
  });

  it("reads a tenant-scoped manifest and bounds run listings", async () => {
    const expected = row();
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [databaseRow(expected)] })
        .mockResolvedValueOnce({ rows: [databaseRow(expected)] }),
    };
    const repository = new ContextManifestRepository(pool as never, organizationId);

    await expect(repository.get(expected.requestManifestId)).resolves.toEqual(expected);
    await expect(repository.listForRun(expected.runId, 10_000)).resolves.toEqual([expected]);
    expect(pool.query.mock.calls[0]?.[1]).toEqual([organizationId, expected.requestManifestId]);
    expect(pool.query.mock.calls[1]?.[1]).toEqual([organizationId, expected.runId, 1_000]);
  });

  it("rejects invalid digests and non-bounded component accounting before opening a transaction", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const repository = new ContextManifestRepository(pool as never, organizationId);

    await expect(repository.record(input({ manifestDigest: "not-a-sha256" }))).rejects.toThrow("CONTEXT_MANIFEST_DIGEST_INVALID");
    await expect(repository.record(input({ components: input().components.slice(0, 4) }))).rejects.toThrow("CONTEXT_MANIFEST_COMPONENTS_INVALID");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("requires canonical transcript cursor and generation to be supplied together", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const repository = new ContextManifestRepository(pool as never, organizationId);

    await expect(repository.record(input({ sourceGeneration: undefined })))
      .rejects.toThrow("CONTEXT_MANIFEST_SOURCE_IDENTITY_INVALID");
    await expect(repository.record(input({ sourceCursor: undefined })))
      .rejects.toThrow("CONTEXT_MANIFEST_SOURCE_IDENTITY_INVALID");
    await expect(repository.record(input({ sourceProjectionDigest: undefined })))
      .rejects.toThrow("CONTEXT_MANIFEST_SOURCE_IDENTITY_INVALID");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("defines a tenant-protected bounded read model without content columns", async () => {
    const migration = await readFile(new URL("../migrations/145_context_request_manifests.sql", import.meta.url), "utf8");

    expect(migration).toContain("CREATE TABLE IF NOT EXISTS agent_context_request_manifests");
    expect(migration).toContain("UNIQUE (organization_id, request_manifest_id)");
    expect(migration).toContain("octet_length(component_accounting::text) <= 4096");
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    const ddl = migration.replace(/^\s*--.*$/gm, "");
    expect(ddl).not.toMatch(/prompt|tool_output|credential|tool_schema\b/i);
  });

  it("defines additive transcript identity columns", async () => {
    const migration = await readFile(new URL("../migrations/175_context_manifest_transcript_identity.sql", import.meta.url), "utf8");

    expect(migration).toContain("source_cursor");
    expect(migration).toContain("source_generation");
    expect(migration).toContain("source_identity_pair_check");
  });
});
