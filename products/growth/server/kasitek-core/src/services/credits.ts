import { createId } from "@paralleldrive/cuid2";
import type { Pool, PoolClient } from "pg";
import { transaction } from "../db.js";
import { ApiError } from "../error.js";
import {
  canonicalJson,
  integer,
  wireInteger,
} from "@kasitek-labs/server-support/json";
export type Units = number | bigint | string;
type Row = Record<string, unknown>;
const SQL = {
  ensure_account: [
    '\n        INSERT INTO "CreditAccount" (id, "orgId", balance, "reservedBalance", "createdAt", "updatedAt")\n        VALUES ($1, $2, 0, 0, NOW(), NOW())\n        ON CONFLICT ("orgId") DO UPDATE SET "updatedAt" = NOW()\n        RETURNING id\n        ',
    '\n        SELECT id, balance, "reservedBalance" AS reserved_balance\n        FROM "CreditAccount"\n        WHERE "orgId" = $1\n        FOR UPDATE\n        ',
  ],
  read_account_balances: [
    '\n        SELECT balance, "reservedBalance"\n        FROM "CreditAccount"\n        WHERE "orgId" = $1\n        ',
  ],
  expire_credit_grants: [
    '\n        SELECT id, "remainingAmount" AS remaining_amount\n        FROM "CreditGrant"\n        WHERE "accountId" = $1\n          AND "remainingAmount" > 0\n          AND "startsAt" <= NOW()\n          AND "endsAt" IS NOT NULL\n          AND "endsAt" <= NOW()\n        ORDER BY "endsAt", "startsAt", id\n        FOR UPDATE\n        ',
    'UPDATE "CreditGrant"\n               SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW()\n               WHERE id = $2',
    '\n            INSERT INTO "CreditLedgerEntry" (\n                id, "accountId", "orgId", grantId, type, amount, "balanceAfter",\n                "sourceType", "sourceId", metadata, "createdAt"\n            )\n            VALUES ($1, $2, $3, $4, \'EXPIRY\', $5, $6, \'SYSTEM\', $4, $7, NOW())\n            ',
    'UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2',
  ],
  existing_operation: [
    '\n        SELECT id, "orgId" AS org_id, "afterBalance" AS after_balance,\n               "afterReservedBalance" AS after_reserved_balance,\n               amount, "ledgerEntryId" AS ledger_entry_id\n        FROM "CreditAdminOperation"\n        WHERE "idempotencyKey" = $1\n        ',
  ],
  existing_ledger: [
    '\n        SELECT id, "orgId" AS org_id, "balanceAfter" AS balance_after, amount,\n               "sourceId" AS source_id, "grantId" AS grant_id, type AS entry_type\n        FROM "CreditLedgerEntry"\n        WHERE "idempotencyKey" = $1\n        ',
  ],
  create_admin_operation: [
    '\n        INSERT INTO "CreditAdminOperation" (\n            id, "accountId", "orgId", "operationType", amount, source, reason, reference,\n            "actorId", "beforeBalance", "afterBalance", "beforeReservedBalance", "afterReservedBalance",\n            "ledgerEntryId", "idempotencyKey",\n            status, "createdAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, \'COMPLETED\', NOW())\n        ',
  ],
  get_credit_account: [
    '\n        SELECT "orgId" AS org_id,\n               balance,\n               "reservedBalance" AS reserved_balance,\n               (balance - "reservedBalance") AS available_balance\n        FROM "CreditAccount"\n        WHERE "orgId" = $1\n        ',
    '\n        SELECT id, source, amount, "remainingAmount" AS remaining_amount,\n               "startsAt" AT TIME ZONE \'UTC\' AS starts_at,\n               "endsAt" AT TIME ZONE \'UTC\' AS ends_at,\n               reason, reference\n        FROM "CreditGrant"\n        WHERE "orgId" = $1 AND "remainingAmount" > 0\n        ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id\n        LIMIT 100\n        ',
    '\n        SELECT id, type AS entry_type, amount, "balanceAfter" AS balance_after,\n               "actionKey" AS action_key, "sourceType" AS source_type,\n               "sourceId" AS source_id, "pricingVersion" AS pricing_version,\n               "createdByAdminId" AS created_by_admin_id,\n               "createdAt" AT TIME ZONE \'UTC\' AS created_at\n        FROM "CreditLedgerEntry"\n        WHERE "orgId" = $1\n        ORDER BY "createdAt" DESC, id DESC\n        LIMIT 100\n        ',
  ],
  get_credit_usage: [
    '\n        SELECT id, "actionKey" AS action_key, quantity, "creditsCharged" AS credits_charged,\n               status, provider, model, "fundingSource" AS funding_source,\n               "inputTokens" AS input_tokens, "outputTokens" AS output_tokens,\n               "providerCostUsd" AS provider_cost_usd,\n               "pricingVersion" AS pricing_version,\n               "createdAt" AT TIME ZONE \'UTC\' AS created_at\n        FROM "CreditUsageEvent"\n        WHERE "orgId" = $1\n        ORDER BY "createdAt" DESC, id DESC\n        LIMIT $2\n        ',
  ],
  get_credit_reservations_for_source: [
    '\n        SELECT id, "actionKey" AS action_key,\n               "estimatedCredits" AS estimated_credits,\n               "capturedCredits" AS captured_credits,\n               "releasedCredits" AS released_credits,\n               status, "sourceType" AS source_type, "sourceId" AS source_id,\n               "pricingVersion" AS pricing_version,\n               "expiresAt" AT TIME ZONE \'UTC\' AS expires_at,\n               "createdAt" AT TIME ZONE \'UTC\' AS created_at,\n               "updatedAt" AT TIME ZONE \'UTC\' AS updated_at\n        FROM "CreditReservation"\n        WHERE "orgId" = $1 AND "sourceType" = $2 AND "sourceId" = $3\n        ORDER BY "createdAt" ASC, id ASC\n        LIMIT $4\n        ',
  ],
  get_credit_usage_reconciliation_for_source: [
    '\n        SELECT usage.id, reservation.id AS reservation_id,\n               usage."actionKey" AS action_key,\n               usage."creditsCharged" AS credits_charged,\n               usage.status, usage.provider, usage.model,\n               usage."inputTokens" AS input_tokens,\n               usage."outputTokens" AS output_tokens,\n               usage."providerCostUsd" AS provider_cost_usd,\n               usage."pricingVersion" AS pricing_version,\n               usage."createdAt" AT TIME ZONE \'UTC\' AS created_at\n        FROM "CreditUsageEvent" usage\n        INNER JOIN "CreditLedgerEntry" ledger\n          ON ledger.id = usage."ledgerEntryId"\n         AND ledger."orgId" = usage."orgId"\n         AND ledger."sourceType" = \'RESERVATION\'\n        INNER JOIN "CreditReservation" reservation\n          ON reservation.id = ledger."sourceId"\n         AND reservation."orgId" = usage."orgId"\n        WHERE usage."orgId" = $1\n          AND reservation."sourceType" = $2\n          AND reservation."sourceId" = $3\n        ORDER BY usage."createdAt" ASC, usage.id ASC\n        LIMIT $4\n        ',
  ],
  search_credit_organizations: [
    "\n        SELECT organization.id,\n               organization.name,\n               organization.slug,\n               owner.email AS owner_email,\n               COALESCE(account.balance - account.\"reservedBalance\", 0)::bigint AS balance,\n               COALESCE(account.\"reservedBalance\", 0)::bigint AS reserved_balance\n        FROM \"Organization\" organization\n        INNER JOIN \"User\" owner ON owner.id = organization.\"ownerId\"\n        LEFT JOIN \"CreditAccount\" account ON account.\"orgId\" = organization.id\n        WHERE $1 = ''\n           OR organization.id ILIKE '%' || $1 || '%'\n           OR organization.name ILIKE '%' || $1 || '%'\n           OR organization.slug ILIKE '%' || $1 || '%'\n           OR COALESCE(owner.email, '') ILIKE '%' || $1 || '%'\n        ORDER BY organization.\"createdAt\" DESC\n        LIMIT $2\n        ",
  ],
  grant_credits: [
    '\n        INSERT INTO "CreditGrant" (\n            id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt", "endsAt",\n            reason, reference, "createdByAdminId", "createdAt", "updatedAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $5, NOW(), $6, $7, $8, $9, NOW(), NOW())\n        ',
    'UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",\n            "sourceType", "sourceId", "idempotencyKey", "createdByAdminId", "createdAt"\n        )\n        VALUES ($1, $2, $3, $4, \'GRANT\', $5, $6, \'ADMIN\', $7, $8, $9, NOW())\n        ',
  ],
  grant_system_credits: [
    '\n        INSERT INTO "CreditGrant" (\n            id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt", "endsAt",\n            reason, reference, metadata, "createdAt", "updatedAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $5, NOW(), $6, $7, $8, $9, NOW(), NOW())\n        ',
    'UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",\n            "sourceType", "sourceId", "idempotencyKey", metadata, "createdAt"\n        )\n        VALUES ($1, $2, $3, $4, \'GRANT\', $5, $6, \'SYSTEM\', $7, $8, $9, NOW())\n        ',
  ],
  revoke_unspent_system_grant: [
    'SELECT "remainingAmount" FROM "CreditGrant" WHERE id = $1 AND "orgId" = $2',
    '\n        SELECT id, "remainingAmount"\n        FROM "CreditGrant"\n        WHERE id = $1 AND "orgId" = $2 AND "accountId" = $3\n        FOR UPDATE\n        ',
    'UPDATE "CreditGrant"\n           SET "remainingAmount" = $1, "updatedAt" = NOW()\n           WHERE id = $2',
    'UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",\n            "sourceType", "sourceId", "idempotencyKey", metadata, "createdAt"\n        )\n        VALUES ($1, $2, $3, $4, \'REVOKE\', $5, $6, \'SYSTEM\', $4, $7, $8, NOW())\n        ',
  ],
  set_credit_balance: [
    '\n            INSERT INTO "CreditGrant" (\n                id, "accountId", "orgId", source, amount, "remainingAmount", "startsAt",\n                reason, reference, "createdByAdminId", "createdAt", "updatedAt"\n            )\n            VALUES ($1, $2, $3, \'COMPENSATION\', $4, $4, NOW(), $5, $6, $7, NOW(), NOW())\n            ',
    '\n            SELECT id, "remainingAmount" AS remaining_amount\n            FROM "CreditGrant"\n            WHERE "accountId" = $1\n              AND "remainingAmount" > 0\n              AND "startsAt" <= NOW()\n              AND ("endsAt" IS NULL OR "endsAt" > NOW())\n            ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id\n            FOR UPDATE\n            ',
    'UPDATE "CreditGrant" SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW() WHERE id = $2',
    'UPDATE "CreditAccount" SET balance = $1, "updatedAt" = NOW() WHERE id = $2',
    '\n            INSERT INTO "CreditLedgerEntry" (\n                id, "accountId", "orgId", "grantId", type, amount, "balanceAfter",\n                "sourceType", "sourceId", "idempotencyKey", "createdByAdminId", "createdAt"\n            )\n            VALUES ($1, $2, $3, $4, \'ADJUSTMENT\', $5, $6, \'ADMIN\', $7, $8, $9, NOW())\n            ',
  ],
  find_reservation_by_idempotency: [
    '\n        SELECT id, "accountId" AS account_id, "orgId" AS org_id, "actionKey" AS action_key,\n               "estimatedCredits" AS estimated_credits, "capturedCredits" AS captured_credits,\n               "releasedCredits" AS released_credits, status,\n               "expiresAt" AT TIME ZONE \'UTC\' AS expires_at,\n               "sourceType" AS source_type, "sourceId" AS source_id,\n               "pricingVersion" AS pricing_version\n        FROM "CreditReservation"\n        WHERE "idempotencyKey" = $1\n        ',
  ],
  lock_reservation: [
    '\n        SELECT id, "accountId" AS account_id, "orgId" AS org_id, "actionKey" AS action_key,\n               "estimatedCredits" AS estimated_credits, "capturedCredits" AS captured_credits,\n               "releasedCredits" AS released_credits, status,\n               "expiresAt" AT TIME ZONE \'UTC\' AS expires_at,\n               "sourceType" AS source_type, "sourceId" AS source_id,\n               "pricingVersion" AS pricing_version\n        FROM "CreditReservation"\n        WHERE id = $1 AND "orgId" = $2\n        FOR UPDATE\n        ',
  ],
  consume_credit_grants: [
    '\n        SELECT id, "remainingAmount" AS remaining_amount\n        FROM "CreditGrant"\n        WHERE "accountId" = $1\n          AND "remainingAmount" > 0\n        -- Captures may settle after the grant expiry. A reservation already\n        -- held the account balance, so settlement must be allowed to consume\n        -- the protected lot instead of failing at the provider callback.\n        ORDER BY ("endsAt" IS NULL), "endsAt", "startsAt", id\n        FOR UPDATE\n        ',
    'UPDATE "CreditGrant" SET "remainingAmount" = "remainingAmount" - $1, "updatedAt" = NOW() WHERE id = $2',
  ],
  reserve_credits: [
    '\n        INSERT INTO "CreditReservation" (\n            id, "accountId", "orgId", "actionKey", "estimatedCredits", "sourceType", "sourceId",\n            "pricingVersion", "idempotencyKey", "expiresAt", status, "createdAt", "updatedAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, \'RESERVED\', NOW(), NOW())\n        ',
    '\n        UPDATE "CreditAccount"\n        SET "reservedBalance" = $1, "updatedAt" = NOW()\n        WHERE id = $2\n        ',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",\n            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", "createdAt"\n        )\n        VALUES ($1, $2, $3, \'RESERVE\', 0, $4, $5, $6, $7, $8, $9, NOW())\n        ',
  ],
  capture_credits: [
    '\n        UPDATE "CreditAccount"\n        SET balance = $1, "reservedBalance" = $2, "updatedAt" = NOW()\n        WHERE id = $3\n        ',
    '\n        UPDATE "CreditReservation"\n        SET "capturedCredits" = $1, "releasedCredits" = $2, status = \'CAPTURED\', "updatedAt" = NOW()\n        WHERE id = $3\n        ',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",\n            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", "createdAt"\n        )\n        VALUES ($1, $2, $3, \'DEBIT\', $4, $5, $6, \'RESERVATION\', $7, $8, $9, NOW())\n        ',
    '\n        INSERT INTO "CreditUsageEvent" (\n            id, "accountId", "orgId", "ledgerEntryId", "actionKey", quantity, "creditsCharged",\n            status, provider, model, "fundingSource", "inputTokens", "outputTokens", "providerCostUsd",\n            "pricingVersion", "idempotencyKey", metadata, "createdAt"\n        )\n        VALUES ($1, $2, $3, $4, $5, 1, $6, \'COMPLETED\', $7, $8, $9, $10, $11, $12::numeric, $13, $14, $15, NOW())\n        ',
  ],
  release_credits: [
    '\n        UPDATE "CreditAccount"\n        SET "reservedBalance" = $1, "updatedAt" = NOW()\n        WHERE id = $2\n        ',
    '\n        UPDATE "CreditReservation"\n        SET "releasedCredits" = "estimatedCredits", status = $1, "updatedAt" = NOW()\n        WHERE id = $2\n        ',
    '\n        INSERT INTO "CreditLedgerEntry" (\n            id, "accountId", "orgId", type, amount, "balanceAfter", "actionKey",\n            "sourceType", "sourceId", "pricingVersion", "idempotencyKey", metadata, "createdAt"\n        )\n        VALUES ($1, $2, $3, \'RELEASE\', 0, $4, $5, \'RESERVATION\', $6, $7, $8, $9, NOW())\n        ',
  ],
} as const;
const bad = (message: string): never => {
  throw new ApiError(400, "bad_request", message);
};
const conflict = (message: string): never => {
  throw new ApiError(409, "conflict", message);
};
const internal = (message: string): never => {
  throw new ApiError(500, "internal_error", message);
};
const notFound = (message: string): never => {
  throw new ApiError(404, "not_found", message);
};
export function requiredText(
  value: string,
  field: string,
  max: number,
): string {
  const text = value.trim();
  if (!text || Array.from(text).length > max)
    bad(`${field} is required and must be at most ${max} characters`);
  return text;
}
const n = (row: Row, key: string): bigint => integer(row[key] as Units);
const str = (row: Row, key: string): string => String(row[key]);
const min = (a: bigint, b: bigint): bigint => (a < b ? a : b);
const MAX_I64 = 9223372036854775807n,
  MIN_I64 = -9223372036854775808n;
