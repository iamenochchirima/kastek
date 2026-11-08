// Central billing contracts shared by Growth, Agents, Agency, and the billing
// service. Money is always a decimal string in minor units so JavaScript
// consumers never lose integer precision through JSON.
export type BillingProduct = "growth" | "agents" | "agency";
export type BillingSubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "grace"
  | "canceled"
  | "incomplete";
export type BillingAccessState =
  | "active"
  | "trialing"
  | "grace"
  | "read_only"
  | "none";
export type BillingPlanInterval = "monthly";
export type BillingInvoiceStatus =
  | "draft"
  | "open"
  | "paid"
  | "void"
  | "refunded"
  | "partially_refunded";

export interface BillingPlanSummary {
  key: string;
  name: string;
  description: string | null;
  product: BillingProduct;
  version: number;
  versionId: string;
  status: "draft" | "scheduled" | "active" | "retired";
  interval: BillingPlanInterval;
  currency: string;
  amountMinor: string;
  taxInclusive: boolean;
  taxRateBps: number;
  grossAmountMinor: string;
  creditsPerPeriod: string | null;
  checkoutReady: boolean;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  notes: string | null;
  entitlements: Array<{
    key: string;
    value: unknown;
    kind: "feature" | "limit" | "meter";
    name: string;
    description: string | null;
    unit: string | null;
    metadata: Record<string, unknown>;
    implementationStatus: "implemented" | "product_pending" | "display_only";
    visibleToCustomer: boolean;
    displayGroup: string | null;
    displayOrder: number;
  }>;
}

export interface BillingSubscriptionSummary {
  id: string;
  product: BillingProduct;
  planKey: string;
  planName: string;
  planVersion: number;
  status: BillingSubscriptionStatus;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  graceEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string | null;
}

export interface BillingCreditSummary {
  balance: string;
  reserved: string;
  available: string;
  currency: string;
}

export interface BillingEntitlementSnapshot {
  version: 1;
  accountId: string;
  product: BillingProduct;
  tenantId: string;
  revision: string;
  access: BillingAccessState;
  plan: {
    key: string;
    name: string;
    version: number;
  } | null;
  subscription: BillingSubscriptionSummary | null;
  features: Record<string, boolean>;
  limits: Record<string, string | number | null>;
  meters: Record<string, { used: string; limit: string | null }>;
  credits: BillingCreditSummary;
  issuedAt: string;
  expiresAt: string;
}

export interface BillingAccountEnsureInput {
  product: BillingProduct;
  tenantId: string;
  name: string;
  billingEmail: string;
  /** Shared OIDC issuer and subject for the workspace owner. */
  ownerIssuer?: string | null;
  ownerSubject?: string | null;
  currency?: string;
  metadata?: Record<string, unknown>;
}

export interface BillingAccountEnsureResult {
  accountId: string;
  product: BillingProduct;
  tenantId: string;
  revision: string;
}

export interface BillingUsageEventInput {
  product: BillingProduct;
  tenantId: string;
  meterKey: string;
  quantity: string;
  occurredAt?: string;
  sourceType?: string | null;
  sourceId?: string | null;
  idempotencyKey: string;
  providerCostMinor?: string | null;
  currency?: string | null;
  metadata?: Record<string, unknown>;
}

export interface BillingUsageEventResult {
  accepted: boolean;
  duplicate: boolean;
  creditsCharged: string;
  balance: string;
  shortfall: string;
}

export interface BillingCheckoutInput {
  product: BillingProduct;
  tenantId: string;
  planKey: string;
  email: string;
  idempotencyKey: string;
  returnUrl: string;
}

export interface BillingCheckoutResult {
  reference: string;
  authorizationUrl: string;
  planKey: string;
  reused: boolean;
}

export interface BillingCheckoutVerification {
  reference: string;
  status: "completed" | "pending" | "failed";
  subscriptionId: string | null;
  invoiceId: string | null;
}

export interface BillingInvoiceLine {
  id: string;
  description: string;
  quantity: number;
  unitAmountMinor: string;
  amountMinor: string;
  product: BillingProduct | null;
  planKey: string | null;
}

export interface BillingInvoiceSummary {
  id: string;
  invoiceNumber: string;
  status: BillingInvoiceStatus;
  currency: string;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  taxRateBps: number;
  taxInclusive: boolean;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string;
  paidAt: string | null;
  lines: BillingInvoiceLine[];
}

// The payload is signed by the billing service. Products verify it with the
// shared snapshot secret before trusting a cached entitlement projection.
export interface SignedBillingSnapshot {
  payload: string;
  signature: string;
}
