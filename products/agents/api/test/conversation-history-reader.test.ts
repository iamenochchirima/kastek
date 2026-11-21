import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { defaultBusinessConfiguration } from "../src/contracts/contracts";
import { PlatformConversationHistory } from "../src/platform/conversations/history";
import { PlatformStore } from "../src/product/agents/store";
import { dropClosedTestDatabase } from "./support/database-cleanup";

const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("conversation history reader", () => {
  let admin: Pool, pool: Pool;
  const database = `agents_history_reader_${randomUUID().replaceAll("-", "")}`;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => { await pool?.end(); if (admin) { await dropClosedTestDatabase(admin, database); await admin.end(); } });

  it("returns the recent terminal window and counts turns outside it", async () => {
    const store = new PlatformStore(pool);
    const user = await store.ensureAccount({ issuer: "https://identity.test", subject: randomUUID(), email: "reader@example.test", displayName: "Reader" });
    const org = await store.createOrganization(user.id, "History");
    const agent = await store.createAgent({ accountId: user.id, organizationId: org.id, name: "History agent" });
    const version = await store.createVersion({ accountId: user.id, organizationId: org.id, agentId: agent.id, expectedRevision: 1 });
    const conversation = randomUUID(), grant = randomUUID(), configuration = defaultBusinessConfiguration();
    const principal = { kind: "human", issuer: user.issuer, subject: user.subject };
    await pool.query("INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,$4)", [conversation, org.id, agent.id, principal]);
    await pool.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,source_revision_ids,max_input_bytes,max_output_tokens,expires_at)
      VALUES($1,'agents',$2,$3,'agents-execution',$4,$5,'["model.reply"]'::jsonb,ARRAY[]::uuid[],$6,$7,now()+interval '1 hour')`,
    [grant, org.id, agent.id, principal, version.id, configuration.model.maxInputBytes, configuration.model.maxOutputTokens]);
    const turn = async (sequence: number, state: string) => {
      const id = randomUUID();
      await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,output,state,turn_sequence,effective_composition,caller_client_id,root_task_id)
        VALUES($1::uuid,'agents',$2,$3,$4,$5,$6,$7,$1::text,repeat('0',64),$8,$9,$10,$11,(SELECT effective_composition FROM agents_platform.agent_versions WHERE id=$5),'agents-execution',$1::uuid)`,
      [id, org.id, agent.id, principal, version.id, grant, conversation, `Turn ${sequence}`, state === "completed" ? `Answer ${sequence}` : null, state, sequence]);
      return id;
    };
    await turn(1, "completed"); await turn(2, "completed"); await turn(3, "failed"); await turn(4, "accepted");
    const reader = new PlatformConversationHistory(pool);
    const read = await reader.readWindow({ conversationId: conversation, beforeSequence: "5", limit: 2,
      terminalStates: ["completed", "incomplete", "refused", "failed", "cancelled", "uncertain"], memoryScopeId: null, memoryGeneration: null });
    expect(read.turns.map(turn => turn.sequence)).toEqual(["3", "2"]);
    expect(read.olderCount).toBe(1);
    const narrow = await reader.readWindow({ conversationId: conversation, beforeSequence: "3", limit: 10,
      terminalStates: ["completed"], memoryScopeId: null, memoryGeneration: null });
    expect(narrow.turns.map(turn => turn.sequence)).toEqual(["2", "1"]);
    expect(narrow.olderCount).toBe(0);
  });
});
