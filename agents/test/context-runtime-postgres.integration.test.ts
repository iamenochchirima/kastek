import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { ModelCapabilityRepository } from "../src/db/repositories/model-capability-repository";
import { ContextCompactionRepository } from "../src/db/repositories/context-compaction-repository";
import { DurableContextCapabilityResolver } from "../src/runtime/context-capability";
import { compactDurableContext } from "../src/runtime/context-compaction";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("context runtime PostgreSQL durability (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = `context-runtime-${randomUUID()}`;

  afterAll(async () => {
    await pool.query("DELETE FROM agent_context_compaction_revisions WHERE organization_id = $1", [organizationId]);
    await pool.query("DELETE FROM agent_model_capabilities WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });

  it("reloads a route-scoped capability after resolver replacement and ignores expired evidence", async () => {
    const repository = new ModelCapabilityRepository(pool);
    const now = Date.now();
    const route = {
      organizationId,
      provider: "openai" as const,
      model: "gpt-5-context-integration",
      endpointId: "openai:default",
      credentialRouteId: "workspace-key-a",
      runtimeEnvironment: "playground",
    };
    await repository.upsert({
      ...route,
      contextWindowTokens: 128_000,
      source: "catalog",
      resolvedAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now + 60_000).toISOString(),
    });

    const profile = {
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      contextWindowTokens: 0,
      capabilitySource: "unknown" as const,
    };
    const first = await new DurableContextCapabilityResolver(repository, 60_000).resolve({
      organizationId,
      profile,
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      credentialRouteId: route.credentialRouteId,
      runtimeEnvironment: route.runtimeEnvironment,
    });
    const afterWorkerReplacement = await new DurableContextCapabilityResolver(repository, 60_000).resolve({
      organizationId,
      profile,
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      credentialRouteId: route.credentialRouteId,
      runtimeEnvironment: route.runtimeEnvironment,
    });

    expect(first).toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "catalog" });
    expect(afterWorkerReplacement).toMatchObject({ contextWindowTokens: 128_000, capabilitySource: "catalog" });

    await repository.upsert({
      ...route,
      contextWindowTokens: 128_000,
      source: "catalog",
      resolvedAt: new Date(now - 10_000).toISOString(),
      expiresAt: new Date(now - 1_000).toISOString(),
    });
    const expired = await new DurableContextCapabilityResolver(repository, 60_000).resolve({
      organizationId,
      profile,
      provider: route.provider,
      model: route.model,
      endpointId: route.endpointId,
      credentialRouteId: route.credentialRouteId,
      runtimeEnvironment: route.runtimeEnvironment,
    });

    expect(expired.capabilitySource).toBe("unknown");
    expect(expired.contextWindowTokens).toBe(0);
  });

  it("replays compaction after repository replacement and rejects a stale generation", async () => {
    const contextId = `context-${randomUUID()}`;
    const messages = [
      { role: "system" as const, content: "runtime policy" },
      { role: "user" as const, content: "older durable evidence" },
      { role: "assistant" as const, content: "older answer" },
      { role: "user" as const, content: "current task" },
    ];
    const firstRepository = new ContextCompactionRepository(pool, organizationId);
    const first = await compactDurableContext({
      operationId: `${contextId}:operation:1`,
      contextId,
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter: firstRepository,
    });

    const replacementRepository = new ContextCompactionRepository(pool, organizationId);
    const replayed = await compactDurableContext({
      operationId: `${contextId}:operation:1`,
      contextId,
      revision: 1,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter: replacementRepository,
    });
    const next = await compactDurableContext({
      operationId: `${contextId}:operation:2`,
      contextId,
      revision: 2,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter: replacementRepository,
    });

    expect(first.diagnostics.replayed).toBe(false);
    expect(replayed.diagnostics.replayed).toBe(true);
    expect(replayed.diagnostics.generation).toBe(first.diagnostics.generation);
    expect(next.diagnostics.generation).toBe(first.diagnostics.generation + 1);

    await expect(compactDurableContext({
      operationId: `${contextId}:operation:stale`,
      contextId,
      revision: 3,
      expectedGeneration: 0,
      messages,
      policy: { maxRetainedMessageUnits: 1 },
      adapter: replacementRepository,
    })).rejects.toMatchObject({ code: "fence_conflict" });
  });
});
