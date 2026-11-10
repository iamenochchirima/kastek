import type { Pool, PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import type { BillingProduct } from "@kasitek-labs/contracts";
import type { BillingConfig } from "./config.js";
import { transaction } from "./db.js";
import {
  getActivePlanVersion,
  getPlanVersionById,
  type PlanVersionRow,
} from "./catalog.js";
import {
  grantCreditsTx,
  revokeUnspentPlanCredits,
  revokeUnspentPlanCreditsTx,
} from "./credits.js";
import { createInvoiceTx, findInvoiceByCheckout, markInvoiceRefunded } from "./invoices.js";
import { addMonth, taxBreakdown } from "./money.js";
import type { BillingProvider, ProviderEvent, VerifiedTransaction } from "./paystack.js";
import {
  bumpEntitlementRevision,
  getAccountForTenant,
} from "./accounts.js";
import type { CheckoutRow, SubscriptionRow } from "./types.js";
import { SUBSCRIPTION_COLUMNS } from "./types.js";
import {
  bad,
  conflict,
  HttpError,
  missing,
  jsonStringify,
  optionalWire,
  wire,
} from "./util.js";

export interface ActivationResult {
  subscriptionId: string;
  invoiceId: string;
  status: "completed";
}

function planGross(plan: PlanVersionRow): bigint {
  return taxBreakdown(
    BigInt(plan.amount_minor),
    plan.tax_inclusive,
    plan.tax_rate_bps,
  ).totalMinor;
}

export async function currentSubscription(
  pool: Pool | PoolClient,
  accountId: string,
  product: BillingProduct,
  forUpdate = false,
): Promise<SubscriptionRow | null> {
  const result = await pool.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions
      WHERE billing_account_id=$1 AND product_key=$2
        AND status IN ('trialing','active','past_due','grace')
      ORDER BY created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
    [accountId, product],
  );
  return result.rows[0] ?? null;
}

