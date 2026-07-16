import { Badge } from "@/components/ui/badge";
import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { PaymentReturnStatus } from "@/components/dashboard/billing/payment-return-status";
import { SubscriptionActionButton } from "@/components/dashboard/billing/subscription-action-button";
import { fetchBillingPlans, fetchBillingSummary, type ProductAccess } from "@/lib/billing";
import { getRustSession } from "@/lib/rust-auth";
import { redirect } from "next/navigation";

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
    <div className="min-h-screen p-6 lg:p-8">
      <div className="mx-auto max-w-[1200px] space-y-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Billing and usage</h1>
          <p className="mt-2 max-w-2xl text-muted-foreground">
            Review the products enabled for this workspace, their current access state, and the
            usage that will apply to future plans.
          </p>
        </div>

        {query.payment === "complete" && (query.reference || query.trxref) ? (
          <PaymentReturnStatus reference={query.reference || query.trxref || ""} />
        ) : query.payment === "complete" ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
            Paystack returned without a transaction reference. No product access was changed.
          </div>
        ) : null}

        {!summary ? (
          <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-5 text-sm text-destructive">
            Billing information is unavailable right now. No product access has been changed.
          </div>
        ) : (
          <section className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {summary.products.map((product) => {
              const plans = planResponse.plans.filter((plan) => plan.productKey === product.key);
              return (
              <article key={product.key} className="rounded-xl border border-border bg-card p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold text-foreground">{product.name}</h2>
                    {product.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">{product.description}</p>
                    ) : null}
                  </div>
                  <Badge
                    className={
                      product.hasAccess
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : "border-border bg-secondary text-muted-foreground"
                    }
                  >
                    {productStateLabel(product)}
                  </Badge>
                </div>

                <div className="mt-5 space-y-2 border-t border-border pt-4 text-sm">
                  <p className="text-muted-foreground">
                    Plan: <span className="text-foreground">{product.planName ?? "Not enabled"}</span>
                  </p>
                  {product.trialEndsAt ? (
                    <p className="text-muted-foreground">Trial ends: <span className="text-foreground">{formatDate(product.trialEndsAt)}</span></p>
                  ) : product.currentPeriodEnd ? (
                    <p className="text-muted-foreground">
                      {product.cancelAtPeriodEnd ? "Access ends" : "Current period"}: <span className="text-foreground">
                        {formatDate(product.currentPeriodStart) ?? "Started"} to {formatDate(product.currentPeriodEnd)}
                      </span>
                    </p>
                  ) : null}
                  {Object.keys(product.usage).length > 0 ? (
                    <div className="space-y-1 text-muted-foreground">
                      <p className="text-foreground">Current month usage</p>
                      {Object.entries(product.usage).map(([metric, quantity]) => (
                        <p key={metric}>
                          {metric}: {quantity}
                          {product.limits[metric] !== undefined ? ` / ${product.limits[metric]}` : ""}
                        </p>
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground">Usage metering has not started for this product.</p>
                  )}
                </div>

                {!product.hasAccess ? (
                  <div className="mt-5 space-y-3">
                    {plans.length ? plans.map((plan) => (
                      <div key={plan.key} className="rounded-lg border border-border bg-secondary/40 p-3">
                        <div className="flex items-baseline justify-between gap-3">
                          <span className="font-medium text-foreground">{plan.name}</span>
                          <span className="text-sm text-muted-foreground">
                            {formatPrice(plan.amountMinor, plan.currency)} / {plan.interval === "YEARLY" ? "year" : "month"}
                          </span>
                        </div>
                        <CheckoutButton planKey={plan.key} disabled={!plan.checkoutReady} />
                      </div>
                    )) : (
                      <p className="rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-muted-foreground">
                        No active plans are available for this product yet.
                      </p>
                    )}
                  </div>
                ) : null}
                {product.subscriptionId && ["ACTIVE", "GRACE"].includes(product.subscriptionStatus ?? "") ? (
                  <SubscriptionActionButton subscriptionId={product.subscriptionId} cancelAtPeriodEnd={product.cancelAtPeriodEnd} />
                ) : null}
              </article>
              );
            })}
          </section>
        )}

        {summary?.manualGrants.length ? (
          <section className="rounded-xl border border-border bg-card p-5">
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
          </section>
        ) : null}

        {summary?.payments.length ? (
          <section className="rounded-xl border border-border bg-card p-5">
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
          </section>
        ) : null}
      </div>
    </div>
  );
}
