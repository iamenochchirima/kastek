import { describe, expect, it } from "vitest";
import { buildApp } from "../src/http/app";
import type { AppConfig } from "../src/config";
import type { AgentVersionRecord } from "../src/db/repositories/agent-repository";

const config = {
  NODE_ENV: "test",
  PORT: 4100,
  HOST: "127.0.0.1",
  AGENTS_DATABASE_URL: "postgres://unused",
  AGENTS_DATABASE_POOL_MAX: 1,
  TEMPORAL_ENABLED: false,
  TEMPORAL_ADDRESS: "localhost:7233",
  TEMPORAL_NAMESPACE: "default",
  TEMPORAL_TASK_QUEUE: "test",
  INTERNAL_AUTH_AUDIENCE: "test",
  AUTH_MODE: "headers",
  LOG_LEVEL: "silent",
} as AppConfig;

const candidate: AgentVersionRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  agent_definition_id: "22222222-2222-4222-8222-222222222222",
  version_number: 2,
  status: "draft",
  instructions: "Answer from the supplied context.",
  configuration: {
    agentSpec: {
      specVersion: 1,
      behavior: { instructions: "Answer from the supplied context." },
      model: { version: "2026-01", primary: { provider: "openrouter", model: "model-candidate" } },
      runtime: { maxContextTokens: 4_000 },
      capabilities: { allowedTools: ["platform.current_time"] },
      knowledge: { sourceIds: ["source-1"], requiredConnections: ["website"] },
      memory: { mode: "explicit" },
      skills: { allowedSkillIds: [] },
      workflow: {},
      channels: { allowed: ["telegram"] },
      release: { mode: "pinned" },
    },
  },
  policy: {},
  checksum: "candidate-checksum",
  created_by: "actor-1",
  created_at: "2026-09-01T00:00:00.000Z",
  published_at: null,
};

const deployed: AgentVersionRecord = {
  ...candidate,
  id: "33333333-3333-4333-8333-333333333333",
  version_number: 1,
  status: "published",
  checksum: "deployed-checksum",
  configuration: {
    ...candidate.configuration,
    agentSpec: {
      ...(candidate.configuration.agentSpec as Record<string, unknown>),
      model: { version: "2026-01", primary: { provider: "openrouter", model: "model-deployed" } },
    },
  },
};

describe("effective configuration route", () => {
  it("returns the sanitized projection and candidate/deployed diff", async () => {
    const app = buildApp({
      config,
      pool: { query: async () => ({ rows: [] }) } as never,
      agents: {
        getVersion: async (_organizationId: string, versionId: string) => versionId === candidate.id ? candidate : versionId === deployed.id ? deployed : null,
      } as never,
      toolGrants: {
        listForVersion: async () => [{ installation_id: null, revoked_at: null, tool_name: "platform.current_time" }],
      } as never,
      skills: { loadPinnedVersions: async () => [] } as never,
      remoteMcpProviders: { listPinned: async () => [] } as never,
    });
    try {
      const response = await app.inject({
        method: "GET",
        url: `/v1/agent-versions/${candidate.id}/effective-config?compareVersionId=${deployed.id}`,
        headers: { "x-organization-id": "org-1", "x-actor-id": "user-1" },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.effective.source).toBe("typed");
      expect(body.effective.model.model).toBe("model-candidate");
      expect(body.effective.tools).toEqual(["platform.current_time"]);
      expect(body.effective.knowledge).toEqual({ sourceIds: ["source-1"], requiredConnections: ["website"] });
      expect(body.effective).not.toHaveProperty("credentialReference");
      expect(body.comparison.diff).toMatchObject({ changed: true, paths: ["/model/model"] });
    } finally {
      await app.close();
    }
  });
});
