import { useState } from "react";
import { Link } from "react-router";
import { ArrowRight, ArrowUpRight, Check, Minus, Sparkles } from "lucide-react";

import landing from "@/app/landing.module.css";
import styles from "./public-pricing.module.css";
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

function PublicPlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: AvailablePlan;
  selected: boolean;
  onSelect: () => void;
}) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor ?? 0) === 0;
  const featured = presentation.recommended === true;
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
      className={`${styles.card} ${featured ? styles.cardFeatured : ""} ${selected ? styles.cardSelected : ""}`}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onSelect();
        }
      }}
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      style={{ cursor: "pointer" }}
    >
      {featured ? <span className={styles.ribbon}>{presentation.ribbon ?? "Most popular"}</span> : null}
      <div className={styles.cardTop}>
        <h2 className={styles.cardName}>{plan.name}</h2>
      </div>
      <p className={styles.tagline}>{presentation.tagline}</p>

      <p className={styles.price}>{formatPrice(plan.amountMinor, plan.currency)}</p>
      <p className={styles.priceNote}>per month · billed monthly · cancel anytime</p>

      <span className={styles.aiLine}>
        <Sparkles className={styles.check} size={13} />
        {plan.creditsPerPeriod && plan.creditsPerPeriod > 0
          ? `${formatUsd(plan.creditsPerPeriod)} AI usage`
          : "No AI usage"}
      </span>

      <dl className={styles.metrics}>
        {metrics.map((metric) => (
          <div key={metric.label} className={styles.metric}>
            <dt className={styles.metricLabel}>{metric.label}</dt>
            <dd className={styles.metricValue}>{metric.value}</dd>
          </div>
        ))}
      </dl>

      <ul className={styles.features}>
        {features.map((feature) => (
          <li key={feature.label} className={styles.feature}>
            <Check className={styles.check} size={15} />
            <span>{feature.label}</span>
          </li>
        ))}
      </ul>

      <div className={styles.cardAction}>
        {available ? (
          <Link
            to={signupHref(plan)}
            className={styles.cta}
          >
            <span>{isFree ? "Get started" : `Choose ${plan.name}`}</span>
            <ArrowRight size={16} />
          </Link>
        ) : (
          <span className={styles.ctaDisabled}>Coming soon</span>
        )}
        <p className={styles.supportLine}>{presentation.support}</p>
      </div>
    </article>
  );
}

function ComparisonRows({ plans }: { plans: AvailablePlan[] }) {
  return (
    <>
      {GROWTH_COMPARISON.map((group) => (
        <tbody key={group.label}>
          <tr className={styles.groupRow}>
            <th colSpan={plans.length + 1}>{group.label}</th>
          </tr>
          {group.rows.map((row) => (
            <tr key={row.label}>
              <td className={styles.cellLabel}>{row.label}</td>
              {plans.map((plan) => {
                const cell = row.cell(plan);
                return (
                  <td key={plan.key}>
                    {cell.kind === "included" ? (
                      <Check className={styles.check} size={16} aria-label="Included" />
                    ) : cell.kind === "excluded" ? (
                      <Minus size={16} color="#b7b3a8" aria-label="Not included" />
                    ) : (
                      cell.value
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
  const [selected, setSelected] = useState<string | null>(
    () =>
      plans.find((plan) => presentationFor(plan).recommended)?.key ??
      plans[0]?.key ??
      null,
  );

  return (
    <div className={landing.landing}>
      <header className={landing.nav}>
        <Link to="/" className={landing.brand} aria-label="KasiTek Growth home">
          kasitek<span>/ growth</span>
        </Link>
        <nav aria-label="Public navigation">
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in<ArrowUpRight size={14} aria-hidden="true" /></Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <p className={landing.kicker}>KasiTek Growth</p>
          <h1 className={styles.heading}>Plans for every stage.</h1>
          <p className={landing.intro}>
            Start with the inbox. Add campaigns, content and workspace agents when you need them.
          </p>
          <div className={landing.actions}>
            <Link to="/signup" className={landing.cta}>
              Get started <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </section>

        <section className={styles.plansSection} aria-label="Growth plans">
          {plans.length ? (
            <div className={styles.planGrid}>
              {plans.map((plan) => (
                <PublicPlanCard
                  key={plan.key}
                  plan={plan}
                  selected={selected === plan.key}
                  onSelect={() => setSelected(plan.key)}
                />
              ))}
            </div>
          ) : (
            <p className={landing.intro}>
              {configured ? "No plans are available right now." : "Plans are being configured."}
            </p>
          )}
        </section>

        {plans.length ? (
          <section className={styles.compareSection}>
            <h2 className={styles.sectionTitle}>Compare plans</h2>
            <p className={styles.sectionCopy}>Seats, volume, features and support side by side.</p>
            <div className={styles.tableWrap}>
              <table className={styles.table}>
                <thead>
                  <tr>
                    <th>Plan</th>
                    {plans.map((plan) => (
                      <th key={plan.key}>
                        <span className={styles.planHeading}>{plan.name}</span>
                        <span className={styles.planPrice}>
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

        <p className={styles.note}>
          Early access pricing. Plans and limits may change before general availability. Prices exclude VAT where applicable.
        </p>
      </main>

      <footer className={landing.footer}>
        <span>© {new Date().getFullYear()} KasiTek</span>
        <nav aria-label="Footer navigation">
          <Link to="/">Growth</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in</Link>
          <a href="https://kasitek.co.za/privacy-policy">Privacy</a>
          <a href="https://kasitek.co.za/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
