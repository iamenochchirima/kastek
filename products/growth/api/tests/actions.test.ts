import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { apiJson, canonicalJson, SerdeFloat } from "@kasitek-labs/server-support/json";
import { catalog } from "../src/actions/catalog.js";
import {
  ActionError,
  actionId,
  initialRegistry,
  growthRegistry,
  builtInDefinitions,
  type IncomingActionRequest,
} from "../src/actions/index.js";
import {
  ExecutionPipeline,
  RunHandle,
  PortError,
  type ExecutionPorts,
} from "../src/execution/index.js";
import {
  aggregateBatchStatus,
  platformMediaError,
  textLengthError,
  safeErrorMessage,
  batchTargetView,
  postSnapshotHash,
} from "../src/capabilities/content-batch.js";
import {
  splitAgentChannelTarget,
  prepareAgentChannels,
} from "../src/capabilities/content-adapter.js";
import type { SocialPost } from "../src/services/social/types.js";
const incoming = (): IncomingActionRequest => ({
  invocation_id: "invoke",
  correlation_id: "trace",
  causation_id: null,
  action: actionId("customer.search", "1.0.0"),
  actor: {
    kind: "direct_user",
    id: "user",
    realm: "direct",
    authenticated_client_id: null,
    delegated_by: null,
  },
  scope: { type: "direct", organisation_id: "org" },
  input: { query: "alice" },
  idempotency_key: null,
  approval_id: null,
  requested_at: new Date("2026-01-01Z"),
  deadline: null,
});

test("tagged action enums keep their Serde wire shape", () => {
  assert.equal(
    apiJson({
      type: "tenant_staff",
      workspace_id: "workspace",
      client_access: { type: "assigned", client_ids: ["client-a", "client-b"] },
    }),
    '{"client_access":{"client_ids":["client-a","client-b"],"type":"assigned"},"type":"tenant_staff","workspace_id":"workspace"}',
  );
  assert.equal(
    apiJson({ status: "approval_required", approval_id: "approval" }),
    '{"approval_id":"approval","status":"approval_required"}',
  );
});

