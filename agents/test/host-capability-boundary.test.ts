import { describe, expect, it, vi } from "vitest";
import type { CoreWorkspaceStatus } from "../src/core/client";
import {
  CORE_WORKSPACE_STATUS_CAPABILITY,
  CoreHostAdapter,
  HostCapabilityRouter,
  NativeHostAdapter,
  NATIVE_CURRENT_TIME_CAPABILITY,
  TenantHostFixtureAdapter,
} from "../src/hosts";
import type { ExecutionScope } from "../src/runtime/execution-scope";

const scope = (grants: string[] = []): ExecutionScope => ({
  organizationId: "org-1",
  installationId: "install-1",
  agentDefinitionId: "agent-1",
  agentVersionId: "version-1",
  sessionId: "session-1",
  conversationId: "conversation-1",
  runId: "run-1",
  actorId: "actor-1",
  actorType: "user",
  correlationId: "correlation-1",
  capabilityGrants: grants,
});

const workspaceStatus: CoreWorkspaceStatus = {
  organizationId: "org-1",
  connections: [{ provider: "WHATSAPP", status: "CONNECTED", count: 1 }],
};

describe("host capability seam", () => {
  it("projects one execution scope into the Core read adapter", async () => {
    const getWorkspaceStatus = vi.fn(async (context) => {
      expect(context.scope).toMatchObject({ organizationId: "org-1", installationId: "install-1", runId: "run-1" });
      expect(context.organizationId).toBe("org-1");
      expect(context.agentId).toBe("agent-1");
      expect(context.correlationId).toBe("correlation-1");
      return workspaceStatus;
    });
    const router = new HostCapabilityRouter([new CoreHostAdapter({ getWorkspaceStatus })]);

    const result = await router.invoke<CoreWorkspaceStatus>({
      name: CORE_WORKSPACE_STATUS_CAPABILITY,
      scope: scope([CORE_WORKSPACE_STATUS_CAPABILITY]),
    });

    expect(result).toMatchObject({ status: "succeeded", value: workspaceStatus });
    expect(getWorkspaceStatus).toHaveBeenCalledOnce();
  });

  it("denies a Core capability before the host is called when the run lacks its grant", async () => {
    const getWorkspaceStatus = vi.fn(async () => workspaceStatus);
    const router = new HostCapabilityRouter([new CoreHostAdapter({ getWorkspaceStatus })]);

    const result = await router.invoke({ name: CORE_WORKSPACE_STATUS_CAPABILITY, scope: scope() });

    expect(result).toMatchObject({ status: "denied", code: "CAPABILITY_NOT_GRANTED" });
    expect(getWorkspaceStatus).not.toHaveBeenCalled();
  });

  it("converts a Core unavailable error into a bounded unavailable outcome", async () => {
    const router = new HostCapabilityRouter([new CoreHostAdapter({
      getWorkspaceStatus: vi.fn(async () => { throw Object.assign(new Error("not configured"), { code: "CORE_UNAVAILABLE" }); }),
    })]);

    const result = await router.invoke({
      name: CORE_WORKSPACE_STATUS_CAPABILITY,
      scope: scope([CORE_WORKSPACE_STATUS_CAPABILITY]),
    });

    expect(result).toMatchObject({ status: "unavailable", code: "HOST_UNAVAILABLE", message: "Host capability is unavailable" });
  });

  it("runs the current-time capability without a Core adapter", async () => {
    const router = new HostCapabilityRouter([new NativeHostAdapter({ now: () => new Date("2030-01-02T03:04:05.000Z") })]);

    const result = await router.invoke<{ iso: string }>({
      name: NATIVE_CURRENT_TIME_CAPABILITY,
      scope: scope([NATIVE_CURRENT_TIME_CAPABILITY]),
    });

    expect(result).toMatchObject({ status: "succeeded", value: { iso: "2030-01-02T03:04:05.000Z" } });
  });

  it("uses a tenant fixture only for its assigned installation and exposes explicit denials", async () => {
    const router = new HostCapabilityRouter([new TenantHostFixtureAdapter({
      organizationId: "org-1",
      installationId: "install-1",
      workspaceStatus,
      deniedCapabilities: [CORE_WORKSPACE_STATUS_CAPABILITY],
    })]);

    const denied = await router.invoke({
      name: CORE_WORKSPACE_STATUS_CAPABILITY,
      scope: scope([CORE_WORKSPACE_STATUS_CAPABILITY]),
    });
    const wrongInstallation = await router.invoke({
      name: CORE_WORKSPACE_STATUS_CAPABILITY,
      scope: { ...scope([CORE_WORKSPACE_STATUS_CAPABILITY]), installationId: "install-2" },
    });

    expect(denied).toMatchObject({ status: "denied", code: "HOST_DENIED" });
    expect(wrongInstallation).toMatchObject({ status: "denied", code: "HOST_DENIED" });
  });

  it("returns unavailable for an unregistered capability and rejects duplicate routes", async () => {
    const router = new HostCapabilityRouter([new NativeHostAdapter()]);
    const unavailable = await router.invoke({ name: "tenant.missing", scope: scope() });

    expect(unavailable).toMatchObject({ status: "unavailable", code: "CAPABILITY_UNAVAILABLE" });
    expect(() => router.register(new NativeHostAdapter())).toThrow("Duplicate host capability");
  });

  it("keeps concurrent installations isolated while rejecting model scope arguments", async () => {
    const first = new HostCapabilityRouter([new TenantHostFixtureAdapter({
      organizationId: "org-1",
      installationId: "install-1",
      workspaceStatus,
    })]);
    const second = new HostCapabilityRouter([new TenantHostFixtureAdapter({
      organizationId: "org-2",
      installationId: "install-2",
      workspaceStatus: { organizationId: "org-2", connections: [] },
    })]);
    const [firstResult, secondResult, modelEscape] = await Promise.all([
      first.invoke({ name: CORE_WORKSPACE_STATUS_CAPABILITY, scope: scope([CORE_WORKSPACE_STATUS_CAPABILITY]) }),
      second.invoke({
        name: CORE_WORKSPACE_STATUS_CAPABILITY,
        scope: { ...scope([CORE_WORKSPACE_STATUS_CAPABILITY]), organizationId: "org-2", installationId: "install-2" },
      }),
      first.invoke({
        name: CORE_WORKSPACE_STATUS_CAPABILITY,
        scope: scope([CORE_WORKSPACE_STATUS_CAPABILITY]),
        arguments: { organizationId: "org-2", installationId: "install-2" },
      }),
    ]);

    expect(firstResult).toMatchObject({ status: "succeeded", value: { organizationId: "org-1" } });
    expect(secondResult).toMatchObject({ status: "succeeded", value: { organizationId: "org-2" } });
    expect(modelEscape).toMatchObject({ status: "failed", code: "INVALID_ARGUMENTS" });
  });
});
