import { Link } from "react-router-dom";
import {
  PiArrowLeft as ArrowLeft,
  PiCheck as Check,
  PiMinus as Minus,
  PiSparkle as Sparkle,
  PiStar as Star,
} from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useWorkspace } from "./shell";
import { useBillingData, type Plan } from "./billing-settings";
import {
  AGENTS_COMPARISON,
  agentsFeatureGroups,
  formatPrice,
  formatUsd,
  metricNumber,
  presentationFor,
} from "./plan-presentation";
import "./management.css";
import "./workspace-surfaces.css";

function PlanCard({
  plan,
  current,
  busy,
  onChoose,
}: {
  plan: Plan;
  current: boolean;
  busy: boolean;
  onChoose: (planKey: string) => void;
}) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor) === 0;
  const features = agentsFeatureGroups(plan).filter((group) => group.included);
  const metrics = [
    { label: "Seats", value: metricNumber(plan, "limit.agent_seats") },
    { label: "Agents", value: metricNumber(plan, "limit.agent_count") },
    { label: "Channels", value: metricNumber(plan, "limit.agent_channels") },
    { label: "Crawl / mo", value: metricNumber(plan, "limit.crawl_pages") },
  ];
  const actionLabel = current
    ? "Current plan"
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
          <Sparkle className="size-3.5 text-primary" />
          {Number(plan.creditsPerPeriod ?? 0) > 0
            ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
            : "No AI usage"}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          {metrics.map((item) => (
            <div
              key={item.label}
              className="rounded-lg border border-border bg-secondary/20 px-2.5 py-2"
            >
              <dt className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">
                {item.label}
              </dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">
                {item.value}
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
          <Button
            className="w-full"
            variant={current || isFree ? "outline" : presentation.recommended ? "default" : "outline"}
            disabled={current || isFree || busy || !plan.checkoutReady}
            onClick={() => onChoose(plan.key)}
          >
            {busy
              ? "Opening…"
              : current
                ? "Current plan"
                : plan.checkoutReady
                  ? actionLabel
                  : "Checkout unavailable"}
          </Button>
          <div className="mt-2 flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
            <span>{presentation.support}</span>
            <span>Secure checkout via Paystack</span>
          </div>
        </div>
      </div>
    </article>
  );
}

function ResellerCard({
  plan,
  current,
  busy,
  onChoose,
}: {
  plan: Plan;
  current: boolean;
  busy: boolean;
  onChoose: (planKey: string) => void;
}) {
  const presentation = presentationFor(plan);
  return (
    <article className="overflow-hidden rounded-2xl border border-primary/30 bg-gradient-to-br from-primary/[0.10] via-card to-card shadow-[var(--shadow-panel)]">
      <div className="grid gap-6 p-6 lg:grid-cols-[1.25fr_1fr] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-foreground">
              {plan.name}
            </h2>
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2.5 py-0.5 text-[11px] font-medium text-primary">
              For agencies
            </span>
            {current ? (
              <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                Current
              </span>
            ) : null}
          </div>
          <p className="mt-2 max-w-xl text-sm leading-6 text-muted-foreground">
            {presentation.tagline}
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-border bg-background/60 px-3 py-1">
              {metricNumber(plan, "limit.agent_count")} agents
            </span>
            <span className="rounded-full border border-border bg-background/60 px-3 py-1">
              {metricNumber(plan, "limit.agent_channels")} channels
            </span>
            <span className="rounded-full border border-border bg-background/60 px-3 py-1">
              {metricNumber(plan, "limit.crawl_pages")} crawl pages / mo
            </span>
            <span className="rounded-full border border-border bg-background/60 px-3 py-1">
              {formatUsd(plan.creditsPerPeriod)} AI usage
            </span>
          </div>
        </div>
        <div className="space-y-3 lg:border-l lg:border-border lg:pl-6">
          <p className="text-3xl font-semibold tracking-[-0.04em] text-foreground">
            {formatPrice(plan.amountMinor, plan.currency)}
            <span className="ml-1 text-sm font-normal text-muted-foreground">
              / month
            </span>
          </p>
          <p className="text-sm leading-6 text-muted-foreground">
            {presentation.support}. Create up to {metricNumber(plan, "limit.agent_count")} agents and
            remove the KasiTek badge from every website widget.
          </p>
          <Button
            className="w-full"
            variant={current ? "outline" : "default"}
            disabled={current || busy || !plan.checkoutReady}
            onClick={() => onChoose(plan.key)}
          >
            {busy
              ? "Opening…"
              : current
                ? "Current plan"
                : plan.checkoutReady
                  ? `Choose ${plan.name}`
                  : "Checkout unavailable"}
          </Button>
          <p className="text-center text-[11px] text-muted-foreground">
            Cancel anytime. Secure checkout via Paystack.
          </p>
        </div>
      </div>
    </article>
  );
}

export function UpgradePage() {
  const { organizationId } = useWorkspace();
  const { data, error, notice, checkoutBusy, startCheckout } =
    useBillingData(organizationId);
  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const plans = [...(data?.plans ?? [])].sort(
    (left, right) => Number(left.amountMinor) - Number(right.amountMinor),
  );
  const currentPlanKey = subscription?.planKey ?? "agents-free";
  const reseller = plans.find((plan) => plan.key === "agents-reseller");
  const mainPlans = plans.filter((plan) => plan.key !== "agents-reseller");

  return (
    <section className="management-page max-w-7xl">
      <header className="management-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1>Plans</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Customer-service agents, channels, knowledge and inbox tools in one
              monthly plan.
            </p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/app/settings?section=billing">
              <ArrowLeft className="size-4" />
              Billing
            </Link>
          </Button>
        </div>
      </header>

      {error ? (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm text-primary">
          {notice}
        </p>
      ) : null}
      {!data ? (
        <p className="mt-6 text-sm text-muted-foreground">Loading plans…</p>
      ) : null}

      {data ? (
        <>
          <section className="relative overflow-hidden rounded-2xl border border-border bg-gradient-to-br from-primary/[0.12] via-card to-card p-6 shadow-[var(--shadow-panel)] sm:p-8">
            <div className="max-w-2xl">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                KasiTek Agents
              </p>
              <h2 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
                Choose how your agents grow.
              </h2>
              <p className="mt-3 max-w-xl text-sm leading-6 text-muted-foreground">
                Start with one agent and one channel. Add handoff, assignment,
                analytics and unbranded widgets as your team grows.
              </p>
            </div>
            <div className="mt-6 flex flex-wrap items-center gap-2">
              <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                Currently on {subscription?.planName ?? "Free"}
              </span>
              <span className="rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
                Monthly billing
              </span>
              <span className="rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
                AI usage shown in USD
              </span>
            </div>
          </section>

          <section className="mt-6">
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
                {mainPlans.map((plan) => (
                  <PlanCard
                    key={plan.key}
                    plan={plan}
                    current={plan.key === currentPlanKey}
                    busy={checkoutBusy === plan.key}
                    onChoose={(planKey) => void startCheckout(planKey)}
                  />
                ))}
              </div>
            ) : (
              <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">
                No plans are available right now.
              </div>
            )}
          </section>

          {reseller ? (
            <section className="mt-4">
              <ResellerCard
                plan={reseller}
                current={reseller.key === currentPlanKey}
                busy={checkoutBusy === reseller.key}
                onChoose={(planKey) => void startCheckout(planKey)}
              />
            </section>
          ) : null}

          <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
            <div className="border-b border-border p-5">
              <h2 className="text-lg font-semibold text-foreground">
                Compare plans
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Seats, agents, knowledge, inbox tools and branding side by side.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/20">
                    <th className="sticky left-0 z-10 min-w-[190px] bg-card px-5 py-4 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">
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
                  {AGENTS_COMPARISON.map((group) => (
                    <ComparisonGroupRows
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

          <section className="mt-6 grid gap-3 rounded-2xl border border-border bg-card p-5 sm:grid-cols-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Monthly billing
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                No annual contracts. Pay monthly through Paystack.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                AI usage
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Included usage renews each billing period and is shown in USD.
              </p>
            </div>
            <div>
              <h2 className="text-sm font-semibold text-foreground">
                Need more?
              </h2>
              <p className="mt-1 text-sm leading-5 text-muted-foreground">
                Contact us for higher volume, onboarding and custom terms.
              </p>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}

function ComparisonGroupRows({
  label,
  rows,
  plans,
  currentPlanKey,
}: {
  label: string;
  rows: (typeof AGENTS_COMPARISON)[number]["rows"];
  plans: Plan[];
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
