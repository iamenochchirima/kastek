import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { describe, expect, it, vi } from "vitest";
import { executionGrantSchema, requestDigest } from "../src/contracts/contracts";
import { acceptedModelRoutesSchema } from "../src/contracts/model-bindings";
import { workspaceExecutionRequestSchema } from "../src/contracts/workspace-execution";
import { trialModelRoutes } from "../src/execution/admission/trial-authority";
import { loadAutomationModelRoutes } from "../src/execution/models/automation-routes";

function snapshot() {
  const organizationId = randomUUID(), agentId = randomUUID(), versionId = randomUUID();
  const definition = { id: "fixture", name: "Fixture", protocol: "openai_chat_completions", baseUrl: "https://fixture.example/v1",
    auth: { kind: "bearer" }, discovery: { kind: "curated" }, officialDocsUrl: "https://fixture.example/docs",
    adapter: { id: "fixture", revision: "1", readiness: "installed" } };
  const source = { kind: "operator", reference: "fixture", observedAt: "2026-10-31T00:00:00Z" };
  const model = { id: "model", providerId: "fixture", name: "Fixture", protocol: definition.protocol, revision: "1",
    contextTokens: { value: 32000, source }, maxInputTokens: { value: 16000, source }, maxOutputTokens: { value: 1000, source },
    capabilities: Object.fromEntries(["tools", "reasoning", "structuredOutput"].map(key => [key, { value: null, evidence: "unknown", source: null }])),
    inputModalities: ["text"], outputModalities: ["text"], pricing: null, lifecycle: "active" };
  const policy = { revision: "model-execution-policy-v1", digest: "a".repeat(64), contextTokens: 32000, maxInputTokens: 16000,
    maxOutputTokens: 1000, safetyTokens: 1000, compactAtTokens: 12000, maxModelCalls: 24, maxToolCalls: 48,
    maxDurationMs: 600000, maxCallDurationMs: 120000, maxInputBytes: 100000, maxRequestBytes: 1000000,
    maxResponseBytes: 100000, maxMessages: 256, maxTools: 64, maxRootTokens: 32000 as number | null, maxCostMicros: null };
  const binding = { organizationId, connectionId: randomUUID(), connectionRevision: 1, credentialRevision: 1,
    useGrantId: randomUUID(), useGrantRevision: 1, providerId: definition.id, providerDefinitionDigest: requestDigest(definition),
    endpoint: definition.baseUrl, protocol: definition.protocol, modelId: model.id, modelRevision: model.revision,
    adapterId: definition.adapter.id, adapterRevision: "1", policyDigest: policy.digest };
  const routes = Object.fromEntries(["primary", "compaction", "delegated"].map(role => [role,
    { definition, model, policy: { ...policy }, binding: { ...binding, role }, consumer: { kind: "agent", agentId } }]));
  const grant = executionGrantSchema.parse({ id: randomUUID(), product: "agents", organizationId, resourceId: agentId,
    callerClientId: "fixture", versionId, principal: { kind: "human", issuer: "https://identity.example", subject: "owner" },
    operations: ["model.reply"], maxInputBytes: 100000, maxOutputTokens: 1000, maxContextTokens: 16000,
    rootTokenLimit: 32000, expiresAt: "2099-01-01T00:00:00Z", revokedAt: null });
  return { organizationId, versionId, routes, grant };
}

describe("optional model policy snapshot boundaries", () => {
  it("loads an old automation snapshot by its original digest without rewriting accepted pins", async () => {
    const f = snapshot(), digest = requestDigest(f.routes);
    const db = { query: vi.fn(async () => ({ rows: [{ routes: f.routes, snapshot_digest: digest }] })) } as unknown as PoolClient;
    const routes = await loadAutomationModelRoutes(db, f.organizationId, randomUUID(), 1, f.versionId);
    expect(routes.primary.policy).toMatchObject({ revision: "model-execution-policy-v1", maxModelCalls: 24, maxRootModelCalls: null });
    expect(requestDigest(f.routes)).toBe(digest);
    expect(f.routes.primary.policy).not.toHaveProperty("maxRootModelCalls");
    f.routes.primary.policy.maxModelCalls = 25;
    await expect(loadAutomationModelRoutes(db, f.organizationId, randomUUID(), 1, f.versionId)).rejects.toMatchObject({ code: "AUTOMATION_MODEL_MISMATCH" });
  });

  it("validates old trial digests and rejects unrestricted routes under finite token authority", async () => {
    const f = snapshot();
    const row = { model_routes: f.routes, model_routes_digest: requestDigest(f.routes), root_token_limit: 32000 };
    const db = { query: vi.fn(async (sql: string) => sql.includes("evaluation_trials") ? { rows: [row] } : { rows: [{}], rowCount: 1 }) } as unknown as PoolClient;
    expect((await trialModelRoutes(db, randomUUID(), f.organizationId, f.grant)).primary.policy.maxModelCalls).toBe(24);
    f.routes.primary.policy.maxRootTokens = null;
    row.model_routes_digest = requestDigest(f.routes);
    await expect(trialModelRoutes(db, randomUUID(), f.organizationId, f.grant)).rejects.toMatchObject({ code: "EVALUATION_MODEL_MISMATCH" });
  });

  it("requires a finite workspace route when the grant is finite and accepts explicit no-cap authority", () => {
    const f = snapshot(), models = acceptedModelRoutesSchema.parse(f.routes);
    for (const route of Object.values(models)) route.policy.maxRootTokens = null;
    const request = { taskId: randomUUID(), runtime: "lina", models, grant: f.grant };
    expect(workspaceExecutionRequestSchema.safeParse(request).success).toBe(false);
    expect(workspaceExecutionRequestSchema.safeParse({ ...request, grant: { ...f.grant, rootTokenLimit: null } }).success).toBe(true);
  });
});
