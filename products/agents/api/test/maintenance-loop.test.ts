import { describe, it, expect } from "vitest";
import { createMaintenanceLoop } from "../src/composition/maintenance-loop";

describe("maintenance loops", () => {
  it("keeps a slow loop from blocking an unrelated one", async () => {
    let release!: () => void;
    const slowGate = new Promise<void>(resolve => { release = resolve; });
    const slow = createMaintenanceLoop(() => slowGate, () => undefined, 60000);
    let fastRuns = 0;
    const fast = createMaintenanceLoop(async () => { fastRuns += 1; }, () => undefined, 60000);
    void slow.tick();
    await fast.tick();
    expect(fastRuns).toBe(1);
    expect(slow.pending()).toBeDefined();
    release();
    await slow.pending();
    slow.stop(); fast.stop();
  });
  it("coalesces overlapping ticks and swallows a failure", async () => {
    let runs = 0, failures = 0;
    const loop = createMaintenanceLoop(async () => { runs += 1; await new Promise(r => setTimeout(r, 5)); }, () => { failures += 1; }, 60000);
    await Promise.all([loop.tick(), loop.tick(), loop.tick()]);
    expect(runs).toBe(1);
    loop.stop();
    const failing = createMaintenanceLoop(async () => { throw new Error("x"); }, () => { failures += 1; }, 60000);
    await failing.tick();
    expect(failures).toBe(1);
    failing.stop();
  });
});
