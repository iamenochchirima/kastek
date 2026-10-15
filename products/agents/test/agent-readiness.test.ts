import { describe, expect, it } from "vitest";
import { buildAgentReadiness } from "../src/domain/agent-readiness";

describe("agent activation readiness", () => {
  it("reports a hosted installation ready when every check passes", () => {
    const readiness = buildAgentReadiness({
      executionMode: "kasitek_hosted",
      installationStatus: "active",
      requiredCapabilities: ["platform.current_time"],
      capabilityAvailability: [{ name: "platform.current_time", available: true }],
      requiredConnections: ["website"],
      configuredConnections: ["website"],
      provider: "openrouter",
      credentialConfigured: true,
    });
    expect(readiness).toMatchObject({ status: "ready", ready: true, blockers: [] });
  });

  it("returns actionable blockers instead of a generic unavailable state", () => {
    const readiness = buildAgentReadiness({
      executionMode: "kasitek_hosted",
      installationStatus: "paused",
      requiredCapabilities: ["kasitek.core.contacts_list"],
      capabilityAvailability: [{ name: "kasitek.core.contacts_list", available: false, reasonCode: "not_granted" }],
      requiredConnections: ["whatsapp"],
      configuredConnections: [],
      provider: "openai",
      credentialConfigured: false,
      workflowError: "Workflow edge references an unknown node: prepare -> respond",
    });
    expect(readiness.ready).toBe(false);
    expect(readiness.blockers.map((blocker) => blocker.code)).toEqual(expect.arrayContaining([
      "installation_inactive",
      "workflow_invalid",
      "capability_not_available",
      "connection_not_configured",
      "model_credential_missing",
    ]));
    expect(readiness.blockers.find((blocker) => blocker.code === "capability_not_available")?.detail).toContain("not granted");
  });

  it("does not require a model credential for external-connected installations", () => {
    const readiness = buildAgentReadiness({
      executionMode: "external_connected",
      installationStatus: "active",
      requiredCapabilities: [],
      capabilityAvailability: [],
      requiredConnections: [],
      configuredConnections: [],
      credentialConfigured: false,
    });
    expect(readiness.checks.credentials.status).toBe("not_required");
    expect(readiness.ready).toBe(true);
  });
});
