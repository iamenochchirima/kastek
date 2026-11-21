import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("adaptive orchestration schema upgrade", () => {
  const database = `agents_upgrade_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl });
    await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href });
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });
  it("upgrades the exact 095 schema, preserves existing data and is idempotent", async () => {
    const directory = join(__dirname, "../schema");
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
    const index = files.indexOf("096_adaptive_orchestration.sql");
    expect(index).toBeGreaterThan(0);
    expect(files[index - 1]).toBe("095_member_channels.sql");
    const previous = (await Promise.all(files.slice(0,index).map(file => readFile(join(directory,file),"utf8")))).join("\n");
    await pool.query(previous);
    await pool.query("CREATE TABLE agents_platform.schema_version (version text PRIMARY KEY, checksum text NOT NULL)");
    await pool.query("INSERT INTO agents_platform.schema_version VALUES ('001_platform',$1)",[createHash("sha256").update(previous).digest("hex")]);
    await pool.query("CREATE TABLE agents_platform.upgrade_sentinel (value text NOT NULL)");
    await pool.query("INSERT INTO agents_platform.upgrade_sentinel VALUES ('preserved')");
    await setupPlatformSchema(pool);
    await setupPlatformSchema(pool);
    expect((await pool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
    const table = (await pool.query("SELECT to_regclass('agents_platform.orchestration_progress') AS name")).rows[0].name;
    expect(table).toBe('agents_platform.orchestration_progress');
    const current = (await Promise.all(files.map(file=>readFile(join(directory,file),"utf8")))).join("\n");
    expect((await pool.query("SELECT checksum FROM agents_platform.schema_version")).rows[0].checksum).toBe(createHash("sha256").update(current).digest("hex"));
    await pool.query("UPDATE agents_platform.schema_version SET checksum=$1",["unknown"]);
    await expect(setupPlatformSchema(pool)).rejects.toThrow("Unsupported Agents platform schema");
    expect((await pool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
  });
  it("reconciles exact hosted and local099 lineages without replaying applied migrations", async () => {
    const directory = join(__dirname, "../schema");
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z_]+\.sql$/.test(name)).sort();
    const contents = new Map(await Promise.all(files.map(async name => [name, await readFile(join(directory,name),"utf8")] as const)));
    const sqlFor = (names: readonly string[]) => names.map(name => contents.get(name)!).join("\n");
    const checksumFor = (sql: string) => createHash("sha256").update(sql).digest("hex");
    const hosted = files.slice(0,files.indexOf("099_recursive_delegation.sql"));
    expect(hosted.at(-1)).toBe("099_managed_default_model.sql");
    expect(checksumFor(sqlFor(hosted))).toBe("e95715b4efd7a675dca22b482e37e0e90b1525fa30e169f85e29654561f899b2");
    const local = files.slice(0, files.indexOf("099_recursive_delegation.sql") + 1).filter(name => name !== "099_managed_default_model.sql");
    const target = checksumFor(sqlFor(files));
    for (const [label,lineage] of [["hosted",hosted],["local",local]] as const) {
      const branchDatabase = `${database}_${label}`;
      await admin.query(`CREATE DATABASE "${branchDatabase}"`);
      const url = new URL(databaseUrl!); url.pathname = `/${branchDatabase}`;
      const branchPool = new Pool({connectionString:url.href});
      try {
      await branchPool.query(sqlFor(lineage));
      await branchPool.query("CREATE TABLE agents_platform.schema_version (version text PRIMARY KEY, checksum text NOT NULL)");
      await branchPool.query("INSERT INTO agents_platform.schema_version VALUES ('001_platform',$1)",[checksumFor(sqlFor(lineage))]);
      await branchPool.query("CREATE TABLE agents_platform.upgrade_sentinel (value text NOT NULL)");
      await branchPool.query("INSERT INTO agents_platform.upgrade_sentinel VALUES ('preserved')");
      await setupPlatformSchema(branchPool);
      await setupPlatformSchema(branchPool);
      expect((await branchPool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
      expect((await branchPool.query("SELECT checksum FROM agents_platform.schema_version")).rows).toEqual([{checksum:target}]);
      expect((await branchPool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_schema='agents_platform' AND (table_name='model_provider_connections' AND column_name='managed_model_id' OR table_name='product_execution_features' AND column_name='managed_capability_baseline')")).rows[0].count).toBe(2);
      await branchPool.query("UPDATE agents_platform.schema_version SET checksum='unrecognized-lineage'");
      await expect(setupPlatformSchema(branchPool)).rejects.toThrow("Unsupported Agents platform schema");
      expect((await branchPool.query("SELECT checksum FROM agents_platform.schema_version")).rows).toEqual([{checksum:"unrecognized-lineage"}]);
      expect((await branchPool.query("SELECT value FROM agents_platform.upgrade_sentinel")).rows).toEqual([{value:"preserved"}]);
      } finally { await branchPool.end(); await dropClosedTestDatabase(admin,branchDatabase); }
    }
  },30_000);

});
