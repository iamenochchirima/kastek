import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const parent = process.env.AGENTS_TEST_DATABASE_URL;
const database = `agents_identity_audit_${randomUUID().replaceAll("-", "")}`;
const issuer = "https://identity.audit.test";

describe.skipIf(!parent)("verified identity audit", () => {
  let admin: Pool, pool: Pool, store: PlatformStore;

  beforeAll(async () => {
    admin = new Pool({ connectionString: parent });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(parent!);
    target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href, max: 4 });
    await setupPlatformSchema(pool);
    store = new PlatformStore(pool);
  });

  afterAll(async () => {
    await pool?.end();
    if (admin) {
      await dropClosedTestDatabase(admin, database);
      await admin.end();
    }
  });

  it("stores verification time and source from a verified claim", async () => {
    const account = await store.ensureAccount({
      issuer,
      subject: randomUUID(),
      email: `verified-${randomUUID()}@example.test`,
      displayName: "Verified",
      emailVerified: true,
    });
    const row = (await pool.query<{ email_verified_at: Date | null; email_verified_source: string | null }>(
      "SELECT email_verified_at,email_verified_source FROM agents_platform.accounts WHERE id=$1",
      [account.id],
    )).rows[0]!;
    expect(row.email_verified_at).toBeInstanceOf(Date);
    expect(row.email_verified_source).toBe("keycloak");
  });

  it("does not invent verification for an unverified caller", async () => {
    const account = await store.ensureAccount({
      issuer,
      subject: randomUUID(),
      email: `unverified-${randomUUID()}@example.test`,
      displayName: "Unverified",
    });
    const row = (await pool.query<{ email_verified_at: Date | null; email_verified_source: string | null }>(
      "SELECT email_verified_at,email_verified_source FROM agents_platform.accounts WHERE id=$1",
      [account.id],
    )).rows[0]!;
    expect(row.email_verified_at).toBeNull();
    expect(row.email_verified_source).toBeNull();
  });

  it("keeps the first verification time when the account signs in again", async () => {
    const subject = randomUUID();
    const input = {
      issuer,
      subject,
      email: `repeat-${randomUUID()}@example.test`,
      displayName: "Repeat",
      emailVerified: true,
    } as const;
    const first = await store.ensureAccount(input);
    const initial = (await pool.query<{ email_verified_at: Date }>(
      "SELECT email_verified_at FROM agents_platform.accounts WHERE id=$1",
      [first.id],
    )).rows[0]!.email_verified_at;
    await new Promise((resolve) => setTimeout(resolve, 10));
    await store.ensureAccount({ ...input, displayName: "Repeat Updated" });
    const after = (await pool.query<{ email_verified_at: Date; display_name: string }>(
      "SELECT email_verified_at,display_name FROM agents_platform.accounts WHERE id=$1",
      [first.id],
    )).rows[0]!;
    expect(after.email_verified_at.getTime()).toBe(initial.getTime());
    expect(after.display_name).toBe("Repeat Updated");
  });
});
