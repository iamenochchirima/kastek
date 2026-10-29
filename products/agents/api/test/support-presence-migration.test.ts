import { createHash, randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { dropClosedTestDatabase } from "./support/database-cleanup";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("presence schema upgrade",()=>{
 const name=`agents_presence_upgrade_${randomUUID().replaceAll("-","")}`;let admin:Pool,pool:Pool;
 beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname=`/${name}`;pool=new Pool({connectionString:target.href});});
 afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,name);await admin.end();}});
 it("upgrades the exact 087 schema, preserves existing data, reruns and rejects unknown checksums",async()=>{
  const directory=join(__dirname,"../schema"),files=(await readdir(directory)).filter(file=>/^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const last=files.indexOf("087_handoff_pending_receipts.sql");expect(last).toBeGreaterThan(0);expect(files[last+1]).toBe("088_support_presence.sql");
  const old=(await Promise.all(files.slice(0,last+1).map(file=>readFile(join(directory,file),"utf8")))).join("\n");
  await pool.query(old);await pool.query("CREATE TABLE agents_platform.schema_version(version text PRIMARY KEY,checksum text NOT NULL)");
  await pool.query("INSERT INTO agents_platform.schema_version VALUES('001_platform',$1)",[createHash("sha256").update(old).digest("hex")]);
  await pool.query("CREATE TABLE agents_platform.presence_upgrade_marker(value text NOT NULL); INSERT INTO agents_platform.presence_upgrade_marker VALUES('preserved')");
  await setupPlatformSchema(pool);
  expect((await pool.query("SELECT value FROM agents_platform.presence_upgrade_marker")).rows[0].value).toBe("preserved");
  expect((await pool.query("SELECT to_regclass('agents_platform.support_presence') AS name")).rows[0].name).toBe("agents_platform.support_presence");
  await setupPlatformSchema(pool);
  await pool.query("UPDATE agents_platform.schema_version SET checksum='unknown'");
  await expect(setupPlatformSchema(pool)).rejects.toThrow("Unsupported Agents platform schema");
 });
});