export async function activateCheckout(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  checkout: CheckoutRow,
  verification: VerifiedTransaction,
): Promise<ActivationResult> {
  if (!verification.successful) conflict("Payment was not successful");
  if (verification.reference !== checkout.reference)
    conflict("Payment reference did not match the checkout");
  const expectedAmount = BigInt(checkout.expected_amount_minor);
  if (
    verification.amountMinor == null ||
    verification.amountMinor !== expectedAmount ||
    verification.currency?.toUpperCase() !== checkout.expected_currency
  ) {
    await recordIssue(pool, {
      billingAccountId: checkout.billing_account_id,
      provider: provider.name,
      resourceType: "checkout",
      resourceId: checkout.reference,
      issueType: "amount_mismatch",
      details: {
        expectedAmountMinor: expectedAmount.toString(),
        receivedAmountMinor: optionalWire(verification.amountMinor),
        expectedCurrency: checkout.expected_currency,
        receivedCurrency: verification.currency,
      },
    });
    conflict("Payment amount or currency did not match the checkout");
  }

  const plan = await getPlanVersionById(pool, checkout.plan_version_id);
  if (plan.product_key !== checkout.product_key)
    conflict("Checkout plan product does not match the account product");

  let providerSubscriptionId = verification.subscriptionId;
  if (
    !providerSubscriptionId &&
    verification.providerCustomerId &&
    plan.paystack_plan_code
  ) {
    try {
      providerSubscriptionId = await provider.resolveSubscriptionId({
        providerCustomerId: verification.providerCustomerId,
        planCode: plan.paystack_plan_code,
      });
    } catch {
      // The subscription-created webhook remains the fallback for the code.
    }
  }

  let periodStart = new Date();
  let periodEnd = addMonth(periodStart);
  if (providerSubscriptionId) {
    try {
      const providerSubscription = await provider.verifySubscription(
        providerSubscriptionId,
      );
      if (providerSubscription.currentPeriodStart)
        periodStart = providerSubscription.currentPeriodStart;
      if (providerSubscription.currentPeriodEnd)
        periodEnd = providerSubscription.currentPeriodEnd;
    } catch {
      // The webhook remains authoritative for the subscription period; the
      // locally calculated month is corrected by reconciliation.
    }
  }

  const activation = await transaction(pool, async (client) => {
    const locked = await client.query<CheckoutRow>(
      `SELECT id, reference, idempotency_key, billing_account_id, plan_version_id,
              product_key, provider, status, authorization_url, return_url,
              expected_amount_minor::text, expected_currency, expected_tax_inclusive,
              expected_tax_rate_bps, provider_transaction_id, provider_response,
              completed_at, created_at, updated_at
         FROM billing.checkouts WHERE id=$1 FOR UPDATE`,
      [checkout.id],
    );
    if (!locked.rows[0]) missing("Checkout not found");
    const current = locked.rows[0];
    if (current.status === "completed") {
      const invoice = await findInvoiceByCheckout(client, current.id);
      if (invoice?.subscription_id)
        return {
          result: {
            subscriptionId: invoice.subscription_id,
            invoiceId: invoice.id,
            status: "completed" as const,
          },
          canceledProviderSubscriptions: [],
        };
      const subscription = await currentSubscription(
        client,
        current.billing_account_id,
        current.product_key,
      );
      if (!subscription) conflict("Completed checkout has no subscription");
      return {
        result: {
          subscriptionId: subscription.id,
          invoiceId: invoice?.id ?? "",
          status: "completed" as const,
        },
        canceledProviderSubscriptions: [],
      };
    }
    if (current.status !== "pending") conflict("Checkout is not pending");

    const canceled = await client.query<{
      id: string;
      provider_subscription_id: string | null;
    }>(
      `UPDATE billing.subscriptions
          SET status='canceled', canceled_at=now(), cancel_at_period_end=false, updated_at=now()
        WHERE billing_account_id=$1 AND product_key=$2
          AND status IN ('trialing','active','past_due','grace')
        RETURNING id, provider_subscription_id`,
      [current.billing_account_id, current.product_key],
    );
    for (const previous of canceled.rows)
      await revokeUnspentPlanCreditsTx(
        client,
        current.billing_account_id,
        current.product_key,
        previous.id,
        "Plan changed",
      );
    const subscriptionId = `sub_${randomUUID()}`;
    await client.query(
      `INSERT INTO billing.subscriptions(
         id, billing_account_id, plan_version_id, product_key, status, provider,
         provider_customer_id, provider_subscription_id,
         current_period_start, current_period_end, cancel_at_period_end
       ) VALUES($1,$2,$3,$4,'active',$5,$6,$7,$8,$9,false)`,
      [
        subscriptionId,
        current.billing_account_id,
        current.plan_version_id,
        current.product_key,
        provider.name,
        verification.customerId,
        providerSubscriptionId ?? `${provider.name}-charge:${current.reference}`,
        periodStart,
        periodEnd,
      ],
    );
    if (verification.customerId) {
      const account = await client.query<{ provider_customer_id: string | null }>(
        `SELECT provider_customer_id FROM billing.accounts WHERE id=$1 FOR UPDATE`,
        [current.billing_account_id],
      );
      if (account.rows[0] && !account.rows[0].provider_customer_id) {
        await client.query(
          `UPDATE billing.accounts
              SET provider_customer_id=$2, updated_at=now() WHERE id=$1`,
          [current.billing_account_id, verification.customerId],
        );
      } else if (
        account.rows[0] &&
        account.rows[0].provider_customer_id !== verification.customerId
      ) {
        await client.query(
          `INSERT INTO billing.reconciliation_issues(
             id, fingerprint, billing_account_id, provider, resource_type,
             resource_id, issue_type, details
           ) VALUES($1,$2,$3,$4,'account',$3,'provider_customer_mismatch',$5)
           ON CONFLICT (fingerprint) DO UPDATE SET
             details=EXCLUDED.details, status='open', updated_at=now()`,
          [
            `rci_${randomUUID()}`,
            `${provider.name}:account:${current.billing_account_id}:provider_customer_mismatch`,
            current.billing_account_id,
            provider.name,
            JSON.stringify({
              existingCustomerId: account.rows[0].provider_customer_id,
              receivedCustomerId: verification.customerId,
              checkoutReference: current.reference,
            }),
          ],
        );
      }
    }
    const invoice = await createInvoiceTx(
      client,
      {
        billingAccountId: current.billing_account_id,
        subscriptionId,
        checkoutId: current.id,
        plan,
        periodStart,
        periodEnd,
        provider: provider.name,
        providerInvoiceId: null,
        providerTransactionId: verification.providerTransactionId ?? current.reference,
        status: "paid",
        metadata: { checkoutReference: current.reference },
      },
      config.invoicePrefix,
    );
    await client.query(
      `UPDATE billing.checkouts
          SET status='completed', completed_at=now(), provider_transaction_id=$2,
              provider_response=COALESCE(provider_response,'{}'::jsonb) || $3::jsonb,
              updated_at=now()
        WHERE id=$1`,
      [
        current.id,
        verification.providerTransactionId,
        JSON.stringify({
          customerId: verification.customerId,
          subscriptionId: providerSubscriptionId,
          amountMinor: expectedAmount.toString(),
          currency: checkout.expected_currency,
        }),
      ],
    );
    await client.query(
      `INSERT INTO billing.provider_transactions(
         id, billing_account_id, provider, provider_transaction_id, reference,
         kind, status, amount_minor, currency, invoice_id, subscription_id, checkout_id, payload
       ) VALUES($1,$2,$3,$4,$5,'charge','succeeded',$6,$7,$8,$9,$10,$11)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING`,
      [
        `ptx_${randomUUID()}`,
        current.billing_account_id,
        provider.name,
        verification.providerTransactionId ?? current.reference,
        current.reference,
        expectedAmount.toString(),
        checkout.expected_currency,
        invoice.id,
        subscriptionId,
        current.id,
        JSON.stringify({ reference: current.reference }),
      ],
    );
    await grantPlanCredits(
      client,
      current.billing_account_id,
      current.product_key,
      plan,
      subscriptionId,
      periodStart,
      periodEnd,
      `plan:${subscriptionId}:${periodStart.toISOString()}`,
    );
    await bumpEntitlementRevision(client, current.billing_account_id);
    return {
      result: { subscriptionId, invoiceId: invoice.id, status: "completed" as const },
      canceledProviderSubscriptions: canceled.rows
        .map((row) => row.provider_subscription_id)
        .filter(
          (code): code is string =>
            code != null && !code.startsWith(`${provider.name}-charge:`),
        ),
    };
  });

  for (const previousProviderSubscriptionId of activation.canceledProviderSubscriptions) {
    try {
      await provider.setSubscriptionEnabled(previousProviderSubscriptionId, false);
    } catch (error) {
      await recordIssue(pool, {
        billingAccountId: checkout.billing_account_id,
        provider: provider.name,
        resourceType: "subscription",
        resourceId: previousProviderSubscriptionId,
        issueType: "provider_subscription_disable_failed",
        details: {
          checkoutReference: checkout.reference,
          message: error instanceof Error ? error.message.slice(0, 500) : "unknown",
        },
      });
    }
  }

  return activation.result;
}

