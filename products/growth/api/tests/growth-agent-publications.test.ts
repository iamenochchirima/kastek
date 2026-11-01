import test from "node:test";
import assert from "node:assert/strict";
import {
  growthAgentPublication, growthAgentPublicationV5, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4,
} from "../src/agents/manifest.js";
import { growthAgentDigest } from "../src/agents/security.js";

test("new Growth defaults preserve every retained publication identity", () => {
  const retained = [
    [growthAgentPublicationV2, "0f95cefad5eaf3c5d136c829044778c1aa38f325dda3df18c86606894a12233b"],
    [growthAgentPublicationV3, "2e50866bbb72691af8b527a6f933ba7fe13e17bdbd86e9c05d5b5a83f22c5f76"],
    [growthAgentPublicationV4, "a31b522d24794c81806a79f938e74831ac6daad0671189e832b7bdfc8388b226"],
    [growthAgentPublicationV5, "8356f52d010eed396766ec577f2b9d3ada636658ffe357f56a9b249d4fa5e6c7"],
  ] as const;
  for (const [publication, digest] of retained) assert.equal(growthAgentDigest(publication), digest);
  assert.equal(growthAgentPublication.manifest.revision, "5");
  assert.equal(growthAgentPublication, growthAgentPublicationV5);
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
