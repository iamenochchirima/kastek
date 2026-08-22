import { describe, expect, it } from "vitest";
import { assertRunTransition, createAgentInputSchema } from "../src/domain/types";

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
