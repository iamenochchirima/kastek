import { fetchCoreJson } from "@/lib/core-server-api";

export type ProductAccess = {
  key: string;
  name: string;
  description: string | null;
  hasAccess: boolean;
  state: "enabled" | "upgrade_required";
  planKey: string | null;
  planName: string | null;
  subscriptionStatus: string | null;
  subscriptionId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  usage: Record<string, number>;
  limits: Record<string, number>;
};

export type CapabilityKey =
  | "feature.agents.manage"
  | "feature.campaigns.manage"
  | "feature.campaigns.send"
  | "feature.contacts.access"
  | "feature.templates.manage"
  | "feature.content.manage"
  | "feature.content.publish"
  | "feature.analytics.view"
  | "feature.inbox.access";

export type CapabilityAccess = {
  key: CapabilityKey;
  name: string;
  description: string;
  enabled: boolean;
};

export type MeterUsage = {
  key: string;
  name: string;
  description: string;
  used: number;
  limit: number | null;
};

export type ManualGrant = {
  id: string;
  orgId: string;
  key: string;
  value: unknown;
  startsAt: string;
  endsAt: string | null;
  reason: string | null;
  createdById: string | null;
};

export type BillingSummary = {
  orgId: string;
  features: CapabilityAccess[];
  meters: MeterUsage[];
  /** @deprecated Checkout/subscription compatibility only. Do not use for feature guards. */
  products: ProductAccess[];
  manualGrants: ManualGrant[];
  payments: PaymentHistoryItem[];
  invoices: BillingInvoiceItem[];
};

export type PaymentHistoryItem = {
  reference: string;
  productName: string;
  planName: string;
  status: string;
  currency: string;
  amountMinor: number | null;
  completedAt: string | null;
  createdAt: string;
};

export type BillingInvoiceItem = {
  invoiceNumber: string;
  productName: string;
  planName: string;
  status: string;
  currency: string;
  amountMinor: number | null;
  issuedAt: string;
  paidAt: string | null;
};

export type AvailablePlan = {
  key: string;
  productKey: string;
  name: string;
  description: string | null;
  interval: "MONTHLY";
  currency: string;
  amountMinor: number | null;
  creditsPerPeriod: number | null;
  checkoutReady: boolean;
  highlights: string[];
  entitlements: PlanEntitlement[];
};

export type PlanEntitlement = {
  key: string;
  name: string;
  description: string | null;
  kind: "feature" | "limit";
  value: unknown;
  unit: string | null;
  displayGroup: string | null;
  displayOrder: number;
  metadata: Record<string, unknown>;
};

export type AvailablePlanDetails = AvailablePlan & {
  entitlements: PlanEntitlement[];
};

export type CreditGrant = {
  id: string;
  source: string;
  amount: number;
  remainingAmount: number;
  startsAt: string;
  endsAt: string | null;
  reason: string | null;
  reference: string | null;
};

export type CreditLedgerEntry = {
  id: string;
  entryType: string;
  amount: number;
  balanceAfter: number;
  actionKey: string | null;
  sourceType: string | null;
  sourceId: string | null;
  pricingVersion: string | null;
  createdByAdminId: string | null;
  createdAt: string;
};

export type CreditAccount = {
  orgId: string;
  balance: number;
  reservedBalance: number;
  availableBalance: number;
  grants: CreditGrant[];
  ledger: CreditLedgerEntry[];
};

export type CreditUsageEvent = {
  id: string;
  actionKey: string;
  quantity: number;
  creditsCharged: number;
  status: string;
  provider: string | null;
  model: string | null;
  fundingSource: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  pricingVersion: string | null;
  createdAt: string;
};

export type BillingTrial = {
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
};

export type BillingCredits = {
  account: CreditAccount;
  usage: CreditUsageEvent[];
};

export type BillingUsageDay = {
  date: string;
  creditsUsed: number;
  operations: number;
};

export type BillingUsageBreakdown = {
  key: string;
  creditsUsed: number;
  operations: number;
};

export type BillingModelUsage = {
  provider: string;
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  creditsUsed: number;
};

export type BillingUsage = {
  rangeStart: string;
  rangeEnd: string;
  timezone: string;
  granularity: "day" | "week" | string;
  daily: BillingUsageDay[];
  previousDaily: BillingUsageDay[];
  credits: {
    used: number;
    balance: number;
    reserved: number;
    available: number;
  };
  operations: number;
  breakdown: BillingUsageBreakdown[];
  models: BillingModelUsage[];
  meters: MeterUsage[];
  recent: CreditUsageEvent[];
};

export function fetchBillingSummary() {
  return fetchCoreJson<BillingSummary>("/api/billing/summary");
}

export function planAllowsAnalytics(summary: BillingSummary | null): boolean {
  return (
    summary?.features.find((feature) => feature.key === "feature.analytics.view")
      ?.enabled !== false
  );
}

export function fetchBillingPlans() {
  return fetchCoreJson<{ plans: AvailablePlan[] }>("/api/billing/plans");
}

export function fetchBillingTrial() {
  return fetchCoreJson<BillingTrial>("/api/billing/trial");
}

export function startBillingTrial() {
  return fetchCoreJson<{ started: boolean; subscription: Record<string, unknown> }>(
    "/api/billing/trial",
    { method: "POST" },
  );
}

export function fetchBillingPlanDetails(planKey: string) {
  return fetchCoreJson<AvailablePlanDetails>(`/api/billing/plans/${encodeURIComponent(planKey)}`);
}

export function fetchBillingCredits() {
  return fetchCoreJson<BillingCredits>("/api/billing/credits");
}

export function fetchBillingUsage(range: "7d" | "30d" | "90d" = "30d") {
  return fetchCoreJson<BillingUsage>(`/api/billing/usage?range=${range}`);
}
