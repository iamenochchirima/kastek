import { useEffect, useRef, useState } from "react";
import { PiWallet as Wallet } from "react-icons/pi";
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
};

type Billing = {
  configured: boolean;
  account: {
    account?: { currency?: string; billing_email?: string };
    subscriptions?: Array<{
      id: string;
      product: string;
      planKey: string;
      planName: string;
      status: string;
      currentPeriodEnd: string | null;
      cancelAtPeriodEnd: boolean;
    }>;
    credits?: { balance: string; reserved: string; available: string };
    invoices?: Invoice[];
    issues?: Array<{ id: string; issueType: string; status: string; createdAt: string }>;
  } | null;
  invoices: Invoice[];
  plans: Plan[];
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

function date(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" }) : "—";
}

export function BillingSettings({ organizationId }: { organizationId: string }) {
  const [data, setData] = useState<Billing | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [checkoutBusy, setCheckoutBusy] = useState("");
  const verified = useRef(false);

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

  const account = data?.account;
  const subscription =
    account?.subscriptions?.find((item) => item.product === "agents") ??
    account?.subscriptions?.[0];
  const invoices = data?.invoices ?? account?.invoices ?? [];
  const plans = data?.plans ?? [];

  return (
    <section className="settings-group" aria-labelledby="settings-billing">
      <h2 id="settings-billing" className="settings-heading">
        <Wallet size={16} strokeWidth={1.7} aria-hidden="true" />
        Billing
      </h2>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p className="text-sm text-emerald-600">{notice}</p> : null}
      {!data ? (
        !error ? <p className="text-sm text-muted-foreground">Loading billing…</p> : null
      ) : !data.configured ? (
        <p className="text-sm text-muted-foreground">Billing is not configured.</p>
      ) : (
        <div className="space-y-5">
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="rounded-lg border border-border p-3">
              <p className="settings-label">Plan</p>
              <p className="settings-value">{subscription?.planName ?? "No active plan"}</p>
              {subscription ? <p className="text-xs capitalize text-muted-foreground">{subscription.status.replaceAll("_", " ")}</p> : null}
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="settings-label">Renews</p>
              <p className="settings-value">{subscription?.cancelAtPeriodEnd ? `Ends ${date(subscription.currentPeriodEnd)}` : date(subscription?.currentPeriodEnd ?? null)}</p>
            </div>
            <div className="rounded-lg border border-border p-3">
              <p className="settings-label">AI usage available</p>
              <p className="settings-value">{usd(account?.credits?.available)}</p>
              <p className="text-xs text-muted-foreground">{usd(account?.credits?.reserved)} reserved</p>
            </div>
          </div>

          {plans.length ? (
            <div>
              <h3 className="mb-2 text-sm font-medium">Plans</h3>
              <div className="divide-y divide-border rounded-lg border border-border">
                {plans.map((plan) => (
                  <div key={plan.key} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                    <div>
                      <p className="font-medium">{plan.name}</p>
                      {plan.description ? <p className="text-xs text-muted-foreground">{plan.description}</p> : null}
                    </div>
                    <div className="flex flex-wrap items-center justify-end gap-3 text-right">
                      <div>
                        <p>{money(plan.amountMinor, plan.currency)} / month</p>
                        <p className="text-xs text-muted-foreground">{usd(plan.creditsPerPeriod)} AI usage</p>
                      </div>
                      {plan.checkoutReady && plan.key !== subscription?.planKey ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={Boolean(checkoutBusy)}
                          onClick={() => void startCheckout(plan.key)}
                        >
                          {checkoutBusy === plan.key ? "Opening…" : "Upgrade"}
                        </Button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <h3 className="mb-2 text-sm font-medium">Invoices</h3>
            {invoices.length ? (
              <div className="overflow-x-auto rounded-lg border border-border">
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
                        <td className="px-3 py-2 font-mono text-xs">{invoice.invoiceNumber}</td>
                        <td className="px-3 py-2 text-muted-foreground">{date(invoice.issuedAt)}</td>
                        <td className="px-3 py-2 text-right">{money(invoice.totalMinor, invoice.currency)}</td>
                        <td className="px-3 py-2 text-right capitalize text-muted-foreground">{invoice.status.replaceAll("_", " ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">No invoices yet</p>
            )}
          </div>

          {account?.issues?.length ? (
            <p className="text-sm text-amber-600">{account.issues.length} billing issue{account.issues.length === 1 ? "" : "s"} need attention.</p>
          ) : null}
        </div>
      )}
    </section>
  );
}
