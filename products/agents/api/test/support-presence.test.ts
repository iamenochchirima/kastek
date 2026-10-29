import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { aggregateSupportPresence, readSupportPresence, renewSupportPresence, setSupportPresence } from "../src/product/inbox/support-presence";
import { supportStatusV2 } from "../src/capabilities/support-status-v2";
import { validateBuiltinResult } from "../src/capabilities/tool-contracts";
import { dropClosedTestDatabase } from "./support/database-cleanup";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("support presence",()=>{
  const name=`agents_presence_${randomUUID().replaceAll("-","")}`;
  let admin:Pool,pool:Pool;
  beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${name}"`);const target=new URL(url!);target.pathname=`/${name}`;pool=new Pool({connectionString:target.href});
    await pool.query(`CREATE SCHEMA agents_platform; CREATE TABLE agents_platform.memberships(organization_id uuid,account_id uuid,revoked_at timestamptz,PRIMARY KEY(organization_id,account_id));`);
    await pool.query(await readFile(join(__dirname,"../schema/088_support_presence.sql"),"utf8")); });
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,name);await admin.end();}});
  async function fixture(){const org=randomUUID(),other=randomUUID(),a=randomUUID(),b=randomUUID();await pool.query("INSERT INTO agents_platform.memberships VALUES($1,$2,NULL),($1,$3,NULL),($4,$2,NULL)",[org,a,b,other]);return{org,other,a,b};}
  it("defaults to unknown and excludes other tenants and revoked members",async()=>{const f=await fixture();expect(await aggregateSupportPresence(pool,f.org)).toBe("unknown");await setSupportPresence(pool,f.other,f.a,"available");expect(await aggregateSupportPresence(pool,f.org)).toBe("unknown");await setSupportPresence(pool,f.org,f.a,"available");expect(await aggregateSupportPresence(pool,f.org)).toBe("available");await pool.query("UPDATE agents_platform.memberships SET revoked_at=now() WHERE organization_id=$1 AND account_id=$2",[f.org,f.a]);expect(await aggregateSupportPresence(pool,f.org)).toBe("unknown");await expect(readSupportPresence(pool,f.org,f.a)).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});});
  it("expires leases, requires explicit away for every member and rejects stale heartbeats",async()=>{const f=await fixture();const old=await setSupportPresence(pool,f.org,f.a,"available");await setSupportPresence(pool,f.org,f.a,"away");await expect(renewSupportPresence(pool,f.org,f.a,old.leaseId)).rejects.toMatchObject({code:"PRESENCE_EXPIRED"});expect(await aggregateSupportPresence(pool,f.org)).toBe("unknown");await setSupportPresence(pool,f.org,f.b,"away");expect(await aggregateSupportPresence(pool,f.org)).toBe("away");await pool.query("UPDATE agents_platform.support_presence SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND account_id=$2",[f.org,f.b]);expect(await aggregateSupportPresence(pool,f.org)).toBe("unknown");});
  it("renews only the unexpired opted-in lease",async()=>{const f=await fixture();const lease=await setSupportPresence(pool,f.org,f.a,"available");expect((await renewSupportPresence(pool,f.org,f.a,lease.leaseId)).state).toBe("available");await pool.query("UPDATE agents_platform.support_presence SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND account_id=$2",[f.org,f.a]);await expect(renewSupportPresence(pool,f.org,f.a,lease.leaseId)).rejects.toMatchObject({code:"PRESENCE_EXPIRED"});expect((await readSupportPresence(pool,f.org,f.a)).state).toBe("unknown");});
  it("returns the next opening with schedule and presence as separate facts",async()=>{const f=await fixture();const hours={timeZone:"Europe/London",intervals:[{day:0,start:"09:00",end:"10:00"}]};const result=await supportStatusV2(pool,f.org,hours,new Date("2026-03-29T07:30:00Z"));expect(result).toMatchObject({hours:{state:"closed"},nextOpening:"2026-03-29T08:00:00.000Z",staffAvailability:"unknown"});expect(()=>validateBuiltinResult("support.get_status_v2",result)).not.toThrow();expect((await supportStatusV2(pool,f.org,undefined)).nextOpening).toBeNull();});
});
