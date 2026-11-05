import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const url = process.env.AGENTS_TEST_DATABASE_URL;
(url ? describe : describe.skip)("runtime-derived publication schema", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_runtime_derived_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: url });
    await admin.query(`CREATE DATABASE "${database}"`);
    const target = new URL(url!); target.pathname = `/${database}`;
    pool = new Pool({ connectionString: target.href });
    await pool.query(`CREATE SCHEMA agents_platform;
      CREATE TABLE agents_platform.agent_versions (
        id uuid PRIMARY KEY, organization_id uuid NOT NULL, agent_id uuid NOT NULL,
        number integer NOT NULL, draft_revision integer NOT NULL,
        UNIQUE (agent_id, number), UNIQUE (agent_id, draft_revision), UNIQUE (organization_id, agent_id, id)
      )`);
    await pool.query(await readFile(new URL("../schema/116_runtime_derived_versions.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("preserves authored draft uniqueness while allowing same-agent runtime descendants", async () => {
    const organization = randomUUID(), agent = randomUUID(), other = randomUUID(), source = randomUUID(), derived = randomUUID(), next = randomUUID();
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision) VALUES($1,$2,$3,1,1)", [source, organization, agent]);
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,runtime_derived_from) VALUES($1,$2,$3,2,1,$4)", [derived, organization, agent, source]);
    await expect(pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision) VALUES($1,$2,$3,3,1)", [randomUUID(), organization, agent])).rejects.toMatchObject({ code: "23505" });
    await expect(pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,runtime_derived_from) VALUES($1,$2,$3,1,1,$4)", [randomUUID(), organization, other, source])).rejects.toMatchObject({ code: "23503" });
    await expect(pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,runtime_derived_from) VALUES($1,$2,$3,3,2,$4)", [randomUUID(), organization, agent, source])).rejects.toMatchObject({ code: "23503" });
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,runtime_derived_from) VALUES($1,$2,$3,3,1,$4)", [next, organization, agent, derived]);
    await pool.query("INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision) VALUES($1,$2,$3,4,2)", [randomUUID(), organization, agent]);
    const found = (await pool.query("SELECT id FROM agents_platform.agent_versions WHERE agent_id=$1 AND draft_revision=1 ORDER BY number DESC LIMIT 1", [agent])).rows[0];
    expect(found.id).toBe(next);
  });
});
