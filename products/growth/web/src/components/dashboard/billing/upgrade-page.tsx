import { useState } from "react";
import { Link } from "react-router";
import { ArrowLeft, Check } from "lucide-react";

import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { startBillingTrial, type AvailablePlan, type BillingSummary, type BillingTrial } from "@/lib/billing";

function formatPrice(amountMinor: number | null, currency: string) {
  if (amountMinor === null) return "Contact sales";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(amountMinor / 100);
}

function formatAiUsage(microUsd: number | null) {
  if (microUsd === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(microUsd / 1_000_000);
}

function formatLimit(value: unknown, unit: string | null) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : null;
  if (number !== null) return `${number.toLocaleString()}${unit ? ` ${unit}` : ""}`;
  return typeof value === "string" ? value : "Included";
}

function entitlementList(plan: AvailablePlan, kind: "feature" | "limit") {
  return (plan.entitlements ?? [])
    .filter((item) => item.kind === kind && (kind === "limit" || item.value === true))
    .sort(
      (left, right) =>
        (left.displayGroup ?? "").localeCompare(right.displayGroup ?? "") ||
        left.displayOrder - right.displayOrder ||
        left.name.localeCompare(right.name),
    );
}

function formatStatus(status: string | null) {
  if (!status) return "No active plan";
  return status.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

export function UpgradePage({
  plans,
  summary,
  trial,
}: {
  plans: AvailablePlan[];
  summary: BillingSummary | null;
  trial: BillingTrial | null;
}) {
  const [trialBusy, setTrialBusy] = useState(false);
  const [trialError, setTrialError] = useState("");

  async function beginTrial() {
    setTrialBusy(true);
    setTrialError("");
    try {
      await startBillingTrial();
      window.location.reload();
    } catch {
      setTrialError("The trial could not be started. Try again.");
      setTrialBusy(false);
    }
  }
  const currentSubscriptions = (summary?.products ?? []).filter(
    (product) => product.subscriptionId && product.hasAccess,
  );

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1240px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Choose a plan</PageHeaderTitle>
            <PageHeaderDescription>Upgrade your workspace with more access and AI usage.</PageHeaderDescription>
          </PageHeaderContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/billing">
              <ArrowLeft className="h-3.5 w-3.5" />
              Billing
            </Link>
          </Button>
        </PageHeader>

        {trial?.eligible ? (
          <MotionReveal>
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-5">
              <div>
                <h2 className="text-lg font-semibold text-foreground">
                  Try {plans.find((plan) => plan.key === trial.planKey)?.name ?? "Growth"} for {trial.days} days
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">No card required. Your workspace returns to the free plan when the trial ends.</p>
                {trialError ? <p className="mt-2 text-sm text-destructive">{trialError}</p> : null}
              </div>
              <Button onClick={() => void beginTrial()} disabled={trialBusy}>
                {trialBusy ? "Starting…" : "Start trial"}
              </Button>
            </section>
          </MotionReveal>
        ) : null}

        {currentSubscriptions.length ? (
          <MotionReveal>
            <section className="rounded-xl border border-border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Current plan</p>
                  <h2 className="mt-1 text-lg font-semibold text-foreground">
                    {currentSubscriptions[0].planName ?? currentSubscriptions[0].name}
                  </h2>
                </div>
                <Badge>{formatStatus(currentSubscriptions[0].subscriptionStatus)}</Badge>
              </div>
              <p className="mt-3 text-sm text-muted-foreground">
                {currentSubscriptions[0].currentPeriodEnd
                  ? `${currentSubscriptions[0].cancelAtPeriodEnd ? "Access ends" : "Renews"} ${new Date(currentSubscriptions[0].currentPeriodEnd).toLocaleDateString("en-ZA", { dateStyle: "medium" })}`
                  : "No renewal date is recorded"}
              </p>
            </section>
          </MotionReveal>
        ) : null}

        <section>
          <div className="mb-4">
            <h2 className="text-lg font-semibold text-foreground">Available plans</h2>
            <p className="mt-1 text-sm text-muted-foreground">Choose the plan that fits your workspace.</p>
          </div>
          {plans.length ? (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan, index) => {
                const isCurrent = currentSubscriptions.some((subscription) => subscription.planName === plan.name);
                return (
                  <MotionReveal key={plan.key} delay={index * 0.06} hoverLift>
                    <article className={`flex h-full flex-col rounded-xl border bg-card p-5 ${isCurrent ? "border-primary/50 ring-1 ring-primary/20" : "border-border"}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <h3 className="text-base font-semibold text-foreground">{plan.name}</h3>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {plan.description ?? `${formatPrice(plan.amountMinor, plan.currency)} / month`}
                          </p>
                        </div>
                        {isCurrent ? <Badge variant="secondary">Current</Badge> : null}
                      </div>

                      <div className="mt-5">
                        <p className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
                          {formatPrice(plan.amountMinor, plan.currency)}
                        </p>
                        <p className="mt-1 text-sm text-muted-foreground">
                          per month
                        </p>
                      </div>

                      <div className="mt-5 flex items-center justify-between gap-3 border-y border-border py-3">
                        <p className="text-sm text-muted-foreground">Monthly AI usage</p>
                        <p className="text-sm font-semibold text-foreground">
                          {formatAiUsage(plan.creditsPerPeriod)}
                        </p>
                      </div>

                      <div className="mt-5 space-y-4 border-t border-border pt-4">
                        {entitlementList(plan, "feature").map((feature) => (
                          <div key={feature.key} className="flex items-start gap-2 text-sm text-muted-foreground">
                            <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                            <span>{feature.name}</span>
                          </div>
                        ))}
                        {entitlementList(plan, "limit").length ? (
                          <div className="space-y-1.5 border-t border-border pt-4">
                            <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Limits</p>
                            {entitlementList(plan, "limit").map((limit) => (
                              <div key={limit.key} className="flex items-start justify-between gap-3 text-sm">
                                <span className="text-muted-foreground">{limit.name}</span>
                                <span className="shrink-0 font-medium text-foreground">{formatLimit(limit.value, limit.unit)}</span>
                              </div>
                            ))}
                          </div>
                        ) : null}
                        <p className="flex items-start gap-2 text-xs text-muted-foreground">
                          <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                          AI usage renews each billing period
                        </p>
                      </div>

                      <div className="mt-auto space-y-2 pt-5">
                        <Button asChild variant="ghost" className="w-full"><Link to={`/upgrade/${encodeURIComponent(plan.key)}`}>View plan details</Link></Button>
                        <CheckoutButton
                          planKey={plan.key}
                          disabled={isCurrent || !plan.checkoutReady}
                          label={isCurrent ? "Current plan" : plan.checkoutReady ? "Upgrade" : "Checkout unavailable"}
                        />
                      </div>
                    </article>
                  </MotionReveal>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No plans available</div>
          )}
        </section>
      </div>
    </div>
  );
}
