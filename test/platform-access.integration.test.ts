import { randomUUID, createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PlatformAccessRepository } from "../src/identity/platform-access";

// Use a disposable database. Every run creates and removes its own schema.
const databaseUrl = process.env.PLATFORM_ACCESS_TEST_DATABASE_URL;
describe.skipIf(!databaseUrl)("Agents platform access, PostgreSQL", () => {
  const schema = `platform_access_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl });
  const pool = new Pool({ connectionString: databaseUrl, options: `-c search_path=${schema},public` });
  const access = new PlatformAccessRepository(pool);
  const issuer = "https://identity.example/realms/kasitek";

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await pool.query(await readFile("migrations/178_platform_identity_sessions.sql", "utf8"));
    await pool.query(await readFile("migrations/179_platform_login_transactions.sql", "utf8"));
  });
  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  });

  async function account(subject = randomUUID(), verified = true) {
    return access.recordIdentity({ issuer, subject, email: "same@example.com",
      display_name: "Test user", image: "", email_verified: verified });
  }
  async function session(accountId: string) {
    return access.createSession({ accountId, providerSessionId: randomUUID(), authenticatedAt: new Date() });
  }

  it("keeps identities distinct despite matching emails; an account starts with no workspace access", async () => {
    const first = await account();
    const second = await account();
    expect(first.id).not.toBe(second.id);
    const browser = await session(first.id);
    const loaded = await access.readSession(browser.token);
    expect(loaded?.organizations).toEqual([]);
    expect(loaded?.activeOrganizationId).toBeNull();
    const stored = await pool.query("SELECT token_hash FROM platform_browser_sessions WHERE account_id = $1", [first.id]);
    expect(stored.rows[0].token_hash).toBe(createHash("sha256").update(browser.token).digest("hex"));
    expect(await access.readSession("malformed")).toBeNull();
  });

  it("denies another workspace and removes revoked membership immediately", async () => {
    const owner = await account();
    const outsider = await account();
    const org = await access.createOrganization(owner.id, "My workspace");
    const ownerSession = await session(owner.id);
    const outsiderSession = await session(outsider.id);
    expect(await access.selectOrganization(outsiderSession.token, org.id)).toBe(false);
    expect(await access.selectOrganization(ownerSession.token, org.id)).toBe(true);
    expect((await access.readSession(ownerSession.token))?.activeOrganizationId).toBe(org.id);
    await pool.query("UPDATE platform_memberships SET revoked_at = now() WHERE account_id = $1", [owner.id]);
    expect((await access.readSession(ownerSession.token))?.activeOrganizationId).toBeNull();
    expect(await access.selectOrganization(ownerSession.token, org.id)).toBe(false);
  });

  it("requires verified, enabled accounts and does not revive a disabled account on login", async () => {
    const user = await account(undefined, false);
    await expect(session(user.id)).rejects.toMatchObject({ statusCode: 403 });
    await expect(access.createOrganization(user.id, "Workspace")).rejects.toMatchObject({ statusCode: 403 });
    const enabled = await account();
    const browser = await session(enabled.id);
    await pool.query("UPDATE platform_accounts SET disabled_at = now() WHERE id = $1", [enabled.id]);
    expect(await access.readSession(browser.token)).toBeNull();
    await expect(account(enabled.subject)).rejects.toMatchObject({ statusCode: 403 });
  });

  it("enforces inactivity and the provider authentication deadline, including on workspace selection", async () => {
    const user = await account();
    const org = await access.createOrganization(user.id, "Expiry workspace");
    const idle = await session(user.id);
    await pool.query("UPDATE platform_browser_sessions SET last_seen_at = now() - interval '8 days' WHERE account_id = $1", [user.id]);
    expect(await access.readSession(idle.token, { touch: true })).toBeNull();
    expect(await access.selectOrganization(idle.token, org.id)).toBe(false);
    const absolute = await session(user.id);
    await pool.query("UPDATE platform_browser_sessions SET created_at = now() - interval '2 days', absolute_expires_at = now() - interval '1 day' WHERE token_hash = $1",
      [createHash("sha256").update(absolute.token).digest("hex")]);
    expect(await access.readSession(absolute.token)).toBeNull();
    await expect(access.createSession({ accountId: user.id, providerSessionId: "old", authenticatedAt: new Date(Date.now() - 31 * 86_400_000) }))
      .rejects.toMatchObject({ statusCode: 401 });
  });

  it("revokes one browser, an account's browsers and provider sessions independently", async () => {
    const user = await account();
    const first = await session(user.id);
    const second = await session(user.id);
    await access.revokeSession(first.token);
    expect(await access.readSession(first.token)).toBeNull();
    const secondLoaded = await access.readSession(second.token);
    expect(secondLoaded).not.toBeNull();
    await access.revokeProviderSession("https://other.example", secondLoaded!.providerSessionId);
    expect(await access.readSession(second.token)).not.toBeNull();
    await access.revokeProviderSession(issuer, secondLoaded!.providerSessionId);
    expect(await access.readSession(second.token)).toBeNull();
    const third = await session(user.id);
    await access.revokeAccountSessions(user.id);
    expect(await access.readSession(third.token)).toBeNull();
  });
});
