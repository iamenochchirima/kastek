import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { agentCreationOperations } from "../src/product/agents/creation-operations";
import type { PlatformStore } from "../src/product/agents/store";

describe("agent creation operations", () => {
  it("creates a generic agent with only the requested purpose and instructions", async () => {
    const createConfiguredAgent = vi.fn().mockResolvedValue({});
    const assertBindings = vi.fn().mockResolvedValue(undefined);
    const operations = agentCreationOperations({
      store: { createConfiguredAgent } as unknown as PlatformStore,
      pool: {} as Pool,
      assertBindings,
    });

    await operations.create({ accountId: "account", organizationId: "workspace" }, {
      name: "Research assistant", purpose: "Research a topic", instructions: "Summarize the evidence.",
    });

    const input = createConfiguredAgent.mock.calls[0]![0];
    expect(input.offering).toBeUndefined();
    expect(input.configuration.identity.purpose).toBe("Research a topic");
    expect(input.configuration.instructions).toBe("Summarize the evidence.");
    expect(input.configuration.tools).toEqual([]);
    expect(input.configuration.memory.enabled).toBe(false);
    expect(assertBindings).toHaveBeenCalledWith(input.configuration);
  });

  it("rejects conflicting configuration sources", async () => {
    const createConfiguredAgent = vi.fn();
    const operations = agentCreationOperations({
      store: { createConfiguredAgent } as unknown as PlatformStore,
      pool: {} as Pool,
      assertBindings: vi.fn(),
    });
    await expect(operations.create({ accountId: "account", organizationId: "workspace" }, {
      name: "Agent", offering: "customer-service", instructions: "Help with research.",
    })).rejects.toThrow();
    expect(createConfiguredAgent).not.toHaveBeenCalled();
  });
});
