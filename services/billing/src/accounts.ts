import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type {
  BillingAccountEnsureInput,
  BillingAccountEnsureResult,
  BillingProduct,
} from "@kasitek-labs/contracts";
import type { BillingConfig } from "./config.js";
import { transaction } from "./db.js";
import { getActivePlanVersion } from "./catalog.js";
import { ensureCreditAccountTx, grantCreditsTx } from "./credits.js";
import { bad, conflict, missing, optionalText, text } from "./util.js";

export interface AccountRow {
  id: string;
  name: string;
  status: string;
  currency: string;
  tax_rate_bps: number;
  vat_number: string | null;
  billing_email: string;
  billing_email_normalized: string;
  owner_issuer: string | null;
  owner_subject: string | null;
  billing_address: unknown;
  provider_customer_id: string | null;
  entitlements_revision: string;
  metadata: unknown;
}

export async function getAccountForTenant(
  pool: Pool | PoolClient,
  product: BillingProduct,
  tenantId: string,
): Promise<{ account: AccountRow; linkId: string; role: string }> {
  const result = await pool.query<AccountRow & { link_id: string; role: string }>(
    `SELECT a.id, a.name, a.status, a.currency, a.tax_rate_bps, a.vat_number,
            a.billing_email, a.billing_email_normalized, a.owner_issuer,
            a.owner_subject, a.billing_address, a.provider_customer_id,
            a.entitlements_revision::text, a.metadata,
            l.id AS link_id, l.role
       FROM billing.account_links l
       JOIN billing.accounts a ON a.id=l.billing_account_id
      WHERE l.product=$1 AND l.tenant_id=$2 AND l.status='active'`,
    [product, text(tenantId, "Tenant id", 256)],
  );
  if (!result.rows[0]) missing("Billing account is not linked for this tenant");
  const { link_id, role, ...account } = result.rows[0];
  return { account, linkId: link_id, role };
}

export async function getAccountById(
  pool: Pool | PoolClient,
  accountId: string,
): Promise<AccountRow> {
  const result = await pool.query<AccountRow>(
    `SELECT id, name, status, currency, tax_rate_bps, vat_number, billing_email,
            billing_email_normalized, owner_issuer, owner_subject, billing_address,
            provider_customer_id, entitlements_revision::text, metadata
       FROM billing.accounts WHERE id=$1`,
    [accountId],
  );
  if (!result.rows[0]) missing("Billing account not found");
  return result.rows[0];
}

export async function bumpEntitlementRevision(
  client: PoolClient,
  accountId: string,
): Promise<void> {
  await client.query(
    `UPDATE billing.accounts
        SET entitlements_revision=entitlements_revision+1, updated_at=now()
      WHERE id=$1`,
    [accountId],
  );
}