function fixture(events: string[]): ExecutionPorts {
  return {
    clock: { now: () => new Date("2026-01-02Z") },
    identity: {
      evaluate: async () => {
        events.push("identity");
        return { type: "allow" };
      },
    },
    access: {
      evaluate: async () => {
        events.push("access");
        return { type: "allow" };
      },
    },
    entitlements: {
      evaluate: async () => {
        events.push("entitlements");
        return { type: "allow" };
      },
    },
    policy: {
      evaluate: async () => {
        events.push("policy");
        return { type: "allow" };
      },
    },
    idempotency: {
      evaluate: async () => {
        events.push("idempotency");
        return { type: "proceed" };
      },
    },
    journal: {
      recordDecision: async (_, result) => {
        events.push(`decision:${result.type}`);
      },
      start: async () => {
        events.push("start");
        return new RunHandle("run");
      },
      finish: async (_, result) => {
        events.push(`finish:${result.type}`);
      },
    },
    runner: {
      run: async () => {
        events.push("run");
        return {
          type: "completed",
          output: { customers: [], nextCursor: null },
        };
      },
    },
  };
}
test("all 19 schemas and policy definitions match the original Rust fixture export", () => {
  assert.equal(
    createHash("sha256").update(canonicalJson(catalog)).digest("hex"),
    "e90e0eb022b9ae05928d5f0ecc01f3688d28b5810089ebbc3c652e5145ceec82",
  );
  assert.equal([...initialRegistry().definitions()].length, 3);
  const registry = growthRegistry();
  assert.equal([...registry.definitions()].length, 19);
  assert.throws(() => actionId("Customer..search", "1.0.0"));
  assert.throws(() => actionId("customer.search", "1.0"));
  assert.throws(() => registry.get(actionId("customer.search", "2.0.0")));
  assert.throws(() => registry.register(builtInDefinitions()[0]!));
  registry.validateRequest({
    ...incoming(),
    input: { query: "alice", limit: 100n },
  });
  assert.throws(
    () =>
      registry.validateRequest({
        ...incoming(),
        input: { query: "alice", limit: 101n },
      }),
    ActionError,
  );
  assert.throws(
    () =>
      registry.validateRequest({
        ...incoming(),
        input: { query: "alice", limit: new SerdeFloat(1.5) },
      }),
    ActionError,
  );
  assert.throws(
    () =>
      registry.validateRequest({
        ...incoming(),
        actor: { ...incoming().actor, realm: "white_label" },
      }),
    ActionError,
  );
  assert.equal(
    [
      ...registry.discoverableDefinitions({
        runtime: "direct",
        actor: "api_client",
        lifecycle: "public",
        grants: new Set(),
      }),
    ].length,
    0,
  );
});
test("execution preserves gate order, journal completion and idempotent replay", async () => {
  const events: string[] = [],
    ports = fixture(events),
    pipeline = new ExecutionPipeline(initialRegistry(), ports);
  assert.equal(
    (await pipeline.execute(incoming())).outcome.status,
    "succeeded",
  );
  assert.deepEqual(events, [
    "identity",
    "access",
    "entitlements",
    "policy",
    "idempotency",
    "start",
    "run",
    "finish:succeeded",
  ]);
  events.length = 0;
  ports.idempotency.evaluate = async () => {
    events.push("idempotency");
    return {
      type: "existing",
      outcome: { status: "accepted", operation_id: "existing" },
    };
  };
  assert.deepEqual((await pipeline.execute(incoming())).outcome, {
    status: "accepted",
    operation_id: "existing",
  });
  assert.deepEqual(events, [
    "identity",
    "access",
    "entitlements",
    "policy",
    "idempotency",
  ]);
});
test("execution expires deadlines, journals approval and preserves dependency failures", async () => {
  const events: string[] = [],
    ports = fixture(events),
    pipeline = new ExecutionPipeline(initialRegistry(), ports);
  assert.deepEqual(
    (
      await pipeline.execute({
        ...incoming(),
        deadline: new Date("2026-01-01T01:00Z"),
      })
    ).outcome,
    { status: "failed", error_code: "deadline_exceeded" },
  );
  assert.deepEqual(events, ["decision:failed"]);
  events.length = 0;
  ports.policy.evaluate = async () => ({
    type: "approval_required",
    approval_id: "approval",
  });
  assert.deepEqual((await pipeline.execute(incoming())).outcome, {
    status: "approval_required",
    approval_id: "approval",
  });
  assert.deepEqual(events, [
    "identity",
    "access",
    "entitlements",
    "decision:approval_required",
  ]);
  ports.journal.recordDecision = async () => {
    throw PortError.unavailable();
  };
  assert.deepEqual((await pipeline.execute(incoming())).outcome, {
    status: "failed",
    error_code: "temporarily_unavailable",
  });
});
test("execution rejects invalid runner outputs and unconfirmed journal completion", async () => {
  const events: string[] = [],
    ports = fixture(events),
    pipeline = new ExecutionPipeline(initialRegistry(), ports);
  ports.runner.run = async () => ({
    type: "completed",
    output: { customers: [], private: true },
  });
  assert.deepEqual((await pipeline.execute(incoming())).outcome, {
    status: "failed",
    error_code: "invalid_output",
  });
  assert.equal(events.at(-1), "finish:failed");
  ports.journal.finish = async () => {
    throw PortError.unavailable();
  };
  assert.deepEqual((await pipeline.execute(incoming())).outcome, {
    status: "failed",
    error_code: "temporarily_unavailable",
  });
});
test("content admission keeps unknown outcomes blocked and approval hashes stable across execution facts", () => {
  assert.equal(aggregateBatchStatus(3, 2, 0, 0, 0, 1, 0, 0), "PARTIAL");
  assert.equal(aggregateBatchStatus(3, 0, 1, 1, 0, 1, 0, 0), "PROCESSING");
  assert.equal(aggregateBatchStatus(3, 0, 0, 0, 0, 0, 3, 0), "BLOCKED");
  assert.equal(aggregateBatchStatus(3, 1, 0, 0, 1, 0, 0, 1), "UNKNOWN");
  assert.deepEqual(platformMediaError("INSTAGRAM", ["IMAGE", "IMAGE"], 2), [
    "media_count_exceeded",
    "INSTAGRAM accepts at most 1 media item",
  ]);
  assert.equal(platformMediaError("TIKTOK", ["VIDEO"], 1), undefined);
  assert.equal(textLengthError("X", "😀".repeat(280)), undefined);
  assert.equal(
    textLengthError("X", "😀".repeat(281))?.[0],
    "text_length_exceeded",
  );
  assert.equal(
    safeErrorMessage("Bearer sensitive"),
    "The provider returned an error while publishing this target",
  );
  assert.equal(
    batchTargetView({
      platform: "X",
      display_name: "Account",
      handle: null,
      status: "FAILED",
      retryable: true,
      error_code: "provider_auth_required",
      error_message: "Unauthorized",
      metadata: { requiredCapability: "SOCIAL_PUBLISH" },
    }).remediationMode,
    "RECONNECT",
  );
  assert.deepEqual(splitAgentChannelTarget("Facebook: (Example)"), [
    "FACEBOOK",
    "Example",
  ]);
  assert.deepEqual(
    prepareAgentChannels({
      channels: ["unknown"],
      channelSelections: { FACEBOOK: "account" },
    }),
    ["FACEBOOK"],
  );
  const post = {
    id: "post",
    content: "Hello",
    channels: ["FACEBOOK"],
    variants: [],
    media: [],
    publishJobs: [],
    status: "DRAFT",
  } as unknown as SocialPost;
  const targets = [
    { jobId: "b", platform: "FACEBOOK", channelConnectionId: "channel" },
    { jobId: "a", platform: "X", channelConnectionId: null },
  ];
  const original = postSnapshotHash(post, targets);
  post.status = "PUBLISHED";
  assert.equal(postSnapshotHash(post, [...targets].reverse()), original);
  post.content = "Changed";
  assert.notEqual(postSnapshotHash(post, targets), original);
});
