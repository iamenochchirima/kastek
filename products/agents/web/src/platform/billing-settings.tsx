import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { HugeiconsIcon } from "@hugeicons/react";
import { Alert02Icon } from "@hugeicons/core-free-icons";
import { billingAllowance } from "@kasitek-labs/ui/billing-allowance";
import { PiArrowClockwise as RefreshCw } from "react-icons/pi";
import { Button } from "@/components/ui/button";
import { api, organizationPath } from "./api";
import "./management.css";
import "./workspace-surfaces.css";

type Invoice = {
  invoiceNumber: string;
  status: string;
  currency: string;
  totalMinor: string;
  issuedAt: string;
  paidAt: string | null;
  planKey: string | null;
  product: string | null;
};

export type Plan = {
  key: string;
  name: string;
  description: string | null;
  product: string;
  currency: string;
  amountMinor: string;
  creditsPerPeriod: string | null;
  checkoutReady: boolean;
  entitlements: Array<{
    key: string;
    name: string;
    description: string | null;
    kind: "feature" | "limit";
    value: unknown;
    unit: string | null;
    displayGroup: string | null;
    displayOrder: number;
  }>;
};

type Subscription = {
  id: string;
  product: string;
  planKey: string;
  planName: string;
  status: string;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

type Usage = {
  from: string;
  to: string;
  creditsUsed: string;
  operations: string;
  daily: Array<{ date: string; creditsUsed: string; operations: string }>;
  previousDaily: Array<{ date: string; creditsUsed: string; operations: string }>;
  breakdown: Array<{ meterKey: string; creditsUsed: string; operations: string }>;
  credits: { balance: string; reserved: string; available: string };
  grants: Array<{
    id: string;
    source: string;
    amount: string;
    remainingAmount: string;
    startsAt: string;
    endsAt: string | null;
    reference: string | null;
  }>;
};

export type Billing = {
  configured: boolean;
  account: {
    account?: { currency?: string; billing_email?: string };
    subscriptions?: Subscription[];
    credits?: { balance: string; reserved: string; available: string };
    invoices?: Invoice[];
    issues?: Array<{ id: string; issueType: string; status: string; createdAt: string }>;
  } | null;
  invoices: Invoice[];
  plans: Plan[];
  usage?: Usage | null;
  snapshot?: {
    plan?: { key: string; name: string; version: number } | null;
    subscription?: { status: string; currentPeriodEnd: string | null } | null;
    meters?: Record<string, { used: string; limit: string | null }>;
  } | null;
  modelUsage?: Array<{
    provider: string;
    model: string;
    requests: number;
    inputTokens: number;
    outputTokens: number;
    costMicros: number;
  }>;
};

export function money(amountMinor: string | number | null, currency: string) {
  if (amountMinor === null) return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amountMinor) / 100);
}

export function usd(microUsd: string | number | null | undefined) {
  if (microUsd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(microUsd) / 1_000_000);
}

function date(value: string | null) {
  return value
    ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" })
    : "—";
}

function statusLabel(value: string | null | undefined) {
  if (!value) return "No active plan";
  return value.replaceAll("_", " ").toLowerCase().replace(/^\w/, (letter) => letter.toUpperCase());
}

