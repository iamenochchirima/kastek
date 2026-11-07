import type { Pool } from "pg";
import { randomUUID } from "node:crypto";
import type {
  BillingCheckoutInput,
  BillingCheckoutResult,
  BillingCheckoutVerification,
} from "@kasitek-labs/contracts";
import type { BillingConfig } from "./config.js";
import { assertReturnUrl } from "./config.js";
import { getAccountForTenant } from "./accounts.js";
import { getActivePlanVersion } from "./catalog.js";
import { taxBreakdown } from "./money.js";
import type { BillingProvider } from "./paystack.js";
import { activateCheckout, checkoutForAccount } from "./subscriptions.js";
import type { CheckoutRow } from "./types.js";
import { bad, conflict, text } from "./util.js";

const CHECKOUT_COLUMNS = `id, reference, idempotency_key, billing_account_id,
  plan_version_id, product_key, provider, status, authorization_url, return_url,
  expected_amount_minor::text, expected_currency, expected_tax_inclusive,
  expected_tax_rate_bps, provider_transaction_id, provider_response,
  completed_at, created_at, updated_at`;

export async function createCheckout(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  input: BillingCheckoutInput,
): Promise<BillingCheckoutResult> {
  const { account } = await getAccountForTenant(pool, input.product, input.tenantId);
  const plan = await getActivePlanVersion(pool, text(input.planKey, "Plan key", 80));
  if (plan.product_key !== input.product)
    bad("That plan belongs to another product");
  if (!plan.paystack_plan_code)
    bad("This plan is not connected to Paystack yet");
  if (BigInt(plan.amount_minor) <= 0n)
    bad("This plan does not have a checkout amount");
  const idempotencyKey = text(input.idempotencyKey, "Checkout idempotency key", 128);
  const email = text(input.email, "Checkout email", 320);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email))
    bad("Checkout email is invalid");
  const returnUrl = assertReturnUrl(
    text(input.returnUrl, "Checkout return URL", 2048),
    config.returnOrigins,
  );
  const expected = taxBreakdown(
    BigInt(plan.amount_minor),
    plan.tax_inclusive,
    plan.tax_rate_bps,
  ).totalMinor;

  const existing = await pool.query<CheckoutRow>(
    `SELECT ${CHECKOUT_COLUMNS} FROM billing.checkouts
      WHERE billing_account_id=$1 AND provider=$2 AND idempotency_key=$3`,
    [account.id, provider.name, idempotencyKey],
  );
  if (existing.rows[0]) {
    const checkout = existing.rows[0];
    if (checkout.plan_version_id !== plan.id)
      conflict("Checkout idempotency key is already used for another plan");
    if (checkout.status === "completed" || checkout.status === "pending") {
      if (!checkout.authorization_url && checkout.status === "pending")
        conflict("Checkout is still being initialised");
      return {
        reference: checkout.reference,
        authorizationUrl: checkout.authorization_url ?? "",
        planKey: plan.plan_key,
        reused: true,
      };
    }
    conflict("Checkout already failed; use a new idempotency key");
  }

  const reference = `ks_${randomUUID().replaceAll("-", "")}`;
  const inserted = await pool.query<CheckoutRow>(
    `INSERT INTO billing.checkouts(
       id, reference, idempotency_key, billing_account_id, plan_version_id,
       product_key, provider, status, return_url, expected_amount_minor,
       expected_currency, expected_tax_inclusive, expected_tax_rate_bps
     ) VALUES($1,$2,$3,$4,$5,$6,$7,'pending',$8,$9,$10,$11,$12)
     ON CONFLICT (billing_account_id, provider, idempotency_key) DO NOTHING
     RETURNING ${CHECKOUT_COLUMNS}`,
    [
      `chk_${randomUUID()}`,
      reference,
      idempotencyKey,
      account.id,
      plan.id,
      plan.product_key,
      provider.name,
      returnUrl,
      expected.toString(),
      plan.currency,
      plan.tax_inclusive,
      plan.tax_rate_bps,
    ],
  );
  let checkout = inserted.rows[0];
  if (!checkout) {
    const current = await pool.query<CheckoutRow>(
      `SELECT ${CHECKOUT_COLUMNS} FROM billing.checkouts
        WHERE billing_account_id=$1 AND provider=$2 AND idempotency_key=$3`,
      [account.id, provider.name, idempotencyKey],
    );
    checkout = current.rows[0];
    if (!checkout) conflict("Checkout could not be created");
    if (checkout.plan_version_id !== plan.id)
      conflict("Checkout idempotency key is already used for another plan");
    return {
      reference: checkout.reference,
      authorizationUrl: checkout.authorization_url ?? "",
      planKey: plan.plan_key,
      reused: true,
    };
  }

  try {
    const initialized = await provider.initializeCheckout({
      email,
      planCode: plan.paystack_plan_code,
      amountMinor: expected,
      currency: plan.currency,
      reference,
      callbackUrl: returnUrl,
      metadata: {
        billingAccountId: account.id,
        product: plan.product_key,
        tenantId: input.tenantId,
        planKey: plan.plan_key,
        planVersion: plan.version,
      },
    });
    if (initialized.reference !== reference)
      throw new Error("Paystack returned a different checkout reference");
    await pool.query(
      `UPDATE billing.checkouts
          SET authorization_url=$2, provider_response=$3::jsonb, updated_at=now()
        WHERE id=$1`,
      [checkout.id, initialized.authorizationUrl, JSON.stringify({ reference: initialized.reference })],
    );
    return {
      reference: initialized.reference,
      authorizationUrl: initialized.authorizationUrl,
      planKey: plan.plan_key,
      reused: false,
    };
  } catch (error) {
    await pool.query(
      `UPDATE billing.checkouts SET status='failed', updated_at=now() WHERE id=$1`,
      [checkout.id],
    );
    throw error;
  }
}

export async function verifyCheckout(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  input: {
    product: BillingCheckoutInput["product"];
    tenantId: string;
    reference: string;
  },
): Promise<BillingCheckoutVerification> {
  const { account } = await getAccountForTenant(pool, input.product, input.tenantId);
  const checkout = await checkoutForAccount(
    pool,
    account.id,
    input.product,
    text(input.reference, "Checkout reference", 256),
  );
  if (checkout.status === "completed") {
    const invoice = await pool.query<{ id: string; subscription_id: string | null }>(
      `SELECT id, subscription_id FROM billing.invoices WHERE checkout_id=$1`,
      [checkout.id],
    );
    return {
      reference: checkout.reference,
      status: "completed",
      subscriptionId: invoice.rows[0]?.subscription_id ?? null,
      invoiceId: invoice.rows[0]?.id ?? null,
    };
  }
  if (checkout.status !== "pending")
    return {
      reference: checkout.reference,
      status: "failed",
      subscriptionId: null,
      invoiceId: null,
    };
  const verification = await provider.verifyTransaction(checkout.reference);
  if (!verification.successful)
    return {
      reference: checkout.reference,
      status: "pending",
      subscriptionId: null,
      invoiceId: null,
    };
  const activated = await activateCheckout(
    pool,
    config,
    provider,
    checkout,
    verification,
  );
  return {
    reference: checkout.reference,
    status: "completed",
    subscriptionId: activated.subscriptionId,
    invoiceId: activated.invoiceId,
  };
}
