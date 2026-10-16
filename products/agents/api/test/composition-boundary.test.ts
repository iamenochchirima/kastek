import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const runtimeModules = [
  "../src/runtime/execution-scope.ts",
  "../src/runtime/scope-projections.ts",
  "../src/runtime/harness.ts",
  "../src/runtime/loop.ts",
];

describe("runtime composition boundary", () => {
  it("keeps Core/client construction out of runtime and domain modules", async () => {
    for (const modulePath of runtimeModules) {
      const source = await readFile(new URL(modulePath, import.meta.url), "utf8");
      expect(source, modulePath).not.toContain("KasitekCoreReadClient");
      expect(source, modulePath).not.toContain("new Pool");
      expect(source, modulePath).not.toContain("new ModelGateway");
    }
  });
});
