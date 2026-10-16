import { describe, expect, it } from "vitest";
import {
  AgentEnvironmentError,
  assertSameAgentEnvironment,
  environmentFromInstallationSettings,
  parseAgentEnvironment,
} from "../src/runtime/execution-environment";
import { runtimeExecutionScopeFromRun } from "../src/runtime/execution-scope";

describe("agent execution environment", () => {
  it("accepts only explicit playground or live installation environments", () => {
    expect(parseAgentEnvironment("playground")).toBe("playground");
    expect(environmentFromInstallationSettings({ environment: "live", profile: "custom" })).toBe("live");
    expect(() => parseAgentEnvironment(undefined)).toThrowError(AgentEnvironmentError);
    expect(() => parseAgentEnvironment("test")).toThrowError(expect.objectContaining({ code: "AGENT_ENVIRONMENT_INVALID" }));
    expect(() => environmentFromInstallationSettings({ profile: "custom" })).toThrowError(expect.objectContaining({ code: "AGENT_ENVIRONMENT_REQUIRED" }));
  });

  it("does not allow a child to cross the parent environment", () => {
    expect(() => assertSameAgentEnvironment("playground", "live")).toThrowError(expect.objectContaining({ code: "AGENT_ENVIRONMENT_INVALID" }));
    expect(() => assertSameAgentEnvironment("playground", "playground")).not.toThrow();
  });

  it("carries the installation environment into an admitted runtime scope", () => {
    expect(runtimeExecutionScopeFromRun({
      organization_id: "org",
      installation_id: "installation",
      agent_definition_id: "agent",
      agent_version_id: "version",
      id: "run",
      correlation_id: "correlation",
      installation_settings: { environment: "playground" },
    })).toMatchObject({ environment: "playground" });
    expect(() => runtimeExecutionScopeFromRun({
      organization_id: "org",
      installation_id: "installation",
      agent_definition_id: "agent",
      agent_version_id: "version",
      id: "run",
      correlation_id: "correlation",
      installation_settings: {},
    })).toThrowError(expect.objectContaining({ code: "AGENT_ENVIRONMENT_REQUIRED" }));
  });
});
