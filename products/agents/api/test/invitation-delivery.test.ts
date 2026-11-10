import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const parent = process.env.AGENTS_TEST_DATABASE_URL;
const database = `agents_invitation_delivery_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3100";
const issuer = "https://identity.invitation.test";

describe.skipIf(!parent)("invitation delivery through the Resend adapter", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>, mail: Server;
  const captured: Array<Record<string, unknown>> = [];
  let previous: Record<string, string | undefined> = {};

  beforeAll(async () => {
    mail = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => { body += chunk; });
      request.on("end", () => {
        captured.push(JSON.parse(body) as Record<string, unknown>);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ id: "fixture-email" }));
      });
    });
    await new Promise<void>((resolve) => mail.listen(0, "127.0.0.1", resolve));
    const mailBase = `http://127.0.0.1:${(mail.address() as AddressInfo).port}`;

    admin = new Pool({ connectionString: parent });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(parent!);
    target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href, max: 8 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);

    previous = {
      AGENTS_INVITATION_RESEND_API_KEY: process.env.AGENTS_INVITATION_RESEND_API_KEY,
      AGENTS_INVITATION_EMAIL_SENDER: process.env.AGENTS_INVITATION_EMAIL_SENDER,
      AGENTS_PUBLIC_URL: process.env.AGENTS_PUBLIC_URL,
    };
    process.env.AGENTS_INVITATION_RESEND_API_KEY = "fixture-resend-key";
    process.env.AGENTS_INVITATION_EMAIL_SENDER = "KasiTek <noreply@example.test>";
    process.env.AGENTS_PUBLIC_URL = origin;

    app = await buildPlatformApp({
      pool,
      logging: false,
      config: loadPlatformConfig({
        NODE_ENV: "test",
        AGENTS_DATABASE_URL: target.href,
        AGENTS_PUBLIC_URL: origin,
        AGENTS_OIDC_ISSUER_URL: issuer,
        AGENTS_OIDC_CLIENT_SECRET: "invitation-fixture-secret-0000000000",
        OPENROUTER_API_KEY: "not-used",
      }),
      testInvitationBaseUrl: mailBase,
    });
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
    await new Promise<void>((resolve) => mail?.close(() => resolve()));
    if (admin) {
      await dropClosedTestDatabase(admin, database);
      await admin.end();
    }
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  async function account(email: string, displayName: string) {
    return store.ensureAccount({ issuer, subject: randomUUID(), email, displayName });
  }
  async function session(accountId: string) {
    return store.createSession({ accountId, providerSessionId: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) });
  }
  async function request(token: string | null, method: "GET" | "POST", url: string, payload?: unknown) {
    const response = await app.inject({
      method,
      url,
      headers: {
        origin,
        ...(token ? { cookie: `agents_session=${token}` } : {}),
        ...(payload === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    });
    return { status: response.statusCode, body: response.body ? JSON.parse(response.body) : null };
  }

  it("sends a real invitation email and accepts it as an admin", async () => {
    const owner = await account(`owner-${randomUUID()}@example.test`, "Owner");
    const organization = await store.createOrganization(owner.id, "Delivery workspace");
    const ownerSession = await session(owner.id);
    const inviteeEmail = `invitee-${randomUUID()}@example.test`;
    const invitee = await account(inviteeEmail, "Invitee");

    const invited = await request(ownerSession.token, "POST", `/api/organizations/${organization.id}/invitations`, {
      email: inviteeEmail,
      role: "admin",
    });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email: inviteeEmail, role: "admin" });

    expect(captured).toHaveLength(1);
    const message = captured[0]!;
    expect(message).toMatchObject({
      from: "KasiTek <noreply@example.test>",
      to: [inviteeEmail],
      subject: "Join Delivery workspace on KasiTek",
    });
    const text = String(message.text);
    const token = text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();

    const preview = await request(null, "GET", `/api/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invitation).toMatchObject({ role: "admin", state: "pending" });

    const inviteeSession = await session(invitee.id);
    const accepted = await request(inviteeSession.token, "POST", `/api/invitations/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.organization.role).toBe("admin");

    const roster = await request(ownerSession.token, "GET", `/api/organizations/${organization.id}/members`);
    expect(roster.status).toBe(200);
    expect(roster.body.members).toContainEqual(expect.objectContaining({
      accountId: invitee.id,
      role: "admin",
    }));
    expect(roster.body.grantableRoles).toEqual(["owner", "admin", "member"]);
  });

  it("keeps the invitation pending when the provider rejects the message", async () => {
    const owner = await account(`owner-${randomUUID()}@example.test`, "Owner");
    const organization = await store.createOrganization(owner.id, "Rejected workspace");
    const ownerSession = await session(owner.id);
    const email = `rejected-${randomUUID()}@example.test`;

    mail.removeAllListeners("request");
    mail.on("request", (request, response) => {
      request.resume();
      request.on("end", () => {
        response.writeHead(422, { "content-type": "application/json" });
        response.end(JSON.stringify({ message: "invalid from" }));
      });
    });
    try {
      const rejected = await request(ownerSession.token, "POST", `/api/organizations/${organization.id}/invitations`, { email });
      expect(rejected.status).toBe(502);
      expect(rejected.body.error.code).toBe("INVITATION_EMAIL_FAILED");
    } finally {
      mail.removeAllListeners("request");
      mail.on("request", (request, response) => {
        let body = "";
        request.on("data", (chunk) => { body += chunk; });
        request.on("end", () => {
          captured.push(JSON.parse(body) as Record<string, unknown>);
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "fixture-email" }));
        });
      });
    }
    const pending = await request(ownerSession.token, "GET", `/api/organizations/${organization.id}/invitations`);
    expect(pending.body.invitations.some((item: { email: string }) => item.email === email)).toBe(true);
  });
});
