import { randomBytes, randomUUID, createHash } from "node:crypto";
import Fastify from "fastify";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { nextSupportOpening, recordHandoffWaiting, SupportWaitingService } from "../src/product/inbox/support-waiting";
import { dispatchSupportWaitingOnce } from "../src/product/inbox/support-waiting-runtime";
import { registerSupportAlertRoutes } from "../src/product/inbox/support-alert-routes";
import { transaction } from "../src/infrastructure/database";
import { registerChannelPorts } from "../src/infrastructure/channel-ports";
import { connectFixtureModel } from "./model-fixture";
import { dropClosedTestDatabase } from "./support/database-cleanup";

describe("support waiting hours", () => {
  it("preserves unknown hours and finds a configured next opening across DST", () => {
    const now = new Date("2026-10-31T22:00:00Z");
    expect(nextSupportOpening(undefined, now)).toBe(now);
    expect(nextSupportOpening({ timeZone: "America/New_York", intervals: [{ day: 0, start: "09:00", end: "17:00" }] }, now).toISOString()).toBe("2026-11-01T14:00:00.000Z");
  });
});

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("durable support waiting", () => {
  let admin: Pool, pool: Pool, platform: PlatformStore;
  const database = `agents_support_wait_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({ connectionString: url.href });
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  async function fixture(supportHours?: ReturnType<typeof defaultBusinessConfiguration>["supportHours"]) {
    const account = await platform.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "support@example.test", displayName: "Support" });
    const org = await platform.createOrganization(account.id, "Waiting fixtures"); await connectFixtureModel(pool, account.id, org.id);
    const configuration = defaultBusinessConfiguration(); configuration.tools = ["channel.request_handoff"];
    if (supportHours) configuration.supportHours = supportHours;
    const agent = await platform.createAgent({ accountId: account.id, organizationId: org.id, name: "Support", configuration });
    const version = await platform.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const deployment = await platform.publishWebsite({ accountId: account.id, organizationId: org.id, agentId: agent.id, versionId: version.id, allowedOrigins: ["https://customer.test"] });
    const sessionId = randomUUID(), token = randomBytes(32).toString("base64url");
    await pool.query("INSERT INTO agents_platform.website_sessions(id,deployment_id,token_hash,origin) VALUES($1,$2,$3,$4)", [sessionId, deployment.id, createHash("sha256").update(token).digest("hex"), "https://customer.test"]);
    const grant = await platform.createWebsiteGrant({ deploymentId: deployment.id, origin: "https://customer.test", sessionId });
    const inbox = new InboxStore(pool, {
      async admit(db, input) { return (await platform.admitTaskInTransaction(db, { authority: { product: "agents", organizationId: org.id, resourceId: deployment.id, callerClientId: "agents-website", principal: { kind: "visitor", deploymentId: deployment.id, sessionId } }, grantId: grant.id, versionId: version.id, input: input.input, requestKey: input.requestKey, channelBinding: input.channelBinding })).task; },
      async readableOutput(_db, _id, body) { return body; }, async cancelRoot() {},
    });
    registerChannelPorts(pool, { assertBinding: (...args) => inbox.assertBinding(...args), requestHandoff: (...args) => inbox.requestHandoff(...args), publishAutomated: (...args) => inbox.publishAutomated(...args), context: (...args) => inbox.context(...args) });
    const visitor = { deploymentId: deployment.id, sessionId }, conversation = await inbox.open(visitor);
    const incoming = await inbox.ingress(visitor, conversation.id, { requestKey: randomUUID(), body: "I need a person" }), taskId = incoming.message.task_id!;
    await transaction(pool, async db => {
      await inbox.requestHandoff(db, { customerConversationId: conversation.id, ownershipGeneration: "1", inputMessageId: incoming.message.id }, taskId);
      await recordHandoffWaiting(db, { conversationId: conversation.id, taskId, ownershipGeneration: "2" });
    });
    const service = new SupportWaitingService(pool, (db, input) => inbox.publishWaitingNotice(db, input));
    const scope = { organizationId: org.id, accountId: account.id };
    const command = async (action: "claim" | "takeover" | "reply" | "return" | "resolve" | "unassign" | "reopen", body?: string) => {
      const current = await inbox.readStaff(scope, conversation.id);
      return inbox.command(scope, conversation.id, { action, commandId: randomUUID(), expectedRevision: current.conversation.revision, ...(body ? { body } : {}) });
    };
    return { inbox, service, scope, taskId, conversation, command, visitor, deployment, agent };
  }
  async function due(taskId: string, minutes: number) {
    await pool.query("UPDATE agents_platform.support_waiting SET requested_at=now()-$2*interval '1 minute',next_action_at=now()-interval '1 second' WHERE task_id=$1", [taskId, minutes]);
  }

  it("coalesces downtime and duplicate wakes into one latest customer notice and staff reminder", async () => {
    const f = await fixture(); await due(f.taskId, 35);
    await Promise.all([f.service.advance(f.taskId), f.service.advance(f.taskId)]);
    const notices = (await pool.query("SELECT * FROM agents_platform.support_waiting_notices WHERE task_id=$1", [f.taskId])).rows;
    expect(notices).toHaveLength(1); expect(notices[0]).toMatchObject({ stage: 2, state: "published" });
    await expect(pool.query("UPDATE agents_platform.support_waiting_notices SET body='Changed claim' WHERE task_id=$1", [f.taskId])).rejects.toMatchObject({ code: "23514" });
    expect((await f.inbox.readVisitor(f.visitor, f.conversation.id)).messages.at(-1)?.body).toContain("still waiting");
    expect((await f.inbox.list(f.scope, {limit:30})).items.find(item => item.id === f.conversation.id)?.last_message_body).toContain("still waiting");
    const alerts = (await pool.query("SELECT stage FROM agents_platform.support_staff_alerts WHERE task_id=$1 ORDER BY stage", [f.taskId])).rows;
    expect(alerts.map(row => row.stage)).toEqual([0, 2]);
  });
  it("continues after takeover until a real human response, then stops obsolete updates", async () => {
    const f = await fixture(); await f.command("claim"); const taken = await f.command("takeover"); await due(f.taskId, 6);
    await f.service.advance(f.taskId);
    expect((await pool.query("SELECT ownership_generation,state FROM agents_platform.support_waiting_notices WHERE task_id=$1", [f.taskId])).rows[0]).toMatchObject({ ownership_generation: taken.ownership_generation, state: "published" });
    await f.command("reply", "A person is replying now"); await due(f.taskId, 35); expect(await f.service.advance(f.taskId)).toBeNull();
    expect((await pool.query("SELECT stopped_reason FROM agents_platform.support_waiting WHERE task_id=$1", [f.taskId])).rows[0].stopped_reason).toBe("human_replied");
  });
  it("keeps publication pending until the supported publisher exists", async () => {
    const f = await fixture(); await due(f.taskId, 6); await new SupportWaitingService(pool).advance(f.taskId);
    expect((await pool.query("SELECT state,message_id FROM agents_platform.support_waiting_notices WHERE task_id=$1", [f.taskId])).rows[0]).toMatchObject({ state: "pending", message_id: null });
    expect((await pool.query("SELECT customer_stage FROM agents_platform.support_waiting WHERE task_id=$1", [f.taskId])).rows[0].customer_stage).toBe(0);
  });
  it("rebinds an unpublished notice after takeover and unassignment without ending the episode", async () => {
    const f = await fixture(); await due(f.taskId, 6); await new SupportWaitingService(pool).advance(f.taskId);
    await f.command("claim"); await f.command("takeover"); const unassigned = await f.command("unassign");
    await due(f.taskId, 7); await f.service.advance(f.taskId);
    expect((await pool.query("SELECT ownership_generation,state FROM agents_platform.support_waiting_notices WHERE task_id=$1", [f.taskId])).rows).toEqual([{ ownership_generation: unassigned.ownership_generation, state: "published" }]);
    expect((await pool.query("SELECT completed_at FROM agents_platform.support_waiting WHERE task_id=$1", [f.taskId])).rows[0].completed_at).toBeNull();
  });
  it("honors published closed hours independently of mutable setup hours", async () => {
    const now = new Date(), tomorrow = (now.getUTCDay() + 1) % 7;
    const f = await fixture({ timeZone: "UTC", intervals: [{ day: tomorrow, start: "09:00", end: "17:00" }] });
    await pool.query("UPDATE agents_platform.agents SET setup=$2 WHERE id=$1", [f.agent.id, { supportHours: { timeZone: "UTC", intervals: [{ day: now.getUTCDay(), start: "00:00", end: "24:00" }] } }]);
    await due(f.taskId, 35); const next = await f.service.advance(f.taskId, now);
    expect(next!.getTime()).toBeGreaterThan(now.getTime());
    expect((await pool.query("SELECT count(*) FROM agents_platform.support_waiting_notices WHERE task_id=$1", [f.taskId])).rows[0].count).toBe("0");
  });
  it("does not revive an episode when resolution and reopening occur between wakes", async () => {
    const f = await fixture(); await f.command("claim"); await f.command("takeover"); await f.command("resolve"); await f.command("reopen"); await due(f.taskId, 6);
    expect(await f.service.advance(f.taskId)).toBeNull();
    expect((await pool.query("SELECT stopped_reason FROM agents_platform.support_waiting WHERE task_id=$1", [f.taskId])).rows[0].stopped_reason).toBe("episode_superseded");
  });
  it("stops after return or channel revocation without publishing", async () => {
    const f = await fixture(); await f.command("claim"); await f.command("return"); await due(f.taskId, 6);
    expect(await f.service.advance(f.taskId)).toBeNull();
    const g = await fixture(); await pool.query("UPDATE agents_platform.website_deployments SET paused=true WHERE id=$1", [g.deployment.id]); await due(g.taskId, 6);
    expect(await g.service.advance(g.taskId)).toBeNull();
    expect((await pool.query("SELECT count(*) FROM agents_platform.support_waiting_notices WHERE task_id=ANY($1::uuid[])", [[f.taskId, g.taskId]])).rows[0].count).toBe("0");
  });
  it("retains retryable timer intent and stable workflow identity after a lost dispatch acknowledgement", async () => {
    const f = await fixture(), urls: string[] = [];
    await expect(dispatchSupportWaitingOnce(pool, "https://restate.test", async input => { urls.push(String(input)); throw Error("lost"); })).rejects.toThrow("lost");
    await dispatchSupportWaitingOnce(pool, "https://restate.test", async input => { urls.push(String(input)); return Response.json({ invocationId: "inv_fixture" }); });
    expect(urls.filter(url => url.includes(f.taskId)).every(url => url.endsWith(`${f.taskId}/run`))).toBe(true);
    expect((await pool.query("SELECT dispatched_at FROM agents_platform.support_waiting WHERE task_id=$1", [f.taskId])).rows[0].dispatched_at).not.toBeNull();
  });
  it("acknowledges only the authenticated recipient's alerts and rejects a revoked member", async () => {
    const f = await fixture(), other = await fixture(), app = Fastify(); let scope = f.scope;
    registerSupportAlertRoutes(app, pool, async () => scope);
    try {
      const url = `/api/organizations/${f.scope.organizationId}/inbox-alerts`, result = await app.inject({ url });
      expect(result.json().unread).toBe(1); const alert = result.json().alerts[0];
      expect(alert.href).toBe(`/app/inbox?conversation=${f.conversation.id}`);
      scope = other.scope; expect((await app.inject({ method: "POST", url: `${url}/${alert.id}/acknowledge` })).statusCode).toBe(404);
      scope = f.scope; expect((await app.inject({ method: "POST", url: `${url}/${alert.id}/acknowledge` })).statusCode).toBe(200);
      expect((await app.inject({ url })).json().unread).toBe(0);
      await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2", [scope.organizationId, scope.accountId]);
      expect((await app.inject({ url })).statusCode).toBe(403);
    } finally { await app.close(); }
  });
});