function checked(value: bigint, message: string): bigint {
  if (value > MAX_I64 || value < MIN_I64) conflict(message);
  return value;
}
function positive(value: Units): bigint {
  const amount = integer(value);
  if (amount <= 0n) bad("Credit amount must be greater than zero");
  return checked(amount, "Credit amount exceeds the supported maximum");
}
function nonnegative(value: Units, label: string): bigint {
  const amount = integer(value);
  if (amount < 0n) bad(`${label} cannot be negative`);
  return checked(amount, `${label} exceeds the supported maximum`);
}
function expiry(value: Date | null | undefined, label = "Credit"): void {
  if (
    value != null &&
    (!Number.isFinite(value.getTime()) || value.getTime() <= Date.now())
  )
    bad(`${label} expiry must be in the future`);
}
export function availableBalance(balance: bigint, reserved: bigint): bigint {
  if (reserved < 0n || reserved > balance)
    internal("Credit account balance invariant is invalid");
  return balance - reserved;
}
export function captureSettlement(
  balance: bigint,
  reserved: bigint,
  estimated: bigint,
  actual: bigint,
): [bigint, bigint, bigint] {
  nonnegative(actual, "Captured credits");
  if (actual > estimated)
    conflict("Captured credits cannot exceed the reservation");
  if (reserved < estimated)
    internal("Credit reservation exceeds the reserved account balance");
  if (balance < actual)
    internal("Credit account balance cannot cover the captured credits");
  return [balance - actual, reserved - estimated, estimated - actual];
}
export function releaseSettlement(
  balance: bigint,
  reserved: bigint,
  estimated: bigint,
): [bigint, bigint] {
  if (reserved < estimated)
    internal("Credit reservation exceeds the reserved account balance");
  availableBalance(balance, reserved);
  return [balance, reserved - estimated];
}
const numericFields = new Set([
  "balance",
  "amount",
  "reserved_balance",
  "available_balance",
  "remaining_amount",
  "balance_after",
  "quantity",
  "credits_charged",
  "input_tokens",
  "output_tokens",
  "estimated_credits",
  "captured_credits",
  "released_credits",
]);
function view(row: Row): Row {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key.replace(/_([a-z])/g, (_match, c: string) => c.toUpperCase()),
      value != null && numericFields.has(key)
        ? wireInteger(value as Units)
        : value,
    ]),
  );
}
async function one(
  tx: Pool | PoolClient,
  statement: string,
  values: unknown[] = [],
): Promise<Row | undefined> {
  return (await tx.query(statement, values)).rows[0];
}
interface Account {
  id: string;
  balance: bigint;
  reserved: bigint;
}
async function ensureAccount(tx: PoolClient, orgId: string): Promise<Account> {
  await tx.query(SQL.ensure_account[0], [createId(), orgId]);
  const row = await one(tx, SQL.ensure_account[1], [orgId]);
  if (!row) notFound("Organization credit account not found");
  return {
    id: str(row!, "id"),
    balance: n(row!, "balance"),
    reserved: n(row!, "reserved_balance"),
  };
}
async function balances(
  tx: PoolClient,
  orgId: string,
): Promise<[bigint, bigint]> {
  const row = await one(tx, SQL.read_account_balances[0], [orgId]);
  if (!row) notFound("Organization credit account not found");
  return [n(row!, "balance"), n(row!, "reservedBalance")];
}
async function lockOperation(tx: PoolClient, key: string): Promise<void> {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    `credit-idempotency:${key}`,
  ]);
}
async function existing(
  tx: PoolClient,
  orgId: string,
  key: string,
  admin = false,
): Promise<Row | undefined> {
  const row = await one(
    tx,
    admin ? SQL.existing_operation[0] : SQL.existing_ledger[0],
    [key],
  );
  if (row && row.org_id !== orgId)
    conflict("Credit idempotency key belongs to another organization");
  return row;
}
export async function expireCreditGrants(
  pool: Pool,
  orgId: string,
): Promise<void> {
  orgId = requiredText(orgId, "Organization id", 160);
  await transaction(pool, async (tx) => {
    const account = await ensureAccount(tx, orgId);
    let balance = account.balance,
      available = availableBalance(balance, account.reserved);
    if (!available) return;
    for (const grant of (
      await tx.query(SQL.expire_credit_grants[0], [account.id])
    ).rows as Row[]) {
      if (!available) break;
      const amount = min(n(grant, "remaining_amount"), available);
      await tx.query(SQL.expire_credit_grants[1], [amount, str(grant, "id")]);
      balance -= amount;
      available -= amount;
      await tx.query(
        SQL.expire_credit_grants[2].replace(" grantId,", ' "grantId",'),
        [
          createId(),
          account.id,
          orgId,
          str(grant, "id"),
          -amount,
          balance,
          { reason: "credit_grant_expired" },
        ],
      );
    }
    if (balance !== account.balance)
      await tx.query(SQL.expire_credit_grants[3], [balance, account.id]);
  });
}
export async function getCreditAccount(
  pool: Pool,
  orgId: string,
): Promise<Row> {
  await expireCreditGrants(pool, orgId);
  const row = (await one(pool, SQL.get_credit_account[0], [orgId])) ?? {
    org_id: orgId,
    balance: 0,
    reserved_balance: 0,
    available_balance: 0,
  };
  return {
    ...view(row),
    grants: (await pool.query(SQL.get_credit_account[1], [orgId])).rows.map(
      view,
    ),
    ledger: (await pool.query(SQL.get_credit_account[2], [orgId])).rows.map(
      view,
    ),
  };
}
export async function getCreditUsage(
  pool: Pool,
  orgId: string,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(SQL.get_credit_usage[0], [
      orgId,
      Math.max(1, Math.min(100, limit)),
    ])
  ).rows.map(view);
}
export async function getCreditReservationsForSource(
  pool: Pool,
  orgId: string,
  sourceType: string,
  sourceId: string,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(SQL.get_credit_reservations_for_source[0], [
      requiredText(orgId, "Organization id", 160),
      requiredText(sourceType, "Source type", 160),
      requiredText(sourceId, "Source id", 240),
      Math.max(1, Math.min(500, limit)),
    ])
  ).rows.map(view);
}
export async function getCreditUsageReconciliationForSource(
  pool: Pool,
  orgId: string,
  sourceType: string,
  sourceId: string,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(SQL.get_credit_usage_reconciliation_for_source[0], [
      requiredText(orgId, "Organization id", 160),
      requiredText(sourceType, "Source type", 160),
      requiredText(sourceId, "Source id", 240),
      Math.max(1, Math.min(500, limit)),
    ])
  ).rows.map(view);
}
export async function searchCreditOrganizations(
  pool: Pool,
  query: string | null | undefined,
  limit: number,
): Promise<Row[]> {
  return (
    await pool.query(SQL.search_credit_organizations[0], [
      query?.trim() ?? "",
      Math.max(1, Math.min(50, limit)),
    ])
  ).rows.map(view);
}
function mutation(
  orgId: string,
  operationId: string,
  ledgerId: string | null,
  grantId: string | null,
  balance: bigint,
  reserved: bigint,
  amount: bigint,
  idempotent: boolean,
): Row {
  return {
    orgId,
    operationId,
    ledgerEntryId: ledgerId,
    grantId,
    balance: wireInteger(balance),
    reservedBalance: wireInteger(reserved),
    availableBalance: wireInteger(availableBalance(balance, reserved)),
    amount: wireInteger(amount),
    idempotent,
  };
}
async function replay(
  tx: PoolClient,
  orgId: string,
  row: Row,
  amount: bigint,
  admin: boolean,
): Promise<Row> {
  if (admin)
    return mutation(
      orgId,
      str(row, "id"),
      row.ledger_entry_id as string | null,
      null,
      n(row, "after_balance"),
      n(row, "after_reserved_balance"),
      row.amount == null ? amount : n(row, "amount"),
      true,
    );
  const [, reserved] = await balances(tx, orgId);
  return mutation(
    orgId,
    str(row, "id"),
    str(row, "id"),
    row.grant_id as string | null,
    n(row, "balance_after"),
    reserved,
    n(row, "amount"),
    true,
  );
}
export async function grantSystemCredits(
  pool: Pool,
  orgId: string,
  amountInput: Units,
  source: string,
  endsAt: Date | null,
  reason: string,
  reference: string | null,
  metadata: unknown,
  key: string,
): Promise<Row> {
  const amount = positive(amountInput);
  source = source.trim().toUpperCase();
  if (
    ![
      "PLAN",
      "TRIAL",
      "REFERRAL",
      "PURCHASE",
      "MIGRATION",
      "EARLY_ACCESS",
    ].includes(source)
  )
    bad(
      "System credit source must be PLAN, TRIAL, REFERRAL, PURCHASE, MIGRATION, or EARLY_ACCESS",
    );
  reason = requiredText(reason, "Reason", 2000);
  key = requiredText(key, "Idempotency key", 240);
  expiry(endsAt);
  reference =
    reference == null ? null : requiredText(reference, "Reference", 240);
  orgId = requiredText(orgId, "Organization id", 160);
  await expireCreditGrants(pool, orgId);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const old = await existing(tx, orgId, key);
    if (old) return replay(tx, orgId, old, amount, false);
    const account = await ensureAccount(tx, orgId),
      balance = checked(
        account.balance + amount,
        "Credit balance exceeds the supported maximum",
      ),
      grantId = createId(),
      ledgerId = createId();
    const data = metadata == null ? null : canonicalJson(metadata);
    await tx.query(SQL.grant_system_credits[0], [
      grantId,
      account.id,
      orgId,
      source,
      amount,
      endsAt,
      reason,
      reference,
      data,
    ]);
    await tx.query(SQL.grant_system_credits[1], [balance, account.id]);
    await tx.query(SQL.grant_system_credits[2], [
      ledgerId,
      account.id,
      orgId,
      grantId,
      amount,
      balance,
      reference ?? grantId,
      key,
      data,
    ]);
    return mutation(
      orgId,
      ledgerId,
      ledgerId,
      grantId,
      balance,
      account.reserved,
      amount,
      false,
    );
  });
}
export async function grantCredits(
  pool: Pool,
  orgId: string,
  amountInput: Units,
  source: string,
  endsAt: Date | null,
  reason: string,
  reference: string | null,
  actorId: string,
  key: string,
): Promise<Row> {
  const amount = positive(amountInput);
  source = source.trim().toUpperCase();
  if (!["MANUAL", "PROMOTIONAL", "COMPENSATION"].includes(source))
    bad("Admin credit source must be MANUAL, PROMOTIONAL, or COMPENSATION");
  reason = requiredText(reason, "Reason", 2000);
  key = requiredText(key, "Idempotency key", 240);
  expiry(endsAt);
  reference =
    reference == null ? null : requiredText(reference, "Reference", 240);
  orgId = requiredText(orgId, "Organization id", 160);
  actorId = requiredText(actorId, "Admin id", 160);
  await expireCreditGrants(pool, orgId);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const old = await existing(tx, orgId, key, true);
    if (old) return replay(tx, orgId, old, amount, true);
    const ledger = await existing(tx, orgId, key);
    if (ledger) {
      const result = await replay(tx, orgId, ledger, amount, false);
      return { ...result, operationId: "", grantId: null };
    }
    const account = await ensureAccount(tx, orgId),
      balance = checked(
        account.balance + amount,
        "Credit balance exceeds the supported maximum",
      ),
      grantId = createId(),
      ledgerId = createId(),
      operationId = createId();
    await tx.query(SQL.grant_credits[0], [
      grantId,
      account.id,
      orgId,
      source,
      amount,
      endsAt,
      reason,
      reference,
      actorId,
    ]);
    await tx.query(SQL.grant_credits[1], [balance, account.id]);
    await tx.query(SQL.grant_credits[2], [
      ledgerId,
      account.id,
      orgId,
      grantId,
      amount,
      balance,
      grantId,
      key,
      actorId,
    ]);
    await tx.query(SQL.create_admin_operation[0], [
      operationId,
      account.id,
      orgId,
      "GRANT",
      amount,
      source,
      reason,
      reference,
      actorId,
      account.balance,
      balance,
      account.reserved,
      account.reserved,
      ledgerId,
      key,
    ]);
    return mutation(
      orgId,
      operationId,
      ledgerId,
      grantId,
      balance,
      account.reserved,
      amount,
      false,
    );
  });
}
export async function revokeUnspentSystemGrant(
  pool: Pool,
  orgId: string,
  grantId: string,
  reason: string,
  key: string,
): Promise<Row> {
  orgId = requiredText(orgId, "Organization id", 160);
  grantId = requiredText(grantId, "Credit grant id", 160);
  reason = requiredText(reason, "Revocation reason", 2000);
  key = requiredText(key, "Idempotency key", 240);
  await expireCreditGrants(pool, orgId);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const old = await existing(tx, orgId, key);
    if (old) {
      if (old.entry_type !== "REVOKE" || old.source_id !== grantId)
        conflict("Credit idempotency key is already used by another operation");
      const row = await one(tx, SQL.revoke_unspent_system_grant[0], [
        grantId,
        orgId,
      ]);
      const prior = n(old, "amount");
      return {
        revokedAmount: wireInteger(prior < 0n ? -prior : prior),
        remainingAmount: wireInteger(
          row ? integer(Object.values(row)[0] as Units) : 0n,
        ),
        idempotent: true,
      };
    }
    const account = await ensureAccount(tx, orgId),
      grant = await one(tx, SQL.revoke_unspent_system_grant[1], [
        grantId,
        orgId,
        account.id,
      ]);
    if (!grant) notFound("Credit grant not found");
    const revoked = min(
        n(grant!, "remainingAmount"),
        availableBalance(account.balance, account.reserved),
      ),
      remaining = n(grant!, "remainingAmount") - revoked,
      balance = account.balance - revoked;
    await tx.query(SQL.revoke_unspent_system_grant[2], [remaining, grantId]);
    await tx.query(SQL.revoke_unspent_system_grant[3], [balance, account.id]);
    await tx.query(SQL.revoke_unspent_system_grant[4], [
      createId(),
      account.id,
      orgId,
      grantId,
      -revoked,
      balance,
      key,
      canonicalJson({
        reason,
        revokedAmount: revoked,
        remainingAmount: remaining,
      }),
    ]);
    return {
      revokedAmount: wireInteger(revoked),
      remainingAmount: wireInteger(remaining),
      idempotent: false,
    };
  });
}
export async function setCreditBalance(
  pool: Pool,
  orgId: string,
  targetInput: Units,
  reason: string,
  reference: string | null,
  actorId: string,
  key: string,
): Promise<Row> {
  const target = nonnegative(targetInput, "Target credit balance");
  reason = requiredText(reason, "Reason", 2000);
  key = requiredText(key, "Idempotency key", 240);
  reference =
    reference == null ? null : requiredText(reference, "Reference", 240);
  orgId = requiredText(orgId, "Organization id", 160);
  actorId = requiredText(actorId, "Admin id", 160);
  await expireCreditGrants(pool, orgId);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const old = await existing(tx, orgId, key, true);
    if (old) return replay(tx, orgId, old, 0n, true);
    const account = await ensureAccount(tx, orgId);
    if (target < account.reserved)
      conflict(
        "Target credit balance cannot be below credits held by active reservations",
      );
    const delta = checked(
        target - account.balance,
        "Credit adjustment exceeds the supported range",
      ),
      operationId = createId();
    let grantId: string | null = null,
      ledgerId: string | null = null;
    if (delta > 0n) {
      grantId = createId();
      await tx.query(SQL.set_credit_balance[0], [
        grantId,
        account.id,
        orgId,
        delta,
        reason,
        reference,
        actorId,
      ]);
    } else if (delta < 0n) {
      let remaining = -delta;
      for (const grant of (
        await tx.query(SQL.set_credit_balance[1], [account.id])
      ).rows as Row[]) {
        if (!remaining) break;
        const amount = min(n(grant, "remaining_amount"), remaining);
        await tx.query(SQL.set_credit_balance[2], [amount, str(grant, "id")]);
        remaining -= amount;
      }
      if (remaining)
        conflict(
          "Active credit grants cannot cover the requested balance reset",
        );
    }
    await tx.query(SQL.set_credit_balance[3], [target, account.id]);
    if (delta !== 0n) {
      ledgerId = createId();
      await tx.query(SQL.set_credit_balance[4], [
        ledgerId,
        account.id,
        orgId,
        grantId,
        delta,
        target,
        operationId,
        key,
        actorId,
      ]);
    }
    await tx.query(SQL.create_admin_operation[0], [
      operationId,
      account.id,
      orgId,
      "SET_BALANCE",
      delta,
      "COMPENSATION",
      reason,
      reference,
      actorId,
      account.balance,
      target,
      account.reserved,
      account.reserved,
      ledgerId,
      key,
    ]);
    return mutation(
      orgId,
      operationId,
      ledgerId,
      grantId,
      target,
      account.reserved,
      delta,
      false,
    );
  });
}
async function reservationByKey(
  tx: PoolClient,
  orgId: string,
  key: string,
): Promise<Row | undefined> {
  const row = await one(tx, SQL.find_reservation_by_idempotency[0], [key]);
  if (row && row.org_id !== orgId)
    conflict("Credit idempotency key belongs to another organization");
  return row;
}
async function lockReservation(
  tx: PoolClient,
  orgId: string,
  id: string,
): Promise<Row> {
  const row = await one(tx, SQL.lock_reservation[0], [id, orgId]);
  if (!row) notFound("Credit reservation not found");
  return row!;
}
function reservationResult(
  row: Row,
  account: Account,
  amount: bigint,
  idempotent: boolean,
): Row {
  const { account_id: _, ...rest } = row;
  return {
    orgId: row.org_id,
    reservation: view(rest),
    balance: wireInteger(account.balance),
    reservedBalance: wireInteger(account.reserved),
    availableBalance: wireInteger(
      availableBalance(account.balance, account.reserved),
    ),
    amount: wireInteger(amount),
    idempotent,
  };
}
async function consumeGrants(
  tx: PoolClient,
  accountId: string,
  amount: bigint,
): Promise<void> {
  let remaining = amount;
  if (!remaining) return;
  for (const grant of (
    await tx.query(SQL.consume_credit_grants[0], [accountId])
  ).rows as Row[]) {
    if (!remaining) break;
    const used = min(n(grant, "remaining_amount"), remaining);
    await tx.query(SQL.consume_credit_grants[1], [used, str(grant, "id")]);
    remaining -= used;
  }
  if (remaining)
    conflict("Active credit grants cannot cover the captured credits");
}
export async function reserveCredits(
  pool: Pool,
  orgId: string,
  actionKey: string,
  estimatedInput: Units,
  sourceType: string | null,
  sourceId: string | null,
  pricingVersion: string | null,
  expiresAt: Date | null,
  key: string,
): Promise<Row> {
  const estimated = positive(estimatedInput);
  orgId = requiredText(orgId, "Organization id", 160);
  actionKey = requiredText(actionKey, "Action key", 240);
  key = requiredText(key, "Idempotency key", 240);
  expiry(expiresAt, "Reservation");
  sourceType =
    sourceType == null ? null : requiredText(sourceType, "Source type", 80);
  sourceId = sourceId == null ? null : requiredText(sourceId, "Source id", 240);
  pricingVersion =
    pricingVersion == null
      ? null
      : requiredText(pricingVersion, "Pricing version", 80);
  await expireCreditGrants(pool, orgId);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const old = await reservationByKey(tx, orgId, key);
    if (old) {
      if (
        old.action_key !== actionKey ||
        n(old, "estimated_credits") !== estimated
      )
        conflict(
          "Credit idempotency key was reused with different reservation parameters",
        );
      return reservationResult(
        old,
        await ensureAccount(tx, orgId),
        estimated,
        true,
      );
    }
    if (await existing(tx, orgId, key))
      conflict("Credit idempotency key is already used by another operation");
    const account = await ensureAccount(tx, orgId),
      available = availableBalance(account.balance, account.reserved);
    if (estimated > available)
      conflict(
        `Insufficient credits: required ${estimated}, available ${available}`,
      );
    const reserved = checked(
        account.reserved + estimated,
        "Reserved credits exceed the supported maximum",
      ),
      id = createId();
    await tx.query(SQL.reserve_credits[0], [
      id,
      account.id,
      orgId,
      actionKey,
      estimated,
      sourceType,
      sourceId,
      pricingVersion,
      key,
      expiresAt,
    ]);
    await tx.query(SQL.reserve_credits[1], [reserved, account.id]);
    await tx.query(SQL.reserve_credits[2], [
      createId(),
      account.id,
      orgId,
      account.balance,
      actionKey,
      sourceType,
      id,
      pricingVersion,
      key,
    ]);
    return reservationResult(
      {
        id,
        org_id: orgId,
        action_key: actionKey,
        estimated_credits: estimated,
        captured_credits: 0,
        released_credits: 0,
        status: "RESERVED",
        expires_at: expiresAt,
        source_type: sourceType,
        source_id: sourceId,
        pricing_version: pricingVersion,
      },
      { ...account, reserved },
      estimated,
      false,
    );
  });
}
export interface CreditCaptureUsage {
  provider?: string | null;
  model?: string | null;
  funding_source?: string | null;
  input_tokens?: Units | null;
  output_tokens?: Units | null;
  provider_cost_usd?: string | null;
  metadata?: unknown;
}
export async function captureCredits(
  pool: Pool,
  orgId: string,
  reservationId: string,
  actualInput: Units,
  usage: CreditCaptureUsage,
  key: string,
): Promise<Row> {
  const actual = nonnegative(actualInput, "Captured credits");
  if (
    [usage.input_tokens, usage.output_tokens].some(
      (v) => v != null && integer(v) < 0n,
    )
  )
    bad("Model token usage cannot be negative");
  for (const [value, label, max] of [
    [usage.provider, "Provider", 80],
    [usage.model, "Model", 240],
    [usage.funding_source, "Funding source", 40],
  ] as const)
    if (value != null) requiredText(value, label, max);
  if (
    usage.provider_cost_usd != null &&
    (!usage.provider_cost_usd.trim() ||
      !Number.isFinite(Number(usage.provider_cost_usd)) ||
      Number(usage.provider_cost_usd) < 0)
  )
    bad("Provider cost must be a finite non-negative number");
  orgId = requiredText(orgId, "Organization id", 160);
  reservationId = requiredText(reservationId, "Reservation id", 160);
  key = requiredText(key, "Idempotency key", 240);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const reservation = await lockReservation(tx, orgId, reservationId),
      old = await existing(tx, orgId, key);
    if (old) {
      if (
        old.entry_type !== "DEBIT" ||
        old.source_id !== reservationId ||
        n(old, "amount") !== -actual
      )
        conflict("Credit idempotency key is already used by another operation");
      return reservationResult(
        reservation,
        await ensureAccount(tx, orgId),
        actual,
        true,
      );
    }
    if (reservation.status !== "RESERVED")
      conflict(
        `Credit reservation is already ${String(reservation.status).toLowerCase()}`,
      );
    if (
      reservation.expires_at != null &&
      new Date(reservation.expires_at as Date).getTime() <= Date.now()
    )
      conflict("Credit reservation has expired");
    const account = await ensureAccount(tx, orgId);
    if (reservation.account_id !== account.id)
      internal("Credit reservation account does not match its organization");
    const [balance, reserved, released] = captureSettlement(
      account.balance,
      account.reserved,
      n(reservation, "estimated_credits"),
      actual,
    );
    await consumeGrants(tx, account.id, actual);
    await tx.query(SQL.capture_credits[0], [balance, reserved, account.id]);
    await tx.query(SQL.capture_credits[1], [actual, released, reservationId]);
    const ledgerId = createId();
    await tx.query(SQL.capture_credits[2], [
      ledgerId,
      account.id,
      orgId,
      -actual,
      balance,
      reservation.action_key,
      reservationId,
      reservation.pricing_version,
      key,
    ]);
    await tx.query(SQL.capture_credits[3], [
      createId(),
      account.id,
      orgId,
      ledgerId,
      reservation.action_key,
      actual,
      usage.provider ?? null,
      usage.model ?? null,
      usage.funding_source ?? null,
      usage.input_tokens ?? null,
      usage.output_tokens ?? null,
      usage.provider_cost_usd ?? null,
      reservation.pricing_version,
      key,
      usage.metadata == null ? null : canonicalJson(usage.metadata),
    ]);
    return reservationResult(
      {
        ...reservation,
        captured_credits: actual,
        released_credits: released,
        status: "CAPTURED",
      },
      { ...account, balance, reserved },
      actual,
      false,
    );
  });
}
export async function releaseCredits(
  pool: Pool,
  orgId: string,
  reservationId: string,
  reason: string,
  key: string,
): Promise<Row> {
  orgId = requiredText(orgId, "Organization id", 160);
  reservationId = requiredText(reservationId, "Reservation id", 160);
  reason = requiredText(reason, "Release reason", 2000);
  key = requiredText(key, "Idempotency key", 240);
  return transaction(pool, async (tx) => {
    await lockOperation(tx, key);
    const reservation = await lockReservation(tx, orgId, reservationId),
      old = await existing(tx, orgId, key);
    if (old) {
      if (old.entry_type !== "RELEASE" || old.source_id !== reservationId)
        conflict("Credit idempotency key is already used by another operation");
      return reservationResult(
        reservation,
        await ensureAccount(tx, orgId),
        0n,
        true,
      );
    }
    if (reservation.status !== "RESERVED")
      conflict(
        `Credit reservation is already ${String(reservation.status).toLowerCase()}`,
      );
    const account = await ensureAccount(tx, orgId);
    if (reservation.account_id !== account.id)
      internal("Credit reservation account does not match its organization");
    const [balance, reserved] = releaseSettlement(
      account.balance,
      account.reserved,
      n(reservation, "estimated_credits"),
    );
    const status =
      reservation.expires_at != null &&
      new Date(reservation.expires_at as Date).getTime() <= Date.now()
        ? "EXPIRED"
        : "RELEASED";
    await tx.query(SQL.release_credits[0], [reserved, account.id]);
    await tx.query(SQL.release_credits[1], [status, reservationId]);
    await tx.query(SQL.release_credits[2], [
      createId(),
      account.id,
      orgId,
      balance,
      reservation.action_key,
      reservationId,
      reservation.pricing_version,
      key,
      { reason },
    ]);
    return reservationResult(
      {
        ...reservation,
        released_credits: n(reservation, "estimated_credits"),
        status,
      },
      { ...account, balance, reserved },
      0n,
      false,
    );
  });
}
