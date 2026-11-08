import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { BillingCreditSummary, BillingProduct } from "@kasitek-labs/contracts";
import { transaction } from "./db.js";
import { bad, bigValue, conflict, missing, text, wire } from "./util.js";

export interface CreditGrantInput {
  billingAccountId: string;
  product: BillingProduct;
  source: "PLAN" | "TRIAL" | "PURCHASE" | "REFERRAL" | "MIGRATION" | "PROMOTION" | "ADJUSTMENT";
  amount: bigint;
  startsAt?: Date;
  endsAt?: Date | null;
  reference?: string | null;
  idempotencyKey: string;
  metadata?: Record<string, unknown>;
}

export interface CreditDebitResult {
  charged: bigint;
  shortfall: bigint;
  balance: bigint;
  ledgerId: string | null;
}

export async function ensureCreditAccountTx(
  client: PoolClient,
  billingAccountId: string,
): Promise<{ id: string; balance: bigint; reserved: bigint }> {
  const existing = await client.query<{ id: string; balance: string; reserved_balance: string }>(
    `SELECT id, balance::text, reserved_balance::text
       FROM billing.credit_accounts WHERE billing_account_id=$1`,
    [billingAccountId],
  );
  if (existing.rows[0]) {
    return {
      id: existing.rows[0].id,
      balance: BigInt(existing.rows[0].balance),
      reserved: BigInt(existing.rows[0].reserved_balance),
    };
  }
  const id = `cra_${randomUUID()}`;
  await client.query(
    `INSERT INTO billing.credit_accounts(id, billing_account_id) VALUES($1,$2)
     ON CONFLICT (billing_account_id) DO NOTHING`,
    [id, billingAccountId],
  );
  const row = await client.query<{ id: string; balance: string; reserved_balance: string }>(
    `SELECT id, balance::text, reserved_balance::text FROM billing.credit_accounts WHERE billing_account_id=$1`,
    [billingAccountId],
  );
  return {
    id: row.rows[0]!.id,
    balance: BigInt(row.rows[0]!.balance),
    reserved: BigInt(row.rows[0]!.reserved_balance),
  };
}

