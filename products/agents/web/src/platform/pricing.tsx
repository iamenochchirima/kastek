import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import {
  PiArrowRight as ArrowRight,
  PiCheck as Check,
  PiMinus as Minus,
  PiSparkle as Sparkle,
} from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Plan } from "./billing-settings";
import {
  AGENTS_COMPARISON,
  agentsFeatureGroups,
  formatPrice,
  formatUsd,
  metricNumber,
  presentationFor,
} from "./plan-presentation";

type PublicPlans = { configured: boolean; plans: Plan[] };

function signupHref(): string {
  return "/signup?returnTo=%2Fapp%2Fupgrade";
}

function PlanCard({ plan }: { plan: Plan }) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor) === 0;
  const features = agentsFeatureGroups(plan).filter((group) => group.included);
  const metrics = [
    { label: "Seats", value: metricNumber(plan, "limit.agent_seats") },
    { label: "Agents", value: metricNumber(plan, "limit.agent_count") },
    { label: "Channels", value: metricNumber(plan, "limit.agent_channels") },
    { label: "Crawl / mo", value: metricNumber(plan, "limit.crawl_pages") },
  ];
  const available = isFree || plan.checkoutReady;

  return (
    <article
      className={cn(
        "flex h-full flex-col overflow-hidden rounded-2xl border bg-white shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_40px_-28px_rgba(16,24,40,.22)]",
        presentation.recommended ? "border-[#245ed2]/40" : "border-[#e7e8ec]",
      )}
    >
      {presentation.recommended ? (
        <div className="bg-[#202530] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white">
          {presentation.ribbon ?? "Most popular"}
        </div>
      ) : null}
      <div className="flex flex-1 flex-col p-5">
        <h2 className="text-lg font-semibold tracking-tight text-[#171a22]">{plan.name}</h2>
        <p className="mt-1 text-sm leading-5 text-[#626874]">{presentation.tagline}</p>

        <div className="mt-6 flex items-end gap-1.5">
          <p className="text-4xl font-semibold tracking-[-0.05em] text-[#171a22]">
            {formatPrice(plan.amountMinor, plan.currency)}
          </p>
          <p className="pb-1 text-xs text-[#626874]">/ month</p>
        </div>
        <p className="mt-1 text-xs text-[#626874]">Billed monthly. Cancel anytime.</p>

        <div className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-[#e7e8ec] bg-[#f7f7f8] px-2.5 py-1 text-xs text-[#171a22]">
          <Sparkle className="size-3.5 text-[#245ed2]" />
          {Number(plan.creditsPerPeriod ?? 0) > 0
            ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
            : "No AI usage"}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg border border-[#e7e8ec] bg-[#fafafa] px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-[0.1em] text-[#7a808b]">{metric.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[#171a22]">{metric.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 border-t border-[#e7e8ec] pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a808b]">Includes</p>
          <ul className="mt-3 space-y-2">
            {features.map((feature) => (
              <li key={feature.label} className="flex items-start gap-2 text-sm text-[#626874]">
                <Check className="mt-0.5 size-4 shrink-0 text-[#245ed2]" />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto pt-5">
          {available ? (
            <Button asChild className="w-full rounded-full bg-[#202530] text-white hover:bg-[#35405a]">
              <Link to={signupHref()}>
                {isFree ? "Get started" : `Choose ${plan.name}`}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button className="w-full rounded-full" variant="outline" disabled>
              Coming soon
            </Button>
          )}
          <p className="mt-2 text-center text-[11px] text-[#7a808b]">{presentation.support}</p>
        </div>
      </div>
    </article>
  );
}

function ResellerCard({ plan }: { plan: Plan }) {
  const presentation = presentationFor(plan);
  const available = plan.checkoutReady;
  return (
    <article className="overflow-hidden rounded-2xl border border-[#245ed2]/30 bg-gradient-to-br from-[#eef4ff] via-white to-white shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_40px_-28px_rgba(16,24,40,.22)]">
      <div className="grid gap-6 p-6 lg:grid-cols-[1.25fr_1fr] lg:items-center">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-xl font-semibold tracking-tight text-[#171a22]">{plan.name}</h2>
            <span className="rounded-full border border-[#245ed2]/25 bg-[#e8f0ff] px-2.5 py-0.5 text-[11px] font-medium text-[#245ed2]">
              For agencies
            </span>
          </div>
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#626874]">{presentation.tagline}</p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1">{metricNumber(plan, "limit.agent_count")} agents</span>
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1">{metricNumber(plan, "limit.agent_channels")} channels</span>
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1">{metricNumber(plan, "limit.crawl_pages")} crawl pages / mo</span>
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1">{formatUsd(plan.creditsPerPeriod)} AI usage</span>
          </div>
        </div>
        <div className="space-y-3 lg:border-l lg:border-[#e7e8ec] lg:pl-6">
          <p className="text-3xl font-semibold tracking-[-0.04em] text-[#171a22]">
            {formatPrice(plan.amountMinor, plan.currency)}
            <span className="ml-1 text-sm font-normal text-[#626874]">/ month</span>
          </p>
          <p className="text-sm leading-6 text-[#626874]">
            {presentation.support}. Build and host agents for clients under your own brand.
          </p>
          {available ? (
            <Button asChild className="w-full rounded-full bg-[#202530] text-white hover:bg-[#35405a]">
              <Link to={signupHref()}>
                Choose {plan.name}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button className="w-full rounded-full" variant="outline" disabled>
              Coming soon
            </Button>
          )}
        </div>
      </div>
    </article>
  );
}

function ComparisonRows({ plans }: { plans: Plan[] }) {
  return (
    <>
      {AGENTS_COMPARISON.map((group) => (
        <tbody key={group.label}>
          <tr className="border-b border-[#e7e8ec] bg-[#f7f7f8]">
            <th colSpan={plans.length + 1} className="px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7a808b]">
              {group.label}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.label} className="border-b border-[#e7e8ec] last:border-0">
              <td className="px-5 py-3 text-sm text-[#626874]">{row.label}</td>
              {plans.map((plan) => {
                const cell = row.cell(plan);
                return (
                  <td key={plan.key} className="px-5 py-3 text-sm text-[#171a22]">
                    {cell.kind === "included" ? (
                      <Check className="size-4 text-[#245ed2]" aria-label="Included" />
                    ) : cell.kind === "excluded" ? (
                      <Minus className="size-4 text-[#c2c6cd]" aria-label="Not included" />
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

export function PricingPage() {
  const [data, setData] = useState<PublicPlans | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let live = true;
    fetch("/api/public/plans", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Plans could not be loaded");
        return (await response.json()) as PublicPlans;
      })
      .then((result) => { if (live) setData(result); })
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Plans could not be loaded"); })
      .finally(() => { if (!live) return; });
    return () => { live = false; };
  }, []);

  const plans = [...(data?.plans ?? [])].sort(
    (left, right) => Number(left.amountMinor) - Number(right.amountMinor),
  );
  const reseller = plans.find((plan) => plan.key === "agents-reseller");
  const mainPlans = plans.filter((plan) => plan.key !== "agents-reseller");

  return (
    <div className="min-h-[100dvh] bg-[#fcfbf9] text-[#171a22]">
      <title>Pricing | KasiTek Agents</title>
      <meta name="description" content="Monthly plans for KasiTek Agents. Start free, add handoff, knowledge, inbox tools and unbranded widgets." />
      <header className="sticky top-0 z-20 border-b border-[#e7e8ec] bg-[#fcfbf9]/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-4">
          <Link to="/landingv2" className="text-sm font-semibold tracking-tight">
            Agents <span className="font-normal text-[#7a808b]">by KasiTek</span>
          </Link>
          <nav className="flex items-center gap-3 text-sm" aria-label="Public navigation">
            <Link to="/landingv2#product" className="text-[#626874] hover:text-[#171a22]">Product</Link>
            <Link to="/pricing" className="font-medium">Pricing</Link>
            <Link to="/login" className="text-[#626874] hover:text-[#171a22]">Sign in</Link>
            <Button asChild size="sm" className="rounded-full bg-[#202530] text-white hover:bg-[#35405a]">
              <Link to="/signup?returnTo=%2Fapp%2Fagents">Get started</Link>
            </Button>
          </nav>
        </div>
      </header>

      <main>
        <section className="mx-auto max-w-6xl px-4 pb-8 pt-12 sm:pt-16">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#245ed2]">KasiTek Agents</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">
            Plans for every stage.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[#626874]">
            Start with one agent. Add handoff, knowledge, inbox tools and unbranded widgets as your team grows.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#245ed2]/25 bg-[#e8f0ff] px-3 py-1 font-medium text-[#245ed2]">Free to start</span>
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1 text-[#626874]">Monthly billing</span>
            <span className="rounded-full border border-[#e7e8ec] bg-white px-3 py-1 text-[#626874]">AI usage shown in USD</span>
          </div>
        </section>

        {error ? <p className="mx-auto max-w-6xl px-4 pb-4 text-sm text-red-600" role="alert">{error}</p> : null}

        <section className="mx-auto max-w-6xl px-4" aria-label="Agents plans">
          {!data && !error ? (
            <div className="rounded-2xl border border-[#e7e8ec] bg-white p-6 text-sm text-[#626874]">Loading plans…</div>
          ) : plans.length ? (
            <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
              {mainPlans.map((plan) => <PlanCard key={plan.key} plan={plan} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-[#e7e8ec] bg-white p-6 text-sm text-[#626874]">
              Plans are being configured.
            </div>
          )}
        </section>

        {reseller ? (
          <section className="mx-auto mt-4 max-w-6xl px-4">
            <ResellerCard plan={reseller} />
          </section>
        ) : null}

        {plans.length ? (
          <section className="mx-auto mt-8 max-w-6xl overflow-hidden rounded-2xl border border-[#e7e8ec] bg-white shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_40px_-28px_rgba(16,24,40,.22)]">
            <div className="border-b border-[#e7e8ec] p-5">
              <h2 className="text-lg font-semibold text-[#171a22]">Compare plans</h2>
              <p className="mt-1 text-sm text-[#626874]">Seats, agents, knowledge, inbox tools and branding side by side.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#e7e8ec] bg-[#f7f7f8]">
                    <th className="min-w-[190px] px-5 py-4 text-xs font-medium uppercase tracking-[0.12em] text-[#7a808b]">Plan</th>
                    {plans.map((plan) => (
                      <th key={plan.key} className="min-w-[150px] px-5 py-4 align-bottom">
                        <span className="block text-sm font-semibold text-[#171a22]">{plan.name}</span>
                        <span className="mt-1 block text-xs font-normal text-[#626874]">
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

        <p className="mx-auto mt-6 max-w-6xl px-4 text-xs leading-5 text-[#7a808b]">
          Early access pricing. Plans and limits may change before general availability. Prices exclude VAT where applicable.
        </p>
      </main>

      <footer className="mt-12 border-t border-[#e7e8ec]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 py-6 text-xs text-[#7a808b]">
          <span>© {new Date().getFullYear()} KasiTek</span>
          <nav className="flex flex-wrap gap-4" aria-label="Footer navigation">
            <Link to="/landingv2" className="hover:text-[#171a22]">Agents</Link>
            <Link to="/pricing" className="hover:text-[#171a22]">Pricing</Link>
            <Link to="/login" className="hover:text-[#171a22]">Sign in</Link>
            <a href="https://kasitek.co.za/privacy-policy" className="hover:text-[#171a22]">Privacy</a>
            <a href="https://kasitek.co.za/terms" className="hover:text-[#171a22]">Terms</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
