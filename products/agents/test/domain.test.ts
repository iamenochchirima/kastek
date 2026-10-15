import { describe, expect, it } from "vitest";
import { assertRunTransition, createAgentInputSchema, createInstallationInputSchema } from "../src/domain/types";
import { assertAgentReleaseMode, defaultAgentReleaseMode } from "../src/domain/release-mode";

describe("agent run state machine", () => {
  it("allows the durable lifecycle transitions", () => {
    expect(() => assertRunTransition("received", "queued")).not.toThrow();
    expect(() => assertRunTransition("queued", "running")).not.toThrow();
    expect(() => assertRunTransition("running", "completed")).not.toThrow();
  });

  it("rejects backward and terminal transitions", () => {
    expect(() => assertRunTransition("running", "received")).toThrow(
      "Invalid run transition: running -> received",
    );
    expect(() => assertRunTransition("completed", "running")).toThrow(
      "Invalid run transition: completed -> running",
    );
  });
});

describe("agent audience contract", () => {
  it("defaults new agents to the personal audience", () => {
    expect(createAgentInputSchema.parse({ name: "Personal helper" })).toMatchObject({
      agentAudience: "personal",
    });
  });

  it("accepts customer-service agents as a distinct audience", () => {
    expect(createAgentInputSchema.parse({ name: "Support helper", agentAudience: "customer_service" })).toMatchObject({
      agentAudience: "customer_service",
    });
  });

  it("rejects unknown audiences", () => {
    expect(() => createAgentInputSchema.parse({ name: "Invalid", agentAudience: "internal" })).toThrow();
  });
});

describe("agent release mode contract", () => {
  it("defaults installations to explicit deployment", () => {
    expect(defaultAgentReleaseMode("kasitek_hosted")).toBe("pinned");
    expect(defaultAgentReleaseMode("system_hosted")).toBe("pinned");
    expect(defaultAgentReleaseMode("external_connected")).toBe("pinned");
  });

  it("accepts an explicit pinned installation", () => {
    const input = createInstallationInputSchema.parse({
      agentVersionId: "00000000-0000-1000-8000-000000000001",
      scopeType: "organization",
      releaseMode: "pinned",
    });
    expect(input.releaseMode).toBe("pinned");
    expect(() => assertAgentReleaseMode("kasitek_hosted", "pinned")).not.toThrow();
  });

  it("rejects every release mode except pinned", () => {
    expect(() => assertAgentReleaseMode("kasitek_hosted", "follow_published" as never)).toThrow(/Only pinned/);
    expect(() => assertAgentReleaseMode("kasitek_hosted", "staged" as never)).toThrow(/Only pinned/);
  });
});
