import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";

it("keeps persistent sandbox business setup on the product HTTP APIs", async () => {
  const source = await readFile(new URL("./harbor-fixture.ts", import.meta.url), "utf8");
  const start = source.indexOf("// sandbox business setup start");
  const end = source.indexOf("// sandbox business setup end", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const branch = source.slice(start, end);
  for (const forbidden of [
    "store.createAgent",
    "store.createVersion",
    "modelProviders.create",
    "publishFixtureSource",
  ]) {
    expect(branch).not.toContain(forbidden);
  }
  expect(branch).toContain("setupSandbox");
});
