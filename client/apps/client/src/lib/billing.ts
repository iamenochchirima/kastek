import { fetchRustJson } from "@/lib/rust-server-api";

export type ProductAccess = {
  key: string;
  name: string;
  description: string | null;
  hasAccess: boolean;
  state: "enabled" | "upgrade_required";
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
  interval: "MONTHLY" | "YEARLY";
  currency: string;
  amountMinor: number | null;
  checkoutReady: boolean;
};

export function fetchBillingSummary() {
  return fetchRustJson<BillingSummary>("/api/billing/summary");
}

export function fetchBillingPlans() {
  return fetchRustJson<{ plans: AvailablePlan[] }>("/api/billing/plans");
}
