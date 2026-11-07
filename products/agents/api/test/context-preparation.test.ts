import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import type { ProductCapabilityDescriptor } from "@kasitek-labs/contracts";
import { payloadHas } from "../src/execution/context/evidence-policy";
import { capabilityDirectory, capabilityExposure } from "../src/execution/context/capability-directory";
import { createToolCatalog, type ToolCatalogMetadata } from "../src/capabilities/tool-discovery";
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

  it("surfaces a contract failure instead of silently dropping the binding", async () => {
    availability.bindings = [binding("broken")];
    const runtime = Object.create(ProductRuntime.prototype) as ProductRuntime;
    Object.assign(runtime, { pool: {} as never, authorizeTask: vi.fn(async () => undefined) });
    Object.assign(runtime, { dispatch: vi.fn(async () => { throw new PlatformError("CAPABILITY_INPUT_INVALID", 400, "Invalid"); }) });
    await expect(runtime.availableBindings(randomUUID())).rejects.toMatchObject({ code: "CAPABILITY_INPUT_INVALID" });
  });

  it("excludes a transiently unavailable binding without failing the turn", async () => {
    availability.bindings = [binding("works"), binding("flaky")];
    const runtime = Object.create(ProductRuntime.prototype) as ProductRuntime;
    Object.assign(runtime, { pool: {} as never, authorizeTask: vi.fn(async () => undefined) });
    Object.assign(runtime, { dispatch: vi.fn(async (_db: unknown, _task: string, _op: string, candidate: { alias: string }) => {
      if (candidate.alias === "flaky") throw new PlatformError("PRODUCT_UNAVAILABLE", 503, "Unavailable");
      return { value: { authorized: true } };
    }) });
    const available = await runtime.availableBindings(randomUUID());
    expect(available.map(item => (item as unknown as { alias: string }).alias)).toEqual(["works"]);
  });
});

describe("tool schema exposure", () => {
  const policy = {
    modelId: "test/model", revision: "p1", counterRevision: "c1", maxDurationSeconds: 120,
    contextWindowTokens: 262144, maxInputTokens: 196608, maxOutputTokens: 4096, safetyTokens: 1024,
    maxMessages: 256, maxTools: 64, maxRequestBytes: 2097152,
    estimateRequestTokens: (request: { tools?: unknown[] }) => Buffer.byteLength(JSON.stringify(request.tools ?? []), "utf8") / 4,
  };
  const definition = (name: string) => ({ type: "function" as const, function: { name, description: `Tool ${name}`,
    parameters: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false } } });
  const versions = new Map([["tools.discover", "3"], ["tools.load", "3"]]);

  it("keeps deferred owning-product schemas out of the prompt while naming them in the directory", () => {
    const catalog = createToolCatalog(
      [definition("work_read"), definition("t_product")],
      new Map<string, ToolCatalogMetadata>([
        ["work_read", { qualifiedName: "runtime:work_read", revision: "r1", schemaLoading: "auto" }],
        ["t_product", { qualifiedName: "product:growth:tenant:content.posts.list", revision: "r2", schemaLoading: "deferred" }],
      ]),
      "3",
    );
    const exposure = capabilityExposure(catalog, [], versions, policy as never);
    const names = exposure.tools.map(tool => tool.function.name);
    expect(names).toContain("work_read");
    expect(names).not.toContain("t_product");
    expect(names).toContain("tools_discover");
    expect(names).toContain("tools_load");
    // The directory still advertises the deferred capability by title, purpose and exact handle.
    const directory = capabilityDirectory({ catalog, tools: exposure.tools, skills: [], specialists: [], policy: policy as never });
    expect(directory.text).toContain("Content posts list");
    expect(directory.text).toContain("tool:t_product");
    expect(directory.text).toContain('"callableNow":false');
  });

  it("promotes the same product schema when it is marked auto", () => {
    const catalog = createToolCatalog(
      [definition("t_product")],
      new Map<string, ToolCatalogMetadata>([
        ["t_product", { qualifiedName: "product:growth:tenant:content.posts.list", revision: "r2", schemaLoading: "auto" }],
      ]),
      "3",
    );
    expect(capabilityExposure(catalog, [], versions, policy as never).tools.map(tool => tool.function.name)).toContain("t_product");
  });
});

describe("optional capability outages", () => {
  it("degrades one binding instead of failing prompt construction", async () => {
    const { degradedBindingObservation } = await import("../src/execution/products/product-runtime");
    expect(degradedBindingObservation(new PlatformError("PRODUCT_UNAVAILABLE", 503, "x"))).toBe(true);
    expect(degradedBindingObservation(new PlatformError("CAPABILITY_RATE_LIMITED", 429, "x"))).toBe(true);
    expect(degradedBindingObservation(Object.assign(new Error("timeout"), { name: "TimeoutError" }))).toBe(true);
    // Authorization and contract failures must stay loud.
    expect(degradedBindingObservation(new PlatformError("CAPABILITY_SCOPE_DENIED", 403, "x"))).toBe(false);
    expect(degradedBindingObservation(new PlatformError("PRODUCT_RESULT_INVALID", 502, "x"))).toBe(true);
    expect(degradedBindingObservation(new PlatformError("INVALID_REQUEST", 400, "x"))).toBe(false);
    expect(degradedBindingObservation(new Error("boom"))).toBe(false);
  });
});
