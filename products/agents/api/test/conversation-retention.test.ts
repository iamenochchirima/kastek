import { randomUUID } from "node:crypto";
import { mkdtemp,readFile,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll,beforeAll,describe,expect,it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { configureConversationRetention,expireInactiveConversations } from "../src/platform/memory/conversation-retention";
import { dropClosedTestDatabase } from "./support/database-cleanup";
import { retentionLedgerCommand } from "../src/composition/retention-ledger";
const url=process.env.AGENTS_TEST_DATABASE_URL;
(url?describe:describe.skip)("conversation retention and restore fences",()=>{
  const database="agents_retention_"+randomUUID().replaceAll("-","");let admin:Pool,pool:Pool;
  beforeAll(async()=>{admin=new Pool({connectionString:url});await admin.query(`CREATE DATABASE "${database}"`);
    const target=new URL(url!);target.pathname="/"+database;pool=new Pool({connectionString:target.href});await setupPlatformSchema(pool);});
  afterAll(async()=>{await pool?.end();if(admin){await dropClosedTestDatabase(admin,database);await admin.end();}});
  it("defaults to no expiry, respects holds and replays deletion before restored access",async()=>{
    const store=new PlatformStore(pool),person=await store.ensureAccount({issuer:"http://localhost/retention",subject:randomUUID(),email:"fixture@example.test",displayName:"Retention"});
    const org=await store.createOrganization(person.id,"Retention"),agent=await store.createAgent({accountId:person.id,organizationId:org.id,name:"Agent",configuration:defaultBusinessConfiguration()});
    const old=randomUUID(),held=randomUUID(),recent=randomUUID();
    for(const [id,days,hold] of [[old,100,false],[held,100,true],[recent,1,false]] as const)await pool.query(`INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal,created_at,retention_hold)
      VALUES($1,$2,$3,$4,now()-$5::integer*interval '1 day',$6)`,[id,org.id,agent.id,{kind:"human",issuer:person.issuer,subject:person.subject},days,hold]);
    expect(await expireInactiveConversations(pool)).toBe(0);
    await configureConversationRetention(pool,org.id,90,"fixture");expect(await expireInactiveConversations(pool)).toBe(1);
    expect(await expireInactiveConversations(pool)).toBe(0);
    expect((await pool.query("SELECT id FROM agents_platform.conversations WHERE deleted_at IS NULL AND organization_id=$1 ORDER BY id",[org.id])).rows.map(r=>r.id).sort()).toEqual([held,recent].sort());
    await expect(pool.query("UPDATE agents_platform.conversations SET deleted_at=NULL WHERE id=$1",[old])).rejects.toMatchObject({code:"23514"});
    const restored=randomUUID(),ledger=[{conversationId:restored,organizationId:org.id,deletedAt:new Date().toISOString()}];
    expect((await pool.query("SELECT agents_platform.replay_conversation_deletion_ledger($1::jsonb) n",[JSON.stringify(ledger)])).rows[0].n).toBe(1);
    await expect(pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)",[restored,org.id,agent.id,{kind:"human",issuer:person.issuer,subject:person.subject}])).rejects.toMatchObject({code:"23514"});
    await expect(pool.query("SELECT agents_platform.replay_conversation_deletion_ledger(NULL)")).rejects.toThrow("Invalid conversation deletion ledger");
    const directory=await mkdtemp(join(tmpdir(),"agents-ledger-")),file=join(directory,"ledger.json"),previous=process.env.AGENTS_DATABASE_URL;
    const target=new URL(url!);target.pathname="/"+database;process.env.AGENTS_DATABASE_URL=target.href;
    try{
      await retentionLedgerCommand(["export","--output",file]);
      const exported=JSON.parse(await readFile(file,"utf8"));expect(exported.complete).toBe(true);expect(exported.conversations).toHaveLength(2);
      await retentionLedgerCommand(["replay","--ledger",file]);
      await writeFile(file,JSON.stringify({...exported,exportedAt:"2000-01-01T00:00:00Z"}));
      await expect(retentionLedgerCommand(["replay","--ledger",file])).rejects.toThrow("fresh complete deletion ledger");
    }finally{if(previous===undefined)delete process.env.AGENTS_DATABASE_URL;else process.env.AGENTS_DATABASE_URL=previous;await rm(directory,{recursive:true,force:true});}
  });
});
