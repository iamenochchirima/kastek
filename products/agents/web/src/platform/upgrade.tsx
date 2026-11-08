import { Link } from "react-router-dom";
import { PiArrowLeft as ArrowLeft, PiCheck as Check, PiStar as Star } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { useWorkspace } from "./shell";
import {
  money,
  usd,
  useBillingData,
  type Plan,
} from "./billing-settings";
import "./management.css";
import "./workspace-surfaces.css";

function limitValue(plan: Plan, key: string) {
  return plan.entitlements.find((item) => item.key === key)?.value;
}

function numberValue(value: unknown): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

function limitLabel(value: unknown, unit: string | null, fallback: string) {
  const number = numberValue(value);
  if (number === null) return fallback;
  return `${number.toLocaleString()}${unit ? ` ${unit}` : ""}`;
}

function planFeatures(plan: Plan) {
  return plan.entitlements.filter(
    (item) => item.kind === "feature" && item.value === true,
  );
}

function PlanCard({
  plan,
  current,
  recommended,
  busy,
  onChoose,
}: {
  plan: Plan;
  current: boolean;
  recommended: boolean;
  busy: boolean;
  onChoose: (planKey: string) => void;
}) {
  const features = planFeatures(plan);
  const agentLimit = limitValue(plan, "limit.agent_count");
  const channelLimit = limitValue(plan, "limit.agent_channels");
  const tokenLimit = limitValue(plan, "limit.agent_tokens");
  return (
    <article className={`relative flex h-full flex-col rounded-2xl border bg-card p-5 shadow-[var(--shadow-panel)] ${current ? "border-primary/50 ring-1 ring-primary/20" : recommended ? "border-primary/35" : "border-border"}`}>
      {recommended && !current ? (
        <div className="absolute -top-3 left-5 flex items-center gap-1.5 rounded-full bg-primary px-3 py-1 text-[11px] font-semibold text-primary-foreground shadow">
          <Star className="size-3" />Most popular
        </div>
      ) : null}
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{plan.name}</h2>
          {plan.description ? <p className="mt-1 text-sm text-muted-foreground">{plan.description}</p> : null}
        </div>
        {current ? <span className="shrink-0 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">Current</span> : null}
      </div>

      <div className="mt-6">
        <p className="text-3xl font-semibold tracking-[-0.04em] text-foreground">
          {money(plan.amountMinor, plan.currency)}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">per month · billed monthly</p>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {agentLimit !== undefined ? <span className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">{limitLabel(agentLimit, "agents", "Agents")}</span> : null}
        {channelLimit !== undefined ? <span className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">{limitLabel(channelLimit, "channels", "Channels")}</span> : null}
        <span className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">{usd(plan.creditsPerPeriod)} AI usage</span>
        {tokenLimit !== undefined ? <span className="rounded-full border border-border bg-secondary/40 px-2.5 py-1 text-xs text-foreground">{limitLabel(tokenLimit, "tokens", "Tokens")}</span> : null}
      </div>

      <div className="mt-5 border-t border-border pt-4">
        <p className="text-sm font-semibold text-foreground">Features</p>
        <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
          {features.length ? features.map((feature) => (
            <li key={feature.key} className="flex items-start gap-2">
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
              <span>{feature.name}</span>
            </li>
          )) : <li>Agents workspace</li>}
        </ul>
      </div>

      <div className="mt-auto space-y-2 pt-6">
        <Button
          className="w-full"
          variant={current ? "outline" : recommended ? "default" : "outline"}
          disabled={current || busy || !plan.checkoutReady}
          onClick={() => onChoose(plan.key)}
        >
          {current ? "Current plan" : busy ? "Opening…" : plan.checkoutReady ? `Choose ${plan.name}` : "Checkout unavailable"}
        </Button>
        <p className="text-center text-[11px] text-muted-foreground">Cancel anytime. No setup fees.</p>
        <p className="text-center text-[11px] text-muted-foreground">Secure checkout via Paystack</p>
      </div>
    </article>
  );
}

export function UpgradePage() {
  const { organizationId } = useWorkspace();
  const { data, error, notice, checkoutBusy, startCheckout } = useBillingData(organizationId);
  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const plans = [...(data?.plans ?? [])].sort(
    (left, right) => Number(left.amountMinor) - Number(right.amountMinor),
  );
  const recommended = plans.find((plan) => Number(plan.amountMinor) > 0)?.key;

  return (
    <section className="management-page max-w-6xl">
      <header className="management-header">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1>Upgrade your plan</h1>
            <p className="mt-1 text-sm text-muted-foreground">More agents, channels and AI usage as your workspace grows.</p>
          </div>
          <Button asChild variant="outline" size="sm">
            <Link to="/app/settings?section=billing"><ArrowLeft className="size-4" />Billing</Link>
          </Button>
        </div>
        <div className="mt-4">
          <span className="inline-flex rounded-full border border-primary/25 bg-primary/5 px-3 py-1 text-xs font-medium text-primary">
            Currently on {subscription?.planName ?? "Free"}
          </span>
        </div>
      </header>

      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm text-primary">{notice}</p> : null}
      {!data ? <p className="mt-6 text-sm text-muted-foreground">Loading plans…</p> : null}

      {data ? (
        <>
          <div className="mt-7 grid items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3">
            {plans.map((plan) => (
              <PlanCard
                key={plan.key}
                plan={plan}
                current={plan.key === subscription?.planKey}
                recommended={plan.key === recommended}
                busy={checkoutBusy === plan.key}
                onChoose={(planKey) => void startCheckout(planKey)}
              />
            ))}
          </div>

          <section className="mt-6 overflow-hidden rounded-2xl border border-border bg-card shadow-[var(--shadow-panel)]">
            <div className="border-b border-border p-5">
              <h2 className="text-base font-semibold text-foreground">Compare plans</h2>
              <p className="mt-1 text-sm text-muted-foreground">Agents, channels, AI usage and token allowances.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-border text-xs text-muted-foreground">
                  <tr>
                    <th className="px-5 py-3 font-medium">Plan</th>
                    {plans.map((plan) => <th key={plan.key} className="px-5 py-3 font-medium">{plan.name}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  <tr><td className="px-5 py-3 text-muted-foreground">Price</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 font-medium text-foreground">{money(plan.amountMinor, plan.currency)}</td>)}</tr>
                  <tr><td className="px-5 py-3 text-muted-foreground">AI usage</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 text-foreground">{usd(plan.creditsPerPeriod)}</td>)}</tr>
                  <tr><td className="px-5 py-3 text-muted-foreground">Agents</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 text-foreground">{limitLabel(limitValue(plan, "limit.agent_count"), "agents", "—")}</td>)}</tr>
                  <tr><td className="px-5 py-3 text-muted-foreground">Channels</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 text-foreground">{limitLabel(limitValue(plan, "limit.agent_channels"), "channels", "—")}</td>)}</tr>
                  <tr><td className="px-5 py-3 text-muted-foreground">Tokens</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 text-foreground">{limitLabel(limitValue(plan, "limit.agent_tokens"), "tokens", "—")}</td>)}</tr>
                  <tr><td className="px-5 py-3 text-muted-foreground">Features</td>{plans.map((plan) => <td key={plan.key} className="px-5 py-3 text-muted-foreground">{planFeatures(plan).map((feature) => feature.name).join(", ") || "Agents workspace"}</td>)}</tr>
                </tbody>
              </table>
            </div>
          </section>
        </>
      ) : null}
    </section>
  );
}
