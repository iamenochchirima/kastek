import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { generateKeyPair, exportPKCS8 } from "jose";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { registerGrowthAgentRoutes } from "../src/agents/routes.js";
import type { CoreContext } from "../src/context.js";

const origin = "http://localhost:3107";
const actor = { issuer: "https://growth.kasitek.co.za/identity", subject: "member" };
const scope = { tenantId: "business", actor };

/**
 * Oracle for the Growth cutover. It drives the Growth public routes and records the
 * signed commands Growth sends to Agents. The operation names change at cutover; the
 * public API and its response shapes must not.
 */
test("Growth journey preserves its public API while recording the signed command sequence", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  let member = true;
  const query = async () => ({ rows: member ? [{ name: "Business", role: "OWNER" }] : [] });
  const core = {
    config: readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", FRONTEND_URL: origin,
      AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: await exportPKCS8(keys.privateKey) }),
    pool: { query, connect: async () => ({ query, release() {} }) },
  } as unknown as CoreContext;
  const commands: Array<Record<string, any>> = [];
  const conversationId = randomUUID(), taskId = randomUUID(), nextTaskId = randomUUID();
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, {
    resolveScope: async () => scope,
    fetch: async (_url, init) => {
      const command = JSON.parse(String(init?.body));
      commands.push(command);
      switch (command.operation) {
        case "conversations.create":
          return Response.json({ conversation: { id: conversationId, featureId: "assistant" } });
        case "runs.start":
          return Response.json({ task: { id: taskId, conversationId, featureId: "assistant", state: "working" }, replayed: false });
        case "runs.get":
          return Response.json({ task: { id: taskId, conversationId, featureId: "assistant", state: "completed" } });
        case "runs.activity":
          return Response.json({ rootTaskId: taskId, parentTaskId: null, task: { id: taskId, state: "completed" },
            operations: [], updates: [], updatesTruncated: false, events: [], nextCursor: null });
        case "reviews.list":
          return Response.json({ reviews: [] });
        case "runs.steer":
          return Response.json({ accepted: true });
        case "runs.cancel":
          return Response.json({ cancelled: true });
        case "runs.continue":
          return Response.json({ task: { id: nextTaskId, conversationId, featureId: "assistant", state: "working" }, replayed: false });
        default:
          return Response.json({ ok: true });
      }
    },
  })]);
  const call = async (method: "GET" | "POST", url: string, payload?: unknown) => {
    const response = await app.inject({ method, url, headers: { origin }, ...(payload === undefined ? {} : { payload }) });
    return { status: response.statusCode, body: response.json() };
  };
  try {
    const conversation = await call("POST", "/api/agents/conversations", { requestId: "journey-conversation", featureId: "assistant" });
    assert.equal(conversation.status, 201, JSON.stringify(conversation.body));
    assert.deepEqual(conversation.body, { conversation: { id: conversationId, featureId: "assistant" } });

    const turn = await call("POST", `/api/agents/conversations/${conversationId}/messages`, { requestId: "journey-turn", text: "Hello" });
    assert.equal(turn.status, 202, JSON.stringify(turn.body));
    assert.equal(turn.body.task.id, taskId);

    const task = await call("GET", `/api/agents/tasks/${taskId}`);
    assert.equal(task.status, 200);
    assert.equal(task.body.task.state, "completed");

    const activity = await call("GET", `/api/agents/tasks/${taskId}/activity`);
    assert.equal(activity.status, 200);
    assert.equal(activity.body.rootTaskId, taskId);

    const reviews = await call("GET", `/api/agents/tasks/${taskId}/reviews`);
    assert.equal(reviews.status, 200);
    assert.deepEqual(reviews.body.reviews, []);

    assert.equal((await call("POST", `/api/agents/tasks/${taskId}/instructions`, { requestId: "journey-instruction", instruction: "Keep it short." })).status, 200);
    assert.equal((await call("POST", `/api/agents/tasks/${taskId}/cancel`, { requestId: "journey-cancel" })).status, 200);
    assert.equal((await call("POST", `/api/agents/tasks/${taskId}/continue`, { requestId: "journey-continue" })).status, 200);

    assert.deepEqual(commands.map(command => command.operation), [
      "features.list", "conversations.create", "runs.start", "runs.get", "runs.activity", "reviews.list",
      "runs.steer", "runs.cancel", "runs.continue",
    ]);
    for (const command of commands) {
      assert.equal(command.version, "1");
      assert.equal(command.tenantId, "business");
      assert.deepEqual(command.actor, actor);
      assert.equal(typeof command.requestId, "string");
    }
    const shared = commands.slice(1);
    for (const command of shared) assert.equal(command.product, "growth");
    assert.deepEqual(shared[0]!.input.target, { kind: "product_feature", featureId: "assistant" });
    assert.equal(shared[1]!.input.conversationId, conversationId);
    assert.equal(shared[1]!.input.message, "Hello");

    member = false;
    const denied = await call("GET", `/api/agents/tasks/${taskId}`);
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});
