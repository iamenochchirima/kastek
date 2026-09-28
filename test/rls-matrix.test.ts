import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const policyMigrations = [
  "091_memory_knowledge_rls.sql",
  "092_conversation_run_rls.sql",
  "093_identity_credentials_effects_rls.sql",
  "094_control_plane_and_lifecycle_rls.sql",
  "097_parallel_branch_budget_leases.sql",
] as const;

const restrictedRoleSuites = [
  "memory-knowledge-rls.integration.test.ts",
  "conversation-run-rls.integration.test.ts",
  "identity-credentials-effects-rls.integration.test.ts",
  "control-plane-lifecycle-rls.integration.test.ts",
] as const;

describe("restricted-role RLS matrix", () => {
  it("keeps every released protected table represented by a seeded isolation suite", async () => {
    const migrationSql = (await Promise.all(policyMigrations.map((file) => readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8")))).join("\n");
    const protectedTables = [...new Set([...migrationSql.matchAll(/CREATE POLICY\s+\S+\s+ON\s+([a-z_]+)/gi)].map((match) => match[1]))];
    const suiteSource = (await Promise.all(restrictedRoleSuites.map((file) => readFile(new URL(`./${file}`, import.meta.url), "utf8")))).join("\n");

    expect(protectedTables).toHaveLength(64);
    for (const table of protectedTables) {
      expect(suiteSource, `${table} is missing from the restricted-role fixture matrix`).toContain(table);
    }
  });

  it("keeps restricted-role suites opt-in and names the production-equivalent gate", async () => {
    const source = await readFile(new URL("./memory-knowledge-rls.integration.test.ts", import.meta.url), "utf8");
    expect(source).toContain("RUN_AGENTS_RLS_INTEGRATION_TESTS === \"true\"");
    expect(source).toContain("AGENTS_RLS_TEST_DATABASE_URL");
  });
});
