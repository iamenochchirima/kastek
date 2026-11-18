import test from "node:test";
import assert from "node:assert/strict";
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
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, {
    resolveScope: async () => scope,
    fetch: async (_url, init) => {
      const command = JSON.parse(String(init?.body));
      commands.push(command);
      switch (command.operation) {
        case "conversations.create":
          return Response.json({ conversation: { id: "conversation-1", featureId: "assistant" } });
        case "turns.submit":
          return Response.json({ task: { id: "task-1", conversationId: "conversation-1", featureId: "assistant", state: "working" }, replayed: false });
        case "tasks.get":
          return Response.json({ task: { id: "task-1", conversationId: "conversation-1", featureId: "assistant", state: "completed" } });
        case "tasks.observe":
          return Response.json({ rootTaskId: "task-1", parentTaskId: null, task: { id: "task-1", state: "completed" },
            operations: [], updates: [], updatesTruncated: false, events: [], nextCursor: null });
        case "reviews.list":
          return Response.json({ reviews: [] });
        case "tasks.instructions":
          return Response.json({ accepted: true });
        case "tasks.cancel":
          return Response.json({ cancelled: true });
        case "tasks.continue":
          return Response.json({ task: { id: "task-2", conversationId: "conversation-1", featureId: "assistant", state: "working" }, replayed: false });
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
    assert.deepEqual(conversation.body, { conversation: { id: "conversation-1", featureId: "assistant" } });

    const turn = await call("POST", "/api/agents/conversations/conversation-1/messages", { requestId: "journey-turn", text: "Hello" });
    assert.equal(turn.status, 202, JSON.stringify(turn.body));
    assert.equal(turn.body.task.id, "task-1");

    const task = await call("GET", "/api/agents/tasks/task-1");
    assert.equal(task.status, 200);
    assert.equal(task.body.task.state, "completed");

    const activity = await call("GET", "/api/agents/tasks/task-1/activity");
    assert.equal(activity.status, 200);
    assert.equal(activity.body.rootTaskId, "task-1");

    const reviews = await call("GET", "/api/agents/tasks/task-1/reviews");
    assert.equal(reviews.status, 200);
    assert.deepEqual(reviews.body.reviews, []);

    assert.equal((await call("POST", "/api/agents/tasks/task-1/instructions", { requestId: "journey-instruction", instruction: "Keep it short." })).status, 200);
    assert.equal((await call("POST", "/api/agents/tasks/task-1/cancel", { requestId: "journey-cancel" })).status, 200);
    assert.equal((await call("POST", "/api/agents/tasks/task-1/continue", { requestId: "journey-continue" })).status, 200);

    assert.deepEqual(commands.map(command => command.operation), [
      "features.list", "conversations.create", "turns.submit", "tasks.get", "tasks.observe", "reviews.list",
      "tasks.instructions", "tasks.cancel", "tasks.continue",
    ]);
    for (const command of commands) {
      assert.equal(command.version, "1");
      assert.equal(command.tenantId, "business");
      assert.deepEqual(command.actor, actor);
      assert.equal(typeof command.requestId, "string");
    }

    member = false;
    const denied = await call("GET", "/api/agents/tasks/task-1");
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});
