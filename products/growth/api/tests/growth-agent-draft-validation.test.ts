import test from "node:test";
import assert from "node:assert/strict";
import type { GrowthAgentAction } from "@kasitek-labs/contracts";
import type { CoreContext } from "../src/context.js";
import { GrowthAgentReviewStore } from "../src/agents/reviews.js";
import { ApiError } from "../src/error.js";

test("invalid model draft channels produce recoverable argument feedback before any review or write", async () => {
  let queries = 0;
  const core = { pool: { query: async () => { queries++; throw new Error("Invalid draft reached the database"); } } } as unknown as CoreContext;
  const store = new GrowthAgentReviewStore(core);
  const action = { version: "1", requestId: "request", operationId: "operation", tenantId: "org",
    actor: { issuer: "https://growth.kasitek.co.za/identity", subject: "user" }, taskId: "task",
    conversationId: "conversation", featureId: "content", context: null, operation: "draft.prepare",
    input: { draft: { title: "Morning Cup", content: "Draft copy", channels: ["social", "whatsapp"], channelSelections: {} } },
  } as GrowthAgentAction<"draft.prepare">;
  await assert.rejects(store.prepare(action), (error: unknown) => {
    assert(error instanceof ApiError);
    assert.equal(error.status, 422);
    assert.equal(error.code, "agent_tool_arguments_invalid");
    return true;
  });
  assert.equal(queries, 0);
});
