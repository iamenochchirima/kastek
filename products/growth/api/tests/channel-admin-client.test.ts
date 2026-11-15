import assert from "node:assert/strict";
import test from "node:test";
import { channelFailure } from "../src/agents/channel-admin-client.js";

const error = (code: string) => JSON.stringify({ error: { code, message: "private provider detail" } });

test("known Agents channel failures map to actionable Growth errors", () => {
  const duplicate = channelFailure(409, error("TELEGRAM_BOT_ALREADY_CONNECTED"));
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.code, "telegram_bot_already_connected");

  const stale = channelFailure(409, error("CHANNEL_CONNECTION_CHANGED"));
  assert.equal(stale.status, 409);
  assert.equal(stale.code, "agent_channel_conflict");

  const missing = channelFailure(404, error("GROWTH_CHANNEL_ORGANIZATION_UNAVAILABLE"));
  assert.equal(missing.status, 404);
  assert.equal(missing.code, "agent_channel_not_found");

  const unavailable = channelFailure(503, error("CHANNEL_SETUP_NOT_CONFIGURED"));
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.code, "agent_channel_unavailable");

  assert.equal(JSON.stringify([duplicate, stale, missing, unavailable]).includes("private provider detail"), false);
});

test("unexpected channel failures do not expose provider text", () => {
  const denied = channelFailure(403, error("UNEXPECTED"));
  assert.equal(denied.status, 403);
  assert.equal(denied.code, "agent_channel_denied");
  assert.equal(denied.message, "Agents could not complete the channel request");

  const outage = channelFailure(502, "not json");
  assert.equal(outage.status, 503);
  assert.equal(outage.code, "agent_channel_unavailable");

  const oversized = channelFailure(500, "x".repeat(20_000));
  assert.equal(oversized.status, 502);
  assert.equal(oversized.code, "agent_channel_response_invalid");
});
