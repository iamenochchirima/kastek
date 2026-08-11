import { describe, expect, it } from "vitest";
import { assertRunTransition } from "../src/domain/types";

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
