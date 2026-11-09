import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, ArrowUpRight, Check, Minus, Sparkles } from "lucide-react";

import styles from "./pricing.module.css";
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

function PublicPlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
}) {
  const presentation = presentationFor(plan);
  const isFree = Number(plan.amountMinor) === 0;
  const featured = presentation.recommended === true;
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
        {Number(plan.creditsPerPeriod ?? 0) > 0
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
          <Link to={signupHref()} className={styles.cta} style={{ color: "#f4f2ea" }}>
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

function ResellerCard({
  plan,
  selected,
  onSelect,
}: {
  plan: Plan;
  selected: boolean;
  onSelect: () => void;
}) {
  const presentation = presentationFor(plan);
  const available = plan.checkoutReady;

  return (
    <article
      className={`${styles.card} ${styles.reseller} ${selected ? styles.cardSelected : ""}`}
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
      <div>
        <div className={styles.cardTop}>
          <h2 className={styles.cardName}>{plan.name}</h2>
          <span className={styles.ribbon} style={{ marginBottom: 0 }}>For agencies</span>
        </div>
        <p className={styles.tagline}>{presentation.tagline}</p>
        <dl className={styles.metrics}>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Agents</dt>
            <dd className={styles.metricValue}>{metricNumber(plan, "limit.agent_count")}</dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Channels</dt>
            <dd className={styles.metricValue}>{metricNumber(plan, "limit.agent_channels")}</dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>Crawl / mo</dt>
            <dd className={styles.metricValue}>{metricNumber(plan, "limit.crawl_pages")}</dd>
          </div>
          <div className={styles.metric}>
            <dt className={styles.metricLabel}>AI usage</dt>
            <dd className={styles.metricValue}>{formatUsd(plan.creditsPerPeriod)}</dd>
          </div>
        </dl>
      </div>
      <div className={styles.cardAction}>
        <p className={styles.price}>{formatPrice(plan.amountMinor, plan.currency)}</p>
        <p className={styles.priceNote}>per month · billed monthly · cancel anytime</p>
        {available ? (
          <Link to={signupHref()} className={styles.cta} style={{ color: "#f4f2ea", marginTop: 18 }}>
            <span>Choose {plan.name}</span>
            <ArrowRight size={16} />
          </Link>
        ) : (
          <span className={styles.ctaDisabled} style={{ marginTop: 18 }}>Coming soon</span>
        )}
        <p className={styles.supportLine}>{presentation.support}</p>
      </div>
    </article>
  );
}

function ComparisonRows({ plans }: { plans: Plan[] }) {
  return (
    <>
      {AGENTS_COMPARISON.map((group) => (
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
      .catch((cause) => { if (live) setError(cause instanceof Error ? cause.message : "Plans could not be loaded"); });
    return () => { live = false; };
  }, []);

  const plans = [...(data?.plans ?? [])].sort(
    (left, right) => Number(left.amountMinor) - Number(right.amountMinor),
  );
  const reseller = plans.find((plan) => plan.key === "agents-reseller");
  const mainPlans = plans.filter((plan) => plan.key !== "agents-reseller");
  const [selected, setSelected] = useState<string | null>(null);
  const activeSelection =
    selected ??
    plans.find((plan) => presentationFor(plan).recommended)?.key ??
    plans[0]?.key ??
    null;

  return (
    <div className={styles.page}>
      <header className={styles.nav}>
        <Link to="/landingv2" className={styles.brand} aria-label="KasiTek Agents home">
          kasitek<span>/ agents</span>
        </Link>
        <nav aria-label="Public navigation">
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in<ArrowUpRight size={14} aria-hidden="true" /></Link>
        </nav>
      </header>

      <main>
        <section className={styles.hero}>
          <p className={styles.kicker}>KasiTek Agents</p>
          <h1 className={styles.heading}>Plans for every stage.</h1>
          <p className={styles.intro}>
            Start with one agent. Add handoff, knowledge, inbox tools and unbranded widgets as your team grows.
          </p>
          <div className={styles.actions}>
            <Link to={signupHref()} className={styles.heroCta}>
              Get started <ArrowRight size={18} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        <section className={styles.plansSection} aria-label="Agents plans">
          {!data && !error ? (
            <p className={styles.intro}>Loading plans…</p>
          ) : plans.length ? (
            <>
              <div className={styles.planGrid}>
                {mainPlans.map((plan) => (
                  <PublicPlanCard
                    key={plan.key}
                    plan={plan}
                    selected={activeSelection === plan.key}
                    onSelect={() => setSelected(plan.key)}
                  />
                ))}
              </div>
              {reseller ? (
                <ResellerCard
                  plan={reseller}
                  selected={activeSelection === reseller.key}
                  onSelect={() => setSelected(reseller.key)}
                />
              ) : null}
            </>
          ) : (
            <p className={styles.intro}>Plans are being configured.</p>
          )}
        </section>

        {plans.length ? (
          <section className={styles.compareSection}>
            <h2 className={styles.sectionTitle}>Compare plans</h2>
            <p className={styles.sectionCopy}>Seats, agents, knowledge, inbox tools and branding side by side.</p>
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

      <footer className={styles.footer}>
        <span>© {new Date().getFullYear()} KasiTek</span>
        <nav aria-label="Footer navigation">
          <Link to="/landingv2">Agents</Link>
          <Link to="/pricing">Pricing</Link>
          <Link to="/login">Sign in</Link>
          <a href="https://kasitek.co.za/privacy-policy">Privacy</a>
          <a href="https://kasitek.co.za/terms">Terms</a>
        </nav>
      </footer>
    </div>
  );
}
