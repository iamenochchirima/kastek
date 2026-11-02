import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { Ajv2020 } from "ajv/dist/2020.js";
import { parseGrowthDraftProposal } from "@kasitek-labs/contracts";
import { readConfig } from "../src/config.js";
import { buildApp } from "../src/app.js";
import { GrowthAgentReviewStore } from "../src/agents/reviews.js";
import { registerGrowthAgentRoutes } from "../src/agents/routes.js";
import { growthAgentDigest } from "../src/agents/security.js";
import { growthAgentPublication, growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8 } from "../src/agents/manifest.js";
import { growthAgentSetupRequest } from "../src/workers/growth-agent-setup.js";
import type { GrowthAgentSetupJob } from "../src/agents/setup.js";
import type { CoreContext } from "../src/context.js";

const origin = "http://localhost:3107", actor = { issuer: "https://growth.kasitek.co.za/identity", subject: "member" };
test("Growth active instructions and continuation retain signed scope, input bounds and request identity", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true }), privateKey = await exportPKCS8(keys.privateKey);
  let member = true;
  const query = async () => ({ rows: member ? [{ name: "Business" }] : [] });
  const core = { config: readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", FRONTEND_URL: origin, AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: privateKey }), pool: { query, connect: async () => ({ query, release() {} }) } } as unknown as CoreContext;
  const forwarded: Array<Record<string, unknown>> = [];
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, { resolveScope: async () => ({ tenantId: "business", actor }), fetch: async (_url, init) => {
    const command = JSON.parse(String(init?.body)), token = (init!.headers as Record<string, string>).authorization.slice(7);
    const claims = await jwtVerify(token, keys.publicKey, { issuer: "https://growth.kasitek.co.za", audience: "agents-product-api" });
    assert.equal(claims.payload.sub, "growth-api");
    forwarded.push(command);
    return Response.json(command.operation === "tasks.instructions" ? { accepted: true } : { task: { id: "task", state: "working" } });
  } })]);
  try {
    const input = { requestId: "stable-instruction", instruction: "Focus on the evidence" };
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/tasks/task/instructions", payload: input })).statusCode, 403);
    for (let i = 0; i < 2; i++) {
      const response = await app.inject({ method: "POST", url: "/api/agents/tasks/task/instructions", headers: { origin }, payload: input });
      assert.equal(response.statusCode, 200, response.body); assert.deepEqual(response.json(), { accepted: true });
    }
    assert.deepEqual(forwarded[0], forwarded[1]);
    assert.deepEqual(forwarded[0], { version: "1", requestId: input.requestId, tenantId: "business", actor, operation: "tasks.instructions", input: { taskId: "task", instruction: input.instruction } });
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/tasks/task/instructions", headers: { origin }, payload: { ...input, instruction: "x".repeat(4001) } })).statusCode, 400);
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/tasks/task/instructions", headers: { origin }, payload: { ...input, actor: "another" } })).statusCode, 400);
    const resumed = await app.inject({ method: "POST", url: "/api/agents/tasks/task/continue", headers: { origin }, payload: { requestId: "continue-request" } });
    assert.equal(resumed.statusCode, 200, resumed.body); assert.equal(forwarded.at(-1)?.operation, "tasks.continue");
    member = false;
    assert.equal((await app.inject({ method: "POST", url: "/api/agents/tasks/task/continue", headers: { origin }, payload: { requestId: "denied" } })).statusCode, 403);
    assert.equal(forwarded.length, 3);
  } finally { await app.close(); }
});

test("managed setup pins every retained publication and the current canonical revision", () => {
  const job = { requestId: "setup", orgId: "business", modelProfileId: "default", modelProfileRevision: "1" } as GrowthAgentSetupJob;
  for (const publication of [growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5, growthAgentPublicationV6, growthAgentPublicationV7, growthAgentPublicationV8, growthAgentPublication]) {
    const request = growthAgentSetupRequest({ ...job, defaultsRevision: publication.manifest.revision });
    assert.deepEqual(request.publication, publication);
    assert.equal(request.defaultsRevision, request.publication!.manifest.revision);
    assert.equal(request.defaultsRevision, request.publication!.policy.revision);
  }
});