export async function ensureAccount(
  pool: Pool,
  input: BillingAccountEnsureInput,
  config: BillingConfig,
): Promise<BillingAccountEnsureResult> {
  const product = input.product;
  if (!["growth", "agents", "agency"].includes(product))
    bad("Product is invalid");
  const tenantId = text(input.tenantId, "Tenant id", 256);
  const name = text(input.name, "Account name", 200);
  const email = text(input.billingEmail, "Billing email", 320);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    bad("Billing email is invalid");
  const normalizedEmail = email.trim().toLowerCase();
  const ownerIssuer = optionalText(input.ownerIssuer, 255);
  const ownerSubject = optionalText(input.ownerSubject, 255);
  if (Boolean(ownerIssuer) !== Boolean(ownerSubject))
    bad("Owner issuer and subject must be provided together");

  return transaction(pool, async (client) => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `account-link:${product}:${tenantId}`,
    ]);
    const existing = await client.query<AccountRow & { link_id: string }>(
      `SELECT a.id, a.name, a.status, a.currency, a.tax_rate_bps, a.vat_number,
              a.billing_email, a.billing_email_normalized, a.owner_issuer,
              a.owner_subject, a.billing_address, a.provider_customer_id,
              a.entitlements_revision::text, a.metadata, l.id AS link_id
         FROM billing.account_links l
         JOIN billing.accounts a ON a.id=l.billing_account_id
        WHERE l.product=$1 AND l.tenant_id=$2 AND l.status='active'`,
      [product, tenantId],
    );
    if (existing.rows[0])
      return {
        accountId: existing.rows[0].id,
        product,
        tenantId,
        revision: existing.rows[0].entitlements_revision,
      };

    const currency = (input.currency ?? config.defaultCurrency).toUpperCase();
    if (ownerIssuer && ownerSubject) {
      const candidate = await client.query<AccountRow>(
        `SELECT id, name, status, currency, tax_rate_bps, vat_number, billing_email,
                billing_email_normalized, owner_issuer, owner_subject, billing_address,
                provider_customer_id, entitlements_revision::text, metadata
           FROM billing.accounts
          WHERE billing_email_normalized=$1 AND owner_issuer=$2
            AND owner_subject=$3 AND status='active'
          ORDER BY created_at LIMIT 1`,
        [normalizedEmail, ownerIssuer, ownerSubject],
      );
      const account = candidate.rows[0];
      if (account) {
        const productLink = await client.query(
          `SELECT 1 FROM billing.account_links
            WHERE billing_account_id=$1 AND product=$2 AND status='active'`,
          [account.id, product],
        );
        if (productLink.rowCount)
          conflict(
            `This billing email is already linked to another ${product} workspace; use a different billing email`,
          );
        await client.query(
          `INSERT INTO billing.account_links(id, billing_account_id, product, tenant_id)
           VALUES($1,$2,$3,$4)`,
          [`lnk_${randomUUID()}`, account.id, product, tenantId],
        );
        await ensureFreePlanTx(client, config, account.id, product, account.currency);
        await bumpEntitlementRevision(client, account.id);
        const revision = await client.query<{ entitlements_revision: string }>(
          `SELECT entitlements_revision::text FROM billing.accounts WHERE id=$1`,
          [account.id],
        );
        return {
          accountId: account.id,
          product,
          tenantId,
          revision: revision.rows[0]!.entitlements_revision,
        };
      }
    }

    const accountId = `acct_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.accounts(
         id, name, currency, tax_rate_bps, billing_email,
         billing_email_normalized, owner_issuer, owner_subject, metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        accountId,
        name,
        currency,
        config.taxRateBps,
        email,
        normalizedEmail,
        ownerIssuer,
        ownerSubject,
        JSON.stringify(input.metadata ?? {}),
      ],
    );
    await client.query(
      `INSERT INTO billing.account_links(id, billing_account_id, product, tenant_id)
       VALUES($1,$2,$3,$4)`,
      [`lnk_${randomUUID()}`, accountId, product, tenantId],
    );
    await ensureCreditAccountTx(client, accountId);

    await ensureFreePlanTx(client, config, accountId, product, currency);
    await bumpEntitlementRevision(client, accountId);
    const result = await client.query<{ entitlements_revision: string }>(
      `SELECT entitlements_revision::text FROM billing.accounts WHERE id=$1`,
      [accountId],
    );
    return {
      accountId,
      product,
      tenantId,
      revision: result.rows[0]!.entitlements_revision,
    };
  });
}

async function ensureFreePlanTx(
  client: PoolClient,
  config: BillingConfig,
  accountId: string,
  product: BillingProduct,
  currency: string,
): Promise<void> {
  const freePlanKey = config.freePlans[product];
  if (!freePlanKey) return;
  try {
    const plan = await getActivePlanVersion(client, freePlanKey, currency);
    if (plan.product_key !== product)
      throw new Error(`Free plan ${freePlanKey} belongs to ${plan.product_key}`);
    const active = await client.query(
      `SELECT 1 FROM billing.subscriptions
        WHERE billing_account_id=$1 AND product_key=$2
          AND status IN ('trialing','active','past_due','grace') LIMIT 1`,
      [accountId, product],
    );
    if (active.rowCount) return;
    const subscriptionId = `sub_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.subscriptions(
         id, billing_account_id, plan_version_id, product_key, status, provider
       ) VALUES($1,$2,$3,$4,'active',NULL)`,
      [subscriptionId, accountId, plan.id, product],
    );
    const credits = BigInt(plan.credits_per_period ?? "0");
    if (credits > 0n)
      await grantCreditsTx(client, {
        billingAccountId: accountId,
        product,
        source: "PLAN",
        amount: credits,
        reference: `free:${freePlanKey}:${subscriptionId}`,
        idempotencyKey: `free-plan:${subscriptionId}`,
        metadata: { planKey: freePlanKey, subscriptionId, free: true },
      });
  } catch (error) {
    // A missing free plan must not block account creation. The account can
    // be assigned a plan through the admin API once the catalog exists.
    if (!(error instanceof Error) || !/not found/i.test(error.message))
      throw error;
  }
}

export async function linkTenant(
  pool: Pool,
  input: {
    accountId: string;
    product: BillingProduct;
    tenantId: string;
    role?: "payer" | "member";
  },
): Promise<unknown> {
  const tenantId = text(input.tenantId, "Tenant id", 256);
  return transaction(pool, async (client) => {
    const account = await client.query<{ id: string }>(
      `SELECT id FROM billing.accounts WHERE id=$1 FOR UPDATE`,
      [input.accountId],
    );
    if (!account.rows[0]) missing("Billing account not found");
    const existing = await client.query<{ id: string; billing_account_id: string }>(
      `SELECT id, billing_account_id FROM billing.account_links
        WHERE product=$1 AND tenant_id=$2 FOR UPDATE`,
      [input.product, tenantId],
    );
    const activeProductLink = await client.query<{ tenant_id: string }>(
      `SELECT tenant_id FROM billing.account_links
        WHERE billing_account_id=$1 AND product=$2 AND status='active'
          AND tenant_id<>$3 FOR UPDATE`,
      [input.accountId, input.product, tenantId],
    );
    if (activeProductLink.rows[0])
      conflict(
        `This billing account already has a ${input.product} workspace; use a different billing account`,
      );
    if (existing.rows[0]) {
      if (existing.rows[0].billing_account_id !== input.accountId)
        conflict("Tenant is already linked to another billing account");
      await client.query(
        `UPDATE billing.account_links SET status='active', role=$2, updated_at=now() WHERE id=$1`,
        [existing.rows[0].id, input.role ?? "payer"],
      );
      await bumpEntitlementRevision(client, input.accountId);
      return { linked: true, reused: true };
    }
    await client.query(
      `INSERT INTO billing.account_links(id, billing_account_id, product, tenant_id, role)
       VALUES($1,$2,$3,$4,$5)`,
      [`lnk_${randomUUID()}`, input.accountId, input.product, tenantId, input.role ?? "payer"],
    );
    await bumpEntitlementRevision(client, input.accountId);
    return { linked: true, reused: false };
  });
}

export async function hasTenantRole(
  pool: Pool | PoolClient,
  product: BillingProduct,
  tenantId: string,
  roles: Array<"payer" | "member"> = ["payer", "member"],
): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM billing.account_links
      WHERE product=$1 AND tenant_id=$2 AND status='active' AND role = ANY($3::text[])`,
    [product, tenantId, roles],
  );
  return (result.rowCount ?? 0) > 0;
}
