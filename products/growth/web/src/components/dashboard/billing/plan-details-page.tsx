import { Link } from "react-router";
import { ArrowLeft, Check, Minus, Sparkles } from "lucide-react";

import { CheckoutButton } from "@/components/dashboard/billing/checkout-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { AvailablePlanDetails } from "@/lib/billing";
import {
  formatPrice,
  formatUsd,
  growthFeatureGroups,
  limitValue,
  presentationFor,
} from "@/components/dashboard/billing/plan-presentation";

function metric(
  details: AvailablePlanDetails,
  key: string,
  unit: string,
): string {
  const value = limitValue(details, key);
  if (value === null || value === 0) return "—";
  return `${value.toLocaleString()} ${unit}`;
}

export function PlanDetailsPage({ details }: { details: AvailablePlanDetails }) {
  const presentation = presentationFor(details);
  const groups = growthFeatureGroups(details);
  const limits = [
    { label: "Team seats", value: metric(details, "limit.team_seats", "seats") },
    {
      label: "Connected channels",
      value: metric(details, "limit.connected_channels", "channels"),
    },
    {
      label: "Campaign recipients",
      value: metric(details, "limit.campaign_recipients", "per month"),
    },
    {
      label: "Social posts",
      value: metric(details, "limit.social_publishes", "per month"),
    },
    {
      label: "API requests",
      value: metric(details, "limit.public_api_requests", "per month"),
    },
  ];

  return (
    <div className="min-h-[100dvh] p-4 sm:p-6">
      <div className="mx-auto max-w-[1040px] space-y-6">
        <div className="flex items-center justify-between gap-4">
          <Button asChild variant="outline" size="sm">
            <Link to="/upgrade">
              <ArrowLeft className="size-3.5" />
              All plans
            </Link>
          </Button>
          <Badge variant="outline">Monthly billing</Badge>
        </div>

        <section className="overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
          <div className="relative bg-gradient-to-br from-primary/[0.14] via-card to-card p-6 sm:p-9">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-primary">
                  KasiTek Growth
                </p>
                <h1 className="mt-2 text-3xl font-semibold tracking-[-0.04em] text-foreground sm:text-4xl">
                  {details.name}
                </h1>
                <p className="mt-2 text-sm leading-6 text-muted-foreground">
                  {presentation.tagline}
                </p>
                <div className="mt-5 flex flex-wrap items-center gap-2">
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-foreground">
                    <Sparkles className="size-3.5 text-primary" />
                    {details.creditsPerPeriod && details.creditsPerPeriod > 0
                      ? `${formatUsd(details.creditsPerPeriod)} AI usage`
                      : "No AI usage"}
                  </span>
                  <span className="rounded-full border border-border bg-background/60 px-3 py-1 text-xs text-muted-foreground">
                    {presentation.support}
                  </span>
                </div>
              </div>
              <div className="w-full max-w-xs rounded-xl border border-border bg-background/60 p-5 sm:w-auto sm:min-w-[240px]">
                <p className="text-4xl font-semibold tracking-[-0.05em] text-foreground">
                  {formatPrice(details.amountMinor, details.currency)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">per month</p>
                <div className="mt-4">
                  {details.amountMinor && details.amountMinor > 0 ? (
                    <CheckoutButton
                      planKey={details.key}
                      disabled={!details.checkoutReady}
                      label={details.checkoutReady ? `Choose ${details.name}` : "Checkout unavailable"}
                      className=""
                    />
                  ) : (
                    <Button className="w-full" variant="outline" disabled>
                      Free plan
                    </Button>
                  )}
                </div>
                <p className="mt-3 text-center text-[11px] text-muted-foreground">
                  Cancel anytime. Secure checkout via Paystack.
                </p>
              </div>
            </div>
          </div>

          <div className="grid gap-8 border-t border-border p-6 sm:p-9 lg:grid-cols-[1.3fr_0.7fr]">
            <section>
              <h2 className="text-lg font-semibold text-foreground">
                What is included
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                The services and tools available on this plan.
              </p>
              <ul className="mt-5 divide-y divide-border rounded-xl border border-border">
                {groups.map((group) => (
                  <li
                    key={group.label}
                    className="flex items-center justify-between gap-4 px-4 py-3.5"
                  >
                    <span className="flex items-center gap-3 text-sm text-foreground">
                      {group.included ? (
                        <Check className="size-4 shrink-0 text-primary" />
                      ) : (
                        <Minus className="size-4 shrink-0 text-muted-foreground/40" />
                      )}
                      {group.label}
                    </span>
                    <span
                      className={cn(
                        "text-xs",
                        group.included
                          ? "text-primary"
                          : "text-muted-foreground",
                      )}
                    >
                      {group.included ? "Included" : "Not included"}
                    </span>
                  </li>
                ))}
              </ul>
            </section>

            <section>
              <h2 className="text-lg font-semibold text-foreground">Limits</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Monthly allowances for this plan.
              </p>
              <dl className="mt-5 divide-y divide-border rounded-xl border border-border">
                {limits.map((limit) => (
                  <div
                    key={limit.label}
                    className="flex items-center justify-between gap-4 px-4 py-3.5"
                  >
                    <dt className="text-sm text-muted-foreground">{limit.label}</dt>
                    <dd className="text-sm font-medium text-foreground">
                      {limit.value}
                    </dd>
                  </div>
                ))}
              </dl>
              <div className="mt-4 rounded-xl border border-border bg-secondary/20 p-4">
                <h3 className="text-sm font-semibold text-foreground">Support</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  {presentation.support}
                </p>
              </div>
            </section>
          </div>
        </section>

        <section className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-border bg-card p-5">
          <div>
            <h2 className="text-sm font-semibold text-foreground">
              Compare this plan with the others
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              See seats, volume and features side by side.
            </p>
          </div>
          <Button asChild variant="outline">
            <Link to="/upgrade">Compare plans</Link>
          </Button>
        </section>
      </div>
    </div>
  );
}
