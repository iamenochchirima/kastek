import { test } from "node:test";
import assert from "node:assert/strict";
import { projectAgentConnectionRead, projectAgentMediaPreview } from "../src/operations/agent-read-projection.js";
import { boundedGrowthOperationResult } from "../src/operations/reviews.js";
import { growthReadResources } from "../src/operations/read-access.js";
import { usesConnectionProjection } from "../src/operations/internal.js";
import { growthAgentPublicationV12, growthAgentPublicationV13 } from "../src/agents/manifest.js";
import type { ProductCapabilityAuthority } from "@kasitek-labs/contracts";

test("connection model pages retain usable selectors and evidence without provider metadata", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ id: `connection-${i}`, displayName: `Page ${i}`, provider: "FACEBOOK", status: "CONNECTED",
    capabilities: [{ key: "publishing", enabled: true }], metadata: { arbitraryCredential: "example-secret", padding: "x".repeat(400) } }));
  const native = { state: "succeeded", result: { connections: rows, pagination: { cursor: 0, limit: 50, nextCursor: null } } };
  const view = projectAgentConnectionRead("connections.list", native);
  const result = view.result as { connections: Array<{ id: string; name: string }>; pagination: { nextCursor: number | null } };
  assert.equal(result.connections[0]?.name, "Page 0");
  assert.ok(result.connections.length >= 3);
  assert.equal(JSON.stringify(view).includes("example-secret"), false);
  assert.deepEqual(boundedGrowthOperationResult(view), view);
  assert.equal(result.pagination.nextCursor, result.connections.length < rows.length ? result.connections.length : null);
  assert.equal(growthReadResources("connections.list", {}, result).resources.length, result.connections.length);
  assert.equal(native.result.connections.length, 50);
});

test("account model page retains the platform capabilities and omits private metadata", () => {
  const view = projectAgentConnectionRead("content.accounts.list", { state: "succeeded", result: {
    accounts: [{ id: "account-1", display_name: "Page", platform: "FACEBOOK", status: "CONNECTED", handle: null,
      external_account_id: "provider-id", metadata: { secret: "example-secret" }, capabilities: { canPublish: true } }],
    pagination: { cursor: 0, limit: 50, nextCursor: null },
  } });
  const account = (view.result as { accounts: Array<{ capabilities: { canPublish: boolean }; platformAccountId?: string }> }).accounts[0]!;
  assert.equal(account.capabilities.canPublish, true);
  assert.equal(account.platformAccountId, "provider-id");
  assert.equal(JSON.stringify(view).includes("example-secret"), false);
});

test("connection projection covers existing and current Growth agent publications", () => {
  const authority = (publication: typeof growthAgentPublicationV12) => ({ manifestDigest: publication.manifest.digest, policyRevision: publication.policy.revision, destinationProduct: "growth" }) as ProductCapabilityAuthority;
  assert.notEqual(growthAgentPublicationV12.manifest.digest, growthAgentPublicationV13.manifest.digest);
  assert.equal(usesConnectionProjection(authority(growthAgentPublicationV12)), true);
  assert.equal(usesConnectionProjection(authority(growthAgentPublicationV13)), true);
  assert.equal(usesConnectionProjection({ ...authority(growthAgentPublicationV13), policyRevision: "12" }), true);
  assert.equal(usesConnectionProjection({ ...authority(growthAgentPublicationV13), destinationProduct: "agencies" }), false);
});

test("agent preview retains usable asset information without a signed media URL", () => {
  const expires=Math.floor(Date.now()/1000)+3600;
  const native={state:"succeeded",result:{asset:{id:"asset-1",kind:"IMAGE",mimeType:"image/png",fileName:"banner.png",processingStatus:"READY",scanStatus:"CLEAN"},
    previewUrl:`https://media.example.test/public?expires=${expires}&signature=private-signature`}};
  const before=structuredClone(native),view=projectAgentMediaPreview(native);
  assert.deepEqual(view,{state:"succeeded",result:{asset:native.result.asset,previewReady:true}});
  assert.equal(JSON.stringify(boundedGrowthOperationResult(view)).includes("private-signature"),false);
  assert.equal(growthReadResources("content.media.preview",{assetId:"asset-1"},native.result).expiresAt,expires*1000);
  assert.deepEqual(native,before);
});
