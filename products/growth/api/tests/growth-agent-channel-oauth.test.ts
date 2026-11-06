import test from "node:test";
import assert from "node:assert/strict";
import { messagingPermissionKeys } from "../src/agents/growth-agent-channel-oauth.js";
import { instagramScopesForRequest, metaScopesForRequest } from "../src/integrations/connection-permissions.js";

test("Agent channel authorization requests messaging scopes only for each supported login mode", () => {
  const facebook = metaScopesForRequest("facebook", messagingPermissionKeys);
  const instagramPage = metaScopesForRequest("instagram", messagingPermissionKeys);
  const instagramDirect = instagramScopesForRequest(messagingPermissionKeys);

  assert.ok(facebook.includes("pages_messaging"));
  assert.ok(instagramPage.includes("instagram_manage_messages"));
  assert.ok(instagramDirect.includes("instagram_business_manage_messages"));
  for (const scopes of [facebook, instagramPage, instagramDirect]) {
    assert.ok(!scopes.includes("read_insights"));
    assert.ok(!scopes.some(scope => scope.includes("content_publish") || scope.includes("manage_insights")));
  }
});
