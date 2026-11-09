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
import "./landing-v2.css";
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
        "flex h-full flex-col overflow-hidden rounded-2xl border bg-[#fffdf8] shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_40px_-28px_rgba(16,24,40,.22)]",
        presentation.recommended ? "border-[#245ed2]/40" : "border-[#e7e2d8]",
      )}
    >
      {presentation.recommended ? (
        <div className="bg-[#202530] px-5 py-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-white">
          {presentation.ribbon ?? "Most popular"}
        </div>
      ) : null}
      <div className="flex flex-1 flex-col p-5">
        <h2 className="text-lg font-semibold tracking-tight text-[#171a22]">{plan.name}</h2>
        <p className="mt-1 text-sm leading-5 text-[#6b6b64]">{presentation.tagline}</p>

        <div className="mt-6 flex items-end gap-1.5">
          <p className="text-4xl font-semibold tracking-[-0.05em] text-[#171a22]">
            {formatPrice(plan.amountMinor, plan.currency)}
          </p>
          <p className="pb-1 text-xs text-[#6b6b64]">/ month</p>
        </div>
        <p className="mt-1 text-xs text-[#6b6b64]">Billed monthly. Cancel anytime.</p>

        <div className="mt-4 inline-flex w-fit items-center gap-1.5 rounded-full border border-[#e7e2d8] bg-[#f1ece2] px-2.5 py-1 text-xs text-[#171a22]">
          <Sparkle className="size-3.5 text-[#245ed2]" />
          {Number(plan.creditsPerPeriod ?? 0) > 0
            ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
            : "No AI usage"}
        </div>

        <dl className="mt-5 grid grid-cols-2 gap-2">
          {metrics.map((metric) => (
            <div key={metric.label} className="rounded-lg border border-[#e7e2d8] bg-[#f7f3ea] px-2.5 py-2">
              <dt className="text-[10px] uppercase tracking-[0.1em] text-[#7a766c]">{metric.label}</dt>
              <dd className="mt-0.5 text-sm font-semibold text-[#171a22]">{metric.value}</dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 border-t border-[#e7e2d8] pt-4">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#7a766c]">Includes</p>
          <ul className="mt-3 space-y-2">
            {features.map((feature) => (
              <li key={feature.label} className="flex items-start gap-2 text-sm text-[#6b6b64]">
                <Check className="mt-0.5 size-4 shrink-0 text-[#245ed2]" />
                <span>{feature.label}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-auto pt-5">
          {available ? (
            <Button asChild className="w-full rounded-full bg-[#202530] text-white hover:bg-[#35405a]">
              <Link to={signupHref()} style={{ color: "#fff" }}>
                {isFree ? "Get started" : `Choose ${plan.name}`}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          ) : (
            <Button className="w-full rounded-full" variant="outline" disabled>
              Coming soon
            </Button>
          )}
          <p className="mt-2 text-center text-[11px] text-[#7a766c]">{presentation.support}</p>
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
          <p className="mt-2 max-w-xl text-sm leading-6 text-[#6b6b64]">{presentation.tagline}</p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1">{metricNumber(plan, "limit.agent_count")} agents</span>
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1">{metricNumber(plan, "limit.agent_channels")} channels</span>
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1">{metricNumber(plan, "limit.crawl_pages")} crawl pages / mo</span>
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1">{formatUsd(plan.creditsPerPeriod)} AI usage</span>
          </div>
        </div>
        <div className="space-y-3 lg:border-l lg:border-[#e7e2d8] lg:pl-6">
          <p className="text-3xl font-semibold tracking-[-0.04em] text-[#171a22]">
            {formatPrice(plan.amountMinor, plan.currency)}
            <span className="ml-1 text-sm font-normal text-[#6b6b64]">/ month</span>
          </p>
          <p className="text-sm leading-6 text-[#6b6b64]">
            {presentation.support}. Build and host agents for clients under your own brand.
          </p>
          {available ? (
            <Button asChild className="w-full rounded-full bg-[#202530] text-white hover:bg-[#35405a]">
              <Link to={signupHref()} style={{ color: "#fff" }}>
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
          <tr className="border-b border-[#e7e2d8] bg-[#f1ece2]">
            <th colSpan={plans.length + 1} className="px-5 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.14em] text-[#7a766c]">
              {group.label}
            </th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.label} className="border-b border-[#e7e2d8] last:border-0">
              <td className="px-5 py-3 text-sm text-[#6b6b64]">{row.label}</td>
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
    <div className="landing-v2">
      <title>Pricing | KasiTek Agents</title>
      <meta name="description" content="Monthly plans for KasiTek Agents. Start free, add handoff, knowledge, inbox tools and unbranded widgets." />
      <header className="lv2-header mt-7">
        <Link to="/landingv2" className="lv2-brand" aria-label="Agents home">
          Agents <small>by KasiTek</small>
        </Link>
        <nav className="lv2-desktop-nav" aria-label="Product navigation">
          <Link to="/landingv2#product">Product</Link>
          <Link to="/landingv2#personal">Personal</Link>
          <Link to="/pricing">Pricing</Link>
        </nav>
        <div className="lv2-header-actions">
          <Link to="/login" className="lv2-signin">Sign in</Link>
          <Button asChild className="lv2-button is-dark">
            <Link to="/signup?returnTo=%2Fapp%2Fagents">Get started</Link>
          </Button>
        </div>
      </header>

      <main>
        <section className="lv2-container pb-8 pt-12 sm:pt-16">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#245ed2]">KasiTek Agents</p>
          <h1 className="mt-3 max-w-2xl text-4xl font-semibold tracking-[-0.05em] sm:text-5xl">
            Plans for every stage.
          </h1>
          <p className="mt-4 max-w-xl text-base leading-7 text-[#6b6b64]">
            Start with one agent. Add handoff, knowledge, inbox tools and unbranded widgets as your team grows.
          </p>
          <div className="mt-5 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full border border-[#245ed2]/25 bg-[#e8f0ff] px-3 py-1 font-medium text-[#245ed2]">Free to start</span>
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1 text-[#6b6b64]">Monthly billing</span>
            <span className="rounded-full border border-[#e7e2d8] bg-[#fffdf8] px-3 py-1 text-[#6b6b64]">AI usage shown in USD</span>
          </div>
        </section>

        {error ? <p className="mx-auto max-w-6xl px-4 pb-4 text-sm text-red-600" role="alert">{error}</p> : null}

        <section className="lv2-container" aria-label="Agents plans">
          {!data && !error ? (
            <div className="rounded-2xl border border-[#e7e2d8] bg-[#fffdf8] p-6 text-sm text-[#6b6b64]">Loading plans…</div>
          ) : plans.length ? (
            <div className="grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-4">
              {mainPlans.map((plan) => <PlanCard key={plan.key} plan={plan} />)}
            </div>
          ) : (
            <div className="rounded-2xl border border-[#e7e2d8] bg-[#fffdf8] p-6 text-sm text-[#6b6b64]">
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
          <section className="mx-auto mt-8 max-w-6xl overflow-hidden rounded-2xl border border-[#e7e2d8] bg-[#fffdf8] shadow-[0_1px_2px_rgba(16,24,40,.04),0_18px_40px_-28px_rgba(16,24,40,.22)]">
            <div className="border-b border-[#e7e2d8] p-5">
              <h2 className="text-lg font-semibold text-[#171a22]">Compare plans</h2>
              <p className="mt-1 text-sm text-[#6b6b64]">Seats, agents, knowledge, inbox tools and branding side by side.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead>
                  <tr className="border-b border-[#e7e2d8] bg-[#f1ece2]">
                    <th className="min-w-[190px] px-5 py-4 text-xs font-medium uppercase tracking-[0.12em] text-[#7a766c]">Plan</th>
                    {plans.map((plan) => (
                      <th key={plan.key} className="min-w-[150px] px-5 py-4 align-bottom">
                        <span className="block text-sm font-semibold text-[#171a22]">{plan.name}</span>
                        <span className="mt-1 block text-xs font-normal text-[#6b6b64]">
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

        <p className="lv2-container mt-6 text-xs leading-5 text-[#7a766c]">
          Early access pricing. Plans and limits may change before general availability. Prices exclude VAT where applicable.
        </p>
      </main>

      <footer className="lv2-footer lv2-container">
        <Link to="/landingv2" className="lv2-footer-brand">Agents <small>by KasiTek</small></Link>
        <nav aria-label="Footer navigation">
          <Link to="/landingv2">Product</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in</Link>
        </nav>
        <div className="lv2-footer-legal">
          <a href="https://kasitek.co.za/privacy-policy">Privacy</a>
          <a href="https://kasitek.co.za/terms">Terms</a>
        </div>
      </footer>
    </div>
  );
}
