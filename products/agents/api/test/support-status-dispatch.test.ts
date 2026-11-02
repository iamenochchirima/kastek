import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { executeTool } from "../src/capabilities/tools";
import { loadExecution } from "../src/execution/lifecycle/execution";

vi.mock("../src/execution/lifecycle/execution", async importOriginal => ({
  ...await importOriginal<typeof import("../src/execution/lifecycle/execution")>(),
  loadExecution: vi.fn(),
}));

describe("support status tool dispatch", () => {
  const pool = {} as Pool;
  const configuration = { ...defaultBusinessConfiguration(), tools: ["channel.request_handoff", "support.get_status"] as const,
    supportHours: { timeZone: "Africa/Johannesburg", intervals: [{ day: 1, start: "09:00", end: "17:00" }] } };
  const execution = () => ({ configuration, task: { channel_binding: { customerConversationId: "conversation" }, parent_task_id: null } });
  beforeEach(() => vi.mocked(loadExecution).mockReset());
  it("dispatches the published configuration, not caller-selected hours", async () => {
    vi.mocked(loadExecution).mockResolvedValue(execution() as never);
    const result = await executeTool(pool, "task", "operation", "support.get_status", "{}");
    expect(result).toMatchObject({ hours: { timeZone: "Africa/Johannesburg", intervals: configuration.supportHours.intervals }, staffAvailability: "unknown", responseTime: "unknown" });
    await expect(executeTool(pool, "task", "operation", "support.get_status", '{"timeZone":"UTC"}')).rejects.toMatchObject({ code: "TOOL_ARGUMENTS_INVALID" });
  });
  it("denies unbound or delegated execution and unpublished access", async () => {
    vi.mocked(loadExecution).mockResolvedValue({ ...execution(), task: { channel_binding: null, parent_task_id: null } } as never);
    await expect(executeTool(pool, "task", "operation", "support.get_status", "{}")).rejects.toMatchObject({ code: "CHANNEL_SCOPE_DENIED" });
    vi.mocked(loadExecution).mockResolvedValue({ ...execution(), task: { channel_binding: {}, parent_task_id: "parent" } } as never);
    await expect(executeTool(pool, "task", "operation", "support.get_status", "{}")).rejects.toMatchObject({ code: "CHANNEL_SCOPE_DENIED" });
    vi.mocked(loadExecution).mockResolvedValue({ ...execution(), configuration: { ...configuration, tools: ["channel.request_handoff"] } } as never);
    await expect(executeTool(pool, "task", "operation", "support.get_status", "{}")).rejects.toMatchObject({ code: "TOOL_DENIED" });
  });
  it("denies even a published tool to a status-only task",async()=>{
    vi.mocked(loadExecution).mockResolvedValue({...execution(),task:{...execution().task,execution_purpose:'support_status_v1'}} as never);
    await expect(executeTool(pool,'task','operation','support.get_status','{}')).rejects.toMatchObject({code:'TOOL_DENIED'});
  });
});
