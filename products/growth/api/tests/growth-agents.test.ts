import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { exportPKCS8, exportSPKI, generateKeyPair, jwtVerify, SignJWT } from "jose";
import { parseGrowthAgentAction, parseGrowthAgentCommand, parseGrowthAgentContext, parseGrowthDraftProposal } from "@kasitek-labs/contracts";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { GrowthAgentClient } from "../src/agents/client.js";
import { registerGrowthAgentRoutes } from "../src/agents/routes.js";
import { growthAgentDigest, verifyGrowthAgentAction } from "../src/agents/security.js";
import type { CoreContext } from "../src/context.js";
const config = (env: Record<string, string> = {}) => readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", ...env });
const actor = { issuer: "https://growth.kasitek.co.za/identity", subject: "user" };
const action = () => ({ version: "1", requestId: "request", operationId: "operation", tenantId: "org", actor, taskId: "task", conversationId: "conversation", featureId: "content", context: null, operation: "workspace.read", input: {} });
test("Growth contracts reject malformed context and hidden mutation authority", () => {
  assert.throws(() => parseGrowthAgentContext({ kind: "content_post" }));
  assert.throws(() => parseGrowthAgentContext({ kind: "workspace", grant: "all" }));
  assert.throws(() => parseGrowthAgentContext({ kind: "analytics_report", range: { from: "2030-02-01", to: "2030-01-01", timezone: "UTC" } }));
  assert.throws(() => parseGrowthDraftProposal({ title: "Title", content: "Content", channels: ["FACEBOOK"], channelSelections: {}, status: "PUBLISHED" }));
  assert.deepEqual(parseGrowthDraftProposal({ title: "Title", content: "Content", channels: [], channelSelections: {} }).channels, []);
  assert.throws(() => parseGrowthAgentCommand({ version: "1", requestId: "one", tenantId: "org", actor, operation: "tasks.cancel", input: {} }));
  assert.throws(() => parseGrowthAgentCommand({ version: "1", requestId: "one", tenantId: "org", actor, operation: "turns.submit", input: { conversationId: "one", text: "hello", actor: "other" } }));
  assert.throws(() => parseGrowthAgentAction({ ...action(), input: { sql: "SELECT *" } }));
  assert.throws(() => parseGrowthAgentAction({ ...action(), operation: "constructor" }));
});
test("Growth signing binds full scope and fixed audience, rejects changed body and excessive lifetime", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true });
  const privateKey = await exportPKCS8(keys.privateKey), publicKey = await exportSPKI(keys.publicKey);
  const body = action(), conf = config({ AGENTS_PRODUCT_ACTION_PUBLIC_KEY: publicKey });
  const sign = (value: unknown, audience = "growth-agent-actions", lifetime = 60) => new SignJWT({ requestDigest: growthAgentDigest(value) })
    .setProtectedHeader({ alg: "RS256", kid: "agents-v1" }).setIssuer("https://agents.kasitek.co.za").setSubject("agents-worker")
    .setAudience(audience).setIssuedAt().setExpirationTime(Math.floor(Date.now() / 1000) + lifetime).setJti(randomUUID()).sign(keys.privateKey);
  const token = await sign(body);
  await verifyGrowthAgentAction(conf, `Bearer ${token}`, body);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${token}`, { ...body, tenantId: "foreign" }), /unauthorized/);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${await sign(body, "agents-product-api")}`, body), /unauthorized/);
  await assert.rejects(verifyGrowthAgentAction(conf, `Bearer ${await sign(body, "growth-agent-actions", 300)}`, body), /unauthorized/);
  const client = new GrowthAgentClient(config({ AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: privateKey }), {
    fetch: (async (url, init) => {
      assert.equal(url, "https://agents.example.test/internal/v1/products/growth/commands");
      const request = JSON.parse(String(init?.body)), bearer = (init?.headers as Record<string, string>).authorization.slice(7);
      const claims = await jwtVerify(bearer, keys.publicKey, { audience: "agents-product-api", issuer: "https://growth.kasitek.co.za", subject: "growth-api" });
      assert.equal(claims.payload.requestDigest, growthAgentDigest(request));
      assert.deepEqual(request.actor, actor); assert.equal(request.requestId, "stable-request");
      return Response.json({ tasks: [], nextCursor: null });
    }) as typeof fetch,
  });
  assert.deepEqual(await client.command({ tenantId: "org", actor }, "tasks.list", {}, "stable-request"), { tasks: [], nextCursor: null });
});
test("Growth browser bridge enforces origin and membership and reports truthful unavailability", async () => {
  let member = true;
  const core = { config: config(), pool: { query: async () => ({ rows: member ? [{ name: "Business" }] : [] }) } } as unknown as CoreContext;
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, { resolveScope: async () => ({ tenantId: "org", actor }) })]);
  try {
    const bootstrap = await app.inject("/api/agents/bootstrap");
    assert.equal(bootstrap.statusCode, 200); assert.equal(bootstrap.json().features.length, 4);
    assert.equal(bootstrap.json().features.every((feature: { ready: boolean }) => !feature.ready), true);
    assert.deepEqual(bootstrap.json().scope, { businessId: "org", userId: "user", businessName: "Business" });
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/conversations", payload: { requestId: "one", featureId: "assistant" } })).statusCode, 403);
    member = false; assert.equal((await app.inject("/api/agents/bootstrap")).statusCode, 403);
  } finally { await app.close(); }
});
