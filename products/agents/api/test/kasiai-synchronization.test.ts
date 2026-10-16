import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config";
import { agentVersionContentMatches } from "../src/db/repositories/agent-repository";
import type { AgentRecord, AgentVersionRecord, AgentRepository, SystemAgentReleaseStatus } from "../src/db/repositories/agent-repository";
import { assertKasiAiReleaseCurrent, kasiaiInitialVersion, synchronizeKasiAi } from "../src/system/kasiai";

const config = {
  KASIAI_MODEL_PROVIDER: "openrouter",
  KASIAI_MODEL: "openai/gpt-4o-mini",
} as AppConfig;

const agent = {
  id: "agent-id",
  organization_id: "kasitek-system",
  owner_type: "system",
  name: "KasiAi",
  slug: "kasiai",
  description: "KasiTek's protected platform guidance agent.",
  creation_profile: "system",
  agent_audience: "personal",
  status: "active",
  protected: true,
  created_by: "kasiai-bootstrap",
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
} as AgentRecord;

const version = {
  id: "version-id",
  agent_definition_id: agent.id,
  version_number: 7,
  status: "published",
  instructions: "",
  configuration: {},
  policy: {},
  checksum: "checksum",
  created_by: "kasiai-bootstrap",
  created_at: new Date().toISOString(),
  published_at: new Date().toISOString(),
} as AgentVersionRecord;

function releaseStatus(overrides: Partial<SystemAgentReleaseStatus> = {}): SystemAgentReleaseStatus {
  return {
    agentId: agent.id,
    publishedVersionId: version.id,
    publishedVersionNumber: version.version_number,
    publishedContentMatches: true,
    activeInstallationCount: 2,
    matchingInstallationCount: 2,
    staleInstallationCount: 0,
    ...overrides,
  };
}

function fakeAgents(status = releaseStatus()): AgentRepository {
  return {
    ensureSystemAgent: vi.fn().mockResolvedValue(agent),
    releaseSystemVersion: vi.fn().mockResolvedValue(version),
    rolloutSystemVersion: vi.fn().mockResolvedValue(2),
    getSystemAgentReleaseStatus: vi.fn().mockResolvedValue(status),
  } as unknown as AgentRepository;
}

describe("KasiAi release synchronization", () => {
  it("keeps release comparisons stable when JSONB key order differs", () => {
    expect(agentVersionContentMatches(
      {
        instructions: "same",
        configuration: { model: "model", provider: "openrouter", nested: { z: 1, a: true } },
        policy: { modelPolicy: { fallback: [], primary: { model: "model", provider: "openrouter" } } },
      },
      {
        instructions: "same",
        configuration: { nested: { a: true, z: 1 }, provider: "openrouter", model: "model" },
        policy: { modelPolicy: { primary: { provider: "openrouter", model: "model" }, fallback: [] } },
      },
    )).toBe(true);
  });

  it("publishes, rolls out, and verifies the source-defined candidate", async () => {
    const agents = fakeAgents();
    const result = await synchronizeKasiAi(agents, config);

    expect(result.version.version_number).toBe(7);
    expect(result.rolledOut).toBe(2);
    expect(result.releaseStatus.staleInstallationCount).toBe(0);
    expect(agents.releaseSystemVersion).toHaveBeenCalledWith("kasiai-bootstrap", agent.id, kasiaiInitialVersion(config));
    expect(agents.rolloutSystemVersion).toHaveBeenCalledWith(agent.id, version.id, "kasiai-bootstrap");
  });

  it("fails closed when an active protected installation remains stale", async () => {
    const agents = fakeAgents(releaseStatus({ matchingInstallationCount: 1, staleInstallationCount: 1 }));

    await expect(synchronizeKasiAi(agents, config)).rejects.toMatchObject({
      code: "KASIAI_ROLLOUT_INCOMPLETE",
    });
  });

  it("prevents a worker from starting against a different published candidate", async () => {
    const agents = fakeAgents(releaseStatus({ publishedContentMatches: false }));

    await expect(assertKasiAiReleaseCurrent(agents, config)).rejects.toMatchObject({
      code: "KASIAI_PUBLISHED_VERSION_MISMATCH",
    });
  });
});
