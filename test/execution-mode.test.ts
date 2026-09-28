import { describe, expect, it } from "vitest";
import {
  ExecutionModeError,
  allowsExecutionMode,
  executionModePolicy,
  isHostedExecutionMode,
  requireExternalConnected,
  requireHostedInstallation,
  requireKasiAiInstallation,
} from "../src/domain/execution-mode";

const hosted = {
  execution_mode: "kasitek_hosted" as const,
  agent_owner_type: "organization",
  agent_protected: false,
  agent_slug: "customer-agent",
};

const kasiai = {
  execution_mode: "system_hosted" as const,
  agent_owner_type: "system",
  agent_protected: true,
  agent_slug: "kasiai",
};

const external = {
  execution_mode: "external_connected" as const,
  agent_owner_type: "organization",
  agent_protected: false,
  agent_slug: "external-runtime",
};

describe("installation execution mode policy", () => {
  it("has an explicit decision for every mode and protected operation family", () => {
    const modes = ["system_hosted", "kasitek_hosted", "external_connected"] as const;
    for (const operation of Object.keys(executionModePolicy) as Array<keyof typeof executionModePolicy>) {
      for (const mode of modes) expect(allowsExecutionMode(mode, operation)).toBe(executionModePolicy[operation][mode]);
    }
  });
  it("recognizes only hosted modes as hosted", () => {
    expect(isHostedExecutionMode("system_hosted")).toBe(true);
    expect(isHostedExecutionMode("kasitek_hosted")).toBe(true);
    expect(isHostedExecutionMode("external_connected")).toBe(false);
    expect(isHostedExecutionMode(null)).toBe(false);
  });

  it("keeps external credentials and protocol access external-only", () => {
    expect(() => requireExternalConnected(external)).not.toThrow();
    expect(() => requireExternalConnected(hosted)).toThrowError(ExecutionModeError);
    expect(() => requireExternalConnected(hosted)).toThrow(/external-connected/);
  });

  it("allows channels and platform chat only for hosted installations", () => {
    expect(() => requireHostedInstallation(hosted)).not.toThrow();
    expect(() => requireHostedInstallation(kasiai)).not.toThrow();
    expect(() => requireHostedInstallation(external)).toThrowError(ExecutionModeError);
  });

  it("requires the protected system KasiAi identity, not only system_hosted mode", () => {
    expect(() => requireKasiAiInstallation(kasiai)).not.toThrow();
    expect(() => requireKasiAiInstallation(hosted)).toThrow(/protected KasiAi/);
    expect(() => requireKasiAiInstallation({ ...kasiai, agent_slug: "other-system-agent" })).toThrow(/protected KasiAi/);
    expect(() => requireKasiAiInstallation(undefined)).toThrowError(ExecutionModeError);
  });
});
