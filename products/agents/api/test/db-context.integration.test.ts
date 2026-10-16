import { afterAll, describe, expect, it } from "vitest";
import { createPool, query, withTransaction } from "../src/db/pool";
import { runWithDatabaseContext } from "../src/db/context";

const databaseUrl = process.env.AGENTS_DATABASE_URL;
const runIntegration = Boolean(databaseUrl && process.env.RUN_AGENTS_DB_INTEGRATION_TESTS === "true");

describe.skipIf(!runIntegration)("database context plumbing (integration)", () => {
  const pool = createPool({
    AGENTS_DATABASE_URL: databaseUrl!,
    AGENTS_DATABASE_POOL_MAX: 2,
    NODE_ENV: "development",
  } as never);

  it("sets transaction-local organization and actor context without leaking between scopes", async () => {
    await runWithDatabaseContext({ organizationId: "context-org-a", actorId: "actor-a" }, async () => {
      const direct = await query<{ organization_id: string; actor_id: string; operator: string }>(
        pool,
        "SELECT current_setting('kasitek.organization_id', true) AS organization_id, current_setting('kasitek.actor_id', true) AS actor_id, current_setting('kasitek.operator', true) AS operator",
      );
      expect(direct.rows[0]).toEqual({ organization_id: "context-org-a", actor_id: "actor-a", operator: "false" });

      await withTransaction(pool, async (client) => {
        const transactional = await client.query<{ organization_id: string; actor_id: string }>(
          "SELECT current_setting('kasitek.organization_id', true) AS organization_id, current_setting('kasitek.actor_id', true) AS actor_id",
        );
        expect(transactional.rows[0]).toEqual({ organization_id: "context-org-a", actor_id: "actor-a" });
      });

      await runWithDatabaseContext({ organizationId: "context-org-b", actorId: "actor-b", operator: true }, async () => {
        const nested = await query<{ organization_id: string; actor_id: string; operator: string }>(
          pool,
          "SELECT current_setting('kasitek.organization_id', true) AS organization_id, current_setting('kasitek.actor_id', true) AS actor_id, current_setting('kasitek.operator', true) AS operator",
        );
        expect(nested.rows[0]).toEqual({ organization_id: "context-org-b", actor_id: "actor-b", operator: "true" });
      });

      const restored = await query<{ organization_id: string; actor_id: string }>(
        pool,
        "SELECT current_setting('kasitek.organization_id', true) AS organization_id, current_setting('kasitek.actor_id', true) AS actor_id",
      );
      expect(restored.rows[0]).toEqual({ organization_id: "context-org-a", actor_id: "actor-a" });

      const concurrent = await Promise.all(["context-org-c", "context-org-d"].map((organizationId) => runWithDatabaseContext(
        { organizationId, actorId: `actor-${organizationId.slice(-1)}` },
        async () => (await query<{ organization_id: string; actor_id: string }>(
          pool,
          "SELECT current_setting('kasitek.organization_id', true) AS organization_id, current_setting('kasitek.actor_id', true) AS actor_id FROM pg_sleep(0.05)",
        )).rows[0],
      )));
      expect(concurrent).toEqual([
        { organization_id: "context-org-c", actor_id: "actor-c" },
        { organization_id: "context-org-d", actor_id: "actor-d" },
      ]);
    });

    const outside = await query<{ organization_id: string | null; actor_id: string | null }>(
      pool,
      "SELECT NULLIF(current_setting('kasitek.organization_id', true), '') AS organization_id, NULLIF(current_setting('kasitek.actor_id', true), '') AS actor_id",
    );
    expect(outside.rows[0]).toEqual({ organization_id: null, actor_id: null });
  });

  afterAll(async () => pool.end());
});