export async function grantPlanCredits(
  client: PoolClient,
  accountId: string,
  product: BillingProduct,
  plan: PlanVersionRow,
  subscriptionId: string,
  periodStart: Date,
  periodEnd: Date,
  idempotencyKey: string,
): Promise<void> {
  const credits = BigInt(plan.credits_per_period ?? "0");
  if (credits <= 0n) return;
  await grantCreditsTx(client, {
    billingAccountId: accountId,
    product,
    source: "PLAN",
    amount: credits,
    endsAt: periodEnd,
    reference: idempotencyKey,
    idempotencyKey,
    metadata: {
      subscriptionId,
      planKey: plan.plan_key,
      planVersionId: plan.id,
      periodStart: periodStart.toISOString(),
      periodEnd: periodEnd.toISOString(),
    },
  });
}

export async function assignPlan(
  pool: Pool,
  input: {
    accountId: string;
    planKey: string;
    status?: "active" | "trialing";
    trialDays?: number;
    periodStart?: Date;
    periodEnd?: Date;
    reason: string;
  },
): Promise<SubscriptionRow> {
  return transaction(pool, async (client) => {
    const account = await client.query<{ id: string; currency: string; environment: string }>(
      `SELECT id, currency, environment FROM billing.accounts WHERE id=$1 FOR UPDATE`,
      [input.accountId],
    );
    if (!account.rows[0]) missing("Billing account not found");
    const plan = await getActivePlanVersion(client, input.planKey, account.rows[0].currency);
    if (plan.plan_audience === "sandbox" && account.rows[0].environment !== "sandbox") {
      bad("Sandbox plans can only be assigned to sandbox accounts");
    }
    const status = input.status ?? "active";
    const start = input.periodStart ?? new Date();
    const end =
      input.periodEnd ??
      (status === "trialing" && input.trialDays
        ? new Date(Date.now() + input.trialDays * 86_400_000)
        : addMonth(start));
    const canceled = await client.query<{ id: string }>(
      `UPDATE billing.subscriptions
          SET status='canceled', canceled_at=now(), cancel_at_period_end=false, updated_at=now()
        WHERE billing_account_id=$1 AND product_key=$2
          AND status IN ('trialing','active','past_due','grace')
        RETURNING id`,
      [input.accountId, plan.product_key],
    );
    for (const previous of canceled.rows)
      await revokeUnspentPlanCreditsTx(
        client,
        input.accountId,
        plan.product_key,
        previous.id,
        "Plan changed",
      );
    const subscriptionId = `sub_${randomUUID()}`;
    const result = await client.query<SubscriptionRow>(
      `INSERT INTO billing.subscriptions(
         id, billing_account_id, plan_version_id, product_key, status,
         current_period_start, current_period_end, trial_ends_at
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING ${SUBSCRIPTION_COLUMNS}`,
      [
        subscriptionId,
        input.accountId,
        plan.id,
        plan.product_key,
        status,
        start,
        status === "trialing" ? null : end,
        status === "trialing" ? end : null,
      ],
    );
    if (status === "active" || status === "trialing")
      await grantPlanCredits(
        client,
        input.accountId,
        plan.product_key,
        plan,
        subscriptionId,
        start,
        end,
        `assigned:${subscriptionId}:${start.toISOString()}`,
      );
    await bumpEntitlementRevision(client, input.accountId);
    return result.rows[0]!;
  });
}

export interface TrialEligibility {
  eligible: boolean;
  planKey: string | null;
  days: number;
  reason:
    | "available"
    | "not_configured"
    | "trial_active"
    | "trial_used"
    | "already_subscribed";
  subscriptionId?: string;
  trialEndsAt?: string | null;
}

