import { describe, expect, it, vi } from "vitest";
import {
  createMcpServerSnapshot,
  McpOperationCoordinator,
  publishMcpServerSnapshot,
  type McpRemoteAdapter,
} from "../src/mcp/operation-boundary";

const scope = { organizationId: "org-1", agentVersionId: "agent-version-1" };
const tool = {
  name: "lookup",
  description: "Look up a value",
  inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
};

function adapter(overrides: Partial<McpRemoteAdapter> = {}): McpRemoteAdapter {
  return {
    discover: vi.fn().mockResolvedValue({ protocolVersion: "2025-06-18", tools: [tool] }),
    call: vi.fn().mockResolvedValue({ answer: "ok" }),
    ...overrides,
  };
}

function publishedSnapshot(overrides: Partial<Parameters<typeof createMcpServerSnapshot>[0]> = {}) {
  return publishMcpServerSnapshot(createMcpServerSnapshot({
    scope,
    serverId: "server-1",
    revision: 1,
    endpointUrl: "https://mcp.example.test/mcp",
    protocolVersion: "2025-06-18",
    state: "discovered",
    tools: [tool],
    limits: {
      timeoutMs: 1_000,
      maxResponseBytes: 100_000,
      maxSchemaBytes: 100_000,
      maxResultBytes: 256,
      maxTools: 10,
    },
    ...overrides,
  }));
}

