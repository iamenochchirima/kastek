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

it("keeps the enquiry outcome runner on product and control-plane APIs", async () => {
  const source = await readFile(new URL("./harbor-fixture.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runEnquiryOutcome");
  const end = source.indexOf("async function main()", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const runner = source.slice(start, end);
  for (const forbidden of [
    "store.createAgent",
    "store.createVersion",
    "modelProviders.create",
    "publishFixtureSource",
  ]) {
    expect(runner).not.toContain(forbidden);
  }
  expect(runner).toContain("/api/website/");
  expect(runner).toContain("/v1/sandboxes/");
  expect(runner).toContain("customer-records/enquiries");
});

it("keeps interactive chat on the client and normal product APIs", async () => {
  const source = await readFile(new URL("./harbor-fixture.ts", import.meta.url), "utf8");
  const start = source.indexOf("async function runInteractiveOutcome");
  const end = source.indexOf("async function runEnquiryOutcome", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const runner = source.slice(start, end);
  for (const forbidden of [
    "store.createAgent",
    "store.createVersion",
    "modelProviders.create",
    "publishFixtureSource",
  ]) {
    expect(runner).not.toContain(forbidden);
  }
  expect(runner).toContain("InteractiveSandboxClient");
  expect(runner).toContain("client.startSession");
  expect(runner).toContain("client.continueSession");
  expect(runner).toContain("client.transcript");
  expect(runner).toContain("client.savedOutcomeRecord");
});
