import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { databasePoolOptions } from "../infrastructure/pool-policy";
import { PlatformStore } from "../product/agents/store";

async function main(): Promise<void> {
  const connectionString = process.env.AGENTS_MIGRATION_DATABASE_URL || process.env.AGENTS_DATABASE_URL;
  if (!connectionString) throw new Error("AGENTS_DATABASE_URL is required");
  const email = process.env.AGENTS_BOOTSTRAP_EMAIL?.trim();
  const workspaceName = process.env.AGENTS_BOOTSTRAP_WORKSPACE_NAME?.trim();
  if (!email) throw new Error("AGENTS_BOOTSTRAP_EMAIL is required");
  if (!workspaceName) throw new Error("AGENTS_BOOTSTRAP_WORKSPACE_NAME is required");

  const pool = new Pool({ connectionString, ...databasePoolOptions("migration") });
  try {
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({
      issuer: process.env.AGENTS_BOOTSTRAP_ISSUER?.trim() || "http://localhost/sandbox",
      subject: process.env.AGENTS_BOOTSTRAP_SUBJECT?.trim() || "sandbox-owner",
      email,
      displayName: process.env.AGENTS_BOOTSTRAP_DISPLAY_NAME?.trim() || "Sandbox owner",
    });
    const organization = await store.createOrganization(account.id, workspaceName);
    const session = await store.createSession({
      accountId: account.id,
      providerSessionId: randomUUID(),
      expiresAt: new Date(Date.now() + 30 * 86_400_000),
    });
    process.stdout.write(JSON.stringify({
      accountId: account.id,
      organizationId: organization.id,
      organizationName: organization.name,
      session: session.token,
      expiresAt: session.expiresAt.toISOString(),
    }));
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
