import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { Execution } from "../src/contracts/execution";
import { assertCurrentAuthority } from "../src/execution/context/evidence-policy";

const checks = vi.hoisted(() => ({ base: vi.fn(), mcp: vi.fn() }));
vi.mock("../src/execution/lifecycle/authority", async original => ({
  ...await original<typeof import("../src/execution/lifecycle/authority")>(), assertBaseAuthority: checks.base,
}));
vi.mock("../src/infrastructure/mcp-job-authority", () => ({ assertMcpTaskAuthority: checks.mcp }));

describe("MCP run authority", () => {
  it("checks the originating connection before continuing a run", async () => {
    const pool = {} as Pool;
    const execution = { task: { id: "run", root_task_id: "root", parent_task_id: null, execution_purpose: "normal" } } as unknown as Execution;
    checks.base.mockResolvedValue(undefined);
    checks.mcp.mockRejectedValue(new Error("Connection revoked"));
    await expect(assertCurrentAuthority(pool, execution)).rejects.toThrow("Connection revoked");
    expect(checks.mcp).toHaveBeenCalledWith(pool, "root");
  });
});