test("retained Growth V3 publication preserves adaptive delegation and its draft contract", () => {
  const growthAgentPublication = growthAgentPublicationV3;
  assert.equal(growthAgentPublication.manifest.revision, "3");
  assert.equal(growthAgentPublication.policy.optionalCapabilities.delegation, true);
  const draft = growthAgentPublication.manifest.operations.find(operation => operation.operation === "draft.prepare")!;
  const validate = new Ajv2020({ strict: false }).compile(draft.inputSchema);
  const input = { draft: { title: "Launch", content: "Launch draft", channels: ["INSTAGRAM"], channelSelections: { INSTAGRAM: "account" } } };
  assert.equal(validate(input), true); assert.deepEqual(parseGrowthDraftProposal(input.draft), input.draft);
  for (const changed of [{ title: "" }, { channels: ["OTHER"] }, { channels: ["INSTAGRAM", "INSTAGRAM"] }, { channelSelections: { OTHER: "account" } }, { variants: [{ platform: "OTHER", content: "Text" }] }]) assert.equal(validate({ draft: { ...input.draft, ...changed } }), false);
  const content = growthAgentPublication.presets.find(preset => preset.id === "content")!;
  assert.match(content.instructions, /Return requested drafts in chat/);
  assert(growthAgentPublication.presets.every(preset => ["user-provided scenarios", "Keep internal tool names", "use only supplied or verified product attributes", "check specialist contributions"].every(guidance => preset.instructions.includes(guidance))));
  assert.match(growthAgentPublication.presets.find(preset=>preset.id==="assistant")!.instructions,/agents_discover with \{\}/);
  assert.match(growthAgentPublication.presets.find(preset=>preset.id==="assistant")!.instructions,/never invent a specialist or binding/);
  assert.equal(growthAgentPublicationV2.manifest.revision, "2");
  // Captured from the pre-upgrade HEAD module, not reconstructed from the new descriptor.
  assert.equal(growthAgentPublicationV2.manifest.digest, "3776590e04bc9c215aedd6242e977be5df13ce8d7e4cea5d0bb045c181f0b6b1");
  assert.equal(growthAgentDigest(growthAgentPublicationV2), "0f95cefad5eaf3c5d136c829044778c1aa38f325dda3df18c86606894a12233b");
  assert.equal(growthAgentPublicationV2.policy.optionalCapabilities.delegation, false);
  const job = { requestId: "setup", orgId: "business", modelProfileId: "default", modelProfileRevision: "1" } as GrowthAgentSetupJob;
  assert.deepEqual(growthAgentSetupRequest({ ...job, defaultsRevision: "2" }).publication, growthAgentPublicationV2);
  assert.deepEqual(growthAgentSetupRequest({ ...job, defaultsRevision: "3" }).publication, growthAgentPublicationV3);
  for (const publication of [growthAgentPublicationV2, growthAgentPublicationV3, growthAgentPublicationV4, growthAgentPublicationV5]) {
    assert.deepEqual(growthAgentSetupRequest({ ...job, defaultsRevision: publication.manifest.revision }).publication, publication);
  }
});


test("Growth root review routes authorize child membership before editing or deciding the exact child", async (t) => {
  const keys = await generateKeyPair("RS256", { extractable: true }), privateKey = await exportPKCS8(keys.privateKey);
  const query = async () => ({ rows: [{ name: "Business" }] });
  const core = { config: readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", FRONTEND_URL: origin, AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: privateKey }), pool: { query, connect: async () => ({ query, release() {} }) } } as unknown as CoreContext;
  const review = { id: "review", taskId: "actual-child", conversationId: "conversation", featureId: "content" as const, kind: "content_draft" as const, payloadDigest: "exact-digest", state: "proposed" as const, draft: { title: "Launch", content: "Draft", channels: [], channelSelections: {} }, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), result: null };
  const decisions: string[] = [], revisions: string[] = [], wakes: string[] = [];
  t.mock.method(GrowthAgentReviewStore.prototype, "decide", async (_scope, reviewId, input, taskId) => {
    assert.equal(reviewId, review.id); assert.equal(input.payloadDigest, review.payloadDigest);
    decisions.push(taskId!); return { review: { ...review, state: "approved" as const } };
  });
  t.mock.method(GrowthAgentReviewStore.prototype, "revise", async (_scope, taskId, reviewId) => {
    assert.equal(reviewId, review.id); revisions.push(taskId); return { review };
  });
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, { resolveScope: async () => ({ tenantId: "business", actor }), fetch: async (_url, init) => {
    const command = JSON.parse(String(init?.body));
    if (command.operation === "reviews.list") return Response.json({ reviews: command.input.taskId === "root" ? [review] : [] });
    assert.equal(command.operation, "reviews.decide"); wakes.push(command.input.taskId); return Response.json({ reviewId: review.id, state: "approved" });
  } })]);
  try {
    const visible = await app.inject("/api/agents/tasks/root/reviews");
    assert.equal(visible.statusCode, 200, visible.body); assert.equal(visible.json().reviews[0].taskId, "root");
    const edited = await app.inject({ method: "PATCH", url: "/api/agents/tasks/root/reviews/review", headers: { origin }, payload: { requestId: "edit", payloadDigest: review.payloadDigest, draft: review.draft } });
    assert.equal(edited.statusCode, 200, edited.body); assert.deepEqual(revisions, ["actual-child"]); assert.equal(edited.json().review.taskId, "root");
    const decision = { requestId: "decision", payloadDigest: review.payloadDigest, decision: "approve" };
    const denied = await app.inject({ method: "POST", url: "/api/agents/tasks/other-root/reviews/review/decision", headers: { origin }, payload: decision });
    assert.equal(denied.statusCode, 404); assert.equal(decisions.length, 0);
    const unscoped = await app.inject({ method: "POST", url: "/api/agents/reviews/review/decision", headers: { origin }, payload: decision });
    assert.equal(unscoped.statusCode, 400); assert.equal(decisions.length, 0); assert.equal(wakes.length, 0);
    const accepted = await app.inject({ method: "POST", url: "/api/agents/tasks/root/reviews/review/decision", headers: { origin }, payload: decision });
    assert.equal(accepted.statusCode, 200, accepted.body); assert.deepEqual(decisions, ["actual-child"]); assert.deepEqual(wakes, ["root"]); assert.equal(accepted.json().review.taskId, "root");
  } finally { await app.close(); }
});

