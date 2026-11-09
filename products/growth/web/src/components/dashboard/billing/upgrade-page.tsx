import { useState } from "react";
import { Link } from "react-router";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  Minus,
  Sparkles,
  Star,
} from "lucide-react";

import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { MotionReveal } from "@/components/ui/motion-reveal";
import { Button } from "@/components/ui/button";
import {
  PageHeader,
  PageHeaderContent,
  PageHeaderDescription,
  PageHeaderTitle,
} from "@/components/ui/page-header";
import { cn } from "@/lib/utils";
import {
  startBillingTrial,
  type AvailablePlan,
  type BillingSummary,
  type BillingTrial,
} from "@/lib/billing";
import {
  formatPrice,
  formatStatus,
  formatUsd,
  GROWTH_COMPARISON,
  growthFeatureGroups,
  limitValue,
  presentationFor,
} from "@/components/dashboard/billing/plan-presentation";

function metricValue(
  plan: AvailablePlan,
  key: string,
  empty = "—",
): string {
  const value = limitValue(plan, key);
  if (value === null || value === 0) return empty;
  return value.toLocaleString();
}

function PlanCard({
  plan,
  current,
  busy,
  trialEligible,
  onTrial,
}: {
  plan: AvailablePlan;
  current: boolean;
  busy: boolean;
  trialEligible: boolean;
  onTrial: () => void;
}) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor ?? 0) === 0;
  const features = growthFeatureGroups(plan).filter((group) => group.included);
  const metrics = [
    { label: "Seats", value: metricValue(plan, "limit.team_seats") },
    { label: "Channels", value: metricValue(plan, "limit.connected_channels") },
    {
      label: "Recipients / mo",
      value: metricValue(plan, "limit.campaign_recipients"),
    },
    {
      label: "Posts / mo",
      value: metricValue(plan, "limit.social_publishes"),
    },
  ];
  const canTrial = trialEligible && !current;
  const actionLabel = current
    ? "Current plan"
    : canTrial
      ? "Start 14-day trial"
      : isFree
        ? "Free plan"
        : `Choose ${plan.name}`;

  return (
    <article
      className={cn(
        "relative flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-panel)] transition-colors",
        current
          ? "border-primary/50 ring-1 ring-primary/20"
          : presentation.recommended
            ? "border-primary/40"
            : "border-border",
      )}
    >
      {presentation.recommended && !current ? (
        <div className="flex items-center gap-1.5 bg-primary px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary-foreground">
          <Star className="size-3" />
          {presentation.ribbon ?? "Most popular"}
        </div>
      ) : null}

      <div className="flex flex-1 flex-col p-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-semibold tracking-tight text-foreground">
              {plan.name}
            </h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              {presentation.tagline}
            </p>
          </div>
          {current ? (
            <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
              Current
            </span>
          ) : null}
        </div>

        <div className="mt-6 flex items-end gap-1.5">
          <p className="text-4xl font-semibold tracking-[-0.05em] text-foreground">
            {formatPrice(plan.amountMinor, plan.currency)}
          </p>
          <p className="pb-1 text-xs text-muted-foreground">/ month</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Billed monthly. Cancel anytime.
        </p>

        <div className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">
          <Sparkles className="size-3.5 text-primary" />
          {plan.creditsPerPeriod && plan.creditsPerPeriod > 0
            ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
            : "No AI usage"}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <div
              key={metric.label}
              className="rounded-lg border border-border bg-secondary/20 px-2.5 py-2"
            >
              <dt className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                {metric.label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">
                {metric.value}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Includes
          </p>
          <ul className="mt-3 space-y-2">
            {features.map((feature) => (
              <li
                key={feature.label}
                className="flex items-start gap-2 text-sm text-muted-foreground"
              >
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto pt-5">
          {current ? (
            <Button className="w-full" variant="outline" disabled>
              Current plan
            </Button>
          ) : canTrial ? (
            <Button className="w-full" onClick={onTrial} disabled={busy}>
              {busy ? "Starting…" : actionLabel}
            </Button>
          ) : isFree ? (
            <Button className="w-full" variant="outline" disabled>
              {actionLabel}
            </Button>
          ) : (
            <CheckoutButton
              planKey={plan.key}
              disabled={!plan.checkoutReady || busy}
              label={plan.checkoutReady ? actionLabel : "Checkout unavailable"}
              variant={presentation.recommended ? "default" : "outline"}
              className=""
            />
          )}
          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{presentation.support}</span>
            <Link
              to={`/upgrade/${encodeURIComponent(plan.key)}`}
              className="inline-flex items-center gap-1 font-medium text-foreground hover:text-primary"
            >
              Details <ArrowRight className="size-3" />
            </Link>
          </div>
        </div>
      </div>
    </article>
  );
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
  const currentSubscription = currentSubscriptions[0] ?? null;
  const currentPlanKey =
    currentSubscription?.planKey ??
    (currentSubscription
      ? plans.find((plan) => plan.name === currentSubscription.planName)?.key
      : "growth-free") ??
    null;
  const mainPlans = plans;

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1240px] space-y-6">
        <PageHeader>
          <PageHeaderContent>
            <PageHeaderTitle>Plans</PageHeaderTitle>
            <PageHeaderDescription>
              Customer conversations, campaigns, content and agents in one
              monthly plan.
            </PageHeaderDescription>
          </PageHeaderContent>
          <Button asChild variant="outline" size="sm">
            <Link to="/billing">
              <ArrowLeft className="size-3.5" />
              Billing
            </Link>
          </Button>
        </PageHeader>

        <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/[0.12] via-card to-card p-6 shadow-[var(--shadow-panel)] sm:p-8">
          <div className="max-w-2xl">
            <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
              KasiTek Growth
            </p>
            <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
              Choose how your workspace grows.
            </h1>
            <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
              Start with the inbox your team already needs. Add campaigns,
              content and agents when you are ready.
            </p>
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2">
            <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
              Currently on {currentSubscription?.planName ?? "Free"}
            </span>
            <span className="rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
              Monthly billing
            </span>
            <span className="rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
              AI usage shown in USD
            </span>
          </div>
        </section>

        {trial?.eligible ? (
          <MotionReveal>
            <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-primary/30 bg-primary/5 p-5">
              <div>
                <h2 className="text-base font-semibold text-foreground">
                  Try {plans.find((plan) => plan.key === trial.planKey)?.name ?? "Growth"} free for {trial.days} days
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  No card required. Your workspace returns to Free when the
                  trial ends.
                </p>
                {trialError ? (
                  <p className="mt-2 text-sm text-destructive">{trialError}</p>
                ) : null}
              </div>
              <Button onClick={() => void beginTrial()} disabled={trialBusy}>
                {trialBusy ? "Starting…" : "Start trial"}
              </Button>
            </section>
          </MotionReveal>
        ) : null}

        {currentSubscription ? (
          <section className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-border bg-card px-5 py-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                Current plan
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {currentSubscription.planName ?? currentSubscription.name}{" "}
                <span className="font-normal text-muted-foreground">
                  · {formatStatus(currentSubscription.subscriptionStatus)}
                </span>
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {currentSubscription.currentPeriodEnd
                  ? `${currentSubscription.cancelAtPeriodEnd ? "Access ends" : "Renews"} ${new Date(currentSubscription.currentPeriodEnd).toLocaleDateString("en-ZA", { dateStyle: "medium" })}`
                  : "No renewal date is recorded"}
              </p>
            </div>
            <Button asChild variant="outline" size="sm">
              <Link to="/billing">Manage billing</Link>
            </Button>
          </section>
        ) : null}

        <section>
          <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-foreground">
                Available plans
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Upgrade or downgrade at any time. Changes apply from the next
                billing period.
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              All prices exclude VAT where applicable.
            </span>
          </div>

          {mainPlans.length ? (
            <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
              {mainPlans.map((plan) => {
                const current = plan.key === currentPlanKey;
                return (
                  <MotionReveal
                    key={plan.key}
                    delay={mainPlans.indexOf(plan) * 0.05}
                    hoverLift
                  >
                    <PlanCard
                      plan={plan}
                      current={current}
                      busy={trialBusy}
                      trialEligible={trial?.eligible === true && trial.planKey === plan.key}
                      onTrial={() => void beginTrial()}
                    />
                  </MotionReveal>
                );
              })}
            </div>
          ) : (
            <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
              No plans are available right now.
            </div>
          )}
        </section>

        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
          <div className="border-b border-border p-5">
            <h2 className="text-lg font-semibold text-foreground">
              Compare plans
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Seats, volume, features and support side by side.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[860px] text-left text-sm">
              <thead>
                <tr className="border-b border-border bg-secondary/20">
                  <th className="sticky left-0 z-10 min-w-[180px] bg-card px-5 py-4 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Plan
                  </th>
                  {plans.map((plan) => {
                    const active = plan.key === currentPlanKey;
                    const recommended = presentationFor(plan).recommended;
                    return (
                      <th
                        key={plan.key}
                        className={cn(
                          "min-w-[150px] px-5 py-4 align-bottom",
                          active && "bg-primary/[0.04]",
                          !active && recommended && "bg-primary/[0.02]",
                        )}
                      >
                        <span className="block text-sm font-semibold text-foreground">
                          {plan.name}
                        </span>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {formatPrice(plan.amountMinor, plan.currency)} / mo
                        </span>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {GROWTH_COMPARISON.map((group) => (
                  <FragmentGroup
                    key={group.label}
                    label={group.label}
                    rows={group.rows}
                    plans={plans}
                    currentPlanKey={currentPlanKey}
                  />
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="grid gap-3 rounded-2xl border border-border bg-card p-5 sm:grid-cols-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Monthly billing</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              No annual contracts. Pay monthly through Paystack.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">AI usage</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Included usage renews each billing period and is shown in USD.
            </p>
          </div>
          <div>
            <h2 className="text-sm font-semibold text-foreground">Need more?</h2>
            <p className="mt-1 text-sm leading-5 text-muted-foreground">
              Contact us for higher volume, onboarding and custom terms.
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function FragmentGroup({
  label,
  rows,
  plans,
  currentPlanKey,
}: {
  label: string;
  rows: (typeof GROWTH_COMPARISON)[number]["rows"];
  plans: AvailablePlan[];
  currentPlanKey: string | null;
}) {
  return (
    <>
      <tr className="border-b border-border bg-secondary/30">
        <th
          colSpan={plans.length + 1}
          className="sticky left-0 z-10 bg-secondary/30 px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground"
        >
          {label}
        </th>
      </tr>
      {rows.map((row) => (
        <tr key={row.label} className="border-b border-border last:border-0">
          <td className="sticky left-0 z-10 bg-card px-5 py-3 text-sm text-muted-foreground">
            {row.label}
          </td>
          {plans.map((plan) => {
            const cell = row.cell(plan);
            const active = plan.key === currentPlanKey;
            const recommended = presentationFor(plan).recommended;
            return (
              <td
                key={plan.key}
                className={cn(
                  "px-5 py-3 text-sm text-foreground",
                  active && "bg-primary/[0.04]",
                  !active && recommended && "bg-primary/[0.02]",
                )}
              >
                {cell.kind === "included" ? (
                  <Check className="size-4 text-primary" aria-label="Included" />
                ) : cell.kind === "excluded" ? (
                  <Minus className="size-4 text-muted-foreground/40" aria-label="Not included" />
                ) : (
                  <span>{cell.value}</span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