export async function trialEligibility(
  pool: Pool | PoolClient,
  config: BillingConfig,
  accountId: string,
  product: BillingProduct,
): Promise<TrialEligibility> {
  const planKey = config.trialPlans[product] ?? null;
  if (!planKey)
    return { eligible: false, planKey: null, days: config.trialDays, reason: "not_configured" };
  const history = await pool.query<{
    id: string;
    status: string;
    trial_ends_at: Date | null;
  }>(
    `SELECT s.id, s.status, s.trial_ends_at
       FROM billing.subscriptions s
      WHERE s.billing_account_id=$1 AND s.product_key=$2
        AND s.trial_ends_at IS NOT NULL
      ORDER BY s.created_at DESC LIMIT 1`,
    [accountId, product],
  );
  const previous = history.rows[0];
  if (previous) {
    if (previous.status === "trialing")
      return {
        eligible: false,
        planKey,
        days: config.trialDays,
        reason: "trial_active",
        subscriptionId: previous.id,
        trialEndsAt: previous.trial_ends_at?.toISOString() ?? null,
      };
    return { eligible: false, planKey, days: config.trialDays, reason: "trial_used" };
  }
  const paid = await pool.query(
    `SELECT 1 FROM billing.subscriptions
      WHERE billing_account_id=$1 AND product_key=$2
        AND status IN ('trialing','active','past_due','grace')
        AND provider_subscription_id IS NOT NULL
      LIMIT 1`,
    [accountId, product],
  );
  if (paid.rowCount)
    return { eligible: false, planKey, days: config.trialDays, reason: "already_subscribed" };
  return { eligible: true, planKey, days: config.trialDays, reason: "available" };
}

export async function startTrial(
  pool: Pool,
  config: BillingConfig,
  accountId: string,
  product: BillingProduct,
): Promise<{ started: true; subscription: SubscriptionRow }> {
  const lock = await pool.connect();
  try {
    await lock.query("SELECT pg_advisory_lock(hashtextextended($1, 0))", [
      `trial:${accountId}:${product}`,
    ]);
    const eligibility = await trialEligibility(lock, config, accountId, product);
    if (!eligibility.eligible || !eligibility.planKey) {
      if (eligibility.reason === "trial_active")
        conflict("This workspace already has an active trial");
      if (eligibility.reason === "trial_used")
        conflict("This workspace has already used its trial");
      if (eligibility.reason === "already_subscribed")
        conflict("This workspace already has a paid subscription");
      bad("A trial is not configured for this product");
    }
    const subscription = await assignPlan(pool, {
      accountId,
      planKey: eligibility.planKey,
      status: "trialing",
      trialDays: eligibility.days,
      reason: "Self-serve trial",
    });
    return { started: true, subscription };
  } finally {
    await lock.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
      `trial:${accountId}:${product}`,
    ]).catch(() => undefined);
    lock.release();
  }
}

export async function extendTrialSubscription(
  pool: Pool,
  accountId: string,
  subscriptionId: string,
  days: number,
): Promise<SubscriptionRow> {
  return transaction(pool, async (client) => {
    const result = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions
        WHERE id=$1 AND billing_account_id=$2 FOR UPDATE`,
      [subscriptionId, accountId],
    );
    const subscription = result.rows[0];
    if (!subscription) missing("Subscription not found");
    if (subscription.status !== "trialing")
      conflict("Only a trialing subscription can be extended");
    const base = subscription.trial_ends_at && subscription.trial_ends_at > new Date()
      ? subscription.trial_ends_at
      : new Date();
    const trialEndsAt = new Date(base.getTime() + days * 86_400_000);
    await client.query(
      `UPDATE billing.subscriptions
          SET trial_ends_at=$2, updated_at=now() WHERE id=$1`,
      [subscriptionId, trialEndsAt],
    );
    await client.query(
      `UPDATE billing.credit_grants
          SET ends_at=$3
        WHERE account_id=(SELECT id FROM billing.credit_accounts WHERE billing_account_id=$1)
          AND product_key=$2 AND source='PLAN' AND metadata->>'subscriptionId'=$4
          AND remaining>0`,
      [accountId, subscription.product_key, trialEndsAt, subscriptionId],
    );
    await bumpEntitlementRevision(client, accountId);
    const updated = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions WHERE id=$1`,
      [subscriptionId],
    );
    return updated.rows[0]!;
  });
}

export async function endTrialSubscription(
  pool: Pool,
  config: BillingConfig,
  accountId: string,
  subscriptionId: string,
): Promise<{ ended: true; planKey: string | null; subscriptionId: string }> {
  const trial = await pool.query<{
    id: string;
    product_key: BillingProduct;
    status: string;
  }>(
    `SELECT id, product_key, status FROM billing.subscriptions
      WHERE id=$1 AND billing_account_id=$2`,
    [subscriptionId, accountId],
  );
  const subscription = trial.rows[0];
  if (!subscription) missing("Subscription not found");
  if (subscription.status !== "trialing")
    conflict("Only a trialing subscription can be ended");
  const freePlan = config.freePlans[subscription.product_key];
  if (!freePlan) {
    await cancelSubscription(pool, null, accountId, subscription.product_key, subscriptionId);
    return { ended: true, planKey: null, subscriptionId };
  }
  const assigned = await assignPlan(pool, {
    accountId,
    planKey: freePlan,
    status: "active",
    reason: "Trial ended by admin",
  });
  await revokeUnspentPlanCredits(
    pool,
    accountId,
    subscription.product_key,
    subscriptionId,
    "Trial ended early",
  );
  return { ended: true, planKey: freePlan, subscriptionId: assigned.id };
}

