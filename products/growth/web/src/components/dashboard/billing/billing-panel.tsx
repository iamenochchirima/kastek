"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PaymentReturnStatus } from "@/components/dashboard/billing/payment-return-status";
import { ReferralRewardsCard } from "@/components/dashboard/billing/referral-rewards-card";
import { SubscriptionActionButton } from "@/components/dashboard/billing/subscription-action-button";
import type { AvailablePlan, BillingCredits, BillingSummary, ProductAccess } from "@/lib/billing";
import { PageHeader, PageHeaderContent, PageHeaderDescription, PageHeaderTitle } from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";
import Link from "next/link";

function productStateLabel(product: ProductAccess) {
  if (product.subscriptionStatus === "TRIAL") return "Trial";
  if (product.subscriptionStatus === "GRACE") return "Grace period";
  if (product.subscriptionStatus === "PAST_DUE") return "Payment required";
  if (product.subscriptionStatus === "SUSPENDED") return "Suspended";
  if (product.subscriptionStatus === "CANCELLED") return "Cancelled";
  if (!product.hasAccess) return "Upgrade required";
  if (product.cancelAtPeriodEnd) return "Cancels at period end";
  return "Active";
}

function formatPrice(amountMinor: number | null, currency: string) {
  if (amountMinor === null) return "Contact sales";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency, maximumFractionDigits: 0 }).format(amountMinor / 100);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" }) : null;
}