export async function grantCreditsTx(
  client: PoolClient,
  input: CreditGrantInput,
): Promise<{ grantId: string; ledgerId: string; balance: bigint; replayed: boolean }> {
  if (input.amount <= 0n) bad("Credit amount must be positive");
  const key = text(input.idempotencyKey, "Credit idempotency key", 240);
  const account = await ensureCreditAccountTx(client, input.billingAccountId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `credit:${key}`,
  ]);
  await client.query(
    `SELECT id FROM billing.credit_grants WHERE idempotency_key=$1 FOR UPDATE`,
    [key],
  );
  const existing = await client.query<{ id: string; amount: string }>(
    `SELECT id, amount::text FROM billing.credit_grants WHERE idempotency_key=$1`,
    [key],
  );
  if (existing.rows[0]) {
    const ledger = await client.query<{ id: string }>(
      `SELECT id FROM billing.credit_ledger WHERE idempotency_key=$1`,
      [`grant:${key}`],
    );
    return {
      grantId: existing.rows[0].id,
      ledgerId: ledger.rows[0]?.id ?? "",
      balance: account.balance,
      replayed: true,
    };
  }
  const grantId = `crg_${randomUUID()}`;
  const ledgerId = `crl_${randomUUID()}`;
  const balance = account.balance + input.amount;
  await client.query(
    `INSERT INTO billing.credit_grants(
       id, account_id, product_key, source, amount, remaining,
       starts_at, ends_at, reference, idempotency_key, metadata
     ) VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,$9,$10)`,
    [
      grantId,
      account.id,
      input.product,
      input.source,
      input.amount.toString(),
      input.startsAt ?? new Date(),
      input.endsAt ?? null,
      input.reference ?? null,
      key,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  await client.query(
    `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
    [account.id, balance.toString()],
  );
  await client.query(
    `INSERT INTO billing.credit_ledger(
       id, account_id, product_key, grant_id, type, amount, balance_after,
       reference, idempotency_key, metadata
     ) VALUES($1,$2,$3,$4,'grant',$5,$6,$7,$8,$9)`,
    [
      ledgerId,
      account.id,
      input.product,
      grantId,
      input.amount.toString(),
      balance.toString(),
      input.reference ?? null,
      `grant:${key}`,
      JSON.stringify({ source: input.source, ...input.metadata }),
    ],
  );
  return { grantId, ledgerId, balance, replayed: false };
}

export async function grantCredits(
  pool: Pool,
  input: CreditGrantInput,
): Promise<{ grantId: string; ledgerId: string; balance: bigint; replayed: boolean }> {
  return transaction(pool, async (client) => {
    const result = await grantCreditsTx(client, input);
    if (!result.replayed)
      await client.query(
        `UPDATE billing.accounts
            SET entitlements_revision=entitlements_revision+1, updated_at=now()
          WHERE id=$1`,
        [input.billingAccountId],
      );
    return result;
  });
}

export async function debitCreditsTx(
  client: PoolClient,
  input: {
    billingAccountId: string;
    product: BillingProduct;
    amount: bigint;
    reference: string;
    idempotencyKey: string;
    metadata?: Record<string, unknown>;
  },
): Promise<CreditDebitResult> {
  if (input.amount < 0n) bad("Credit debit cannot be negative");
  if (input.amount === 0n)
    return {
      charged: 0n,
      shortfall: 0n,
      balance: (await ensureCreditAccountTx(client, input.billingAccountId)).balance,
      ledgerId: null,
    };
  const account = await ensureCreditAccountTx(client, input.billingAccountId);
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
    `credit-account:${account.id}`,
  ]);
  await client.query(
    `SELECT id FROM billing.credit_accounts WHERE id=$1 FOR UPDATE`,
    [account.id],
  );
  const current = await client.query<{ balance: string; reserved_balance: string }>(
    `SELECT balance::text, reserved_balance::text FROM billing.credit_accounts WHERE id=$1`,
    [account.id],
  );
  const balance = BigInt(current.rows[0]!.balance);
  const reserved = BigInt(current.rows[0]!.reserved_balance);
  const available = balance - reserved > 0n ? balance - reserved : 0n;
  const charged = input.amount < available ? input.amount : available;
  const shortfall = input.amount - charged;
  if (charged === 0n)
    return { charged, shortfall, balance, ledgerId: null };

  let remaining = charged;
  const grants = await client.query<{ id: string; remaining: string; ends_at: string | null }>(
    `SELECT id, remaining::text, ends_at::text
       FROM billing.credit_grants
      WHERE account_id=$1 AND product_key=$2 AND remaining>0
        AND starts_at<=now() AND (ends_at IS NULL OR ends_at>now())
      ORDER BY ends_at NULLS LAST, starts_at, created_at
      FOR UPDATE`,
    [account.id, input.product],
  );
  const allocations: Array<{ grantId: string; amount: string }> = [];
  for (const grant of grants.rows) {
    if (remaining === 0n) break;
    const grantRemaining = BigInt(grant.remaining);
    const take = grantRemaining < remaining ? grantRemaining : remaining;
    if (take === 0n) continue;
    await client.query(
      `UPDATE billing.credit_grants SET remaining=remaining-$2 WHERE id=$1`,
      [grant.id, take.toString()],
    );
    allocations.push({ grantId: grant.id, amount: take.toString() });
    remaining -= take;
  }
  const remainingAfter = balance - charged;
  const ledgerId = `crl_${randomUUID()}`;
  await client.query(
    `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
    [account.id, remainingAfter.toString()],
  );
  await client.query(
    `INSERT INTO billing.credit_ledger(
       id, account_id, product_key, type, amount, balance_after,
       reference, idempotency_key, metadata
     ) VALUES($1,$2,$3,'debit',$4,$5,$6,$7,$8)`,
    [
      ledgerId,
      account.id,
      input.product,
      (-charged).toString(),
      remainingAfter.toString(),
      input.reference,
      `debit:${input.idempotencyKey}`,
      JSON.stringify({ ...input.metadata, allocations, shortfall: shortfall.toString() }),
    ],
  );
  return { charged, shortfall, balance: remainingAfter, ledgerId };
}

export async function getCreditSummary(
  pool: Pool | PoolClient,
  billingAccountId: string,
  currency = "USD",
): Promise<BillingCreditSummary> {
  const row = await pool.query<{ balance: string; reserved_balance: string }>(
    `SELECT balance::text, reserved_balance::text
       FROM billing.credit_accounts WHERE billing_account_id=$1`,
    [billingAccountId],
  );
  const balance = BigInt(row.rows[0]?.balance ?? "0");
  const reserved = BigInt(row.rows[0]?.reserved_balance ?? "0");
  return {
    balance: wire(balance),
    reserved: wire(reserved),
    available: wire(balance - reserved > 0n ? balance - reserved : 0n),
    currency,
  };
}

export async function listCreditLedger(
  pool: Pool,
  billingAccountId: string,
  limit = 100,
): Promise<Array<Record<string, unknown>>> {
  const account = await pool.query<{ id: string }>(
    `SELECT id FROM billing.credit_accounts WHERE billing_account_id=$1`,
    [billingAccountId],
  );
  if (!account.rows[0]) return [];
  const rows = await pool.query(
    `SELECT id, product_key, type, amount::text, balance_after::text,
            reference, metadata, created_at
       FROM billing.credit_ledger WHERE account_id=$1
      ORDER BY created_at DESC LIMIT $2`,
    [account.rows[0].id, Math.min(500, Math.max(1, limit))],
  );
  return rows.rows.map((row) => ({
    id: row.id,
    product: row.product_key,
    type: row.type,
    amount: row.amount,
    balanceAfter: row.balance_after,
    reference: row.reference,
    metadata: row.metadata,
    createdAt: row.created_at,
  }));
}

export function creditCost(
  quantity: string,
  costPerUnit: string | null,
  minimum: string | number,
): bigint {
  const min = bigValue(minimum, "Minimum credits", 0n);
  if (costPerUnit == null) return 0n;
  const scale = 1_000_000n;
  const quantityMicros = decimalToMicros(quantity);
  const costMicros = decimalToMicros(costPerUnit);
  if (quantityMicros === 0n || costMicros === 0n) return min;
  const product = quantityMicros * costMicros;
  const credits = (product + scale * scale - 1n) / (scale * scale);
  return credits + min;
}

function decimalToMicros(value: string): bigint {
  const normalized = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized)) return 0n;
  const [whole, fraction = ""] = normalized.split(".");
  return BigInt(whole!) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
}

