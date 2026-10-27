import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { PlatformStore } from "../src/product/agents/store";
import { InboxStore } from "../src/product/inbox/inbox-store";
import { inboxConversation } from "../src/product/inbox/inbox-routes";
import { dropClosedTestDatabase } from "./support/database-cleanup";
const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("messaging channels in canonical Inbox", () => {
  const database = `agents_messaging_inbox_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool, platform: PlatformStore, inbox: InboxStore;
  beforeAll(async () => {
    admin = new Pool({connectionString: databaseUrl}); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`; pool = new Pool({connectionString: url.href});
    await setupPlatformSchema(pool); platform = new PlatformStore(pool);
    inbox = new InboxStore(pool, { admit: async () => { throw Error("No website admission expected"); },
      admitChannel: async () => { throw Error("Human-owned ingress must not admit model work"); },
      readableOutput: async (_db,_task,body) => body, cancelRoot: async () => undefined });
  });
  afterAll(async () => { await pool?.end(); if(admin) { await dropClosedTestDatabase(admin,database); await admin.end(); } });
  async function fixture() {
    const owner=await platform.ensureAccount({issuer:"https://messaging.test",subject:randomUUID(),email:"owner@example.test",displayName:"Owner"});
    const org=await platform.createOrganization(owner.id,"Messaging"), scope={accountId:owner.id,organizationId:org.id};
    const {agent,snapshot}=await platform.createConfiguredAgent({...scope,name:"Support"});
    const connectionId=randomUUID(),deploymentId=randomUUID(),conversationId=randomUUID();
    await pool.query(`INSERT INTO agents_platform.channel_connections(id,organization_id,created_by,kind,name,asset_id,mode,state)
      VALUES($1,$2,$3,'telegram','Support bot',$4,'bot','active')`,[connectionId,org.id,owner.id,randomUUID()]);
    await pool.query(`INSERT INTO agents_platform.channel_deployments(id,organization_id,connection_id,agent_id,version_id,created_by)
      VALUES($1,$2,$3,$4,$5,$6)`,[deploymentId,org.id,connectionId,agent.id,snapshot.id,owner.id]);
    await pool.query(`INSERT INTO agents_platform.customer_conversations(id,organization_id,agent_id,version_id,channel_kind,
      channel_deployment_id,external_conversation_id,external_sender_id,state,assignee_account_id)
      VALUES($1,$2,$3,$4,'telegram',$5,'chat-1','customer-1','human_owned',$6)`,[conversationId,org.id,agent.id,snapshot.id,deploymentId,owner.id]);
    return {scope,org,owner,connectionId,deploymentId,conversationId};
  }
  it("stores and deduplicates external human-owned input without website sessions or model admission",async()=>{
    const f=await fixture(),input={deploymentId:f.deploymentId,externalConversationId:"chat-1",senderId:"customer-1",requestKey:"provider-update-1",body:"Please help"};
    const first=await inbox.ingressChannel(input),second=await inbox.ingressChannel(input);
    expect(first.conversation.id).toBe(f.conversationId);expect(first.conversation.session_id).toBeNull();expect(first.message.task_id).toBeNull();
    expect(second.replayed).toBe(true);expect(second.message.id).toBe(first.message.id);
    expect((await pool.query("SELECT count(*)::int n FROM agents_platform.tasks WHERE organization_id=$1",[f.org.id])).rows[0].n).toBe(0);
    await expect(inbox.ingressChannel({...input,body:"Conflicting duplicate"})).rejects.toMatchObject({code:"INBOX_CONFLICT"});
    const reply=await inbox.command(f.scope,f.conversationId,{commandId:randomUUID(),expectedRevision:"1",action:"reply",body:"A staff reply"});
    expect(reply.state).toBe("human_owned");
    expect((await inbox.readStaff(f.scope,f.conversationId)).messages.map(m=>m.body)).toEqual(["Please help","A staff reply"]);
  });
  it("filters canonical Inbox by actual channel and denies other workspaces and disconnected ingress",async()=>{
    const f=await fixture();
    expect((await inbox.list(f.scope,{channel:"website",limit:30})).items).toHaveLength(0);
    const listed=await inbox.list(f.scope,{channel:"telegram",limit:30});expect(listed.items).toHaveLength(1);
    expect(inboxConversation(listed.items[0]!)).toMatchObject({channel:"telegram",channelDeploymentId:f.deploymentId});
    const other=await fixture();await expect(inbox.readStaff(other.scope,f.conversationId)).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});
    expect((await inbox.readStaff(f.scope,f.conversationId)).channelAvailable).toBe(true);
    expect(inboxConversation((await inbox.list(f.scope,{limit:30})).items[0]!).channelAvailable).toBe(true);
    await pool.query("UPDATE agents_platform.channel_deployments SET state='paused' WHERE id=$1",[f.deploymentId]);
    expect((await inbox.readStaff(f.scope,f.conversationId)).channelAvailable).toBe(false);
    expect(inboxConversation((await inbox.list(f.scope,{limit:30})).items[0]!).channelAvailable).toBe(false);
    await pool.query("UPDATE agents_platform.channel_deployments SET state='active' WHERE id=$1",[f.deploymentId]);
    await pool.query("UPDATE agents_platform.channel_connections SET state='disconnected' WHERE id=$1",[f.connectionId]);
    expect((await inbox.readStaff(f.scope,f.conversationId)).channelAvailable).toBe(false);
    expect(inboxConversation((await inbox.list(f.scope,{limit:30})).items[0]!).channelAvailable).toBe(false);
    await expect(inbox.ingressChannel({deploymentId:f.deploymentId,externalConversationId:"chat-1",senderId:"customer-1",requestKey:"new-event",body:"Hello"})).rejects.toMatchObject({code:"INBOX_ACCESS_DENIED"});
  });
});
