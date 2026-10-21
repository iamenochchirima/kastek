import type { PoolClient } from "pg";

/** All counters are observed totals. Cache counts are subsets of input, reasoning is a subset of output. */
export interface AccountingUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  reasoningTokens: number | null;
}
export interface AccountingPrices {
  currency: "USD";
  inputMicrosPerMillionTokens: number | null;
  outputMicrosPerMillionTokens: number | null;
  cachedInputMicrosPerMillionTokens: number | null;
  cacheWriteMicrosPerMillionTokens?: number | null;
  /** Only an explicit attestation permits substituting base input price for an unknown cache read price. */
  cacheReadBasePriceIsCeiling?: boolean;
}
export type CostQuote = { status: "known"; costMicros: bigint } | { status: "unknown"; reason: string };
const maximumMoney = 9223372036854775807n;
function count(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isSafeInteger(value) && value >= 0;
}
function money(value: bigint): bigint {
  if (value < 0n || value > maximumMoney) throw new Error("Monetary amount exceeds bigint storage");
  return value;
}
export function quoteNormalizedUsage(usage: AccountingUsage | null, prices: AccountingPrices | null): CostQuote {
  if (!usage) return { status: "unknown", reason: "Usage is unavailable" };
  if (![usage.inputTokens, usage.outputTokens, usage.cacheReadTokens, usage.cacheWriteTokens].every(count) ||
      usage.reasoningTokens !== null && !count(usage.reasoningTokens)) {
    return { status: "unknown", reason: "Usage components are unavailable or invalid" };
  }
  const input = BigInt(usage.inputTokens!), output = BigInt(usage.outputTokens!);
  const read = BigInt(usage.cacheReadTokens!), write = BigInt(usage.cacheWriteTokens!);
  // Reasoning is already included in normalized output. Its missing breakdown does not make total output pricing unknown.
  if (read + write > input || usage.reasoningTokens !== null && BigInt(usage.reasoningTokens) > output) {
    return { status: "unknown", reason: "Usage subsets exceed observed totals" };
  }
  if (!prices || prices.currency !== "USD") return { status: "unknown", reason: "USD pricing is unavailable" };
  const cachedPrice = prices.cachedInputMicrosPerMillionTokens ??
    (prices.cacheReadBasePriceIsCeiling ? prices.inputMicrosPerMillionTokens : null);
  const components = [[input - read - write, prices.inputMicrosPerMillionTokens], [output, prices.outputMicrosPerMillionTokens],
    [read, cachedPrice], [write, prices.cacheWriteMicrosPerMillionTokens]] as const;
  let numerator = 0n;
  for (const [tokens, price] of components) {
    if (tokens === 0n) continue;
    if (!count(price)) return { status: "unknown", reason: "An observed usage component has unknown pricing" };
    numerator += tokens * BigInt(price);
  }
  return { status: "known", costMicros: money((numerator + 999999n) / 1000000n) };
}
export interface ModelAccountScope { organizationId: string; rootTaskId: string }
export interface ModelOperationScope extends ModelAccountScope { taskId: string; operationId: string }
export interface ModelAccountSnapshot {
  maxCostMicros: bigint | null; usedMicros: bigint; reservedMicros: bigint; unknownOperations: number;
}
function snapshot(row: Record<string, unknown>): ModelAccountSnapshot {
  return { maxCostMicros: row.max_cost_micros === null ? null : BigInt(String(row.max_cost_micros)),
    usedMicros: BigInt(String(row.used_micros)), reservedMicros: BigInt(String(row.reserved_micros)), unknownOperations: Number(row.unknown_operations) };
}
/** Caller owns the transaction. Lock execution_roots, then account, then reservation, before operation rows.
 * Existing lifecycle callers may already hold the root lock. Never acquire a different root afterwards. */