export async function expireCreditGrants(pool: Pool, limit = 100): Promise<number> {
  return transaction(pool, async (client) => {
    const grants = await client.query<{
      id: string;
      account_id: string;
      product_key: string;
      remaining: string;
    }>(
      `SELECT id, account_id, product_key, remaining::text
         FROM billing.credit_grants
        WHERE remaining>0 AND ends_at IS NOT NULL AND ends_at<=now()
        ORDER BY ends_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
      [Math.min(500, Math.max(1, limit))],
    );
    let expired = 0;
    for (const grant of grants.rows) {
      const amount = BigInt(grant.remaining);
      if (amount <= 0n) continue;
      const account = await client.query<{ balance: string }>(
        `SELECT balance::text FROM billing.credit_accounts WHERE id=$1 FOR UPDATE`,
        [grant.account_id],
      );
      const balance = BigInt(account.rows[0]!.balance);
      const after = balance - amount;
      await client.query(
        `UPDATE billing.credit_grants SET remaining=0 WHERE id=$1`,
        [grant.id],
      );
      await client.query(
        `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
        [grant.account_id, after.toString()],
      );
      await client.query(
        `INSERT INTO billing.credit_ledger(
           id, account_id, product_key, grant_id, type, amount, balance_after, reference, idempotency_key
         ) VALUES($1,$2,$3,$4,'expiry',$5,$6,$7,$8)`,
        [
          `crl_${randomUUID()}`,
          grant.account_id,
          grant.product_key,
          grant.id,
          (-amount).toString(),
          after.toString(),
          `expiry:${grant.id}`,
          `expiry:${grant.id}`,
        ],
      );
      await client.query(
        `UPDATE billing.accounts a
            SET entitlements_revision=a.entitlements_revision+1, updated_at=now()
           FROM billing.credit_accounts c
          WHERE c.id=$1 AND a.id=c.billing_account_id`,
        [grant.account_id],
      );
      expired++;
    }
    return expired;
  });
}

