import { Link } from "react-router";
import { ArrowLeft, Check, Gauge } from "lucide-react";

import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { AvailablePlanDetails } from "@/lib/billing";

function formatPrice(amountMinor: number | null, currency: string) {
  if (amountMinor === null) return "Contact sales";
  return new Intl.NumberFormat("en-ZA", { style: "currency", currency, minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amountMinor / 100);
}

function entitlementNumber(value: unknown) {
  return typeof value === "number" ? value.toLocaleString() : null;
}

export function PlanDetailsPage({ details }: { details: AvailablePlanDetails }) {
  const features = details.entitlements.filter((item) => item.kind === "feature" && item.value === true);
  const limits = details.entitlements.filter((item) => item.kind === "limit");

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[980px] space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Button asChild variant="outline" size="sm"><Link to="/upgrade"><ArrowLeft className="size-3.5" />All plans</Link></Button>
          <Badge variant="outline">Monthly billing</Badge>
        </div>

        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
          <div className="bg-gradient-to-br from-primary/[0.15] via-card to-card p-6 sm:p-10">
            <p className="text-xs font-medium uppercase tracking-[0.16em] text-primary">{details.productKey}</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">{details.name}</h1>
            <div className="mt-7 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
              <div><p className="text-4xl font-semibold tracking-[-0.04em] text-foreground">{formatPrice(details.amountMinor, details.currency)}</p><p className="mt-1 text-sm text-muted-foreground">per month</p></div>
              <div className="rounded-xl border border-border bg-background/40 px-4 py-3"><p className="text-xs text-muted-foreground">Credits per period</p><p className="mt-1 text-lg font-semibold text-foreground">{details.creditsPerPeriod?.toLocaleString() ?? "—"}</p></div>
            </div>
          </div>
          <div className="border-t border-border p-6 sm:p-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-lg font-semibold text-foreground">Included</h2><p className="mt-1 text-sm text-muted-foreground">Features and limits for this plan.</p></div><CheckoutButton planKey={details.key} disabled={!details.checkoutReady} label={details.checkoutReady ? "Upgrade" : "Checkout unavailable"} /></div>

            {features.length ? (
              <div className="mt-6 grid gap-3 sm:grid-cols-2">
                {features.map((feature) => <div key={feature.key} className="rounded-xl border border-border bg-secondary/20 p-4"><div className="flex items-start gap-3"><Check className="mt-0.5 size-4 shrink-0 text-primary" /><div><p className="text-sm font-medium text-foreground">{feature.name}</p>{feature.description ? <p className="mt-1 text-xs leading-5 text-muted-foreground">{feature.description}</p> : null}</div></div></div>)}
              </div>
            ) : null}

            {limits.length ? (
              <div className="mt-8"><div className="flex items-center gap-2"><Gauge className="size-4 text-primary" /><h3 className="text-sm font-semibold text-foreground">Usage limits</h3></div><div className="mt-3 grid gap-3 sm:grid-cols-2">{limits.map((limit) => <div key={limit.key} className="flex items-center justify-between gap-4 rounded-xl border border-border bg-secondary/20 p-4"><span className="text-sm text-foreground">{limit.name}</span><span className="text-sm font-semibold text-foreground">{entitlementNumber(limit.value) ?? "Included"}</span></div>)}</div></div>
            ) : null}

            {!features.length && !limits.length ? <p className="mt-6 rounded-xl border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">Plan details are being configured</p> : null}
          </div>
        </section>
      </div>
    </div>
  );
}