describe("MCP operation boundary", () => {
  it("creates a scoped, checksummed discovery snapshot without putting credentials in evidence", async () => {
    const evidence: unknown[] = [];
    const coordinator = new McpOperationCoordinator({ adapter: adapter(), environment: "test", onEvidence: (item) => evidence.push(item) });
    const result = await coordinator.discover({
      scope,
      serverId: "server-1",
      revision: 1,
      endpointUrl: "http://127.0.0.1:4310/mcp",
      authorizationToken: "secret-token-value",
      limits: { timeoutMs: 1_000, maxResponseBytes: 100_000, maxSchemaBytes: 100_000, maxResultBytes: 256, maxTools: 10 },
      environment: "test",
      operationId: "op-discover-1",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.snapshot).toMatchObject({ state: "discovered", serverId: "server-1", revision: 1 });
    expect(result.value.snapshot.checksum).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(evidence)).not.toContain("secret-token-value");
    expect(result.evidence).toMatchObject({ evidenceVersion: "mcp.operation.v1", operationId: "op-discover-1", outcome: "success", toolCount: 1 });
  });

  it("rejects unpublished, cross-scope, and tampered snapshots before remote calls", async () => {
    const remote = adapter();
    const coordinator = new McpOperationCoordinator({ adapter: remote, environment: "test" });
    const discovered = createMcpServerSnapshot({
      scope,
      serverId: "server-1",
      revision: 1,
      endpointUrl: "https://mcp.example.test/mcp",
      protocolVersion: "2025-06-18",
      state: "discovered",
      tools: [tool],
      limits: { timeoutMs: 1_000, maxResponseBytes: 100_000, maxSchemaBytes: 100_000, maxResultBytes: 256, maxTools: 10 },
    });
    const unpublished = await coordinator.call({ scope, snapshot: discovered, toolName: "lookup", argumentsValue: {}, environment: "test" });
    expect(unpublished).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_SNAPSHOT_NOT_PUBLISHED" } });

    const published = publishedSnapshot();
    const wrongScope = await coordinator.call({ scope: { ...scope, organizationId: "other-org" }, snapshot: published, toolName: "lookup", argumentsValue: {}, environment: "test" });
    expect(wrongScope).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_SNAPSHOT_SCOPE_MISMATCH" } });

    const tampered = { ...published, tools: [{ ...tool, name: "other-tool" }] };
    const checksumFailure = await coordinator.call({ scope, snapshot: tampered, toolName: "lookup", argumentsValue: {}, environment: "test" });
    expect(checksumFailure).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_SNAPSHOT_CHECKSUM_MISMATCH" } });
    expect(remote.call).not.toHaveBeenCalled();
  });

  it("redacts and bounds oversized tool results while retaining stable evidence", async () => {
    const remote = adapter({ call: vi.fn().mockResolvedValue({ apiKey: "secret", text: "x".repeat(2_000) }) });
    const coordinator = new McpOperationCoordinator({ adapter: remote, environment: "test" });
    const result = await coordinator.call({ scope, snapshot: publishedSnapshot({ limits: { timeoutMs: 1_000, maxResponseBytes: 100_000, maxSchemaBytes: 100_000, maxResultBytes: 128, maxTools: 10 } }), toolName: "lookup", argumentsValue: { query: "value" }, environment: "test", operationId: "op-call-1" });

    expect(result).toMatchObject({ ok: true, outcome: "success", value: { resultTruncated: true }, evidence: { operationId: "op-call-1", outcome: "success", resultTruncated: true } });
    if (!result.ok) return;
    expect(result.value.result).not.toEqual(expect.objectContaining({ apiKey: "secret" }));
    expect(JSON.stringify(result.value.result)).not.toContain("secret");
    expect(result.value.resultBytes).toBeLessThanOrEqual(128);
  });

  it("propagates cancellation and returns a terminal outcome", async () => {
    let observedSignal: AbortSignal | undefined;
    const remote = adapter({ call: vi.fn().mockImplementation((_input, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    }) });
    const coordinator = new McpOperationCoordinator({ adapter: remote, environment: "test" });
    const controller = new AbortController();
    const pending = coordinator.call({ scope, snapshot: publishedSnapshot(), toolName: "lookup", argumentsValue: {}, environment: "test", signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const result = await pending;
    expect(result).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_OPERATION_CANCELLED" } });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("classifies retryable, terminal, and unknown remote failures", async () => {
    const cases = [
      { error: Object.assign(new Error("REMOTE_MCP_HTTP_503"), { statusCode: 503 }), outcome: "retryable", code: "MCP_REMOTE_HTTP_503" },
      { error: Object.assign(new Error("REMOTE_MCP_HTTP_401"), { statusCode: 401 }), outcome: "terminal", code: "MCP_REMOTE_HTTP_401" },
      { error: new Error("provider exploded with no known code"), outcome: "unknown", code: "MCP_REMOTE_UNKNOWN_FAILURE" },
    ] as const;
    for (const candidate of cases) {
      const coordinator = new McpOperationCoordinator({ adapter: adapter({ call: vi.fn().mockRejectedValue(candidate.error) }), environment: "test" });
      const result = await coordinator.call({ scope, snapshot: publishedSnapshot(), toolName: "lookup", argumentsValue: {}, environment: "test" });
      expect(result).toMatchObject({ ok: false, outcome: candidate.outcome, error: { code: candidate.code } });
    }
  });

  it("returns a retryable timeout and aborts the adapter signal", async () => {
    let observedSignal: AbortSignal | undefined;
    const remote = adapter({ call: vi.fn().mockImplementation((_input, signal: AbortSignal) => {
      observedSignal = signal;
      return new Promise<never>(() => undefined);
    }) });
    const coordinator = new McpOperationCoordinator({ adapter: remote, environment: "test" });
    const result = await coordinator.call({ scope, snapshot: publishedSnapshot({ limits: { timeoutMs: 10, maxResponseBytes: 100_000, maxSchemaBytes: 100_000, maxResultBytes: 256, maxTools: 10 } }), toolName: "lookup", argumentsValue: {}, environment: "test" });
    expect(result).toMatchObject({ ok: false, outcome: "retryable", error: { code: "MCP_OPERATION_TIMEOUT" } });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("rejects unsupported protocols and oversized tool schemas before issuing a snapshot", async () => {
    const unsupported = new McpOperationCoordinator({
      adapter: adapter({ discover: vi.fn().mockResolvedValue({ protocolVersion: "2030-01-01", tools: [tool] }) }),
      environment: "test",
    });
    const unsupportedResult = await unsupported.discover({ scope, serverId: "server-1", revision: 1, endpointUrl: "https://mcp.example.test/mcp", environment: "test" });
    expect(unsupportedResult).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_PROTOCOL_UNSUPPORTED" } });

    const oversized = new McpOperationCoordinator({
      adapter: adapter({ discover: vi.fn().mockResolvedValue({ protocolVersion: "2025-06-18", tools: [{ ...tool, inputSchema: { description: "x".repeat(2_000) } }] }) }),
      environment: "test",
    });
    const oversizedResult = await oversized.discover({ scope, serverId: "server-1", revision: 1, endpointUrl: "https://mcp.example.test/mcp", environment: "test", limits: { maxSchemaBytes: 256 } });
    expect(oversizedResult).toMatchObject({ ok: false, outcome: "terminal", error: { code: "MCP_TOOL_SCHEMA_BYTES_EXCEEDED" } });
  });
});
