import { Link } from "react-router";
import { ArrowRight, Check, Minus, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AvailablePlan } from "@/lib/billing";
import {
  formatPrice,
  formatUsd,
  GROWTH_COMPARISON,
  growthFeatureGroups,
  limitValue,
  presentationFor,
} from "@/components/dashboard/billing/plan-presentation";

function metricValue(plan: AvailablePlan, key: string): string {
  const value = limitValue(plan, key);
  return value === null || value === 0 ? "—" : value.toLocaleString();
}

function signupHref(plan: AvailablePlan): string {
  if (Number(plan.amountMinor ?? 0) === 0) return "/signup";
  return `/signup?returnTo=${encodeURIComponent(`/upgrade/${plan.key}`)}`;
}

function PublicPlanCard({ plan }: { plan: AvailablePlan }) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor ?? 0) === 0;
  const features = growthFeatureGroups(plan).filter((group) => group.included);
  const metrics = [
    { label: "Seats", value: metricValue(plan, "limit.team_seats") },
    { label: "Channels", value: metricValue(plan, "limit.connected_channels") },
    { label: "Recipients / mo", value: metricValue(plan, "limit.campaign_recipients") },
    { label: "Posts / mo", value: metricValue(plan, "limit.social_publishes") },
  ];
  const available = isFree || plan.checkoutReady;

  return (
    <article
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-2xl border bg-card shadow-[var(--shadow-panel)]",
        presentation.recommended ? "border-primary/40" : "border-border",
      )}
    >
      {presentation.recommended ? (
        <div className="bg-primary px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-primary-foreground">
          {presentation.ribbon ?? "Most popular"}
        </div>
      ) : null}
      <div className="flex flex-1 flex-col p-5">
        <h2 className="text-lg font-semibold tracking-tight text-foreground">{plan.name}</h2>
        <p className="mt-1 text-sm leading-5 text-muted-foreground">{presentation.tagline}</p>

        <div className="mt-6 flex items-end gap-1.5">
          <p className="text-4xl font-semibold tracking-[-0.05em] text-foreground">
            {formatPrice(plan.amountMinor, plan.currency)}
          </p>
          <p className="pb-1 text-xs text-muted-foreground">/ month</p>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Billed monthly. Cancel anytime.</p>

        <div className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">
          <Sparkles className="size-3.5 text-primary" />
          {plan.creditsPerPeriod && plan.creditsPerPeriod > 0
            ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
            : "No AI usage"}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg border border-border bg-secondary/20 px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground">{metric.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-foreground">{metric.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 border-t border-border pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">Includes</p>
          <ul className="mt-3 space-y-2">
            {features.map((feature) => (
              <li key={feature.label} className="flex items-start gap-2 text-sm text-muted-foreground">
                <Check className="mt-0.5 size-4 shrink-0 text-primary" />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto pt-5">
          {available ? (
            <Button asChild className="w-full">
              <Link to={signupHref(plan)}>
                {isFree ? "Get started" : `Choose ${plan.name}`}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button className="w-full" variant="outline" disabled>
              Coming soon
            </Button>
          )}
          <p className="mt-2 text-center text-[11px] text-muted-foreground">{presentation.support}</p>
        </div>
      </div>
    </article>
  );
}

function ComparisonRows({ plans }: { plans: AvailablePlan[] }) {
  return (
    <>
      {GROWTH_COMPARISON.map((group) => (
        <tbody key={group.label}>
          <tr className="border-b border-border bg-secondary/30">
            <th colSpan={plans.length + 1} className="px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
              {group.label}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.label} className="border-b border-border last:border-0">
              <td className="px-5 py-3 text-sm text-muted-foreground">{row.label}</td>
              {plans.map((plan) => {
                const cell = row.cell(plan);
                return (
                  <td key={plan.key} className="px-5 py-3 text-sm text-foreground">
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
        </tbody>
      ))}
    </>
  );
}

export function PublicPricingPage({
  plans,
  configured,
}: {
  plans: AvailablePlan[];
  configured: boolean;
}) {
  return (
    <div className="min-h-[100dvh] bg-background text-foreground">
      <header className="sticky top-0 z-20 border-b border-border bg-background/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/" className="text-sm font-semibold tracking-tight">
            kasitek<span className="text-muted-foreground"> / growth</span>
          </Link>
          <nav className="flex items-center gap-3 text-sm" aria-label="Public navigation">
            <Link to="/pricing" className="font-medium">Pricing</Link>
            <Link to="/login" className="text-muted-foreground hover:text-foreground">Sign in</Link>
            <Button asChild size="sm">
              <Link to="/signup">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-8 pt-12 sm:pt-16">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">KasiTek Growth</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">
            Plans for every stage.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-muted-foreground">
            Start with the inbox. Add campaigns, content and workspace agents when you need them.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-primary/25 bg-primary/10 px-3 py-1 font-medium text-primary">Free to start</span>
            <span className="rounded-full border border-border bg-card px-3 py-1 text-muted-foreground">Monthly billing</span>
            <span className="rounded-full border border-border bg-card px-3 py-1 text-muted-foreground">AI usage shown in USD</span>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4" aria-label="Growth plans">
          {plans.length ? (
            <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
              {plans.map((plan) => <PublicPlanCard key={plan.key} plan={plan} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-border bg-card p-6 text-sm text-muted-foreground">
              {configured ? "No plans are available right now." : "Plans are being configured."}
            </div>
          )}
        </section>

        {plans.length ? (
          <section className="mx-auto mt-8 max-w-6xl overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
            <div className="border-b border-border p-5">
              <h2 className="text-lg font-semibold text-foreground">Compare plans</h2>
              <p className="mt-1 text-sm text-muted-foreground">Seats, volume, features and support side by side.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[860px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border bg-secondary/20">
                    <th className="min-w-[180px] px-5 py-4 text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Plan</th>
                    {plans.map((plan) => (
                      <th key={plan.key} className="min-w-[150px] px-5 py-4 align-bottom">
                        <span className="block text-sm font-semibold text-foreground">{plan.name}</span>
                        <span className="mt-1 block text-xs font-normal text-muted-foreground">
                          {formatPrice(plan.amountMinor, plan.currency)} / mo
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <ComparisonRows plans={plans} />
              </table>
            </div>
          </section>
        ) : null}

        <p className="mx-auto mt-6 max-w-6xl px-4 text-xs leading-5 text-muted-foreground">
          Early access pricing. Plans and limits may change before general availability. Prices exclude VAT where applicable.
        </p>
      </main>

      <footer className="mt-12 border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs text-muted-foreground">
          <span>© {new Date().getFullYear()} KasiTek</span>
          <nav className="flex flex-wrap gap-4" aria-label="Footer navigation">
            <Link to="/" className="hover:text-foreground">Growth</Link>
            <Link to="/pricing" className="hover:text-foreground">Pricing</Link>
            <Link to="/login" className="hover:text-foreground">Sign in</Link>
            <a href="https://kasitek.co.za/privacy-policy" className="hover:text-foreground">Privacy</a>
            <a href="https://kasitek.co.za/terms" className="hover:text-foreground">Terms</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
