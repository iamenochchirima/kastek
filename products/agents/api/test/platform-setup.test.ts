import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultFaqConfiguration } from "../src/platform/contracts";
import { setupPlatformSchema } from "../src/platform/setup";
import { PlatformStore } from "../src/platform/store";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("fresh platform setup and database snapshot boundaries", () => {
  let admin: Pool;
  const databases: string[] = [];
  const pools: Pool[] = [];
  const roles: string[] = [];
  beforeAll(() => { admin = new Pool({ connectionString: databaseUrl }); });
  afterAll(async () => {
    for (const pool of pools) await pool.end();
    for (const name of databases) await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    for (const name of roles) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin?.end();
  });
  async function freshDatabase() {
    const name = `agents_setup_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE DATABASE "${name}"`);
    databases.push(name);
    const url = new URL(databaseUrl!); url.pathname = `/${name}`;
    const pool = new Pool({ connectionString: url.href }); pools.push(pool);
    return { name, pool, url };
  }
  async function snapshotFixture(pool: Pool) {
    await setupPlatformSchema(pool);
    const store = new PlatformStore(pool);
    const account = await store.ensureAccount({ issuer: "http://localhost:8080/realms/setup-test", subject: randomUUID(), email: "setup@example.com", displayName: "Setup fixture" });
    const org = await store.createOrganization(account.id, "Setup verification");
    const knowledge = await store.approveKnowledge({ accountId: account.id, organizationId: org.id, title: "Returns", content: "Returns within 30 days.", visibility: "public" });
    const configuration = defaultFaqConfiguration(); configuration.knowledgeIds = [knowledge.id];
    const agent = await store.createAgent({ accountId: account.id, organizationId: org.id, name: "FAQ", configuration });
    const version = await store.createVersion({ accountId: account.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    return { store, account, org, knowledge, agent, version };
  }

  it("initializes a fresh database once and verifies the same schema checksum on repeated setup", async () => {
    const { pool } = await freshDatabase();
    await Promise.all([setupPlatformSchema(pool), setupPlatformSchema(pool)]);
    await setupPlatformSchema(pool);
    const directory = resolve(__dirname,"../schema");
    const source = (await Promise.all((await readdir(directory)).filter(name=>/^\d+_[a-z_]+\.sql$/.test(name)).sort().map(name=>readFile(resolve(directory,name),"utf8")))).join("\n");
    const checksum = createHash("sha256").update(source).digest("hex");
    expect((await pool.query("SELECT version,checksum FROM agents_platform.schema_version")).rows).toEqual([{ version: "001_platform", checksum }]);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.accounts")).rows[0].count).toBe(0);
  });

  it("refuses an installed schema whose checksum differs from the current SQL source", async () => {
    const { pool } = await freshDatabase(); await setupPlatformSchema(pool);
    await pool.query("UPDATE agents_platform.schema_version SET checksum=$1", ["0".repeat(64)]);
    await expect(setupPlatformSchema(pool)).rejects.toThrow("Unsupported Agents platform schema");
    expect((await pool.query("SELECT checksum FROM agents_platform.schema_version")).rows[0].checksum).toBe("0".repeat(64));
  });

  it("refuses another product's nonempty database without changing its schema or records", async () => {
    const { pool } = await freshDatabase();
    await pool.query("CREATE SCHEMA growth_data; CREATE TABLE growth_data.orders (id integer PRIMARY KEY, content text NOT NULL); INSERT INTO growth_data.orders VALUES (1,'preserve this product record')");
    const before = (await pool.query("SELECT n.nspname,c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='growth_data' ORDER BY c.relname")).rows;
    await expect(setupPlatformSchema(pool)).rejects.toThrow("fresh dedicated database");
    expect((await pool.query("SELECT n.nspname,c.relname,c.relkind FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='growth_data' ORDER BY c.relname")).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM growth_data.orders")).rows).toEqual([{ id: 1, content: "preserve this product record" }]);
    expect((await pool.query("SELECT to_regnamespace('agents_platform') AS schema")).rows[0].schema).toBeNull();
  });

  it("refuses a hidden product table even when a restricted login can create databases and schemas", async () => {
    const { name, pool, url } = await freshDatabase();
    await pool.query("CREATE SCHEMA growth_data; CREATE TABLE growth_data.private_orders (id integer PRIMARY KEY); INSERT INTO growth_data.private_orders VALUES (7)");
    const role = `agents_setup_role_${randomUUID().replaceAll("-", "")}`;
    const password = randomUUID();
    await admin.query(`CREATE ROLE "${role}" LOGIN CREATEDB PASSWORD '${password}'`); roles.push(role);
    await admin.query(`GRANT CONNECT, CREATE ON DATABASE "${name}" TO "${role}"`);
    url.username = role; url.password = password;
    const restricted = new Pool({ connectionString: url.href }); pools.push(restricted);
    expect((await restricted.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS can_create")).rows[0].can_create).toBe(true);
    expect((await restricted.query("SELECT rolcreatedb FROM pg_catalog.pg_roles WHERE rolname=current_user")).rows[0].rolcreatedb).toBe(true);
    await expect(restricted.query("SELECT * FROM growth_data.private_orders")).rejects.toMatchObject({ code: "42501" });
    expect((await restricted.query("SELECT 1 FROM information_schema.tables WHERE table_schema='growth_data' AND table_name='private_orders'")).rowCount).toBe(0);
    await expect(setupPlatformSchema(restricted)).rejects.toThrow("fresh dedicated database");
    expect((await pool.query("SELECT * FROM growth_data.private_orders")).rows).toEqual([{ id: 7 }]);
    expect((await pool.query("SELECT to_regnamespace('agents_platform') AS schema")).rows[0].schema).toBeNull();
  });

  it("rejects SQL updates and deletions of version, approved knowledge, and pinned source edges", async () => {
    const { pool } = await freshDatabase(); const f = await snapshotFixture(pool);
    for (const statement of [
      "UPDATE agents_platform.agent_versions SET number=number+1 WHERE id=$1",
      "DELETE FROM agents_platform.agent_versions WHERE id=$1",
    ]) await expect(pool.query(statement, [f.version.id])).rejects.toMatchObject({ code: "23514" });
    for (const statement of [
      "UPDATE agents_platform.knowledge_sources SET content='changed' WHERE id=$1",
      "DELETE FROM agents_platform.knowledge_sources WHERE id=$1",
    ]) await expect(pool.query(statement, [f.knowledge.id])).rejects.toMatchObject({ code: "23514" });
    for (const statement of [
      "DELETE FROM agents_platform.version_knowledge WHERE version_id=$1",
      "UPDATE agents_platform.version_knowledge SET knowledge_id=knowledge_id WHERE version_id=$1",
    ]) await expect(pool.query(statement, [f.version.id])).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query("SELECT knowledge_id FROM agents_platform.version_knowledge WHERE version_id=$1", [f.version.id])).rows).toEqual([{ knowledge_id: f.knowledge.id }]);
    expect((await pool.query("SELECT content FROM agents_platform.knowledge_sources WHERE id=$1", [f.knowledge.id])).rows[0].content).toBe("Returns within 30 days.");
  });

  it("rejects a website binding to a different agent's version in the same organization", async () => {
    const { pool } = await freshDatabase(); const f = await snapshotFixture(pool);
    const other = await f.store.createAgent({ accountId: f.account.id, organizationId: f.org.id, name: "Other FAQ", configuration: defaultFaqConfiguration() });
    const sql = "INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)";
    await expect(pool.query(sql, [randomUUID(), f.org.id, other.id, f.version.id, JSON.stringify(["https://example.com"]), f.account.id])).rejects.toMatchObject({ code: "23503" });
    await pool.query(sql, [randomUUID(), f.org.id, f.agent.id, f.version.id, JSON.stringify(["https://example.com"]), f.account.id]);
    expect((await pool.query("SELECT agent_id,version_id FROM agents_platform.website_deployments")).rows).toEqual([{ agent_id: f.agent.id, version_id: f.version.id }]);
  });
});