test("Growth specialist inspection bounds output and requires current root scope and direct lineage", async () => {
  const keys = await generateKeyPair("RS256", { extractable: true }), privateKey = await exportPKCS8(keys.privateKey);
  let member = true, redacted = false, invalidRoot = false;
  const query = async () => ({ rows: member ? [{ name: "Business" }] : [] });
  const core = { config: readConfig({ DATABASE_URL: "postgres://unused", LOG_LEVEL: "silent", FRONTEND_URL: origin, AGENTS_PRODUCT_API_URL: "https://agents.example.test", GROWTH_AGENTS_SIGNING_PRIVATE_KEY: privateKey }), pool: { query, connect: async () => ({ query, release() {} }) } } as unknown as CoreContext;
  const roots: string[] = [];
  const app = await buildApp(core, [(app, core) => registerGrowthAgentRoutes(app, core, { resolveScope: async () => ({ tenantId: "business", actor }), fetch: async (_url, init) => {
    const command = JSON.parse(String(init?.body)); assert.equal(command.operation, "tasks.export"); roots.push(command.input.taskId);
    if (command.input.taskId !== "root") return Response.json({ error: "Task unavailable", code: "TASK_MISSING" }, { status: 404 });
    return Response.json({ capture: { schemaVersion: "execution-export.v1", rootTaskId: invalidRoot ? "other" : "root", secret: "never project", tasks: [
      { id: "child", parentTaskId: "root", state: "completed", output: redacted ? null : "😀".repeat(4100), input: "private prompt", modelCalls: ["private receipt"] },
      { id: "foreign", parentTaskId: "another-root", state: "completed", output: "foreign" },
      { id: "nested", parentTaskId: "child", state: "completed", output: "nested" },
    ] } });
  } })]);
  try {
    const first = await app.inject("/api/agents/tasks/root/specialists/child/result"); assert.equal(first.statusCode, 200, first.body);
    assert.equal(first.headers["cache-control"], "no-store");
    assert.deepEqual(first.json(), { taskId: "child", state: "completed", available: true, output: "😀".repeat(4096), nextOffset: 4096 });
    assert.equal(Buffer.byteLength(first.json().output), 16384); assert.equal(first.body.includes("private"), false);
    const second = await app.inject("/api/agents/tasks/root/specialists/child/result?offset=4096"); assert.equal(second.json().output, "😀".repeat(4)); assert.equal(second.json().nextOffset, null);
    for (const child of ["foreign", "nested", "missing"]) assert.equal((await app.inject(`/api/agents/tasks/root/specialists/${child}/result`)).statusCode, 404);
    assert.equal((await app.inject("/api/agents/tasks/another-root/specialists/child/result")).statusCode, 404);
    assert.equal((await app.inject("/api/agents/tasks/root/specialists/child/result?offset=-1")).statusCode, 400);
    redacted = true; assert.equal((await app.inject("/api/agents/tasks/root/specialists/child/result")).json().available, false);
    invalidRoot = true; assert.equal((await app.inject("/api/agents/tasks/root/specialists/child/result")).statusCode, 502);
    member = false; const count = roots.length; assert.equal((await app.inject("/api/agents/tasks/root/specialists/child/result")).statusCode, 403); assert.equal(roots.length, count);
  } finally { await app.close(); }
});
