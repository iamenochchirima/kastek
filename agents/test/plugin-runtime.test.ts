import { describe, expect, it, vi } from "vitest";
import {
  decodePluginWorkerRequest,
  decodePluginWorkerResponse,
  createPluginToolDefinition,
  DeterministicPluginSubprocessFactory,
  encodePluginWorkerRequest,
  IsolatedPluginAdapter,
  PluginProtocolError,
  type PluginExecutionRequest,
  type PluginWorkerRequest,
  type PluginWorkerResponse,
} from "../src/extensions";
import type { ExtensionPackageManifest, ExtensionPackageRuntime } from "../src/extensions/package-manifest";

const checksum = "a".repeat(64);

function manifest(overrides: Partial<ExtensionPackageManifest> = {}): Readonly<ExtensionPackageManifest> {
  return {
    manifestVersion: 1,
    id: "demo-plugin",
    version: "1.0.0",
    checksum,
    kind: "plugin",
    runtime: { id: "kasitek-agent-runtime", versionRange: "^2.0.0", requiredFeatures: ["plugin-subprocess-v1"] },
    execution: { mode: "plugin", entrypoint: "plugin.register" },
    dependencies: [],
    permissions: ["calendar.read"],
    ...overrides,
  };
}

function runtime(overrides: Partial<ExtensionPackageRuntime> = {}): ExtensionPackageRuntime {
  return {
    runtimeId: "kasitek-agent-runtime",
    runtimeVersion: "2.4.0",
    supportedFeatures: ["plugin-subprocess-v1"],
    supportedExecutionModes: ["plugin"],
    trustedChecksums: [{ kind: "plugin", id: "demo-plugin", version: "1.0.0", checksum }],
    grantedPermissions: ["calendar.read"],
    configuration: { region: "za" },
    ...overrides,
  };
}

function request(overrides: Partial<PluginExecutionRequest> = {}): PluginExecutionRequest {
  return {
    operationId: "plugin-operation-1",
    package: { organizationId: "org-a", packageVersionId: "plugin-version-1", manifest: manifest() },
    runtime: runtime(),
    scope: { organizationId: "org-a", capabilityGrants: ["calendar.read"] },
    input: { prompt: "private customer prompt", value: 3 },
    ...overrides,
  };
}

function success(requestFrame: PluginWorkerRequest, output: unknown = { ok: true }): PluginWorkerResponse {
  return {
    type: "kasitek.plugin.result",
    protocolVersion: 1,
    operationId: requestFrame.operationId,
    ok: true,
    output,
  };
}

function makeAdapter(options: ConstructorParameters<typeof DeterministicPluginSubprocessFactory>[0] = { execute: async (frame) => success(frame) }): {
  adapter: IsolatedPluginAdapter;
  factory: DeterministicPluginSubprocessFactory;
} {
  const factory = new DeterministicPluginSubprocessFactory(options);
  return { factory, adapter: new IsolatedPluginAdapter({ factory }) };
}

describe("isolated plugin protocol", () => {
  it("accepts one narrow request frame and rejects unknown or malformed fields", () => {
    const frame = encodePluginWorkerRequest({
      type: "kasitek.plugin.execute",
      protocolVersion: 1,
      operationId: "operation-1",
      packageId: "demo-plugin",
      packageVersion: "1.0.0",
      packageChecksum: checksum,
      entrypoint: "plugin.register",
      capabilities: ["calendar.read", "calendar.read"],
      configuration: { region: "za" },
      input: { value: 1 },
    });
    expect(decodePluginWorkerRequest(frame)).toMatchObject({
      type: "kasitek.plugin.execute",
      capabilities: ["calendar.read"],
      input: { value: 1 },
    });

    expect(() => decodePluginWorkerRequest(JSON.stringify({
      type: "kasitek.plugin.execute",
      protocolVersion: 1,
      operationId: "operation-1",
      packageId: "demo-plugin",
      packageVersion: "1.0.0",
      packageChecksum: checksum,
      entrypoint: "plugin.register",
      capabilities: [],
      configuration: {},
      input: {},
      prompt: "must not be accepted as a protocol field",
    }))).toThrowError(PluginProtocolError);
    expect(() => decodePluginWorkerRequest("not-json")).toThrowError(PluginProtocolError);
  });

  it("bounds response frames and output values before handing them to the host", () => {
    expect(() => decodePluginWorkerResponse(JSON.stringify({
      type: "kasitek.plugin.result",
      protocolVersion: 1,
      operationId: "operation-1",
      ok: true,
      output: "x".repeat(200),
    }), { maxOutputBytes: 64, maxFrameBytes: 1_024 })).toThrowError(PluginProtocolError);
  });
});

