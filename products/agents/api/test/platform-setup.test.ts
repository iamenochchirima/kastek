import {dropClosedTestDatabase} from "./support/database-cleanup";
import {publishFixtureSource} from "./knowledge-fixture";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";

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
    for (const name of databases) await dropClosedTestDatabase(admin,name);
    for (const name of roles) await admin.query(`DROP ROLE IF EXISTS "${name}"`);
    await admin?.end();
  },60_000);
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
    const knowledge = await publishFixtureSource(pool,{ accountId: account.id, organizationId: org.id, title: "Returns", content: "Returns within 30 days.", visibility: "public" });
    const configuration = defaultBusinessConfiguration(); configuration.sourceRevisionIds = [knowledge.id];
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

  it.each(["070_product_capability_reviews.sql","104_retained_evidence_graph.sql","108_orchestration_stall_decisions.sql","109_product_task_artifacts.sql","110_platform_admission_gate.sql"])("applies recognized additive schema %s without resetting installed records",async suffix=>{
    const {pool}=await freshDatabase(),directory=resolve(__dirname,"../schema");
    const files=(await readdir(directory)).filter(name=>/^\d+_[a-z_]+\.sql$/.test(name)).sort();
    const first=files.indexOf(suffix);expect(first).toBeGreaterThan(0);
    const source=(await Promise.all(files.slice(0,first).map(file=>readFile(resolve(directory,file),"utf8")))).join("\n");
    await pool.query(source);
    await pool.query("CREATE TABLE agents_platform.schema_version(version text PRIMARY KEY,checksum text NOT NULL)");
    await pool.query("INSERT INTO agents_platform.schema_version VALUES('001_platform',$1)",[createHash("sha256").update(source).digest("hex")]);
    const organizationId=randomUUID();await pool.query("INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Existing organisation')",[organizationId]);
    if(suffix==="104_retained_evidence_graph.sql")expect((await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='agents_platform.evidence_nodes'::regclass AND conname IN ('evidence_nodes_evidence_ids_check','evidence_nodes_parents_check')")).rows).toHaveLength(2);
    await setupPlatformSchema(pool);await setupPlatformSchema(pool);
    expect((await pool.query("SELECT name FROM agents_platform.organizations WHERE id=$1",[organizationId])).rows[0].name).toBe("Existing organisation");
    expect((await pool.query("SELECT column_default FROM information_schema.columns WHERE table_schema='agents_platform' AND table_name='tasks' AND column_name='harness_release'")).rows[0].column_default).toContain("product-capabilities-v11");
    expect((await pool.query("SELECT to_regclass('agents_platform.growth_capability_publications') name")).rows[0].name).toBeTruthy();
    if(suffix==="104_retained_evidence_graph.sql")expect((await pool.query("SELECT conname FROM pg_constraint WHERE conrelid='agents_platform.evidence_nodes'::regclass AND conname IN ('evidence_nodes_evidence_ids_check','evidence_nodes_parents_check')")).rows).toEqual([]);
    if(suffix==="108_orchestration_stall_decisions.sql"||suffix==="109_product_task_artifacts.sql"||suffix==="110_platform_admission_gate.sql"){
      const index=(await pool.query(`SELECT i.indisvalid,i.indisready,i.indisunique FROM pg_catalog.pg_index i
        JOIN pg_catalog.pg_class x ON x.oid=i.indexrelid JOIN pg_catalog.pg_namespace n ON n.oid=x.relnamespace
        WHERE n.nspname='agents_platform' AND x.relname='product_task_artifact_operation'`)).rows;
      expect(index).toEqual([{indisvalid:true,indisready:true,indisunique:true}]);
      const rollout=(await pool.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_schema='agents_platform' AND table_name='product_execution_features' AND column_name='artifact_rollout_revision'")).rows[0];
      expect(rollout).toEqual({column_default:"0",is_nullable:"NO"});
      const directory=resolve(__dirname,"../schema");
      const current=(await Promise.all((await readdir(directory)).filter(name=>/^\d+_[a-z_]+\.sql$/.test(name)).sort().map(name=>readFile(resolve(directory,name),"utf8")))).join("\n");
      expect((await pool.query("SELECT checksum FROM agents_platform.schema_version WHERE version='001_platform'")).rows[0].checksum).toBe(createHash("sha256").update(current).digest("hex"));
    }
    if(suffix==="110_platform_admission_gate.sql"){
      expect((await pool.query("SELECT accepting_roots,revision FROM agents_platform.platform_admission_gate WHERE id=1")).rows)
        .toEqual([{accepting_roots:true,revision:"0"}]);
      expect((await pool.query("SELECT count(*)::int AS count FROM agents_platform.platform_admission_gate_events")).rows[0].count).toBe(0);
    }
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
      "UPDATE agents_platform.source_revisions SET text_digest=repeat('a',64) WHERE id=$1",
      "DELETE FROM agents_platform.source_revisions WHERE id=$1",
    ]) await expect(pool.query(statement, [f.knowledge.id])).rejects.toMatchObject({ code: "23514" });
    for (const statement of [
      "DELETE FROM agents_platform.version_sources WHERE version_id=$1",
      "UPDATE agents_platform.version_sources SET revision_id=revision_id WHERE version_id=$1",
    ]) await expect(pool.query(statement, [f.version.id])).rejects.toMatchObject({ code: "23514" });
    expect((await pool.query("SELECT revision_id FROM agents_platform.version_sources WHERE version_id=$1", [f.version.id])).rows).toEqual([{ revision_id: f.knowledge.id }]);
    expect((await pool.query("SELECT text_digest FROM agents_platform.source_revisions WHERE id=$1", [f.knowledge.id])).rows[0].text_digest).toBe(createHash("sha256").update("Returns within 30 days.").digest("hex"));
  });

  it("removes an agent from active use while preserving its records and revoking its website", async () => {
    const {pool}=await freshDatabase(); const f=await snapshotFixture(pool);
    const deploymentId=randomUUID();
    await pool.query(`INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by)
      VALUES($1,$2,$3,$4,$5::jsonb,$6)`,[deploymentId,f.org.id,f.agent.id,f.version.id,JSON.stringify(["https://example.com"]),f.account.id]);
    const outsider=await f.store.ensureAccount({issuer:"http://localhost:8080/realms/setup-test",subject:randomUUID(),email:"other@example.com",displayName:"Other"});
    await expect(f.store.deleteAgent(outsider.id,f.org.id,f.agent.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await f.store.deleteAgent(f.account.id,f.org.id,f.agent.id);
    expect((await f.store.listAgents(f.account.id,f.org.id)).map(agent=>agent.name)).toEqual(["Assistant"]);
    await expect(f.store.getAgent(f.account.id,f.org.id,f.agent.id)).rejects.toMatchObject({code:"NOT_FOUND"});
    expect((await pool.query("SELECT revoked_at IS NOT NULL revoked FROM agents_platform.website_deployments WHERE id=$1",[deploymentId])).rows[0].revoked).toBe(true);
    expect((await pool.query("SELECT id FROM agents_platform.agent_versions WHERE id=$1",[f.version.id])).rowCount).toBe(1);
    await expect(f.store.publishWebsite({accountId:f.account.id,organizationId:f.org.id,agentId:f.agent.id,versionId:f.version.id,allowedOrigins:["https://example.com"]})).rejects.toMatchObject({code:"NOT_FOUND"});
  });

  it("fences deletion against active work and pauses attached channels and automations", async () => {
    const {pool}=await freshDatabase(); const f=await snapshotFixture(pool);
    const scope=[f.org.id,f.agent.id], principal={kind:"human",issuer:f.account.issuer,subject:f.account.subject};
    const member=await f.store.ensureAccount({issuer:f.account.issuer,subject:randomUUID(),email:"member@example.com",displayName:"Member"});
    await pool.query("INSERT INTO agents_platform.memberships(organization_id,account_id,role) VALUES($1,$2,'member')",[f.org.id,member.id]);
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.org.id,member.id]);
    await expect(f.store.deleteAgent(member.id,f.org.id,f.agent.id)).rejects.toMatchObject({code:"ACCESS_DENIED"});
    await pool.query("UPDATE agents_platform.memberships SET revoked_at=NULL WHERE organization_id=$1 AND account_id=$2",[f.org.id,member.id]);
    const grant=randomUUID(),conversation=randomUUID(),task=randomUUID();
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at)
      VALUES($1,'agents',$2,$3,'fixture',$4,$5,'["model.reply"]',8192,1024,now()+interval '1 hour')`,[grant,f.org.id,f.agent.id,principal,f.version.id]);
    await pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)",[conversation,...scope,principal]);
    await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,state,effective_composition,root_task_id)
      VALUES($1,'agents',$2,$3,'fixture',$4,$5,$6,$7,$1::uuid::text,$8,'Hello','running',(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),$1)`,[task,f.org.id,f.agent.id,principal,f.version.id,grant,conversation,'a'.repeat(64)]);
    await expect(f.store.deleteAgent(member.id,f.org.id,f.agent.id)).rejects.toMatchObject({code:"AGENT_TASKS_ACTIVE",statusCode:409});
    await pool.query("UPDATE agents_platform.tasks SET state='completed' WHERE id=$1",[task]);
    const connection=randomUUID(),deployment=randomUUID(),thread=randomUUID(),message=randomUUID(),outbound=randomUUID(),automation=randomUUID();
    await pool.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state) VALUES($1,$2,$3,'telegram','Fixture','fixture-bot','bot','active')`,[connection,f.org.id,f.account.id]);
    await pool.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by) VALUES($1,$2,$3,$4,$5,$6)`,[deployment,f.org.id,connection,f.agent.id,f.version.id,f.account.id]);
    await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,channel_deployment_id,external_conversation_id,external_sender_id,state,assignee_account_id)
      VALUES($1,$2,$3,$4,'telegram',$5,'fixture','fixture','human_owned',$6)`,[thread,f.org.id,f.agent.id,f.version.id,deployment,f.account.id]);
    await pool.query(`INSERT INTO agents_platform.customer_messages(id,conversation_id,sequence,author_kind,author_account_id,body,request_key,request_digest,ownership_generation)
      VALUES($1,$2,1,'human',$3,'Hello','fixture','digest',1)`,[message,thread,f.account.id]);
    await pool.query(`INSERT INTO agents_platform.channel_outbound(id,organization_id,connection_id,deployment_id,conversation_id,message_id,segment,ownership_generation,connection_revision,credential_revision,request,digest,state)
      VALUES($1,$2,$3,$4,$5,$6,0,1,1,0,'{}','digest','sending')`,[outbound,f.org.id,connection,deployment,thread,message]);
    await pool.query("INSERT INTO agents_platform.automations(id,organization_id,owner_account_id,name) VALUES($1,$2,$3,'Fixture')",[automation,f.org.id,f.account.id]);
    await pool.query("INSERT INTO agents_platform.automation_revisions(automation_id,revision,version_id,configuration) VALUES($1,1,$2,'{}')",[automation,f.version.id]);
    await expect(f.store.deleteAgent(member.id,f.org.id,f.agent.id)).rejects.toMatchObject({code:"AGENT_DELIVERY_ACTIVE",statusCode:409});
    expect((await pool.query("SELECT state FROM agents_platform.channel_deployments WHERE id=$1",[deployment])).rows[0].state).toBe("active");
    await pool.query("UPDATE agents_platform.channel_outbound SET state='accepted' WHERE id=$1",[outbound]);
    await f.store.deleteAgent(member.id,f.org.id,f.agent.id);
    expect((await pool.query("SELECT state FROM agents_platform.channel_deployments WHERE id=$1",[deployment])).rows[0].state).toBe("revoked");
    expect((await pool.query("SELECT state FROM agents_platform.channel_connections WHERE id=$1",[connection])).rows[0].state).toBe("active");
    expect((await pool.query("SELECT state FROM agents_platform.automations WHERE id=$1",[automation])).rows[0].state).toBe("paused");
    expect((await pool.query("SELECT revoked_at IS NOT NULL revoked FROM agents_platform.execution_grants WHERE id=$1",[grant])).rows[0].revoked).toBe(true);
    expect((await pool.query("SELECT id FROM agents_platform.customer_messages WHERE id=$1",[message])).rowCount).toBe(1);
  });

  it("rejects a website binding to a different agent's version in the same organization", async () => {
    const { pool } = await freshDatabase(); const f = await snapshotFixture(pool);
    const other = await f.store.createAgent({ accountId: f.account.id, organizationId: f.org.id, name: "Other FAQ", configuration: defaultBusinessConfiguration() });
    const sql = "INSERT INTO agents_platform.website_deployments(id,organization_id,agent_id,version_id,allowed_origins,published_by) VALUES($1,$2,$3,$4,$5::jsonb,$6)";
    await expect(pool.query(sql, [randomUUID(), f.org.id, other.id, f.version.id, JSON.stringify(["https://example.com"]), f.account.id])).rejects.toMatchObject({ code: "23503" });
    await pool.query(sql, [randomUUID(), f.org.id, f.agent.id, f.version.id, JSON.stringify(["https://example.com"]), f.account.id]);
    expect((await pool.query("SELECT agent_id,version_id FROM agents_platform.website_deployments")).rows).toEqual([{ agent_id: f.agent.id, version_id: f.version.id }]);
  });
});
