import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CredentialVaultRepository } from "../src/db/repositories/credential-vault-repository";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("credential vault (integration)", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const organizationId = `credential-test-${randomUUID()}`;
  const vault = new CredentialVaultRepository(pool, "11".repeat(32));
  let credentialId = "";

  it("encrypts, resolves, lists, and revokes without exposing plaintext", async () => {
    const stored = await vault.store({ organizationId, provider: "openai", apiKey: "secret-api-key", actorId: "user-1" });
    credentialId = stored.id;
    expect(JSON.stringify(stored)).not.toContain("secret-api-key");
    expect((await vault.resolve(organizationId, "openai", stored.id)).apiKey).toBe("secret-api-key");
    expect((await vault.list(organizationId))[0]?.id).toBe(stored.id);
    await vault.revoke(organizationId, stored.id);
    await expect(vault.resolve(organizationId, "openai", stored.id)).rejects.toThrow("not found or revoked");
  });

  beforeAll(async () => { await pool.query("SELECT 1"); });
  afterAll(async () => {
    if (credentialId) await pool.query("DELETE FROM credential_vault WHERE organization_id = $1", [organizationId]);
    await pool.end();
  });
});
