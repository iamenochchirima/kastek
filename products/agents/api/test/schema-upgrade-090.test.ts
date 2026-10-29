import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("uncertain connected effects schema upgrade", () => {
  const database = `agents_upgrade_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  it("upgrades the exact 089 schema, preserves existing data and is idempotent", async () => {
    const directory = join(__dirname, "../schema");
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
    const index = files.indexOf("090_connected_uncertain_escalations.sql");
    expect(index).toBeGreaterThan(0);
    expect(files[index - 1]).toBe("089_support_status_execution.sql");
    const previous = (await Promise.all(files.slice(0,index).map(file => readFile(join(directory,file),"utf8")))).join("\n");
    await pool.query(previous);
    await pool.query("CREATE TABLE agents_platform.schema_version (version text PRIMARY KEY, checksum text NOT NULL)");
    await pool.query("INSERT INTO agents_platform.schema_version VALUES ('001_platform',$1)",[createHash("sha256").update(previous).digest("hex")]);
    await pool.query("CREATE TABLE agents_platform.upgrade_sentinel (value text NOT NULL)");
    await pool.query("INSERT INTO agents_platform.upgrade_sentinel VALUES ('preserved')");
    await setupPlatformSchema(pool);
    await setupPlatformSchema(pool);
    expect((await pool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
    const table = (await pool.query("SELECT to_regclass('agents_platform.connected_uncertain_escalations') AS name")).rows[0].name;
    expect(table).toBe('agents_platform.connected_uncertain_escalations');
    const current = (await Promise.all(files.map(file=>readFile(join(directory,file),"utf8")))).join("\n");
    expect((await pool.query("SELECT checksum FROM agents_platform.schema_version")).rows[0].checksum).toBe(createHash("sha256").update(current).digest("hex"));
    await pool.query("UPDATE agents_platform.schema_version SET checksum=$1",["unknown"]);
    await expect(setupPlatformSchema(pool)).rejects.toThrow("Unsupported Agents platform schema");
    expect((await pool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
  });
});
