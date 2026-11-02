import test from "node:test";
import assert from "node:assert/strict";
import {
  growthAgentPublication, growthAgentPublicationV7, growthAgentPublicationV6, growthAgentPublicationV5, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4,
} from "../src/agents/manifest.js";
import { growthAgentDigest } from "../src/agents/security.js";

test("new Growth defaults preserve every retained publication identity", () => {
  const retained = [
    [growthAgentPublicationV2, "0f95cefad5eaf3c5d136c829044778c1aa38f325dda3df18c86606894a12233b"],
    [growthAgentPublicationV3, "2e50866bbb72691af8b527a6f933ba7fe13e17bdbd86e9c05d5b5a83f22c5f76"],
    [growthAgentPublicationV4, "a31b522d24794c81806a79f938e74831ac6daad0671189e832b7bdfc8388b226"],
    [growthAgentPublicationV5, "8356f52d010eed396766ec577f2b9d3ada636658ffe357f56a9b249d4fa5e6c7"],
    [growthAgentPublicationV6, "2e491ffdb2178913e46716f4aa1233c2703cd3be0c1bfa7001e3600f7f5f522d"],
    [growthAgentPublicationV7, "7dc3f0249a1eb3fe867ac16b7246fc8075694d3a049361ba0a15db54bbf3e558"],
  ] as const;
  for (const [publication, digest] of retained) assert.equal(growthAgentDigest(publication), digest);
  assert.equal(growthAgentPublicationV5.manifest.revision, "5");
  assert.equal(growthAgentPublicationV5.policy.revision, "5");
  assert.notEqual(growthAgentDigest(growthAgentPublicationV5), growthAgentDigest(growthAgentPublicationV4));
});

test("revised Growth instructions change behavior without expanding product authority", () => {
  assert.deepEqual(growthAgentPublicationV5.manifest.operations, growthAgentPublicationV4.manifest.operations);
  assert.deepEqual(growthAgentPublicationV5.manifest.adapter, growthAgentPublicationV4.manifest.adapter);
  assert.deepEqual(growthAgentPublicationV5.policy.optionalCapabilities, growthAgentPublicationV4.policy.optionalCapabilities);
  assert.deepEqual(growthAgentPublicationV5.presets.map(p => [p.id, p.operations]), growthAgentPublicationV4.presets.map(p => [p.id, p.operations]));
  for (const preset of growthAgentPublicationV5.presets) {
    const previous = growthAgentPublicationV4.presets.find(p => p.id === preset.id)!;
    assert.notEqual(preset.instructions, previous.instructions);
    assert.notEqual(preset.description, previous.description);
    assert(preset.instructions.length > 0 && preset.instructions.length <= 32768);
    assert(preset.description.length > 0 && preset.description.length <= 512);
  }
  const {digest, ...body} = growthAgentPublicationV5.manifest;
  assert.equal(digest, growthAgentDigest(body));
});

test("current Growth publication derives the canonical callable contract", async () => {
  const {growthOperationDescriptors}=await import("../src/operations/manifest.js");
  assert.equal(growthAgentPublication.manifest.revision,"8");
  assert.equal(growthAgentPublication.policy.revision,"8");
  assert.deepEqual(growthAgentPublication.manifest.operations,growthOperationDescriptors);
  assert(growthAgentPublication.presets.every(preset=>preset.operations.every(name=>growthOperationDescriptors.some(operation=>operation.operation===name))));
  assert(growthAgentPublication.presets.find(preset=>preset.id==="content")!.operations.includes("content.posts.draft.create"));
  assert(growthAgentPublication.presets.find(preset=>preset.id==="content")!.operations.includes("content.posts.update_published"));
  assert(!growthAgentPublicationV6.manifest.operations.some(operation=>operation.operation==="content.posts.update_published"));
  assert.equal((growthAgentPublicationV7.manifest.operations.find(operation=>operation.operation==="content.posts.update_published")!.inputSchema.properties as Record<string, unknown>).removePhoto, undefined);
  assert(!growthAgentPublication.presets.find(preset=>preset.id==="research")!.operations.includes("content.posts.update_published"));
  assert(!growthAgentPublication.presets.find(preset=>preset.id==="research")!.operations.includes("content.posts.draft.create"));
  const {digest,...body}=growthAgentPublication.manifest;
  assert.equal(digest,growthAgentDigest(body));
});
