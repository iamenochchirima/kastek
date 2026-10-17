import { describe, expect, it, vi } from "vitest";
import { AgentRepository } from "../src/db/repositories/agent-repository";

describe("Studio agent creation", () => {
  it("creates a customer-service agent with a Playground target and no Live installation", async () => {
    const repository = Object.create(AgentRepository.prototype) as AgentRepository;
    const agent = { id: "agent-1" };
    const version = { id: "version-1" };
    const playground = { id: "playground-1" };
    const createAgent = vi.spyOn(repository, "createAgent").mockResolvedValue(agent as never);
    vi.spyOn(repository, "createVersion").mockResolvedValue(version as never);
    vi.spyOn(repository, "publishVersion").mockResolvedValue(version as never);
    const createInstallation = vi.spyOn(repository, "createInstallation").mockResolvedValue(playground as never);

    const result = await repository.createStudioAgent(
      "organization-1",
      "actor-1",
      { name: "Support assistant", instructions: "Answer support enquiries." },
      {} as never,
    );

    expect(createAgent).toHaveBeenCalledWith("organization-1", "actor-1", expect.objectContaining({
      name: "Support assistant",
      agentAudience: "customer_service",
    }));
    expect(createInstallation).toHaveBeenCalledTimes(1);
    expect(createInstallation).toHaveBeenCalledWith("organization-1", "actor-1", expect.objectContaining({
      settings: expect.objectContaining({ environment: "playground" }),
    }));
    expect(result).toEqual({ agent, version, installation: playground });
  });
});