export async function revokeUnspentPlanCreditsTx(
  client: PoolClient,
  billingAccountId: string,
  product: BillingProduct,
  subscriptionId: string,
  reason: string,
): Promise<bigint> {
  const account = await ensureCreditAccountTx(client, billingAccountId);
  const grants = await client.query<{ id: string; remaining: string }>(
    `SELECT id, remaining::text FROM billing.credit_grants
      WHERE account_id=$1 AND product_key=$2 AND source='PLAN' AND remaining>0
        AND metadata->>'subscriptionId'=$3
      FOR UPDATE`,
    [account.id, product, subscriptionId],
  );
  let revoked = 0n;
  for (const grant of grants.rows) {
    const amount = BigInt(grant.remaining);
    if (amount <= 0n) continue;
    revoked += amount;
    await client.query(
      `UPDATE billing.credit_grants SET remaining=0 WHERE id=$1`,
      [grant.id],
    );
    const current = await client.query<{ balance: string }>(
      `SELECT balance::text FROM billing.credit_accounts WHERE id=$1 FOR UPDATE`,
      [account.id],
    );
    const after = BigInt(current.rows[0]!.balance) - amount;
    await client.query(
      `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
      [account.id, after.toString()],
    );
    await client.query(
      `INSERT INTO billing.credit_ledger(
         id, account_id, product_key, grant_id, type, amount, balance_after, reference, idempotency_key, metadata
       ) VALUES($1,$2,$3,$4,'adjustment',$5,$6,$7,$8,$9)`,
      [
        `crl_${randomUUID()}`,
        account.id,
        product,
        grant.id,
        (-amount).toString(),
        after.toString(),
        `revoke:${grant.id}`,
        `revoke:${grant.id}`,
        JSON.stringify({ reason, subscriptionId }),
      ],
    );
  }
  return revoked;
}

export async function revokeUnspentPlanCredits(
  pool: Pool,
  billingAccountId: string,
  product: BillingProduct,
  subscriptionId: string,
  reason: string,
): Promise<bigint> {
  return transaction(pool, (client) =>
    revokeUnspentPlanCreditsTx(
      client,
      billingAccountId,
      product,
      subscriptionId,
      reason,
    ),
  );
}

export async function revokeCreditGrant(
  pool: Pool,
  grantId: string,
  reason: string,
  idempotencyKey: string,
): Promise<{ revoked: bigint; balance: bigint }> {
  return transaction(pool, async (client) => {
    const grant = await client.query<{
      id: string;
      account_id: string;
      product_key: string;
      remaining: string;
      billing_account_id: string;
    }>(
      `SELECT g.id, g.account_id, g.product_key, g.remaining::text, a.billing_account_id
         FROM billing.credit_grants g
         JOIN billing.credit_accounts a ON a.id=g.account_id
        WHERE g.id=$1 FOR UPDATE`,
      [grantId],
    );
    if (!grant.rows[0]) missing("Credit grant not found");
    const amount = BigInt(grant.rows[0].remaining);
    if (amount <= 0n)
      return {
        revoked: 0n,
        balance: BigInt(
          (
            await client.query<{ balance: string }>(
              `SELECT balance::text FROM billing.credit_accounts WHERE id=$1`,
              [grant.rows[0].account_id],
            )
          ).rows[0]!.balance,
        ),
      };
    await client.query(`UPDATE billing.credit_grants SET remaining=0 WHERE id=$1`, [
      grantId,
    ]);
    const account = await client.query<{ balance: string }>(
      `SELECT balance::text FROM billing.credit_accounts WHERE id=$1 FOR UPDATE`,
      [grant.rows[0].account_id],
    );
    const after = BigInt(account.rows[0]!.balance) - amount;
    await client.query(
      `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
      [grant.rows[0].account_id, after.toString()],
    );
    await client.query(
      `INSERT INTO billing.credit_ledger(
         id, account_id, product_key, grant_id, type, amount, balance_after,
         reference, idempotency_key, metadata
       ) VALUES($1,$2,$3,$4,'adjustment',$5,$6,$7,$8,$9)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        `crl_${randomUUID()}`,
        grant.rows[0].account_id,
        grant.rows[0].product_key,
        grantId,
        (-amount).toString(),
        after.toString(),
        `revoke:${idempotencyKey}`,
        `revoke:${idempotencyKey}`,
        JSON.stringify({ reason }),
      ],
    );
    await client.query(
      `UPDATE billing.accounts
          SET entitlements_revision=entitlements_revision+1, updated_at=now()
        WHERE id=$1`,
      [grant.rows[0].billing_account_id],
    );
    return { revoked: amount, balance: after };
  });
}

export async function setCreditBalance(
  pool: Pool,
  input: {
    billingAccountId: string;
    product: BillingProduct;
    targetBalance: bigint;
    reason: string;
    reference: string | null;
    actorId: string;
    idempotencyKey: string;
  },
): Promise<{ balance: bigint; adjustment: bigint; replayed: boolean }> {
  if (input.targetBalance < 0n) bad("Credit balance cannot be negative");
  return transaction(pool, async (client) => {
    const account = await ensureCreditAccountTx(client, input.billingAccountId);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `credit-balance:${input.idempotencyKey}`,
    ]);
    const existing = await client.query<{ amount: string; balance_after: string }>(
      `SELECT amount::text, balance_after::text FROM billing.credit_ledger
        WHERE idempotency_key=$1`,
      [`balance:${input.idempotencyKey}`],
    );
    if (existing.rows[0])
      return {
        balance: BigInt(existing.rows[0].balance_after),
        adjustment: BigInt(existing.rows[0].amount),
        replayed: true,
      };
    await client.query(
      `SELECT balance::text FROM billing.credit_accounts WHERE id=$1 FOR UPDATE`,
      [account.id],
    );
    const current = await client.query<{ balance: string }>(
      `SELECT balance::text FROM billing.credit_accounts WHERE id=$1`,
      [account.id],
    );
    const balance = BigInt(current.rows[0]!.balance);
    const adjustment = input.targetBalance - balance;
    if (adjustment !== 0n)
      await client.query(
        `UPDATE billing.credit_accounts SET balance=$2, updated_at=now() WHERE id=$1`,
        [account.id, input.targetBalance.toString()],
      );
    await client.query(
      `INSERT INTO billing.credit_ledger(
         id, account_id, product_key, type, amount, balance_after,
         reference, idempotency_key, metadata
       ) VALUES($1,$2,$3,'adjustment',$4,$5,$6,$7,$8)`,
      [
        `crl_${randomUUID()}`,
        account.id,
        input.product,
        adjustment.toString(),
        input.targetBalance.toString(),
        input.reference,
        `balance:${input.idempotencyKey}`,
        JSON.stringify({ reason: input.reason, actorId: input.actorId }),
      ],
    );
    await client.query(
      `UPDATE billing.accounts
          SET entitlements_revision=entitlements_revision+1, updated_at=now()
        WHERE id=$1`,
      [input.billingAccountId],
    );
    return {
      balance: input.targetBalance,
      adjustment,
      replayed: false,
    };
  });
}
