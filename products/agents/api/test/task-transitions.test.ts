import { describe, expect, it } from "vitest";
import { assertTaskTransition } from "../src/contracts/contracts";

describe("task state transitions", () => {
  it("allows execution progress and rejects impossible moves", () => {
    expect(() => assertTaskTransition("accepted", "running")).not.toThrow();
    expect(() => assertTaskTransition("running", "waiting_authority")).not.toThrow();
    expect(() => assertTaskTransition("waiting_authority", "running")).not.toThrow();
    expect(() => assertTaskTransition("running", "completed")).not.toThrow();
    expect(() => assertTaskTransition("completed", "running")).toThrow();
    expect(() => assertTaskTransition("cancelled", "completed")).toThrow();
  });
});
