import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupPlatformSchema } from "../src/composition/setup";
import { transaction } from "../src/infrastructure/database";
import { initializeRootModelAccount, reserveModelCost, settleModelCost, quoteNormalizedUsage,
  type AccountingUsage, type AccountingPrices, type CostQuote, type ModelOperationScope } from "../src/execution/models/accounting";
const usage: AccountingUsage = { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 100, reasoningTokens: 50 };
const prices: AccountingPrices = { currency: "USD", inputMicrosPerMillionTokens: 2000000, outputMicrosPerMillionTokens: 10000000,
  cachedInputMicrosPerMillionTokens: 500000, cacheWriteMicrosPerMillionTokens: 3000000 };
const known = (costMicros: bigint): CostQuote => ({ status: "known", costMicros });
const unknown: CostQuote = { status: "unknown", reason: "No observed usage" };
describe("normalized model usage pricing", () => {
  it("charges cache subsets once and includes reasoning only in observed output", () => {
    expect(quoteNormalizedUsage(usage, prices)).toEqual(known(2800n));
  });
  it("rounds up once using integer arithmetic beyond safe intermediate numbers", () => {
    expect(quoteNormalizedUsage({ ...usage, inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      { ...prices, inputMicrosPerMillionTokens: 1 })).toEqual(known(1n));
    expect(quoteNormalizedUsage({ ...usage, inputTokens: 9007199254740991, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
      { ...prices, inputMicrosPerMillionTokens: 999 })).toEqual(known(8998192055487n));
  });
  it("keeps missing usage and unknown priced components unknown", () => {
    for (const changed of [null, { ...usage, inputTokens: null }, { ...usage, cacheReadTokens: null },
      { ...usage, cacheReadTokens: 1001 }, { ...usage, reasoningTokens: 101 }, { ...usage, outputTokens: -1 }]) {
      expect(quoteNormalizedUsage(changed, prices).status).toBe("unknown");
    }
    expect(quoteNormalizedUsage(usage, { ...prices, cacheWriteMicrosPerMillionTokens: null }).status).toBe("unknown");
    expect(quoteNormalizedUsage({ ...usage, reasoningTokens: null }, prices)).toEqual(quoteNormalizedUsage(usage, prices));
    expect(quoteNormalizedUsage(usage, { ...prices, cachedInputMicrosPerMillionTokens: null }).status).toBe("unknown");
    expect(quoteNormalizedUsage(usage, { ...prices, cachedInputMicrosPerMillionTokens: null, cacheReadBasePriceIsCeiling: true })).toEqual(known(3100n));
  });
  it("distinguishes observed zero from unknown and ignores prices for observed zero components", () => {
    const zero = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };
    expect(quoteNormalizedUsage(zero, { currency: "USD", inputMicrosPerMillionTokens: null, outputMicrosPerMillionTokens: null,
      cachedInputMicrosPerMillionTokens: null })).toEqual(known(0n));
    expect(quoteNormalizedUsage(null, prices).status).toBe("unknown");
    expect(quoteNormalizedUsage({ ...usage, cacheWriteTokens: 0 }, { ...prices, cacheWriteMicrosPerMillionTokens: null }).status).toBe("known");
  });
});
const databaseUrl = process.env.AGENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("root monetary accounting with fresh PostgreSQL", () => {
  const database = `agents_cost_${randomUUID().replaceAll("-", "")}`;
  let admin: Pool, pool: Pool;
  beforeAll(async () => {
    admin = new Pool({ connectionString: databaseUrl }); await admin.query(`CREATE DATABASE "${database}"`);
    const url = new URL(databaseUrl!); url.pathname = `/${database}`;
    pool = new Pool({ connectionString: url.href }); await setupPlatformSchema(pool);
  });
  afterAll(async () => {
    await pool?.end(); if (admin) { await admin.query(`DROP DATABASE IF EXISTS "${database}" WITH(FORCE)`); await admin.end(); }
  });
  async function fixture(maxCostMicros: bigint | null = 100n): Promise<ModelOperationScope> {
    const organizationId = randomUUID(), account = randomUUID(), agent = randomUUID(), version = randomUUID(), grant = randomUUID(), conversation = randomUUID(), rootTaskId = randomUUID();
    await transaction(pool, async db => {
      await db.query(`INSERT INTO agents_platform.accounts(id,issuer,subject,email,display_name) VALUES($1::uuid,'fixture',($1::uuid)::text,'fixture@example.test','Fixture')`, [account]);
      await db.query(`INSERT INTO agents_platform.organizations(id,name) VALUES($1,'Fixture')`, [organizationId]);
      await db.query(`INSERT INTO agents_platform.agents(id,organization_id,name,draft,created_by) VALUES($1,$2,'Fixture','{}',$3)`, [agent, organizationId, account]);
      await db.query(`INSERT INTO agents_platform.agent_versions(id,organization_id,agent_id,number,draft_revision,execution_kind,configuration,created_by,effective_composition)
        VALUES($1,$2,$3,1,1,'business','{"executionKind":"business"}',$4,jsonb_build_object('schemaVersion','1','digest',repeat('a',64)))`, [version, organizationId, agent, account]);
      await db.query(`INSERT INTO agents_platform.execution_grants(id,product,organization_id,resource_id,caller_client_id,principal,version_id,operations,max_input_bytes,max_output_tokens,expires_at)
        VALUES($1,'agents',$2,$3,'fixture','{"kind":"human"}',$4,'[]',16384,1024,now()+interval '1 hour')`, [grant, organizationId, agent, version]);
      await db.query(`INSERT INTO agents_platform.conversations(id,organization_id,agent_id,principal) VALUES($1,$2,$3,'{}')`, [conversation, organizationId, agent]);
      await db.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,root_task_id,effective_composition)
        VALUES($1,'agents',$2,$3,'fixture','{}',$4,$5,$6,($1::uuid)::text,repeat('a',64),'Fixture',$1,jsonb_build_object('schemaVersion','1','digest',repeat('a',64)))`, [rootTaskId, organizationId, agent, version, grant, conversation]);
      await db.query(`INSERT INTO agents_platform.execution_roots(root_task_id) VALUES($1)`, [rootTaskId]);
      await initializeRootModelAccount(db, { organizationId, rootTaskId, maxCostMicros });
    });
    return { organizationId, rootTaskId, taskId: rootTaskId, operationId: randomUUID() };
  }
  async function insertOperation(db: PoolClient, scope: ModelOperationScope) {
    await db.query(`INSERT INTO agents_platform.operations(id,task_id,kind,name,request_digest,request,state,reserved_ms,attempt_id)
      VALUES($1,$2,'model','fixture',repeat('a',64),'{}','started',0,$3)`, [scope.operationId, scope.taskId, randomUUID()]);
  }
  async function reserve(scope: ModelOperationScope, upperQuote = known(60n)) {
    return transaction(pool, async db => { const result = await reserveModelCost(db, { ...scope, upperQuote }); await insertOperation(db, scope); return result; });
  }
  it("serializes concurrent sibling reservations against a finite root cap", async () => {
    const scope = await fixture();
    const sibling = randomUUID();
    await pool.query(`INSERT INTO agents_platform.tasks(id,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,request_key,request_digest,input,root_task_id,parent_task_id,depth,effective_composition,turn_sequence)
      SELECT $1,product,organization_id,resource_id,caller_client_id,principal,version_id,grant_id,conversation_id,($1::uuid)::text,request_digest,input,id,id,1,effective_composition,2 FROM agents_platform.tasks WHERE id=$2`, [sibling, scope.taskId]);
    const attempts = await Promise.allSettled([reserve(scope), reserve({ ...scope, taskId: sibling, operationId: randomUUID() })]);
    expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  });
  it("settles once, releases its hold, and rejects conflicting outcome or amount replays", async () => {
    const scope = await fixture(); await reserve(scope);
    const settle = (amount: bigint, outcome: "completed" | "failed" = "completed") => transaction(pool, db => settleModelCost(db, { ...scope, outcome, quote: known(amount) }));
    expect(await settle(35n)).toMatchObject({ usedMicros: 35n, reservedMicros: 0n });
    expect(await settle(35n)).toMatchObject({ usedMicros: 35n, reservedMicros: 0n });
    await expect(settle(36n)).rejects.toThrow("replay changed");
    await expect(settle(35n, "failed")).rejects.toThrow("replay changed");
    await expect(transaction(pool, db => reserveModelCost(db, { ...scope, upperQuote: known(61n) }))).rejects.toThrow("replay changed");
  });
  it("keeps unknown final usage and uncertain physical outcomes reserved", async () => {
    for (const outcome of ["completed", "uncertain"] as const) {
      const scope = await fixture(); await reserve(scope);
      const quote = outcome === "uncertain" ? known(12n) : unknown;
      const result = await transaction(pool, db => settleModelCost(db, { ...scope, outcome, quote }));
      expect(result).toMatchObject({ usedMicros: 0n, reservedMicros: 60n, unknownOperations: 1 });
      expect(await transaction(pool, db => settleModelCost(db, { ...scope, outcome, quote }))).toEqual(result);
      await expect(reserve({ ...scope, operationId: randomUUID() }, known(41n))).rejects.toThrow("limit exceeded");
      await expect(transaction(pool, db => settleModelCost(db, { ...scope, outcome, quote: known(13n) }))).rejects.toThrow("replay changed");
    }
  });
  it("rejects unknown upper quotes for finite caps and preserves unknown settlement for uncapped roots", async () => {
    const finite = await fixture(); await expect(reserve(finite, unknown)).rejects.toThrow("known upper quote");
    const unlimited = await fixture(null); await reserve(unlimited, unknown);
    expect(await transaction(pool, db => settleModelCost(db, { ...unlimited, outcome: "completed", quote: unknown }))).toMatchObject({ unknownOperations: 1, usedMicros: 0n });
  });
  it("validates organization and root membership and rolls back reservations without an operation", async () => {
    const a = await fixture(), b = await fixture();
    await expect(reserve({ ...a, organizationId: b.organizationId })).rejects.toThrow("root scope");
    await expect(reserve({ ...a, taskId: b.taskId })).rejects.toThrow("task scope");
    await expect(transaction(pool, db => reserveModelCost(db, { ...a, upperQuote: known(60n) }))).rejects.toMatchObject({ code: "23503" });
    expect((await reserve(a)).reservedMicros).toBe(60n);
  });
  it("stores token and call limits above development defaults", async () => {
    const scope = await fixture();
    await pool.query(`UPDATE agents_platform.tasks SET root_token_limit=1000000,model_calls=50,tool_calls=100,allocation_active_ms=1000000 WHERE id=$1`, [scope.taskId]);
    await pool.query(`UPDATE agents_platform.execution_roots SET model_calls=50,tool_calls=100 WHERE root_task_id=$1`, [scope.rootTaskId]);
    await pool.query(`UPDATE agents_platform.execution_grants SET max_context_tokens=1000000,max_output_tokens=100000,root_token_limit=1000000 WHERE id=(SELECT grant_id FROM agents_platform.tasks WHERE id=$1)`, [scope.taskId]);
    await expect(pool.query(`UPDATE agents_platform.tasks SET root_token_limit=0 WHERE id=$1`, [scope.taskId])).rejects.toMatchObject({ code: "23514" });
  });
});