export function useBillingData(organizationId: string) {
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState("");
  const verified = useRef(false);

  async function refresh() {
    setError("");
    try {
      const result = await api<Billing>(`${organizationPath(organizationId)}/billing`);
      setData(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Billing could not be loaded");
    }
  }

  useEffect(() => {
    let active = true;
    setData(null);
    setError("");
    const params = new URLSearchParams(window.location.search);
    const reference = params.get("reference");
    const payment = params.get("payment");
    const verification =
      payment === "complete" && reference && !verified.current
        ? (verified.current = true,
          api(
            `${organizationPath(organizationId)}/billing/checkout/${encodeURIComponent(reference)}/verify`,
            {},
            "POST",
          )
            .then(() => setNotice("Payment received. Your plan will update shortly."))
            .catch((cause) =>
              setError(cause instanceof Error ? cause.message : "Payment could not be verified"),
            )
            .finally(() => {
              params.delete("payment");
              params.delete("reference");
              params.delete("trxref");
              const query = params.toString();
              window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
            }))
        : Promise.resolve();
    void verification
      .then(() =>
        api<Billing>(`${organizationPath(organizationId)}/billing`)
          .then((result) => {
            if (active) setData(result);
          })
          .catch((cause) => {
            if (active) setError(cause instanceof Error ? cause.message : "Billing could not be loaded");
          }),
      );
    return () => {
      active = false;
    };
  }, [organizationId]);

  async function startCheckout(planKey: string) {
    setCheckoutBusy(planKey);
    setError("");
    setNotice("");
    try {
      const result = await api<{ authorizationUrl: string }>(
        `${organizationPath(organizationId)}/billing/checkout`,
        { planKey, idempotencyKey: crypto.randomUUID() },
        "POST",
      );
      window.location.assign(result.authorizationUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checkout could not be started");
      setCheckoutBusy("");
    }
  }

  return { data, error, notice, checkoutBusy, startCheckout, refresh };
}

export function BillingSettings({ organizationId }: { organizationId: string }) {
  const { data, error, notice, refresh } = useBillingData(organizationId);
  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const invoices = data?.invoices ?? account?.invoices ?? [];

  return (
    <div className="space-y-5">
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-sm text-primary">{notice}</p> : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">Loading billing…</p> : null}
      {data && !data.configured ? (
        <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
          <p className="text-sm text-muted-foreground">Billing is not configured.</p>
        </section>
      ) : null}

      {data?.configured ? (
        <>
          <section className="overflow-hidden rounded-xl border border-border bg-card shadow-[var(--shadow-panel)]">
            <div className="flex flex-wrap items-start justify-between gap-5 border-b border-border bg-gradient-to-br from-primary/10 via-card to-card p-5">
              <div>
                <p className="text-xs font-medium uppercase tracking-[0.14em] text-primary">Current plan</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <h2 className="text-2xl font-semibold tracking-[-0.03em] text-foreground">
                    {subscription?.planName ?? "Free workspace"}
                  </h2>
                  <span className="rounded-full border border-border bg-background px-2 py-0.5 text-xs capitalize text-muted-foreground">
                    {statusLabel(subscription?.status)}
                  </span>
                </div>
                <p className="mt-2 text-sm text-muted-foreground">
                  {subscription?.cancelAtPeriodEnd
                    ? `Access ends ${date(subscription.currentPeriodEnd)}`
                    : subscription?.currentPeriodEnd
                      ? `Renews ${date(subscription.currentPeriodEnd)}`
                      : "No renewal date"}
                </p>
              </div>
              <div className="flex flex-col items-end gap-3">
                <div className="rounded-lg border border-border bg-background/60 p-4 text-right">
                  <p className="text-xs text-muted-foreground">AI usage available</p>
                  <p className="mt-1 text-2xl font-semibold text-foreground">
                    {usd(account?.credits?.available)}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {usd(account?.credits?.reserved)} reserved
                  </p>
                </div>
                <Button asChild variant="outline" size="sm"><Link to="/app/upgrade">Change plan</Link></Button>
              </div>
            </div>
            <div className="grid gap-3 p-5 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="text-xs text-muted-foreground">Billing email</p>
                <p className="mt-1 break-all text-sm font-medium text-foreground">{account?.account?.billing_email ?? "—"}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="text-xs text-muted-foreground">AI usage used</p>
                <p className="mt-1 text-lg font-semibold text-foreground">{usd(data.usage?.creditsUsed)}</p>
              </div>
              <div className="flex items-end justify-end">
                <Button type="button" variant="outline" size="sm" onClick={() => void refresh()}>
                  <RefreshCw className="size-3.5" />Refresh
                </Button>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <h2 className="text-base font-semibold text-foreground">Invoices</h2>
            <p className="mt-1 text-sm text-muted-foreground">Your billing documents.</p>
            {invoices.length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Invoice</th>
                      <th className="px-3 py-2 font-medium">Issued</th>
                      <th className="px-3 py-2 text-right font-medium">Total</th>
                      <th className="px-3 py-2 text-right font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {invoices.map((invoice) => (
                      <tr key={invoice.invoiceNumber}>
                        <td className="px-3 py-3 font-mono text-xs">{invoice.invoiceNumber}</td>
                        <td className="px-3 py-3 text-muted-foreground">{date(invoice.issuedAt)}</td>
                        <td className="px-3 py-3 text-right">{money(invoice.totalMinor, invoice.currency)}</td>
                        <td className="px-3 py-3 text-right capitalize text-muted-foreground">{invoice.status.replaceAll("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-4 text-sm text-muted-foreground">No invoices yet</p>
            )}
          </section>

          {account?.issues?.length ? (
            <section className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-5">
              <h2 className="text-sm font-semibold text-amber-700">Open billing issues</h2>
              <div className="mt-2 space-y-1 text-sm text-amber-700">
                {account.issues.map((issue) => (
                  <p key={issue.id}>{issue.issueType.replaceAll("_", " ")} · {date(issue.createdAt)}</p>
                ))}
              </div>
            </section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function UsageBars({ daily }: { daily: Usage["daily"] }) {
  const rows = daily.slice(-30);
  const max = Math.max(...rows.map((day) => Number(day.creditsUsed)), 1);
  if (!rows.length) return <p className="mt-4 text-sm text-muted-foreground">No usage in this period.</p>;
  return (
    <div className="mt-5 flex h-44 items-end gap-1 overflow-x-auto rounded-lg border border-border bg-background/40 p-4">
      {rows.map((day) => {
        const value = Number(day.creditsUsed);
        return (
          <div
            key={day.date}
            className="flex h-full min-w-2 flex-1 items-end"
            title={`${date(day.date)} · ${usd(day.creditsUsed)} · ${Number(day.operations).toLocaleString()} operations`}
          >
            <div
              className="w-full rounded-t bg-primary/80 transition-colors hover:bg-primary"
              style={{ height: `${Math.max(value > 0 ? 4 : 0, (value / max) * 100)}%` }}
            />
          </div>
        );
      })}
    </div>
  );
}

export function UsageSettings({ organizationId }: { organizationId: string }) {
  const { data, error } = useBillingData(organizationId);
  const usage = data?.usage;
  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const tokenMeter = data?.snapshot?.meters?.agent_tokens;
  const modelRequests = (data?.modelUsage ?? []).reduce((sum, item) => sum + item.requests, 0);
  const allowance = billingAllowance({
    used: usage ? Number(usage.creditsUsed) : 0,
    available: usage ? Number(usage.credits.available) : 0,
  });

  return (
    <div className="space-y-5">
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">Loading usage…</p> : null}
      {!usage ? null : (
        <>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
              <p className="text-xs text-muted-foreground">AI usage</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{usd(usage.creditsUsed)}</p>
              <p className="mt-1 text-xs text-muted-foreground">in the last 30 days</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
              <p className="text-xs text-muted-foreground">Model requests</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{modelRequests.toLocaleString()}</p>
              <p className="mt-1 text-xs text-muted-foreground">Across all models</p>
            </div>
            <div className="rounded-xl border border-border bg-card p-4 shadow-[var(--shadow-panel)]">
              <p className="text-xs text-muted-foreground">Tokens</p>
              <p className="mt-2 text-2xl font-semibold tracking-tight text-foreground">{tokenMeter ? Number(tokenMeter.used).toLocaleString() : "—"}</p>
              <p className="mt-1 text-xs text-muted-foreground">Accounted model tokens</p>
            </div>
          </div>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            {allowance.exhausted ? (
              <div role="alert" className="mb-5 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
                <div className="flex items-start gap-3">
                  <HugeiconsIcon icon={Alert02Icon} size={16} className="mt-0.5 shrink-0 text-destructive" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-destructive">AI usage allowance used up</p>
                    <p className="mt-1 text-sm text-destructive">
                      New AI requests are blocked until the next billing period.{" "}
                      <Link className="font-medium underline underline-offset-2" to="/app/upgrade">View plans</Link>
                    </p>
                  </div>
                </div>
              </div>
            ) : allowance.approaching ? (
              <div role="status" className="mb-5 rounded-lg border border-status-attention/30 bg-status-attention-soft p-4">
                <div className="flex items-start gap-3">
                  <HugeiconsIcon icon={Alert02Icon} size={16} className="mt-0.5 shrink-0 text-status-attention" aria-hidden="true" />
                  <div>
                    <p className="text-sm font-medium text-status-attention">AI usage at {allowance.percent}%</p>
                    <p className="mt-1 text-sm text-status-attention">
                      New AI requests stop at 100%.{" "}
                      <Link className="font-medium underline underline-offset-2" to="/app/upgrade">View plans</Link>
                    </p>
                  </div>
                </div>
              </div>
            ) : null}
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">AI usage and limits</h2>
                <p className="mt-1 text-sm text-muted-foreground">{subscription?.planName ?? data.snapshot?.plan?.name ?? "Free workspace"} · {subscription?.currentPeriodEnd ? `Renews ${date(subscription.currentPeriodEnd)}` : "No renewal date"}</p>
              </div>
              <p className="text-sm font-medium text-foreground">{usd(usage.credits.available)} available</p>
            </div>
            <div className="mt-5 rounded-lg border border-border bg-background/40 p-4">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span className="font-medium text-foreground">AI usage</span>
                <span className="text-muted-foreground">{usd(usage.creditsUsed)} used</span>
              </div>
              <div className="mt-3 h-2 overflow-hidden rounded-full bg-secondary">
                <div className={allowance.exhausted ? "h-full rounded-full bg-destructive" : allowance.approaching ? "h-full rounded-full bg-status-attention" : "h-full rounded-full bg-primary"} style={{ width: `${allowance.percent}%` }} />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">{usd(usage.credits.reserved)} reserved</p>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <div>
              <h2 className="text-base font-semibold text-foreground">Daily AI usage</h2>
              <p className="mt-1 text-sm text-muted-foreground">{date(usage.from)} – {date(usage.to)}</p>
            </div>
            <UsageBars daily={usage.daily} />
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <h2 className="text-base font-semibold text-foreground">Usage by meter</h2>
            {usage.breakdown.length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[520px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr><th className="px-3 py-2 font-medium">Meter</th><th className="px-3 py-2 text-right font-medium">Operations</th><th className="px-3 py-2 text-right font-medium">AI usage</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {usage.breakdown.map((item) => (
                      <tr key={item.meterKey}>
                        <td className="px-3 py-2 font-medium capitalize text-foreground">{item.meterKey.replaceAll("_", " ")}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{Number(item.operations).toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-foreground">{usd(item.creditsUsed)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="mt-3 text-sm text-muted-foreground">No usage in this period.</p>}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">Usage by model</h2>
                <p className="mt-1 text-sm text-muted-foreground">Includes free models and zero-cost requests.</p>
              </div>
              <span className="text-xs text-muted-foreground">{(data.modelUsage ?? []).length} models</span>
            </div>
            {data.modelUsage?.length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[620px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Model</th>
                      <th className="px-3 py-2 text-right font-medium">Requests</th>
                      <th className="px-3 py-2 text-right font-medium">Input</th>
                      <th className="px-3 py-2 text-right font-medium">Output</th>
                      <th className="px-3 py-2 text-right font-medium">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {data.modelUsage.map((item) => (
                      <tr key={`${item.provider}:${item.model}`}>
                        <td className="px-3 py-2">
                          <p className="font-medium text-foreground">{item.model}</p>
                          <p className="text-xs text-muted-foreground">{item.provider}</p>
                        </td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{item.requests.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{item.inputTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{item.outputTokens.toLocaleString()}</td>
                        <td className="px-3 py-2 text-right text-foreground">{usd(item.costMicros)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="mt-3 text-sm text-muted-foreground">No model usage recorded.</p>}
          </section>

          {usage.grants?.length ? (
            <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold text-foreground">AI usage grants</h2>
                <span className="text-xs text-muted-foreground">{usd(usage.credits.available)} available</span>
              </div>
              <div className="mt-3 divide-y divide-border">
                {usage.grants.slice(0, 5).map((grant) => (
                  <div key={grant.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <div><p className="font-medium capitalize text-foreground">{grant.source.replaceAll("_", " ")}</p><p className="text-xs text-muted-foreground">{grant.endsAt ? `Expires ${date(grant.endsAt)}` : "No expiry"}</p></div>
                    <span className="text-foreground">{usd(grant.remainingAmount)}</span>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