export async function cancelSubscription(
  pool: Pool,
  provider: BillingProvider | null,
  accountId: string,
  product: BillingProduct,
  subscriptionId: string,
): Promise<{ canceled: boolean; cancelAtPeriodEnd: boolean }> {
  const subscription = await transaction(pool, async (client) => {
    const result = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions
        WHERE id=$1 AND billing_account_id=$2 AND product_key=$3 FOR UPDATE`,
      [subscriptionId, accountId, product],
    );
    if (!result.rows[0]) missing("Subscription not found");
    return result.rows[0];
  });
  if (subscription.provider_subscription_id && !provider)
    throw new HttpError(
      503,
      "Paystack is required to cancel a paid subscription",
      "provider_unavailable",
    );
  if (subscription.provider_subscription_id && provider)
    await provider.setSubscriptionEnabled(
      subscription.provider_subscription_id,
      false,
    );
  const cancelAtPeriodEnd =
    Boolean(subscription.current_period_end) &&
    subscription.status !== "canceled";
  await transaction(pool, async (client) => {
    await client.query(
      `UPDATE billing.subscriptions
          SET cancel_at_period_end=$2,
              status=CASE WHEN $2 THEN status ELSE 'canceled' END,
              canceled_at=CASE WHEN $2 THEN canceled_at ELSE now() END,
              updated_at=now()
        WHERE id=$1 AND billing_account_id=$3`,
      [subscriptionId, cancelAtPeriodEnd, accountId],
    );
    await bumpEntitlementRevision(client, accountId);
  });
  return { canceled: true, cancelAtPeriodEnd };
}

export async function reactivateSubscription(
  pool: Pool,
  provider: BillingProvider | null,
  accountId: string,
  product: BillingProduct,
  subscriptionId: string,
): Promise<{ reactivated: boolean }> {
  const subscription = await transaction(pool, async (client) => {
    const result = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions
        WHERE id=$1 AND billing_account_id=$2 AND product_key=$3 FOR UPDATE`,
      [subscriptionId, accountId, product],
    );
    if (!result.rows[0]) missing("Subscription not found");
    return result.rows[0];
  });
  if (subscription.provider_subscription_id && !provider)
    throw new HttpError(
      503,
      "Paystack is required to reactivate a paid subscription",
      "provider_unavailable",
    );
  if (subscription.provider_subscription_id && provider)
    await provider.setSubscriptionEnabled(
      subscription.provider_subscription_id,
      true,
    );
  await transaction(pool, async (client) => {
    await client.query(
      `UPDATE billing.subscriptions
          SET cancel_at_period_end=false, canceled_at=NULL, status='active', updated_at=now()
        WHERE id=$1 AND billing_account_id=$2`,
      [subscriptionId, accountId],
    );
    await bumpEntitlementRevision(client, accountId);
  });
  return { reactivated: true };
}

