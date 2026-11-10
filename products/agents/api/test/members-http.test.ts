import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildPlatformApp } from "../src/composition/app";
import { setupPlatformSchema } from "../src/composition/setup";
import { loadPlatformConfig } from "../src/infrastructure/config";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const parent = process.env.AGENTS_TEST_DATABASE_URL;
const database = `agents_members_${randomUUID().replaceAll("-", "")}`;
const origin = "http://localhost:3100";
const issuer = "https://identity.members.test";

describe.skipIf(!parent)("workspace members and invitations", () => {
  let admin: Pool, pool: Pool, store: PlatformStore, app: Awaited<ReturnType<typeof buildPlatformApp>>;
  let emailFails = false;
  const messages: Array<{ to: string; subject: string; text: string; idempotencyKey: string }> = [];
  const sender = {
    async send(input: { to: string; subject: string; text: string; idempotencyKey: string }) {
      messages.push(input);
      return emailFails
        ? { state: "rejected" as const, status: 500 }
        : { state: "accepted" as const, providerId: "members-test" };
    },
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: parent });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(parent!);
    target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href, max: 8 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
    app = await buildPlatformApp({
      pool,
      logging: false,
      config: loadPlatformConfig({
        NODE_ENV: "test",
        AGENTS_DATABASE_URL: target.href,
        AGENTS_PUBLIC_URL: origin,
        AGENTS_OIDC_ISSUER_URL: issuer,
        AGENTS_OIDC_CLIENT_SECRET: "members-fixture-secret-000000000000",
        OPENROUTER_API_KEY: "not-used",
      }),
      testInvitationSender: sender,
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

  async function account(email: string, displayName = "Member") {
    return store.ensureAccount({
      issuer,
      subject: randomUUID(),
      email,
      displayName,
    });
  }

  async function organization(ownerId: string, name: string) {
    return store.createOrganization(ownerId, name);
  }

  async function session(accountId: string) {
    return store.createSession({
      accountId,
      providerSessionId: randomUUID(),
      expiresAt: new Date(Date.now() + 3_600_000),
    });
  }

  async function request(
    token: string | null,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    url: string,
    payload?: unknown,
  ) {
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
    return {
      status: response.statusCode,
      body: response.body ? JSON.parse(response.body) : null,
    };
  }

  async function fixture(name: string) {
    const owner = await account(`owner-${randomUUID()}@example.test`, "Owner");
    const org = await organization(owner.id, name);
    const ownerSession = await session(owner.id);
    return { owner, org, ownerSession, base: `/api/organizations/${org.id}` };
  }

  it("exposes workspace permissions in the session", async () => {
    const f = await fixture("Session permissions");
    const session = await request(f.ownerSession.token, "GET", "/api/session");
    expect(session.status).toBe(200);
    expect(session.body.organizations[0]).toMatchObject({
      id: f.org.id,
      role: "owner",
    });
    expect(session.body.organizations[0].permissions).toContain("billing.manage");
    expect(session.body.organizations[0].permissions).toContain("channels.manage");
  });

  it("lists members and enforces role-based management", async () => {
    emailFails = false;
    const f = await fixture("Members permissions");
    const target = await account(`target-${randomUUID()}@example.test`, "Target");

    const added = await request(f.ownerSession.token, "POST", `${f.base}/members`, {
      email: target.email,
      role: "member",
    });
    expect(added.status).toBe(201);
    expect(added.body.member).toMatchObject({ accountId: target.id, role: "member" });

    const targetSession = await session(target.id);
    const listed = await request(targetSession.token, "GET", `${f.base}/members`);
    expect(listed.status).toBe(200);
    expect(listed.body.canManage).toBe(false);
    expect(listed.body.members).toHaveLength(2);

    expect((await request(targetSession.token, "POST", `${f.base}/invitations`, {
      email: `blocked-${randomUUID()}@example.test`,
    })).status).toBe(403);
    expect((await request(targetSession.token, "PATCH", `${f.base}/members/${f.owner.id}`, {
      role: "member",
    })).status).toBe(403);
    expect((await request(targetSession.token, "DELETE", `${f.base}/members/${f.owner.id}`)).status).toBe(403);
  });

  it("invites, previews, accepts, replays and revokes an invitation", async () => {
    emailFails = false;
    const f = await fixture("Invitation lifecycle");
    const email = `invitee-${randomUUID()}@example.test`;
    const invited = await request(f.ownerSession.token, "POST", `${f.base}/invitations`, {
      email,
      role: "member",
    });
    expect(invited.status).toBe(201);
    expect(invited.body.invitation).toMatchObject({ email, role: "member", expired: false });
    expect(messages).toHaveLength(1);
    const token = messages[0]!.text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    expect(token).toBeTruthy();

    const preview = await request(null, "GET", `/api/invitations/${token}`);
    expect(preview.status).toBe(200);
    expect(preview.body.invitation).toMatchObject({
      organizationName: "Invitation lifecycle",
      email: `${email.slice(0, 1)}***@${email.split("@")[1]}`,
      role: "member",
      state: "pending",
    });

    const invitee = await account(email, "Invitee");
    const inviteeSession = await session(invitee.id);
    const accepted = await request(inviteeSession.token, "POST", `/api/invitations/${token}/accept`);
    expect(accepted.status).toBe(200);
    expect(accepted.body.organization).toMatchObject({ id: f.org.id, role: "member" });

    const replay = await request(inviteeSession.token, "POST", `/api/invitations/${token}/accept`);
    expect(replay.status).toBe(200);
    expect(replay.body.organization.role).toBe("member");

    const listed = await request(inviteeSession.token, "GET", `${f.base}/members`);
    expect(listed.status).toBe(200);
    expect(listed.body.members.some((member: { accountId: string; role: string }) =>
      member.accountId === invitee.id && member.role === "member")).toBe(true);

    const pending = await request(f.ownerSession.token, "GET", `${f.base}/invitations`);
    expect(pending.body.invitations).toEqual([]);

    const second = await request(f.ownerSession.token, "POST", `${f.base}/invitations`, {
      email: `second-${randomUUID()}@example.test`,
    });
    const secondToken = second.body.invitation.id;
    expect((await request(f.ownerSession.token, "DELETE", `${f.base}/invitations/${secondToken}`)).status).toBe(200);
    const secondMessage = messages.at(-1)!;
    const secondRawToken = secondMessage.text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1];
    const secondAccount = await account(secondMessage.to, "Second");
    const secondSession = await session(secondAccount.id);
    const revoked = await request(secondSession.token, "POST", `/api/invitations/${secondRawToken}/accept`);
    expect(revoked.status).toBe(410);
    expect(revoked.body.error.code).toBe("INVITATION_REVOKED");
  });

  it("rejects duplicate pending invitations, wrong emails and expired invitations", async () => {
    emailFails = false;
    const f = await fixture("Invitation failures");
    const email = `duplicate-${randomUUID()}@example.test`;
    const first = await request(f.ownerSession.token, "POST", `${f.base}/invitations`, { email });
    expect(first.status).toBe(201);
    const token = messages.at(-1)!.text.match(/\/invite\/([A-Za-z0-9_-]{43})/)?.[1]!;

    const duplicate = await request(f.ownerSession.token, "POST", `${f.base}/invitations`, { email });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe("INVITATION_EXISTS");

    const wrong = await account(`wrong-${randomUUID()}@example.test`, "Wrong");
    const wrongSession = await session(wrong.id);
    const mismatch = await request(wrongSession.token, "POST", `/api/invitations/${token}/accept`);
    expect(mismatch.status).toBe(403);
    expect(mismatch.body.error.code).toBe("INVITATION_EMAIL_MISMATCH");

    await pool.query(
      "UPDATE agents_platform.organization_invitations SET created_at=now()-interval '10 minutes',expires_at=now()-interval '1 minute' WHERE organization_id=$1",
      [f.org.id],
    );
    const expiredAccount = await account(email, "Expired");
    const expiredSession = await session(expiredAccount.id);
    const expired = await request(expiredSession.token, "POST", `/api/invitations/${token}/accept`);
    expect(expired.status).toBe(410);
    expect(expired.body.error.code).toBe("INVITATION_EXPIRED");
  });

  it("keeps a pending invitation when email delivery fails", async () => {
    emailFails = true;
    const f = await fixture("Email failure");
    const email = `undelivered-${randomUUID()}@example.test`;
    const failed = await request(f.ownerSession.token, "POST", `${f.base}/invitations`, { email });
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe("INVITATION_EMAIL_FAILED");
    const pending = await request(f.ownerSession.token, "GET", `${f.base}/invitations`);
    expect(pending.status).toBe(200);
    expect(pending.body.invitations.some((item: { email: string }) => item.email === email)).toBe(true);

    const invitationId = pending.body.invitations.find((item: { email: string }) => item.email === email).id;
    expect((await request(f.ownerSession.token, "DELETE", `${f.base}/invitations/${invitationId}`)).status).toBe(200);
    emailFails = false;
  });

  it("protects the last owner and supports role changes and removal", async () => {
    emailFails = false;
    const f = await fixture("Owner protection");
    const memberAccount = await account(`owner-member-${randomUUID()}@example.test`, "Member");

    const selfRemove = await request(f.ownerSession.token, "DELETE", `${f.base}/members/${f.owner.id}`);
    expect(selfRemove.status).toBe(409);
    expect(selfRemove.body.error.code).toBe("LAST_OWNER");
    const selfRole = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${f.owner.id}`, { role: "member" });
    expect(selfRole.status).toBe(409);
    expect(selfRole.body.error.code).toBe("SELF_ROLE_CHANGE");

    await request(f.ownerSession.token, "POST", `${f.base}/members`, { email: memberAccount.email, role: "owner" });
    const changed = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${memberAccount.id}`, { role: "member" });
    expect(changed.status).toBe(200);
    expect(changed.body.member.role).toBe("member");
    const removed = await request(f.ownerSession.token, "DELETE", `${f.base}/members/${memberAccount.id}`);
    expect(removed.status).toBe(200);

    const memberSession = await session(memberAccount.id);
    expect((await request(memberSession.token, "GET", `${f.base}/members`)).status).toBe(403);
  });

  it("denies cross-organization access and unknown accounts", async () => {
    emailFails = false;
    const first = await fixture("Cross organization one");
    const second = await fixture("Cross organization two");
    expect((await request(first.ownerSession.token, "GET", `${second.base}/members`)).status).toBe(403);
    expect((await request(first.ownerSession.token, "GET", `${second.base}/enquiries`)).status).toBe(403);
    expect((await request(first.ownerSession.token, "GET", `${second.base}/customer-records/enquiries/00000000-0000-4000-8000-000000000000`)).status).toBe(403);
    const unknown = await request(first.ownerSession.token, "POST", `${first.base}/members`, {
      email: `unknown-${randomUUID()}@example.test`,
    });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("ACCOUNT_NOT_FOUND");
  });

  it("lets admins manage members without granting ownership", async () => {
    emailFails = false;
    const f = await fixture("Admin authority");
    const adminAccount = await account(`admin-${randomUUID()}@example.test`, "Admin");
    const addedAdmin = await request(f.ownerSession.token, "POST", `${f.base}/members`, {
      email: adminAccount.email,
      role: "admin",
    });
    expect(addedAdmin.status).toBe(201);
    expect(addedAdmin.body.member.role).toBe("admin");

    const adminSession = await session(adminAccount.id);
    const roster = await request(adminSession.token, "GET", `${f.base}/members`);
    expect(roster.status).toBe(200);
    expect(roster.body).toMatchObject({ canManage: true, role: "admin" });
    expect(roster.body.grantableRoles).toEqual(["admin", "member"]);
    expect(roster.body.permissions).toContain("members.invite");
    expect(roster.body.permissions).not.toContain("billing.manage");
    expect(roster.body.permissions).not.toContain("credentials.manage");

    const memberAccount = await account(`admin-managed-${randomUUID()}@example.test`, "Managed");
    const addedMember = await request(adminSession.token, "POST", `${f.base}/members`, {
      email: memberAccount.email,
      role: "member",
    });
    expect(addedMember.status).toBe(201);
    expect(addedMember.body.member.role).toBe("member");

    const promoted = await request(adminSession.token, "PATCH", `${f.base}/members/${memberAccount.id}`, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.member.role).toBe("admin");

    const peerDemotion = await request(adminSession.token, "PATCH", `${f.base}/members/${memberAccount.id}`, {
      role: "member",
    });
    expect(peerDemotion.status).toBe(403);
    expect(peerDemotion.body.error.code).toBe("ROLE_ESCALATION_DENIED");

    const ownerChange = await request(adminSession.token, "PATCH", `${f.base}/members/${f.owner.id}`, {
      role: "member",
    });
    expect(ownerChange.status).toBe(403);
    expect(ownerChange.body.error.code).toBe("ROLE_ESCALATION_DENIED");

    const ownerInvite = await request(adminSession.token, "POST", `${f.base}/invitations`, {
      email: `owner-invite-${randomUUID()}@example.test`,
      role: "owner",
    });
    expect(ownerInvite.status).toBe(403);
    expect(ownerInvite.body.error.code).toBe("ROLE_ESCALATION_DENIED");

    const adminInvite = await request(adminSession.token, "POST", `${f.base}/invitations`, {
      email: `admin-invite-${randomUUID()}@example.test`,
      role: "admin",
    });
    expect(adminInvite.status).toBe(201);
    expect(adminInvite.body.invitation.role).toBe("admin");

    const memberInvite = await request(adminSession.token, "POST", `${f.base}/invitations`, {
      email: `member-invite-${randomUUID()}@example.test`,
      role: "member",
    });
    expect(memberInvite.status).toBe(201);

    const peerRemoval = await request(adminSession.token, "DELETE", `${f.base}/members/${memberAccount.id}`);
    expect(peerRemoval.status).toBe(403);

    const ownerDemotes = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${memberAccount.id}`, {
      role: "member",
    });
    expect(ownerDemotes.status).toBe(200);

    const removed = await request(adminSession.token, "DELETE", `${f.base}/members/${memberAccount.id}`);
    expect(removed.status).toBe(200);
  });

  it("keeps billing with owners", async () => {
    emailFails = false;
    const f = await fixture("Billing authority");
    const member = await account(`billing-member-${randomUUID()}@example.test`, "Member");
    const adminAccount = await account(`billing-admin-${randomUUID()}@example.test`, "Admin");
    await request(f.ownerSession.token, "POST", `${f.base}/members`, { email: member.email, role: "member" });
    await request(f.ownerSession.token, "POST", `${f.base}/members`, { email: adminAccount.email, role: "admin" });

    const memberSession = await session(member.id);
    const adminSession = await session(adminAccount.id);
    for (const token of [memberSession.token, adminSession.token]) {
      const denied = await request(token, "GET", `${f.base}/billing`);
      expect(denied.status).toBe(403);
      expect(denied.body.error.code).toBe("INSUFFICIENT_ROLE");
    }

    const owner = await request(f.ownerSession.token, "GET", `${f.base}/billing`);
    expect(owner.status).toBe(200);
    expect(owner.body.configured).toBe(false);
  });

  it("lets owners grant admin and protects the last owner", async () => {
    emailFails = false;
    const f = await fixture("Owner grants admin");
    const target = await account(`owner-granted-${randomUUID()}@example.test`, "Granted");
    await request(f.ownerSession.token, "POST", `${f.base}/members`, { email: target.email, role: "member" });

    const promoted = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${target.id}`, {
      role: "admin",
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.member.role).toBe("admin");

    const demoted = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${target.id}`, {
      role: "member",
    });
    expect(demoted.status).toBe(200);
    expect(demoted.body.member.role).toBe("member");

    const targetSession = await session(target.id);
    const left = await request(targetSession.token, "DELETE", `${f.base}/members/${target.id}`);
    expect(left.status).toBe(200);

    const selfDemotion = await request(f.ownerSession.token, "PATCH", `${f.base}/members/${f.owner.id}`, {
      role: "admin",
    });
    expect(selfDemotion.status).toBe(409);
    expect(selfDemotion.body.error.code).toBe("SELF_ROLE_CHANGE");
  });
});
