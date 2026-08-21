import { Badge } from "@/components/ui/badge";
import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { PaymentReturnStatus } from "@/components/dashboard/billing/payment-return-status";
import { SubscriptionActionButton } from "@/components/dashboard/billing/subscription-action-button";
import { fetchBillingPlans, fetchBillingSummary, type ProductAccess } from "@/lib/billing";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { MotionReveal } from "@/components/ui/motion-reveal";

export const metadata = {
  title: "Billing and Usage | KasiTek",
};

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
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency }).format(amountMinor / 100);
}

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" }) : null;
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ payment?: string; reference?: string; trxref?: string }>;
}) {
  const session = await getRustSession();
  if (!session?.user?.id) redirect("/login");

  const [summary, planResponse, query] = await Promise.all([
    fetchBillingSummary().catch(() => null),
    fetchBillingPlans().catch(() => ({ plans: [] })),
    searchParams,
  ]);

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1440px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Billing and usage</PageHeaderTitle>
            <PageHeaderDescription>Plan, usage, and payments.</PageHeaderDescription>
          </PageHeaderContent>
        </PageHeader>

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
          <MotionReveal><section className="rounded-xl border border-border bg-card p-5">
            <div>
              <h2 className="text-lg font-semibold text-foreground">Workspace features</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Access is resolved from your current plan and any temporary workspace grants.
              </p>
            </div>
            <div className="mt-5 grid gap-3 md:grid-cols-2">
              {(summary.features ?? []).map((feature) => (
                <div key={feature.key} className="flex items-start justify-between gap-4 rounded-lg border border-border bg-secondary/30 p-4">
                  <div>
                    <p className="font-medium text-foreground">{feature.name}</p>
                    <p className="mt-1 text-sm text-muted-foreground">{feature.description}</p>
                  </div>
                  <Badge
                    className={
                      feature.enabled
                        ? "shrink-0 border-primary/30 bg-primary/10 text-primary"
                        : "shrink-0 border-border bg-secondary text-muted-foreground"
                    }
                  >
                    {feature.enabled ? "Included" : "Not included"}
                  </Badge>
                </div>
              ))}
            </div>
          </section></MotionReveal>
        )}

        {summary?.products.some((product) => product.subscriptionId) ? (
          <MotionReveal delay={0.08}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Current subscription</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {summary.products.filter((product) => product.subscriptionId).map((product) => (
                <article key={product.key} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="font-medium text-foreground">{product.planName ?? product.name}</p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {product.currentPeriodEnd
                          ? `${product.cancelAtPeriodEnd ? "Access ends" : "Renews"} ${formatDate(product.currentPeriodEnd)}`
                          : "No renewal date is recorded"}
                      </p>
                    </div>
                    <Badge>{productStateLabel(product)}</Badge>
                  </div>
                  {product.subscriptionId && ["ACTIVE", "GRACE"].includes(product.subscriptionStatus ?? "") ? (
                    <SubscriptionActionButton subscriptionId={product.subscriptionId} cancelAtPeriodEnd={product.cancelAtPeriodEnd} />
                  ) : null}
                </article>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}

        {summary ? (
          <MotionReveal delay={0.16}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Current month usage</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Usage meters are independent of plan names and reset at the start of each month.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {(summary.meters ?? []).map((meter) => (
                <div key={meter.key} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <p className="font-medium text-foreground">{meter.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">{meter.description}</p>
                  <p className="mt-4 text-2xl font-semibold text-foreground">
                    {meter.used}
                    <span className="text-sm font-normal text-muted-foreground">
                      {meter.limit === null ? " used" : ` / ${meter.limit}`}
                    </span>
                  </p>
                </div>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}

        {planResponse.plans.length ? (
          <MotionReveal delay={0.24}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Available plans</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Choose the workspace plan that matches the features and limits your team needs.
            </p>
            <div className="mt-4 grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {planResponse.plans.map((plan) => (
                <div key={plan.key} className="rounded-lg border border-border bg-secondary/30 p-4">
                  <p className="font-medium text-foreground">{plan.name}</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {formatPrice(plan.amountMinor, plan.currency)} / {plan.interval === "YEARLY" ? "year" : "month"}
                  </p>
                  <CheckoutButton planKey={plan.key} disabled={!plan.checkoutReady} />
                </div>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}

        {summary?.manualGrants.length ? (
          <MotionReveal delay={0.32}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Manual access</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Temporary or internal access granted outside a paid subscription.
            </p>
            <div className="mt-4 divide-y divide-border">
              {summary.manualGrants.map((grant) => (
                <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{grant.key}</p>
                    <p className="text-muted-foreground">{grant.reason ?? "No reason recorded"}</p>
                  </div>
                  <span className="text-muted-foreground">
                    {grant.endsAt ? `Expires ${new Date(grant.endsAt).toLocaleDateString("en-ZA")}` : "No expiry"}
                  </span>
                </div>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}

        {summary?.payments.length ? (
          <MotionReveal delay={0.4}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Payment history</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Checkout records confirmed by the billing server.
            </p>
            <div className="mt-4 divide-y divide-border">
              {summary.payments.map((payment) => (
                <div key={payment.reference} className="flex flex-wrap items-center justify-between gap-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{payment.productName} · {payment.planName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{payment.reference}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-foreground">{formatPrice(payment.amountMinor, payment.currency)}</p>
                    <p className="text-muted-foreground">{payment.status.replaceAll("_", " ").toLowerCase()} · {formatDate(payment.completedAt ?? payment.createdAt)}</p>
                  </div>
                </div>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}

        {summary?.invoices.length ? (
          <MotionReveal delay={0.48}><section className="rounded-xl border border-border bg-card p-5">
            <h2 className="text-lg font-semibold text-foreground">Invoices</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Billing documents created after a payment has been verified by the billing server.
            </p>
            <div className="mt-4 divide-y divide-border">
              {summary.invoices.map((invoice) => (
                <div key={invoice.invoiceNumber} className="flex flex-wrap items-center justify-between gap-4 py-3 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{invoice.productName} · {invoice.planName}</p>
                    <p className="font-mono text-xs text-muted-foreground">{invoice.invoiceNumber}</p>
                  </div>
                  <div className="text-right">
                    <p className="font-medium text-foreground">{formatPrice(invoice.amountMinor, invoice.currency)}</p>
                    <p className="text-muted-foreground">
                      {invoice.status.replaceAll("_", " ").toLowerCase()} · issued {formatDate(invoice.issuedAt)}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </section></MotionReveal>
        ) : null}
      </div>
    </div>
  );
}