async function lockAccount(db: PoolClient, scope: ModelAccountScope): Promise<ModelAccountSnapshot> {
  const root = await db.query(`SELECT r.root_task_id FROM agents_platform.execution_roots r
    JOIN agents_platform.tasks t ON t.id=r.root_task_id
    WHERE r.root_task_id=$1 AND t.organization_id=$2 AND t.root_task_id=t.id FOR UPDATE OF r`, [scope.rootTaskId, scope.organizationId]);
  if (!root.rowCount) throw new Error("Model account root scope is unavailable");
  const account = await db.query(`SELECT * FROM agents_platform.root_model_accounts WHERE root_task_id=$1 AND organization_id=$2 FOR UPDATE`,
    [scope.rootTaskId, scope.organizationId]);
  if (!account.rowCount) throw new Error("Model account is unavailable");
  return snapshot(account.rows[0]);
}
export async function initializeRootModelAccount(db: PoolClient, scope: ModelAccountScope & { maxCostMicros: bigint | null }): Promise<ModelAccountSnapshot> {
  if (scope.maxCostMicros !== null) money(scope.maxCostMicros);
  // Serialize initialization with reserve and settlement even before the account row exists.
  const root = await db.query(`SELECT r.root_task_id FROM agents_platform.execution_roots r JOIN agents_platform.tasks t ON t.id=r.root_task_id
    WHERE r.root_task_id=$1 AND t.organization_id=$2 AND t.root_task_id=t.id FOR UPDATE OF r`, [scope.rootTaskId, scope.organizationId]);
  if (!root.rowCount) throw new Error("Model account root scope is unavailable");
  await db.query(`INSERT INTO agents_platform.root_model_accounts(root_task_id,organization_id,max_cost_micros)
    VALUES($1,$2,$3) ON CONFLICT(root_task_id) DO NOTHING`, [scope.rootTaskId, scope.organizationId, scope.maxCostMicros?.toString() ?? null]);
  const result = await lockAccount(db, scope);
  if (result.maxCostMicros !== scope.maxCostMicros) throw new Error("Model account limit changed");
  return result;
}
export async function reserveModelCost(db: PoolClient, scope: ModelOperationScope & { upperQuote: CostQuote }): Promise<ModelAccountSnapshot> {
  const account = await lockAccount(db, scope);
  const task = await db.query(`SELECT id FROM agents_platform.tasks WHERE id=$1 AND root_task_id=$2 AND organization_id=$3`,
    [scope.taskId, scope.rootTaskId, scope.organizationId]);
  if (!task.rowCount) throw new Error("Model operation task scope is unavailable");
  const upper = scope.upperQuote.status === "known" ? money(scope.upperQuote.costMicros) : null;
  const prior = await db.query(`SELECT * FROM agents_platform.model_cost_reservations WHERE operation_id=$1 FOR UPDATE`, [scope.operationId]);
  if (prior.rowCount) {
    const row = prior.rows[0];
    if (row.task_id !== scope.taskId || row.root_task_id !== scope.rootTaskId || row.organization_id !== scope.organizationId ||
      (row.upper_cost_micros === null ? null : BigInt(row.upper_cost_micros)) !== upper) throw new Error("Model reservation replay changed");
    return account;
  }
  if (account.maxCostMicros !== null && upper === null) throw new Error("A finite cost cap requires a known upper quote");
  const reserved = upper ?? 0n;
  if (account.maxCostMicros !== null && account.usedMicros + account.reservedMicros + reserved > account.maxCostMicros) throw new Error("Root model cost limit exceeded");
  money(account.reservedMicros + reserved);
  await db.query(`INSERT INTO agents_platform.model_cost_reservations(operation_id,organization_id,root_task_id,task_id,reserved_micros,upper_cost_micros)
    VALUES($1,$2,$3,$4,$5,$6)`, [scope.operationId, scope.organizationId, scope.rootTaskId, scope.taskId, reserved.toString(), upper?.toString() ?? null]);
  await db.query(`UPDATE agents_platform.root_model_accounts SET reserved_micros=reserved_micros+$2::bigint WHERE root_task_id=$1`, [scope.rootTaskId, reserved.toString()]);
  return { ...account, reservedMicros: account.reservedMicros + reserved };
}
export async function settleModelCost(db: PoolClient, scope: ModelOperationScope & {
  outcome: "completed" | "failed" | "uncertain"; quote: CostQuote;
}): Promise<ModelAccountSnapshot> {
  const account = await lockAccount(db, scope);
  const result = await db.query(`SELECT * FROM agents_platform.model_cost_reservations WHERE operation_id=$1 AND task_id=$2
    AND root_task_id=$3 AND organization_id=$4 FOR UPDATE`, [scope.operationId, scope.taskId, scope.rootTaskId, scope.organizationId]);
  if (!result.rowCount) throw new Error("Model reservation is unavailable");
  const row = result.rows[0];
  const quoted = scope.quote.status === "unknown" ? null : money(scope.quote.costMicros);
  const actual = scope.outcome === "uncertain" ? null : quoted;
  if (row.state !== "reserved") {
    if (row.outcome !== scope.outcome || (row.settlement_quote_micros === null ? null : BigInt(row.settlement_quote_micros)) !== quoted) throw new Error("Model settlement replay changed");
    return account;
  }
  // Unknown usage/cost retains its full hold. It cannot be released by a replay with a different outcome.
  const released = actual === null ? 0n : BigInt(row.reserved_micros);
  const used = money(account.usedMicros + (actual ?? 0n));
  await db.query(`UPDATE agents_platform.model_cost_reservations SET state=$2,outcome=$3,actual_micros=$4,settlement_quote_micros=$5,settled_at=now() WHERE operation_id=$1`,
    [scope.operationId, actual === null ? "unknown" : "settled", scope.outcome, actual?.toString() ?? null, quoted?.toString() ?? null]);
  await db.query(`UPDATE agents_platform.root_model_accounts SET used_micros=$2,reserved_micros=reserved_micros-$3::bigint,
    unknown_operations=unknown_operations+$4 WHERE root_task_id=$1`, [scope.rootTaskId, used.toString(), released.toString(), actual === null ? 1 : 0]);
  return { ...account, usedMicros: used, reservedMicros: account.reservedMicros - released, unknownOperations: account.unknownOperations + (actual === null ? 1 : 0) };
}