function formatStatus(value: string) {
  return value.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

function matchingPlan(plans: AvailablePlan[], product: ProductAccess) {
  return plans.find((plan) => plan.name === product.planName);
}

export function BillingPanel({
  summary,
  planResponse,
  billingCredits,
  query,
  embedded = false,
}: {
  summary: BillingSummary | null;
  planResponse: { plans: AvailablePlan[] };
  billingCredits: BillingCredits | null;
  query: { payment?: string; reference?: string; trxref?: string };
  embedded?: boolean;
}) {
  const subscriptions = summary?.products.filter((product) => product.subscriptionId) ?? [];

  return (
    <div className={embedded ? "space-y-5" : "min-h-[100dvh] p-4 sm:p-6"}>
      <div className={embedded ? "space-y-5" : "mx-auto max-w-[1080px] space-y-6"}>
        {!embedded ? (
          <PageHeader>
            <PageHeaderContent>
              <PageHeaderTitle>Billing</PageHeaderTitle>
              <PageHeaderDescription>Plans, payments, and invoices.</PageHeaderDescription>
            </PageHeaderContent>
          </PageHeader>
        ) : null}

        {query.payment === "complete" && (query.reference || query.trxref) ? (
          <MotionReveal><PaymentReturnStatus reference={query.reference || query.trxref || ""} /></MotionReveal>
        ) : query.payment === "complete" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Paystack returned without a transaction reference. No workspace access was changed.
          </div>
        ) : null}

        {!summary ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
            Billing information is unavailable right now. No workspace access has been changed.
          </div>
        ) : (
          <>
            <MotionReveal>
              <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
                <div className="border-b border-border bg-gradient-to-br from-primary/[0.13] via-card to-card p-5 sm:p-7">
                  <div className="flex flex-col gap-6 sm:flex-row sm:items-end sm:justify-between">
                    <div>
                      <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">Current plan</p>
                      {subscriptions.length ? (
                        <div className="mt-2 flex flex-wrap items-center gap-3">
                          <h2 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">
                            {subscriptions[0].planName ?? subscriptions[0].name}
                          </h2>
                          <Badge>{productStateLabel(subscriptions[0])}</Badge>
                        </div>
                      ) : (
                        <h2 className="mt-2 text-2xl font-semibold tracking-[-0.03em] text-foreground">Free workspace</h2>
                      )}
                      <p className="mt-2 max-w-xl text-sm text-muted-foreground">
                        {subscriptions.length
                          ? subscriptions[0].cancelAtPeriodEnd
                            ? `Access ends ${formatDate(subscriptions[0].currentPeriodEnd) ?? "at the end of the billing period"}.`
                            : `Renews ${formatDate(subscriptions[0].currentPeriodEnd) ?? "at the end of the billing period"}.`
                          : "Choose a plan when your workspace needs more credits."}
                      </p>
                    </div>
                    <Button asChild><Link href="/upgrade">Change plan</Link></Button>
                  </div>
                </div>

                {subscriptions.length ? (
                  <div className="grid gap-3 p-5 sm:grid-cols-3 sm:p-7">
                    {subscriptions.map((product) => {
                      const plan = matchingPlan(planResponse.plans, product);
                      return (
                        <div key={product.key} className="rounded-xl border border-border bg-secondary/20 p-4">
                          <p className="text-xs text-muted-foreground">Plan price</p>
                          <p className="mt-1 text-lg font-semibold text-foreground">
                            {plan ? formatPrice(plan.amountMinor, plan.currency) : "—"}
                            <span className="ml-1 text-xs font-normal text-muted-foreground">/ {plan?.interval === "YEARLY" ? "year" : "month"}</span>
                          </p>
                        </div>
                      );
                    })}
                    <div className="rounded-xl border border-border bg-secondary/20 p-4">
                      <p className="text-xs text-muted-foreground">Billing status</p>
                      <p className="mt-1 text-lg font-semibold text-foreground">{formatStatus(subscriptions[0].subscriptionStatus ?? "ACTIVE")}</p>
                    </div>
                    <div className="rounded-xl border border-border bg-secondary/20 p-4">
                      <p className="text-xs text-muted-foreground">Next date</p>
                      <p className="mt-1 text-lg font-semibold text-foreground">{formatDate(subscriptions[0].currentPeriodEnd) ?? "—"}</p>
                    </div>
                  </div>
                ) : null}
              </section>
            </MotionReveal>

            {subscriptions.some((product) => ["ACTIVE", "GRACE"].includes(product.subscriptionStatus ?? "")) ? (
              <MotionReveal delay={0.06}>
                <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
                  <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-foreground">Subscription settings</h2>
                      <p className="mt-1 text-sm text-muted-foreground">Manage renewal for your active workspace plan.</p>
                    </div>
                    {subscriptions.filter((product) => ["ACTIVE", "GRACE"].includes(product.subscriptionStatus ?? "")).map((product) => (
                      <SubscriptionActionButton key={product.subscriptionId} subscriptionId={product.subscriptionId!} cancelAtPeriodEnd={product.cancelAtPeriodEnd} />
                    ))}
                  </div>
                </section>
              </MotionReveal>
            ) : null}

            <MotionReveal delay={0.1}>
              <ReferralRewardsCard referral={billingCredits?.referral ?? null} />
            </MotionReveal>

            <MotionReveal delay={0.12}>
              <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-foreground">Invoices</h2>
                    <p className="mt-1 text-sm text-muted-foreground">Your billing documents.</p>
                  </div>
                  <span className="text-xs text-muted-foreground">{summary.invoices.length} total</span>
                </div>
                {summary.invoices.length ? (
                  <div className="mt-5 overflow-x-auto">
                    <table className="w-full min-w-[620px] text-left text-sm">
                      <thead className="border-b border-border text-xs text-muted-foreground">
                        <tr>
                          <th className="pb-3 font-medium">Invoice</th>
                          <th className="pb-3 font-medium">Plan</th>
                          <th className="pb-3 font-medium">Date</th>
                          <th className="pb-3 text-right font-medium">Amount</th>
                          <th className="pb-3 text-right font-medium">Status</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {summary.invoices.map((invoice) => (
                          <tr key={invoice.invoiceNumber}>
                            <td className="py-4 font-mono text-xs text-foreground">{invoice.invoiceNumber}</td>
                            <td className="py-4 text-muted-foreground">{invoice.planName}</td>
                            <td className="py-4 text-muted-foreground">{formatDate(invoice.issuedAt) ?? "—"}</td>
                            <td className="py-4 text-right font-medium text-foreground">{formatPrice(invoice.amountMinor, invoice.currency)}</td>
                            <td className="py-4 text-right"><Badge variant="outline">{formatStatus(invoice.status)}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="mt-5 rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">No invoices yet</p>
                )}
              </section>
            </MotionReveal>

            {summary.payments.length ? (
              <MotionReveal delay={0.18}>
                <section className="rounded-2xl border border-border bg-card p-5 shadow-[var(--shadow-panel)] sm:p-7">
                  <h2 className="text-base font-semibold text-foreground">Payment activity</h2>
                  <div className="mt-4 divide-y divide-border">
                    {summary.payments.map((payment) => (
                      <div key={payment.reference} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-center sm:justify-between">
                        <div>
                          <p className="text-sm font-medium text-foreground">{payment.planName}</p>
                          <p className="mt-1 font-mono text-xs text-muted-foreground">{payment.reference}</p>
                        </div>
                        <div className="text-left sm:text-right">
                          <p className="text-sm font-medium text-foreground">{formatPrice(payment.amountMinor, payment.currency)}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{formatStatus(payment.status)} · {formatDate(payment.completedAt ?? payment.createdAt) ?? "—"}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>
              </MotionReveal>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
