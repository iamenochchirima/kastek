import test from "node:test";
import assert from "node:assert/strict";
import { parseGrowthAgentCommand, parseGrowthAgentProvisionRequest } from "@kasitek-labs/contracts";
import { growthAgentPublication } from "../src/agents/manifest.js";

const command = (publication: unknown) => ({
  version: "1", requestId: "publication-request", tenantId: "business",
  actor: { issuer: "https://growth.example/identity", subject: "member" },
  operation: "features.list", input: { publication },
});
const provision = (publication: unknown) => ({
  version: "1", requestId: "569b17ec-9763-45c3-b736-7e549597250f", tenantId: "business",
  defaultsRevision: growthAgentPublication.manifest.revision,
  modelProfileId: "growth-default", modelProfileRevision: "1", publication,
});

test("current Growth catalogue passes command and provisioning publication bounds", () => {
  assert.doesNotThrow(() => parseGrowthAgentCommand(command(growthAgentPublication)));
  assert.doesNotThrow(() => parseGrowthAgentProvisionRequest(provision(growthAgentPublication)));
  const oversized = structuredClone(growthAgentPublication);
  oversized.presets[0]!.instructions += "界".repeat(30_000);
  assert.ok(JSON.stringify(oversized).length < 262_144, "multibyte payload stays below the character ceiling");
  assert.ok(Buffer.byteLength(JSON.stringify(oversized)) > 262_144, "encoded payload exceeds the byte ceiling");
  assert.throws(() => parseGrowthAgentCommand(command(oversized)));
  assert.throws(() => parseGrowthAgentProvisionRequest(provision(oversized)));
});
