import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { AgentStore } from "../src/product/agents/agent-store";

const policy = vi.hoisted(() => ({ permission: vi.fn(), limit: vi.fn() }));
vi.mock("../src/platform/access/permissions", async original => ({
  ...await original<typeof import("../src/platform/access/permissions")>(), requirePermission: policy.permission,
}));
vi.mock("../src/product/billing/billing", async original => ({
  ...await original<typeof import("../src/product/billing/billing")>(), assertAgentsBillingLimit: policy.limit,
}));
vi.mock("../src/infrastructure/database", () => ({
  transaction: async (pool: unknown, work: (db: unknown) => Promise<unknown>) => work(pool),
}));

describe("shared agent creation policy", () => {
  beforeEach(() => { vi.clearAllMocks(); policy.permission.mockResolvedValue("owner"); policy.limit.mockResolvedValue(undefined); });
  it("checks permission and the current agent count before inserting", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("FROM agents_platform.memberships") ? { rows: [{ account_id: "account" }] } : sql.includes("count(*)") ? { rows: [{ count: "3" }] } :
      sql.includes("INSERT INTO agents_platform.agents") ? { rows: [{ id: "agent" }] } : { rows: [] });
    const pool = { query } as unknown as Pool;
    const store = new AgentStore(pool);
    vi.spyOn(store, "createVersionInTransaction").mockResolvedValue({ id: "version" } as never);
    await store.createConfiguredAgent({ accountId: "account", organizationId: "workspace", name: "Agent" });
    expect(policy.permission).toHaveBeenCalledWith(pool, { accountId: "account", organizationId: "workspace" }, "agents.manage");
    expect(policy.limit).toHaveBeenCalledWith(pool, "workspace", "limit.agent_count", 3);
    expect(policy.limit.mock.invocationCallOrder[0]).toBeLessThan(query.mock.invocationCallOrder.find((_, i) => query.mock.calls[i]![0].includes("INSERT INTO agents_platform.agents"))!);
  });
  it("does not insert when the plan limit is reached", async () => {
    policy.limit.mockRejectedValue(new Error("limit reached"));
    const query = vi.fn(async (sql: string) => sql.includes("FROM agents_platform.memberships") ? { rows: [{ account_id: "account" }] } : sql.includes("count(*)") ? { rows: [{ count: "3" }] } : { rows: [] });
    const store = new AgentStore({ query } as unknown as Pool);
    await expect(store.createConfiguredAgent({ accountId: "account", organizationId: "workspace", name: "Agent" })).rejects.toThrow("limit reached");
    expect(query.mock.calls.some(([sql]) => sql.includes("INSERT INTO agents_platform.agents"))).toBe(false);
  });
});
