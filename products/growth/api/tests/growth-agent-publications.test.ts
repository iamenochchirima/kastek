import test from "node:test";
import assert from "node:assert/strict";
import {
  growthAgentPublication, growthAgentPublicationV10, growthAgentPublicationV9, growthAgentPublicationV8, growthAgentPublicationV7, growthAgentPublicationV6, growthAgentPublicationV5, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4,
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
    [growthAgentPublicationV8, "2c4347d6697106ad3c79b7add614fa9b0c24adcc81b1ed449af60c2ff296f31d"],
    [growthAgentPublicationV10, "e602d03156fbb4dfaa07f86c2082d9e36ce23b052f251b1b78c6b90075f49a7b"],
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
  assert.equal(growthAgentPublication.manifest.revision,"11");
  assert.equal(growthAgentPublication.policy.revision,"11");
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


test("private content writes remain writes and only revision 9 receives the new preview contract", () => {
  assert.equal(growthAgentPublication.manifest.adapter.release, "8");
  const direct = ["content.posts.draft.create", "content.posts.draft.update", "content.posts.duplicate", "content.media.upload", "content.media.transfer.prepare"];
  for (const name of direct) {
    const operation = growthAgentPublication.manifest.operations.find(item => item.operation === name)!;
    assert.equal(operation.policy.effect, "draft_write", name);
    assert.equal(operation.policy.approval, "none", name);
    assert.equal(operation.policy.retry, "status_only", name);
    assert.equal(operation.policy.disclosure, "exact_requested_payload", name);
    for (const preset of growthAgentPublication.presets.filter(preset => ["research", "campaigns"].includes(preset.id)))
      assert(!preset.operations.includes(name), `${preset.id} must not gain ${name}`);
  }
  assert(growthAgentPublication.manifest.operations.some(item => item.operation === "content.actions.preview"));
  assert.equal(growthAgentPublicationV9.manifest.revision,"9");
  assert.equal(growthAgentPublicationV9.manifest.adapter.release,"6");
  for (const name of ["content.posts.publish","content.posts.schedule","content.posts.delete","content.posts.update_published"]) {
    const operation=growthAgentPublication.manifest.operations.find(item=>item.operation===name)!;
    assert.equal(operation.policy.effect,"authorized_write");
    assert.equal(operation.policy.approval,"none");
    assert.equal(growthAgentPublicationV9.manifest.operations.find(item=>item.operation===name)!.policy.effect,"reviewed_write");
  }
  for (const publication of [growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8]) {
    assert(!publication.manifest.operations.some(item => item.operation === "content.actions.preview"));
    for (const descriptor of publication.manifest.operations) assert.equal((descriptor.inputSchema.properties as Record<string, unknown>)._previewId, undefined);
    assert.equal(publication.manifest.operations.find(item => item.operation === "content.posts.draft.create")!.policy.effect, "reviewed_write");
  }
  assert(growthAgentPublication.presets.find(preset => preset.id === "content")!.instructions.includes("content.actions.preview"));
});


test("library tools share canonical schemas, preserve private-write effects and exclude destructive research tools", async () => {
  const {growthOperationDescriptors}=await import("../src/operations/manifest.js");
  const {growthAgentSetupRequest}=await import("../src/workers/growth-agent-setup.js");
  const read=["content.media.list","content.media.usage","content.templates.list","content.templates.get","content.templates.render"];
  const draft=["content.media.update","content.templates.create","content.templates.update","content.templates.instantiate"];
  const manage=["content.media.archive","content.media.restore","content.templates.archive","content.templates.restore"];
  for(const name of [...read,...draft,...manage]) {
    const descriptor=growthAgentPublication.manifest.operations.find(operation=>operation.operation===name)!;
    assert.ok(descriptor,name);
    assert.deepEqual(descriptor,growthOperationDescriptors.find(operation=>operation.operation===name));
    assert.equal(descriptor.policy.effect,read.includes(name)?"read":draft.includes(name)?"draft_write":"authorized_write");
    for(const preset of growthAgentPublication.presets) {
      assert.equal(preset.operations.includes(name),["assistant","content"].includes(preset.id)||read.includes(name),`${preset.id}: ${name}`);
    }
    assert(!growthAgentPublicationV10.manifest.operations.some(operation=>operation.operation===name));
  }
  for(const publication of [growthAgentPublicationV9,growthAgentPublicationV10,growthAgentPublication]) {
    const request=growthAgentSetupRequest({defaultsRevision:publication.manifest.revision} as Parameters<typeof growthAgentSetupRequest>[0]);
    assert.deepEqual(request.publication,publication);
  }
  assert(growthAgentPublication.presets.find(p=>p.id==="content")!.instructions.includes("Template instantiation and duplication create new drafts"));
});