export async function processRecurringCharge(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  event: Extract<ProviderEvent, { kind: "charge_succeeded" }>,
): Promise<boolean> {
  if (!event.subscriptionId) return false;
  const subscription = await pool.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions
      WHERE provider=$1 AND provider_subscription_id=$2`,
    [provider.name, event.subscriptionId],
  );
  if (!subscription.rows[0]) return false;
  const current = subscription.rows[0];
  const plan = await getPlanVersionById(pool, current.plan_version_id);
  const expected = planGross(plan);
  if (
    event.amountMinor == null ||
    event.amountMinor !== expected ||
    event.currency?.toUpperCase() !== plan.currency
  ) {
    await recordIssue(pool, {
      billingAccountId: current.billing_account_id,
      provider: provider.name,
      resourceType: "subscription",
      resourceId: current.id,
      issueType: "recurring_amount_mismatch",
      details: {
        expectedAmountMinor: expected.toString(),
        receivedAmountMinor: optionalWire(event.amountMinor),
        expectedCurrency: plan.currency,
        receivedCurrency: event.currency,
      },
    });
    return false;
  }
  if (event.invoiceId) {
    const existing = await pool.query(
      `SELECT 1 FROM billing.invoices WHERE provider=$1 AND provider_invoice_id=$2`,
      [provider.name, event.invoiceId],
    );
    if (existing.rowCount) return true;
  }
  const periodStart = current.current_period_end ?? new Date();
  const periodEnd = addMonth(periodStart);
  await transaction(pool, async (client) => {
    const locked = await client.query<SubscriptionRow>(
      `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions WHERE id=$1 FOR UPDATE`,
      [current.id],
    );
    if (!locked.rows[0]) missing("Subscription not found");
    const invoice = await createInvoiceTx(
      client,
      {
        billingAccountId: current.billing_account_id,
        subscriptionId: current.id,
        checkoutId: null,
        plan,
        periodStart,
        periodEnd,
        provider: provider.name,
        providerInvoiceId: event.invoiceId,
        providerTransactionId: event.transactionId ?? event.reference,
        status: "paid",
        metadata: { recurring: true, reference: event.reference },
      },
      config.invoicePrefix,
    );
    await client.query(
      `UPDATE billing.subscriptions
          SET status='active', current_period_start=$2, current_period_end=$3,
              grace_ends_at=NULL, cancel_at_period_end=false, updated_at=now()
        WHERE id=$1`,
      [current.id, periodStart, periodEnd],
    );
    await client.query(
      `INSERT INTO billing.provider_transactions(
         id, billing_account_id, provider, provider_transaction_id, reference,
         kind, status, amount_minor, currency, invoice_id, subscription_id, payload
       ) VALUES($1,$2,$3,$4,$5,'charge','succeeded',$6,$7,$8,$9,$10)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING`,
      [
        `ptx_${randomUUID()}`,
        current.billing_account_id,
        provider.name,
        event.transactionId ?? event.reference,
        event.reference,
        expected.toString(),
        plan.currency,
        invoice.id,
        current.id,
        jsonStringify(event),
      ],
    );
    await grantPlanCredits(
      client,
      current.billing_account_id,
      plan.product_key,
      plan,
      current.id,
      periodStart,
      periodEnd,
      `plan:${current.id}:${periodStart.toISOString()}`,
    );
    await bumpEntitlementRevision(client, current.billing_account_id);
  });
  return true;
}

export async function processRefund(
  pool: Pool,
  provider: BillingProvider,
  event: Extract<ProviderEvent, { kind: "refund_processed" }>,
): Promise<boolean> {
  const transactionRow = await pool.query<{
    billing_account_id: string;
    invoice_id: string | null;
    subscription_id: string | null;
    amount_minor: string;
    currency: string;
  }>(
    `SELECT billing_account_id, invoice_id, subscription_id,
            amount_minor::text, currency
       FROM billing.provider_transactions
      WHERE provider=$1 AND reference=$2 AND kind='charge'
      ORDER BY created_at DESC LIMIT 1`,
    [provider.name, event.transactionReference],
  );
  if (!transactionRow.rows[0]) return false;
  const original = transactionRow.rows[0];
  if (!original.invoice_id) {
    await recordIssue(pool, {
      billingAccountId: original.billing_account_id,
      provider: provider.name,
      resourceType: "transaction",
      resourceId: event.transactionReference,
      issueType: "refund_without_invoice",
      details: { reference: event.transactionReference },
    });
    return false;
  }
  const total = BigInt(original.amount_minor);
  const refunded = event.amountMinor;
  if (refunded == null || refunded < total) {
    await transaction(pool, async (client) => {
      await markInvoiceRefunded(client, original.invoice_id!, "partially_refunded");
      await bumpEntitlementRevision(client, original.billing_account_id);
    });
    await recordIssue(pool, {
      billingAccountId: original.billing_account_id,
      provider: provider.name,
      resourceType: "transaction",
      resourceId: event.transactionReference,
      issueType: "partial_refund_processed",
      details: {
        refundedAmountMinor: optionalWire(refunded),
        transactionAmountMinor: total.toString(),
      },
    });
    return true;
  }
  await transaction(pool, async (client) => {
    await markInvoiceRefunded(client, original.invoice_id!, "refunded");
    if (original.subscription_id) {
      const subscription = await client.query<{ product_key: BillingProduct }>(
        `SELECT product_key FROM billing.subscriptions WHERE id=$1`,
        [original.subscription_id],
      );
      await client.query(
        `UPDATE billing.subscriptions SET status='canceled', canceled_at=now(),
                cancel_at_period_end=false, updated_at=now()
          WHERE id=$1`,
        [original.subscription_id],
      );
      if (subscription.rows[0])
        await revokeUnspentPlanCreditsTx(
          client,
          original.billing_account_id,
          subscription.rows[0].product_key,
          original.subscription_id,
          "Full refund",
        );
    }
    await client.query(
      `INSERT INTO billing.provider_transactions(
         id, billing_account_id, provider, provider_transaction_id, reference,
         kind, status, amount_minor, currency, invoice_id, subscription_id, payload
       ) VALUES($1,$2,$3,$4,$5,'refund','succeeded',$6,$7,$8,$9,$10)
       ON CONFLICT (provider, provider_transaction_id) DO NOTHING`,
      [
        `ptx_${randomUUID()}`,
        original.billing_account_id,
        provider.name,
        `${provider.name}-refund-${event.transactionReference}`,
        event.transactionReference,
        total.toString(),
        original.currency,
        original.invoice_id,
        original.subscription_id,
        jsonStringify(event),
      ],
    );
    await bumpEntitlementRevision(client, original.billing_account_id);
  });
  return true;
}

export async function processProviderEvent(
  pool: Pool,
  config: BillingConfig,
  provider: BillingProvider,
  event: ProviderEvent,
): Promise<boolean> {
  switch (event.kind) {
    case "charge_succeeded": {
      const checkout = await pool.query<CheckoutRow>(
        `SELECT id, reference, idempotency_key, billing_account_id, plan_version_id,
                product_key, provider, status, authorization_url, return_url,
                expected_amount_minor::text, expected_currency, expected_tax_inclusive,
                expected_tax_rate_bps, provider_transaction_id, provider_response,
                completed_at, created_at, updated_at
           FROM billing.checkouts WHERE provider=$1 AND reference=$2`,
        [provider.name, event.reference],
      );
      if (checkout.rows[0]) {
        await activateCheckout(pool, config, provider, checkout.rows[0], {
          successful: true,
          reference: event.reference,
          amountMinor: event.amountMinor,
          currency: event.currency,
          customerId: event.customerId,
          providerCustomerId: null,
          subscriptionId: event.subscriptionId,
          providerTransactionId: event.transactionId,
          providerAuthorizationId: null,
        });
        return true;
      }
      return processRecurringCharge(pool, config, provider, event);
    }
    case "subscription_created": {
      const existing = await pool.query<{ id: string; billing_account_id: string }>(
        `SELECT s.id, s.billing_account_id
           FROM billing.subscriptions s
           JOIN billing.plan_versions v ON v.id=s.plan_version_id
          WHERE s.provider=$1 AND s.provider_customer_id=$2
            AND v.paystack_plan_code=$3
          ORDER BY s.created_at DESC LIMIT 1`,
        [provider.name, event.customerId, event.planCode],
      );
      if (!existing.rows[0]) {
        await recordIssue(pool, {
          billingAccountId: null,
          provider: provider.name,
          resourceType: "subscription",
          resourceId: event.subscriptionId,
          issueType: "unmatched_subscription_created",
          details: event,
        });
        return false;
      }
      await pool.query(
        `UPDATE billing.subscriptions
            SET provider_subscription_id=$2, status='active', updated_at=now()
          WHERE id=$1 AND (provider_subscription_id IS NULL OR provider_subscription_id LIKE $3)`,
        [existing.rows[0].id, event.subscriptionId, `${provider.name}-charge:%`],
      );
      await transaction(pool, (client) =>
        bumpEntitlementRevision(client, existing.rows[0]!.billing_account_id),
      );
      return true;
    }
    case "subscription_not_renewing":
      return updateSubscriptionState(
        pool,
        provider.name,
        event.subscriptionId,
        { cancelAtPeriodEnd: true },
      );
    case "subscription_disabled":
      return updateSubscriptionState(
        pool,
        provider.name,
        event.subscriptionId,
        { status: "canceled", cancelAtPeriodEnd: false, canceledAt: new Date() },
      );
    case "invoice_payment_failed":
      return updateSubscriptionState(pool, provider.name, event.subscriptionId, {
        status: "past_due",
        graceEndsAt: new Date(Date.now() + 7 * 86_400_000),
      });
    case "refund_processed":
      return processRefund(pool, provider, event);
    case "dispute_opened": {
      const charge = await pool.query<{ billing_account_id: string }>(
        `SELECT billing_account_id FROM billing.provider_transactions
          WHERE provider=$1 AND reference=$2 AND kind='charge'
          ORDER BY created_at DESC LIMIT 1`,
        [provider.name, event.transactionReference],
      );
      await recordIssue(pool, {
        billingAccountId: charge.rows[0]?.billing_account_id ?? null,
        provider: provider.name,
        resourceType: "transaction",
        resourceId: event.transactionReference,
        issueType: "dispute_opened",
        details: event,
      });
      return true;
    }
    case "ignored":
      return false;
  }
}

async function updateSubscriptionState(
  pool: Pool,
  provider: string,
  providerSubscriptionId: string,
  change: {
    status?: "active" | "past_due" | "canceled";
    cancelAtPeriodEnd?: boolean;
    canceledAt?: Date;
    graceEndsAt?: Date;
  },
): Promise<boolean> {
  const result = await pool.query(
    `UPDATE billing.subscriptions
        SET status=COALESCE($3,status),
            cancel_at_period_end=COALESCE($4,cancel_at_period_end),
            canceled_at=COALESCE($5,canceled_at),
            grace_ends_at=COALESCE($6,grace_ends_at),
            updated_at=now()
      WHERE provider=$1 AND provider_subscription_id=$2`,
    [
      provider,
      providerSubscriptionId,
      change.status ?? null,
      change.cancelAtPeriodEnd ?? null,
      change.canceledAt ?? null,
      change.graceEndsAt ?? null,
    ],
  );
  if ((result.rowCount ?? 0) > 0) {
    const account = await pool.query<{ billing_account_id: string }>(
      `SELECT billing_account_id FROM billing.subscriptions
        WHERE provider=$1 AND provider_subscription_id=$2`,
      [provider, providerSubscriptionId],
    );
    if (account.rows[0])
      await transaction(pool, (client) =>
        bumpEntitlementRevision(client, account.rows[0]!.billing_account_id),
      );
  }
  return (result.rowCount ?? 0) > 0;
}

export async function recordIssue(
  pool: Pool,
  input: {
    billingAccountId: string | null;
    provider: string;
    resourceType: string;
    resourceId: string;
    issueType: string;
    details: unknown;
  },
): Promise<void> {
  const fingerprint = `${input.provider}:${input.resourceType}:${input.resourceId}:${input.issueType}`;
  await pool.query(
    `INSERT INTO billing.reconciliation_issues(
       id, fingerprint, billing_account_id, provider, resource_type, resource_id,
       issue_type, details
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (fingerprint) DO UPDATE SET
       details=EXCLUDED.details, updated_at=now(),
       status=CASE WHEN billing.reconciliation_issues.status='resolved' THEN 'open' ELSE billing.reconciliation_issues.status END`,
    [
      `rci_${randomUUID()}`,
      fingerprint,
      input.billingAccountId,
      input.provider,
      input.resourceType,
      input.resourceId,
      input.issueType,
      jsonStringify(input.details ?? {}),
    ],
  );
}

export async function reconcileSubscription(
  pool: Pool,
  provider: BillingProvider,
  subscriptionId: string,
): Promise<{ updated: boolean; status: string }> {
  const subscription = await pool.query<SubscriptionRow>(
    `SELECT ${SUBSCRIPTION_COLUMNS} FROM billing.subscriptions WHERE id=$1`,
    [subscriptionId],
  );
  if (!subscription.rows[0]?.provider_subscription_id)
    return { updated: false, status: "unmanaged" };
  const current = subscription.rows[0];
  const verified = await provider.verifySubscription(
    current.provider_subscription_id!,
  );
  const normalized = internalState(verified.state);
  if (!normalized) {
    await recordIssue(pool, {
      billingAccountId: current.billing_account_id,
      provider: provider.name,
      resourceType: "subscription",
      resourceId: current.id,
      issueType: "unknown_provider_status",
      details: { state: verified.state },
    });
    return { updated: false, status: verified.state };
  }
  await transaction(pool, async (client) => {
    await client.query(
      `UPDATE billing.subscriptions
          SET status=$2, cancel_at_period_end=$3,
              current_period_start=COALESCE($4,current_period_start),
              current_period_end=COALESCE($5,current_period_end),
              updated_at=now()
        WHERE id=$1`,
      [
        current.id,
        normalized.status,
        normalized.cancelAtPeriodEnd,
        verified.currentPeriodStart,
        verified.currentPeriodEnd,
      ],
    );
    if (
      normalized.status !== current.status ||
      verified.currentPeriodEnd?.getTime() !== current.current_period_end?.getTime()
    )
      await recordIssue(pool, {
        billingAccountId: current.billing_account_id,
        provider: provider.name,
        resourceType: "subscription",
        resourceId: current.id,
        issueType: "state_mismatch",
        details: {
          internalStatus: current.status,
          providerState: verified.state,
          correctedStatus: normalized.status,
        },
      });
    await bumpEntitlementRevision(client, current.billing_account_id);
  });
  return { updated: true, status: normalized.status };
}

function internalState(
  state: string,
): { status: "active" | "past_due" | "canceled"; cancelAtPeriodEnd: boolean } | null {
  switch (state) {
    case "active":
      return { status: "active", cancelAtPeriodEnd: false };
    case "non-renewing":
      return { status: "active", cancelAtPeriodEnd: true };
    case "attention":
      return { status: "past_due", cancelAtPeriodEnd: false };
    case "completed":
    case "cancelled":
      return { status: "canceled", cancelAtPeriodEnd: false };
    default:
      return null;
  }
}

export async function expireTrialsAndGrace(
  pool: Pool,
  config: BillingConfig,
): Promise<{ trialsExpired: number; graceExpired: number }> {
  const trials = await pool.query<{ id: string; billing_account_id: string; product_key: BillingProduct }>(
    `SELECT id, billing_account_id, product_key FROM billing.subscriptions
      WHERE status='trialing' AND trial_ends_at IS NOT NULL AND trial_ends_at<=now()
      LIMIT 100`,
  );
  let trialsExpired = 0;
  for (const trial of trials.rows) {
    const freePlan = config.freePlans[trial.product_key];
    if (freePlan) {
      try {
        await assignPlan(pool, {
          accountId: trial.billing_account_id,
          planKey: freePlan,
          status: "active",
          reason: "Trial ended",
        });
      } catch {
        await transaction(pool, async (client) => {
          await client.query(
            `UPDATE billing.subscriptions SET status='canceled', canceled_at=now(), updated_at=now() WHERE id=$1`,
            [trial.id],
          );
          await bumpEntitlementRevision(client, trial.billing_account_id);
        });
      }
    } else {
      await transaction(pool, async (client) => {
        await client.query(
          `UPDATE billing.subscriptions SET status='canceled', canceled_at=now(), updated_at=now() WHERE id=$1`,
          [trial.id],
        );
        await bumpEntitlementRevision(client, trial.billing_account_id);
      });
    }
    trialsExpired++;
  }
  const grace = await pool.query<{ id: string; billing_account_id: string }>(
    `SELECT id, billing_account_id FROM billing.subscriptions
      WHERE status='past_due' AND grace_ends_at IS NOT NULL AND grace_ends_at<=now()
      LIMIT 100`,
  );
  let graceExpired = 0;
  for (const subscription of grace.rows) {
    await transaction(pool, async (client) => {
      await client.query(
        `UPDATE billing.subscriptions SET status='canceled', canceled_at=now(), updated_at=now() WHERE id=$1`,
        [subscription.id],
      );
      await bumpEntitlementRevision(client, subscription.billing_account_id);
    });
    graceExpired++;
  }
  return { trialsExpired, graceExpired };
}

export async function checkoutForAccount(
  pool: Pool,
  accountId: string,
  product: BillingProduct,
  reference: string,
): Promise<CheckoutRow> {
  const result = await pool.query<CheckoutRow>(
    `SELECT id, reference, idempotency_key, billing_account_id, plan_version_id,
            product_key, provider, status, authorization_url, return_url,
            expected_amount_minor::text, expected_currency, expected_tax_inclusive,
            expected_tax_rate_bps, provider_transaction_id, provider_response,
            completed_at, created_at, updated_at
       FROM billing.checkouts
      WHERE reference=$1 AND billing_account_id=$2 AND product_key=$3`,
    [reference, accountId, product],
  );
  if (!result.rows[0]) missing("Checkout not found");
  return result.rows[0];
}