describe("isolated plugin execution", () => {
  it("executes through the fake process boundary and records only redacted metadata", async () => {
    const evidence = vi.fn();
    const factory = new DeterministicPluginSubprocessFactory({
      execute: async (workerRequest) => success(workerRequest, { accepted: workerRequest.input }),
    });
    const isolated = new IsolatedPluginAdapter({ factory, evidenceSink: { record: evidence } });
    const result = await isolated.execute(request());

    expect(result).toMatchObject({ ok: true, output: { accepted: { prompt: "private customer prompt", value: 3 } }, evidence: { outcome: "succeeded" } });
    expect(evidence).toHaveBeenCalledTimes(1);
    const recorded = evidence.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(JSON.stringify(recorded)).not.toContain("private customer prompt");
    expect(recorded).not.toHaveProperty("input");
    expect(recorded).not.toHaveProperty("output");
    expect(factory.processes[0]).toMatchObject({ terminated: true, disposed: true });
  });

  it("rejects an oversized output and still cleans up the subprocess", async () => {
    const { adapter, factory } = makeAdapter({ execute: async (workerRequest) => success(workerRequest, "x".repeat(512)) });
    const result = await adapter.execute(request({ limits: { maxInputBytes: 1_024, maxOutputBytes: 128, maxFrameBytes: 64 * 1024 } }));

    expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_OUTPUT_TOO_LARGE" }, evidence: { cleanup: { terminated: true, disposed: true } } });
  });

  it("returns a bounded timeout when a subprocess ignores cancellation", async () => {
    const { adapter, factory } = makeAdapter({ execute: async () => new Promise<PluginWorkerResponse>(() => undefined) });
    const startedAt = Date.now();
    const result = await adapter.execute(request({ limits: { maxInputBytes: 1_024, maxOutputBytes: 1_024, maxFrameBytes: 64 * 1024, timeoutMs: 10 } }));

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_TIMEOUT" }, evidence: { outcome: "timed_out", cleanup: { terminated: true, disposed: true } } });
    expect(factory.processes[0]).toMatchObject({ terminated: true, disposed: true });
  });

  it("propagates caller cancellation and terminates the subprocess", async () => {
    const { adapter, factory } = makeAdapter({ execute: async () => new Promise<PluginWorkerResponse>(() => undefined) });
    const controller = new AbortController();
    const pending = adapter.execute(request({ signal: controller.signal }));
    controller.abort();
    const result = await pending;

    expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_CANCELLED" }, evidence: { outcome: "cancelled" } });
    expect(factory.processes[0]).toMatchObject({ terminated: true, disposed: true });
  });

  it("turns a process crash into a typed failure without exposing crash text", async () => {
    const { adapter, factory } = makeAdapter({ crash: true, execute: async (workerRequest) => success(workerRequest) });
    const result = await adapter.execute(request());

    expect(result).toMatchObject({ ok: false, error: { code: "PLUGIN_PROCESS_CRASHED", message: "The plugin process exited unexpectedly." }, evidence: { failureCode: "PLUGIN_PROCESS_CRASHED" } });
    expect(JSON.stringify(result)).not.toContain("private customer prompt");
    expect(factory.processes[0]).toMatchObject({ terminated: true, disposed: true });
  });

  it("composes the isolated runtime as a normal durable capability", async () => {
    const { adapter } = makeAdapter({ execute: async (workerRequest) => success(workerRequest, { connected: true }) });
    const tool = createPluginToolDefinition({
      name: "plugin.demo",
      description: "Demo plugin",
      version: "1.0.0",
      inputSchema: { type: "object" },
      outputSchema: { type: "object" },
      package: request().package,
      runtime: runtime(),
      adapter,
    });

    const output = await tool.handler({
      organizationId: "org-a",
      installationId: "installation-1",
      agentVersionId: "agent-version-1",
      runId: "run-1",
      conversationId: "conversation-1",
      operationId: "plugin-operation-1",
      grantedTools: ["plugin.demo"],
      scope: { capabilityGrants: ["calendar.read"] },
    }, { value: 1 });

    expect(output).toEqual({ connected: true });
    expect(tool.manifest).toMatchObject({ execution: "durable", idempotency: "required", requiredScope: "plugin:demo-plugin" });
  });

  it.each([
    ["organization scope", request({ package: { organizationId: "org-b", packageVersionId: "plugin-version-1", manifest: manifest() } }), "PLUGIN_SCOPE_MISMATCH"],
    ["missing capability grant", request({ scope: { organizationId: "org-a", capabilityGrants: [] } }), "PLUGIN_GRANT_MISMATCH"],
    ["untrusted package digest", request({ runtime: runtime({ trustedChecksums: [] }) }), "PLUGIN_DIGEST_MISMATCH"],
    ["incompatible runtime", request({ runtime: runtime({ runtimeVersion: "1.0.0" }) }), "PLUGIN_RUNTIME_INCOMPATIBLE"],
  ] as const)("rejects %s before starting a process", async (_label, input, code) => {
    const { adapter, factory } = makeAdapter();
    const result = await adapter.execute(input);

    expect(result).toMatchObject({ ok: false, error: { code } });
    expect(factory.processes).toHaveLength(0);
  });
});
