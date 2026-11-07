import { NextResponse } from "next/server";
import { getAdminSession } from "@/lib/admin-auth";
import { billingJson } from "@/lib/billing-api";

export async function GET(req: Request) {
  const actor = await getAdminSession();
  if (!actor) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const days = Math.min(366, Math.max(1, Number(new URL(req.url).searchParams.get("days") ?? 30)));
  const end = new Date();
  const start = new Date(end.getTime() - (days - 1) * 86_400_000);
  try {
    const metrics = await billingJson<{
      subscriptions: Array<{
        product_key: string;
        active: string;
        trialing: string;
        past_due: string;
        mrr_minor: string;
      }>;
      openIssues: number;
      creditBalance: string;
    }>(actor, "GET", "/admin/metrics");
    const sum = (field: "active" | "trialing" | "past_due" | "mrr_minor") =>
      metrics.subscriptions.reduce((total, row) => total + Number(row[field] ?? 0), 0);
    return NextResponse.json({
      range: { start: start.toISOString(), end: end.toISOString(), days, interval: "day" },
      source: "central_billing",
      timezone: "UTC",
      dataAsOf: new Date().toISOString(),
      coverage: [
        { key: "subscriptions", label: "Subscriptions", status: "available", detail: "Central billing subscription state" },
        { key: "invoices", label: "Invoices", status: "partial", detail: "Totals are not aggregated by this endpoint yet" },
        { key: "payments", label: "Paystack payments", status: "partial", detail: "Provider outcomes are retained in the billing audit trail" },
        { key: "credits", label: "Credit lifecycle", status: "partial", detail: `Current balance ${metrics.creditBalance}` },
      ],
      kpis: {
        collectedRevenueMinor: 0,
        refundsMinor: 0,
        monthlyRecurringRevenueMinor: sum("mrr_minor"),
        paidInvoices: 0,
        failedPayments: 0,
        activeSubscriptions: sum("active"),
        trials: sum("trialing"),
        pastDueSubscriptions: sum("past_due"),
        newSubscriptions: 0,
        cancellations: 0,
      },
      daily: [],
      planMix: metrics.subscriptions.map((row) => ({
        product: row.product_key,
        plan: "current",
        subscriptions: Number(row.active) + Number(row.trialing) + Number(row.past_due),
      })),
      paymentOutcomes: [],
      invoiceStatus: [],
      subscriptionStatus: metrics.subscriptions.map((row) => ({
        key: row.product_key,
        label: row.product_key,
        value: Number(row.active) + Number(row.trialing) + Number(row.past_due),
      })),
      creditLifecycle: [],
      openIssues: metrics.openIssues,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Revenue analytics are unavailable" },
      { status: 503 },
    );
  }
}
