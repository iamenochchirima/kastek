import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, Check, Minus } from "lucide-react";

import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { Button } from "@/components/ui/button";
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

function metricValue(plan: AvailablePlan, key: string, empty = "—") {
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
        "flex h-full flex-col rounded-xl border p-5 transition-colors",
        current ? "border-primary/40" : "border-border",
      )}
    >
      <div className="min-h-[3.25rem]">
        {presentation.recommended && !current ? (
          <p className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-primary">
            {presentation.ribbon ?? "Most popular"}
          </p>
        ) : null}
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-base font-semibold tracking-tight text-foreground">
            {plan.name}
          </h3>
          {current ? (
            <span className="text-xs text-muted-foreground">Current</span>
          ) : null}
        </div>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">
          {presentation.tagline}
        </p>
      </div>

      <div className="mt-5 flex items-baseline gap-1.5">
        <p className="text-[28px] font-semibold tracking-[-0.04em] text-foreground">
          {formatPrice(plan.amountMinor, plan.currency)}
        </p>
        <p className="text-xs text-muted-foreground">/ month</p>
      </div>

      <dl className="mt-5 divide-y divide-border border-y border-border text-sm">
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">AI usage</dt>
          <dd className="text-foreground">
            {plan.creditsPerPeriod && plan.creditsPerPeriod > 0
              ? formatUsd(plan.creditsPerPeriod)
              : "None"}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Seats</dt>
          <dd className="text-foreground">{metricValue(plan, "limit.team_seats")}</dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Channels</dt>
          <dd className="text-foreground">
            {metricValue(plan, "limit.connected_channels")}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Recipients / mo</dt>
          <dd className="text-foreground">
            {metricValue(plan, "limit.campaign_recipients")}
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3 py-2">
          <dt className="text-muted-foreground">Posts / mo</dt>
          <dd className="text-foreground">
            {metricValue(plan, "limit.social_publishes")}
          </dd>
        </div>
      </dl>

      {features.length ? (
        <ul className="mt-4 space-y-1.5">
          {features.map((feature) => (
            <li
              key={feature.label}
              className="flex items-start gap-2 text-sm text-muted-foreground"
            >
              <Check className="mt-0.5 size-3.5 shrink-0 text-primary" />
              <span>{feature.label}</span>
            </li>
          ))}
        </ul>
      ) : null}

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
        <div className="mt-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>{presentation.support}</span>
          <Link
            to={`/upgrade/${encodeURIComponent(plan.key)}`}
            className="inline-flex items-center gap-1 text-foreground/80 hover:text-foreground"
          >
            Details <ArrowRight className="size-3" />
          </Link>
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

  return (
    <div className="min-h-[100dvh]">
      <div className="mx-auto w-full max-w-[1100px] px-4 py-8 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.03em] text-foreground">
              Plans
            </h1>
            <p className="mt-1.5 max-w-xl text-[13px] leading-6 text-muted-foreground">
              Conversations, campaigns, content and agents on one monthly plan.
            </p>
          </div>
          <Link
            to="/billing"
            className="mt-1 text-[13px] font-medium text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            Billing
          </Link>
        </div>

        {currentSubscription || trial?.eligible ? (
          <div className="mt-8 divide-y divide-border border-y border-border">
            {currentSubscription ? (
              <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <p className="text-xs uppercase tracking-[0.12em] text-muted-foreground">
                    Current plan
                  </p>
                  <p className="mt-1 text-sm text-foreground">
                    {currentSubscription.planName ?? currentSubscription.name}
                    <span className="text-muted-foreground">
                      {" "}
                      · {formatStatus(currentSubscription.subscriptionStatus)}
                    </span>
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {currentSubscription.currentPeriodEnd
                      ? `${currentSubscription.cancelAtPeriodEnd ? "Access ends" : "Renews"} ${new Date(currentSubscription.currentPeriodEnd).toLocaleDateString("en-ZA", { dateStyle: "medium" })}`
                      : "No renewal date is recorded"}
                  </p>
                </div>
                <Link
                  to="/billing"
                  className="text-[13px] font-medium text-foreground/80 underline-offset-4 hover:text-foreground hover:underline"
                >
                  Manage billing
                </Link>
              </div>
            ) : null}

            {trial?.eligible ? (
              <div className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div className="min-w-0">
                  <p className="text-sm text-foreground">
                    Try {plans.find((plan) => plan.key === trial.planKey)?.name ?? "Growth"} free for {trial.days} days
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    No card required. Returns to Free when the trial ends.
                  </p>
                  {trialError ? (
                    <p className="mt-1 text-xs text-destructive">{trialError}</p>
                  ) : null}
                </div>
                <Button size="sm" onClick={() => void beginTrial()} disabled={trialBusy}>
                  {trialBusy ? "Starting…" : "Start trial"}
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}

        <section className="mt-10">
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="text-sm font-semibold text-foreground">Available plans</h2>
            <p className="text-xs text-muted-foreground">
              Prices exclude VAT where applicable.
            </p>
          </div>

          {plans.length ? (
            <div className="grid items-stretch gap-3 sm:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan) => (
                <PlanCard
                  key={plan.key}
                  plan={plan}
                  current={plan.key === currentPlanKey}
                  busy={trialBusy}
                  trialEligible={trial?.eligible === true && trial.planKey === plan.key}
                  onTrial={() => void beginTrial()}
                />
              ))}
            </div>
          ) : (
            <p className="border-t border-border py-6 text-sm text-muted-foreground">
              No plans are available right now.
            </p>
          )}
        </section>

        <details className="group mt-10 border-t border-border pt-4">
          <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-sm font-semibold text-foreground [&::-webkit-details-marker]:hidden">
            Compare plans
            <ArrowRight className="size-4 text-muted-foreground transition-transform group-open:rotate-90" />
          </summary>
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="min-w-[170px] py-3 pr-4 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
                    Plan
                  </th>
                  {plans.map((plan) => (
                    <th
                      key={plan.key}
                      className={cn(
                        "min-w-[130px] py-3 pr-4 align-bottom font-normal",
                        plan.key === currentPlanKey && "text-foreground",
                      )}
                    >
                      <span className="block text-sm font-semibold text-foreground">
                        {plan.name}
                      </span>
                      <span className="mt-0.5 block text-xs text-muted-foreground">
                        {formatPrice(plan.amountMinor, plan.currency)} / mo
                      </span>
                    </th>
                  ))}
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
        </details>

        <p className="mt-10 border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
          Monthly billing through Paystack. Included AI usage renews each period and is shown in
          USD. For higher volume, onboarding or custom terms, contact us.
        </p>
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
      <tr className="border-b border-border">
        <th
          colSpan={plans.length + 1}
          className="py-2 pr-4 text-left text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
        >
          {label}
        </th>
      </tr>
      {rows.map((row) => (
        <tr key={row.label} className="border-b border-border last:border-0">
          <td className="py-2.5 pr-4 text-sm text-muted-foreground">{row.label}</td>
          {plans.map((plan) => {
            const cell = row.cell(plan);
            return (
              <td
                key={plan.key}
                className={cn(
                  "py-2.5 pr-4 text-sm text-foreground",
                  plan.key === currentPlanKey && "text-foreground",
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
