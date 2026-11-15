import { generateKeyPairSync, randomBytes, randomUUID } from "node:crypto";
import Fastify from "fastify";
import { importPKCS8, SignJWT } from "jose";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requestDigest } from "../src/contracts/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { ChannelStore } from "../src/product/channels/channel-store";
import { TelegramSetupService } from "../src/product/channels/telegram-setup";
import { registerGrowthChannelAdminRoutes } from "../src/product/integrations/growth-channels";
import { PlatformStore } from "../src/product/agents/store";
import { ConnectionVault } from "../src/infrastructure/vault";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("Growth channel administration", () => {
  const database = `agents_growth_channel_admin_${randomUUID().replaceAll("-", "")}`;
  const issuer = "https://growth.example.test";
  const actorIssuer = `${issuer}/identity`;
  const growthOrganizationId = "growth-tenant-admin";
  const keyPair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privatePem = keyPair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = keyPair.publicKey.export({ type: "spki", format: "pem" }).toString();
  let admin: Pool;
  let pool: Pool;
  let app: Awaited<ReturnType<typeof Fastify>>;
  let assistantId: string;

  async function token(body: unknown) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({ product: "growth", requestDigest: requestDigest(body) })
      .setProtectedHeader({ alg: "RS256", kid: "growth-v1" })
      .setIssuer(issuer)
      .setAudience("agents-product-api")
      .setSubject("growth-api")
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .setJti(randomUUID())
      .sign(await importPKCS8(privatePem, "RS256"));
  }

  async function send(body: Record<string, unknown>, signed = true) {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (signed) headers.authorization = `Bearer ${await token(body)}`;
    return app.inject({
      method: "POST",
      url: "/internal/v1/products/growth/channels",
      headers,
      payload: body,
    });
  }

  function command(operation: string, extra: Record<string, unknown> = {}) {
    return {
      version: "1",
      requestId: randomUUID(),
      operation,
      actor: { issuer: actorIssuer, subject: randomUUID() },
      growthOrganizationId,
      ...extra,
    };
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const isolated = new URL(url!);
    isolated.pathname = `/${database}`;
    pool = new Pool({ connectionString: isolated.href });
    await setupPlatformSchema(pool);

    const platform = new PlatformStore(pool);
    const owner = await platform.ensureAccount({
      issuer: actorIssuer,
      subject: randomUUID(),
      email: "owner@example.test",
      displayName: "Owner",
    });
    const organization = await platform.createOrganization(owner.id, "Growth business");
    const scope = { accountId: owner.id, organizationId: organization.id };
    await pool.query(
      `INSERT INTO agents_platform.product_execution_tenants(product,tenant_id,organization_id,client_id,issuer)
        VALUES('growth',$1,$2,'growth-api',$3)`,
      [growthOrganizationId, organization.id, issuer],
    );
    const created = await platform.createConfiguredAgent({
      ...scope,
      name: "Growth assistant",
      offering: "faq",
    });
    await pool.query("ALTER TABLE agents_platform.agents DISABLE TRIGGER immutable_agent_offering");
    await pool.query(
      "UPDATE agents_platform.agents SET offering='growth-assistant' WHERE id=$1",
      [created.agent.id],
    );
    await pool.query("ALTER TABLE agents_platform.agents ENABLE TRIGGER immutable_agent_offering");
    assistantId = created.agent.id;

    const store = new ChannelStore(
      pool,
      new ConnectionVault("test", { test: randomBytes(32).toString("base64") }),
    );
    let webhook = "";
    const telegram = new TelegramSetupService(store, {
      callbackUrl: (id) => `https://agents.example.com/api/channel-webhooks/telegram/${id}`,
      fetch: async (input, init) => {
        const method = String(input).split("/").at(-1)!;
        if (method === "setWebhook") {
          webhook = JSON.parse(String(init?.body)).url;
          return Response.json({ ok: true, result: true });
        }
        if (method === "getWebhookInfo") return Response.json({ ok: true, result: { url: webhook } });
        if (method === "getMe")
          return Response.json({
            ok: true,
            result: { id: 123456, is_bot: true, first_name: "Growth", username: "growth_bot" },
          });
        return Response.json({ ok: false, error_code: 404, description: "not found" }, { status: 404 });
      },
    });
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      const failure = error as Error & { statusCode?: number; code?: string };
      reply
        .code(failure.statusCode ?? 400)
        .send({ error: { code: failure.code, message: failure.message } });
    });
    registerGrowthChannelAdminRoutes(app, {
      pool,
      store,
      telegram,
      trust: { issuer, actorIssuer, keys: { "growth-v1": publicPem } },
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    if (admin) {
      await dropClosedTestDatabase(admin, database);
      await admin.end();
    }
  });

  it("requires a Growth service assertion bound to the full request", async () => {
    const unauthenticated = await send(command("channel.list"), false);
    expect(unauthenticated.statusCode).toBe(401);
    expect(unauthenticated.json().error.code).toBe("PRODUCT_SERVICE_DENIED");

    const body = command("channel.list");
    const signed = await token(body);
    const changed = { ...body, growthOrganizationId: "another-growth-tenant" };
    const denied = await app.inject({
      method: "POST",
      url: "/internal/v1/products/growth/channels",
      headers: { "content-type": "application/json", authorization: `Bearer ${signed}` },
      payload: changed,
    });
    expect(denied.statusCode).toBe(401);

    const invalid = await send({ ...command("telegram.connect"), name: "Growth" });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error.code).toBe("INVALID_PRODUCT_COMMAND");
  });

  it("connects Telegram for the linked Growth workspace without creating a Growth user account", async () => {
    const growthActor = randomUUID();
    const connected = await send(
      command("telegram.connect", { actor: { issuer: actorIssuer, subject: growthActor }, name: "Growth assistant", botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi" }),
    );
    expect(connected.statusCode, connected.body).toBe(200);
    const body = connected.json();
    expect(body.status).toBe("active");
    expect(body.connection).toMatchObject({ kind: "telegram", mode: "bot", state: "active" });
    expect(body.connection.metadata).toMatchObject({ botUsername: "growth_bot", setupStatus: "verified" });
    expect(connected.body).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ");

    const human = await pool.query("SELECT 1 FROM agents_platform.accounts WHERE issuer=$1 AND subject=$2", [
      actorIssuer,
      growthActor,
    ]);
    expect(human.rowCount).toBe(0);
    const service = await pool.query(
      "SELECT 1 FROM agents_platform.accounts WHERE issuer=$1 AND display_name='Growth channel administration'",
      ["https://growth.kasitek.co.za/products/channel-admin"],
    );
    expect(service.rowCount).toBe(1);
  });

  it("replays an identical request and rejects a reused request identity with different input", async () => {
    const body = command("assistant.target");
    const first = await send(body);
    expect(first.statusCode).toBe(200);
    const replay = await send(body);
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual(first.json());

    const conflict = await send({
      ...body,
      actor: { ...(body.actor as Record<string, unknown>), subject: randomUUID() },
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error.code).toBe("PRODUCT_REQUEST_CONFLICT");
  });

  it("rejects connecting a Telegram bot that is already linked to the workspace", async () => {
    const duplicate = await send(
      command("telegram.connect", {
        name: "Duplicate bot",
        botToken: "123456:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi",
      }),
    );
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("TELEGRAM_BOT_ALREADY_CONNECTED");
  });

  it("lists Telegram channels, targets the Growth assistant and binds or revokes a deployment", async () => {
    const listed = await send(command("channel.list"));
    expect(listed.statusCode).toBe(200);
    const channels = listed.json().connections as Array<{ id: string; revision: number; kind: string }>;
    expect(channels).toHaveLength(1);
    expect(channels[0]!.kind).toBe("telegram");
    expect(listed.json().deployments).toEqual([]);

    const target = await send(command("assistant.target"));
    expect(target.statusCode).toBe(200);
    expect(target.json().targetAgentId).toBe(assistantId);

    const bound = await send(
      command("channel.bind", {
        connectionId: channels[0]!.id,
        expectedRevision: channels[0]!.revision,
      }),
    );
    expect(bound.statusCode, bound.body).toBe(200);
    expect(bound.json().deployment).toMatchObject({ agentId: assistantId, state: "active" });

    const afterBind = await send(command("channel.list"));
    expect(afterBind.json().deployments).toHaveLength(1);

    const revoked = await send(
      command("channel.unbind", { connectionId: channels[0]!.id }),
    );
    expect(revoked.statusCode).toBe(200);
    expect(revoked.json().status).toBe("revoked");
    const afterUnbind = await send(command("channel.unbind", { connectionId: channels[0]!.id }));
    expect(afterUnbind.json().status).toBe("not_linked");
  });

  it("links and unlinks a Growth-managed WhatsApp connection", async () => {
    const linked = await send(
      command("growth.link", {
        provider: "whatsapp",
        connectionId: "growth-connection-1",
        providerAssetId: "1074164405768729",
        permissionRevision: "revision-1",
        name: "Growth WhatsApp",
        providerMode: "meta",
        grantId: randomUUID(),
        intentId: randomUUID(),
        growthRequestId: randomUUID(),
        exchangeRequestId: randomUUID(),
      }),
    );
    expect(linked.statusCode, linked.body).toBe(200);
    expect(linked.json().connection).toMatchObject({ kind: "whatsapp", mode: "growth_managed", state: "active" });
    expect(linked.json().deployment).toMatchObject({ agentId: assistantId, state: "active" });
    const connection = linked.json().connection as { id: string; revision: number };
    const grant = await pool.query(
      "SELECT state, provider_asset_id FROM agents_platform.growth_channel_grants WHERE organization_id=$1 AND connection_id=$2",
      [linked.json().connection.organizationId, connection.id],
    );
    expect(grant.rows[0]).toMatchObject({ state: "active", provider_asset_id: "1074164405768729" });

    const unlinked = await send(
      command("growth.unlink", { connectionId: connection.id, expectedRevision: connection.revision }),
    );
    expect(unlinked.statusCode, unlinked.body).toBe(200);
    expect(unlinked.json().connection.state).toBe("removed");
    const revoked = await pool.query(
      "SELECT state FROM agents_platform.growth_channel_grants WHERE organization_id=$1 AND connection_id=$2",
      [linked.json().connection.organizationId, connection.id],
    );
    expect(revoked.rows[0]?.state).toBe("revoked");
  });
});
