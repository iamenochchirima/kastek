import { useEffect, useRef, useState } from "react";
import { PiArrowClockwise as RefreshCw, PiWallet as Wallet } from "react-icons/pi";
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

type Plan = {
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

type Billing = {
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
};

function money(amountMinor: string | number | null, currency: string) {
  if (amountMinor === null) return "—";
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(Number(amountMinor) / 100);
}

function usd(microUsd: string | null | undefined) {
  if (microUsd == null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(microUsd) / 1_000_000);
}

function formatLimit(value: unknown, unit: string | null) {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : null;
  if (number !== null) return `${number.toLocaleString()}${unit ? ` ${unit}` : ""}`;
  return typeof value === "string" ? value : "Included";
}

function entitlementList(plan: Plan, kind: "feature" | "limit") {
  return (plan.entitlements ?? [])
    .filter((item) => item.kind === kind && (kind === "limit" || item.value === true))
    .sort(
      (left, right) =>
        (left.displayGroup ?? "").localeCompare(right.displayGroup ?? "") ||
        left.displayOrder - right.displayOrder ||
        left.name.localeCompare(right.name),
    );
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

function useBillingData(organizationId: string) {
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
  const { data, error, notice, checkoutBusy, startCheckout, refresh } = useBillingData(organizationId);
  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const invoices = data?.invoices ?? account?.invoices ?? [];
  const plans = data?.plans ?? [];

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
              <div className="rounded-lg border border-border bg-background/60 p-4 text-right">
                <p className="text-xs text-muted-foreground">AI usage available</p>
                <p className="mt-1 text-2xl font-semibold text-foreground">
                  {usd(account?.credits?.available)}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {usd(account?.credits?.reserved)} reserved
                </p>
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
            <div>
              <h2 className="text-base font-semibold text-foreground">Plans</h2>
              <p className="mt-1 text-sm text-muted-foreground">Choose the Agents plan for this workspace.</p>
            </div>
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {plans.map((plan) => {
                const current = plan.key === subscription?.planKey;
                return (
                  <article key={plan.key} className={`flex flex-col rounded-lg border p-4 ${current ? "border-primary/40 bg-primary/5" : "border-border bg-secondary/10"}`}>
                    <div className="flex items-start justify-between gap-3">
                      <div>
                        <h3 className="text-sm font-semibold text-foreground">{plan.name}</h3>
                        {plan.description ? <p className="mt-1 text-xs text-muted-foreground">{plan.description}</p> : null}
                      </div>
                      {current ? <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs text-primary">Current</span> : null}
                    </div>
                    <p className="mt-4 text-2xl font-semibold tracking-tight text-foreground">{money(plan.amountMinor, plan.currency)}</p>
                    <p className="text-xs text-muted-foreground">per month</p>
                    <p className="mt-3 text-sm text-muted-foreground">{usd(plan.creditsPerPeriod)} AI usage</p>
                    <div className="mt-4 space-y-3 border-t border-border pt-4">
                      {entitlementList(plan, "feature").map((feature) => (
                        <div key={feature.key} className="flex items-start gap-2 text-sm text-muted-foreground">
                          <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary" />
                          <span>{feature.name}</span>
                        </div>
                      ))}
                      {entitlementList(plan, "limit").length ? (
                        <div className="space-y-1.5 border-t border-border pt-3">
                          <p className="text-xs font-medium uppercase tracking-[0.12em] text-muted-foreground">Limits</p>
                          {entitlementList(plan, "limit").map((limit) => (
                            <div key={limit.key} className="flex items-start justify-between gap-3 text-sm">
                              <span className="text-muted-foreground">{limit.name}</span>
                              <span className="shrink-0 font-medium text-foreground">{formatLimit(limit.value, limit.unit)}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="mt-auto pt-4">
                      {plan.checkoutReady && !current ? (
                        <Button
                          size="sm"
                          className="w-full"
                          disabled={Boolean(checkoutBusy)}
                          onClick={() => void startCheckout(plan.key)}
                        >
                          {checkoutBusy === plan.key ? "Opening…" : "Upgrade"}
                        </Button>
                      ) : (
                        <p className="text-xs text-muted-foreground">{current ? "Current plan" : plan.checkoutReady ? "Unavailable" : "Checkout unavailable"}</p>
                      )}
                    </div>
                  </article>
                );
              })}
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

export function UsageSettings({ organizationId }: { organizationId: string }) {
  const { data, error } = useBillingData(organizationId);
  const usage = data?.usage;
  const account = data?.account;
  const daily = usage?.daily ?? [];
  const breakdown = usage?.breakdown ?? [];

  return (
    <div className="space-y-5">
      {error ? <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">{error}</p> : null}
      {!data && !error ? <p className="text-sm text-muted-foreground">Loading usage…</p> : null}
      {!usage ? null : (
        <>
          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-foreground">AI usage</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {date(usage.from)} – {date(usage.to)}
                </p>
              </div>
              <Wallet className="size-5 text-primary" />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="text-xs text-muted-foreground">Used</p>
                <p className="mt-1 text-xl font-semibold text-foreground">{usd(usage.creditsUsed)}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="text-xs text-muted-foreground">Available</p>
                <p className="mt-1 text-xl font-semibold text-foreground">{usd(usage.credits?.available ?? account?.credits?.available)}</p>
              </div>
              <div className="rounded-lg border border-border bg-secondary/20 p-4">
                <p className="text-xs text-muted-foreground">Operations</p>
                <p className="mt-1 text-xl font-semibold text-foreground">{Number(usage.operations).toLocaleString()}</p>
              </div>
            </div>
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <h2 className="text-base font-semibold text-foreground">Daily usage</h2>
            {daily.length ? (
              <div className="mt-4 overflow-x-auto rounded-lg border border-border">
                <table className="w-full min-w-[420px] text-left text-sm">
                  <thead className="border-b border-border text-xs text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Day</th>
                      <th className="px-3 py-2 text-right font-medium">AI usage</th>
                      <th className="px-3 py-2 text-right font-medium">Operations</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {daily.slice(-30).map((day) => (
                      <tr key={day.date}>
                        <td className="px-3 py-2 text-muted-foreground">{date(day.date)}</td>
                        <td className="px-3 py-2 text-right">{usd(day.creditsUsed)}</td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{Number(day.operations).toLocaleString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No usage in this period.</p>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <h2 className="text-base font-semibold text-foreground">Usage by meter</h2>
            {breakdown.length ? (
              <div className="mt-4 divide-y divide-border">
                {breakdown.map((item) => (
                  <div key={item.meterKey} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                    <span className="font-medium capitalize text-foreground">{item.meterKey.replaceAll("_", " ")}</span>
                    <span className="text-muted-foreground">{usd(item.creditsUsed)} · {Number(item.operations).toLocaleString()} operations</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No metered usage in this period.</p>
            )}
          </section>

          <section className="rounded-xl border border-border bg-card p-5 shadow-[var(--shadow-panel)]">
            <h2 className="text-base font-semibold text-foreground">AI usage grants</h2>
            {usage.grants?.length ? (
              <div className="mt-4 divide-y divide-border">
                {usage.grants.slice(0, 10).map((grant) => (
                  <div key={grant.id} className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm">
                    <div>
                      <p className="font-medium capitalize text-foreground">{grant.source.replaceAll("_", " ")}</p>
                      <p className="text-xs text-muted-foreground">{grant.reference ?? grant.id}</p>
                    </div>
                    <div className="text-right">
                      <p className="font-medium text-foreground">{usd(grant.remainingAmount)} remaining</p>
                      <p className="text-xs text-muted-foreground">{grant.endsAt ? `Expires ${date(grant.endsAt)}` : "No expiry"}</p>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">No grants.</p>
            )}
          </section>
        </>
      )}
    </div>
  );
}
