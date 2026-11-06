import assert from "node:assert/strict";
import test from "node:test";
import { readConfig } from "../src/config.js";
import { ApiError } from "../src/error.js";
import { resolveGrowthManagedChannelActor } from "../src/agents/channel-links.js";
import type { CoreContext } from "../src/context.js";

const issuer = "https://growth.example.test/identity";

function coreForUser(userId: string | null) {
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const core = {
    config: readConfig({ DATABASE_URL: "postgres://unused", GROWTH_IDENTITY_ISSUER: issuer }),
    pool: {
      async query(sql: string, values: unknown[]) {
        queries.push({ sql, values });
        return { rows: userId ? [{ id: userId }] : [] };
      },
    },
  } as unknown as CoreContext;
  return { core, queries };
}

test("Growth channel actor resolves a verified internal Growth user ID", async () => {
  const { core, queries } = coreForUser("growth-user-1");

  assert.equal(await resolveGrowthManagedChannelActor(core, { issuer, subject: "growth-user-1" }), "growth-user-1");
  assert.match(queries[0]!.sql, /FROM "User" WHERE id=\$1 AND "emailVerified" IS NOT NULL/);
  assert.deepEqual(queries[0]!.values, ["growth-user-1"]);
});

test("Growth channel actor rejects a different issuer before querying users", async () => {
  const { core, queries } = coreForUser("growth-user-1");

  await assert.rejects(
    resolveGrowthManagedChannelActor(core, { issuer: "https://untrusted.example.test/identity", subject: "growth-user-1" }),
    (error: unknown) => error instanceof ApiError && error.code === "agent_channel_access_denied",
  );
  assert.equal(queries.length, 0);
});

test("Growth channel actor rejects a missing or unverified user", async () => {
  const { core } = coreForUser(null);

  await assert.rejects(
    resolveGrowthManagedChannelActor(core, { issuer, subject: "missing-user" }),
    (error: unknown) => error instanceof ApiError && error.code === "agent_channel_access_denied",
  );
});
