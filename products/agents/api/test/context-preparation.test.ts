import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { payloadHas } from "../src/execution/context/evidence-policy";
import { ProductRuntime } from "../src/execution/products/product-runtime";
import { PlatformError, requestDigest } from "../src/contracts/contracts";

const availability = vi.hoisted(() => ({
  bindings: [] as Array<Record<string, unknown>>,
  loadCalls: 0,
}));

vi.mock("../src/execution/lifecycle/execution", async importOriginal => {
  const actual = await importOriginal<typeof import("../src/execution/lifecycle/execution")>();
  return {
    ...actual,
    loadExecution: vi.fn(async () => {
      availability.loadCalls += 1;
      return { configuration: { productBindings: availability.bindings } };
    }),
  };
});

function binding(alias: string) {
  return { id: randomUUID(), alias, digest: randomUUID().replaceAll("-", "").padEnd(64, "0"),
    organizationId: randomUUID(), policy: { effect: "read" as const } };
}

describe("context preparation cost guards", () => {
  it("keeps catalogue and tool schemas out of evidence passage verification", () => {
    const passage = "Vendor contract renewal is due in March [E7]";
    expect(payloadHas({ messages: [{ role: "tool", content: passage }] }, "Vendor contract renewal", "E7")).toBe(true);
    // Catalogue entries and tool schemas can never carry evidence, so they are not walked.
    expect(payloadHas({ catalog: { entries: [{ description: passage }] } }, "Vendor contract renewal", "E7")).toBe(false);
    expect(payloadHas({ tools: [{ function: { description: passage } }] }, "Vendor contract renewal", "E7")).toBe(false);
    expect(payloadHas({ catalog: { entries: [] }, messages: [{ role: "tool", content: passage }] }, "Vendor contract renewal", "E7")).toBe(true);
  });

  it("preserves binding order, bounded concurrency and per-binding exclusion during availability", async () => {
    availability.bindings = [binding("first"), binding("denied"), binding("third"), binding("fourth")];
    availability.loadCalls = 0;
    let inFlight = 0, peak = 0;
    const runtime = Object.create(ProductRuntime.prototype) as ProductRuntime;
    Object.assign(runtime, { pool: {} as never, authorizeTask: vi.fn(async () => undefined) });
    Object.assign(runtime, {
      dispatch: vi.fn(async (_db: unknown, _task: string, _operation: string, candidate: { alias: string }) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise(resolve => setTimeout(resolve, 5));
        inFlight -= 1;
        if (candidate.alias === "denied") throw new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "Denied");
        return { value: { authorized: true } };
      }),
    });

    const available = await runtime.availableBindings(randomUUID());

    expect(available.map(item => (item as unknown as { alias: string }).alias)).toEqual(["first", "third", "fourth"]);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(8);
    // One execution load for the whole pass instead of one per binding.
    expect(availability.loadCalls).toBe(1);
  });

  it("surfaces a non-denial dispatch failure instead of silently dropping the binding", async () => {
    availability.bindings = [binding("broken")];
    const runtime = Object.create(ProductRuntime.prototype) as ProductRuntime;
    Object.assign(runtime, { pool: {} as never, authorizeTask: vi.fn(async () => undefined) });
    Object.assign(runtime, { dispatch: vi.fn(async () => { throw new PlatformError("PRODUCT_RESULT_INVALID", 502, "Invalid"); }) });
    await expect(runtime.availableBindings(randomUUID())).rejects.toMatchObject({ code: "PRODUCT_RESULT_INVALID" });
  });
});
