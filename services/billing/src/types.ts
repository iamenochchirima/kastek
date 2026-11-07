import type { BillingProduct, BillingSubscriptionStatus } from "@kasitek-labs/contracts";

export interface CheckoutRow {
  id: string;
  reference: string;
  idempotency_key: string;
  billing_account_id: string;
  plan_version_id: string;
  product_key: BillingProduct;
  provider: string;
  status: string;
  authorization_url: string | null;
  return_url: string | null;
  expected_amount_minor: string;
  expected_currency: string;
  expected_tax_inclusive: boolean;
  expected_tax_rate_bps: number;
  provider_transaction_id: string | null;
  provider_response: unknown;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface SubscriptionRow {
  id: string;
  billing_account_id: string;
  plan_version_id: string;
  product_key: BillingProduct;
  status: BillingSubscriptionStatus;
  provider: string | null;
  provider_customer_id: string | null;
  provider_subscription_id: string | null;
  current_period_start: Date | null;
  current_period_end: Date | null;
  trial_ends_at: Date | null;
  grace_ends_at: Date | null;
  cancel_at_period_end: boolean;
  canceled_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export const CHECKOUT_COLUMNS = `id, reference, idempotency_key, billing_account_id,
  plan_version_id, product_key, provider, status, authorization_url, return_url,
  expected_amount_minor::text, expected_currency, expected_tax_inclusive,
  expected_tax_rate_bps, provider_transaction_id, provider_response,
  completed_at, created_at, updated_at`;

export const SUBSCRIPTION_COLUMNS = `id, billing_account_id, plan_version_id,
  product_key, status, provider, provider_customer_id, provider_subscription_id,
  current_period_start, current_period_end, trial_ends_at, grace_ends_at,
  cancel_at_period_end, canceled_at, created_at, updated_at`;
