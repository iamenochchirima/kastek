import { fetchRustJson } from "@/lib/rust-server-api";

export type ProductAccess = {
  key: string;
  name: string;
  description: string | null;
  hasAccess: boolean;
  state: "enabled" | "upgrade_required";
  planName: string | null;
  subscriptionStatus: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  cancelAtPeriodEnd: boolean;
  usage: Record<string, number>;
};

export type BillingSummary = {
  orgId: string;
  products: ProductAccess[];
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
