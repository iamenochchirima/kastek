"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import ConfirmModal from "@/components/admin/confirm-modal";
import { Badge } from "@/components/ui/badge";
import { buttonClassName } from "@/components/ui/button";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type Organization = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
};

type Plan = {
  key: string;
  name: string;
  product: string;
  status: string;
  amountMinor: string;
  currency: string;
};

type Subscription = {
  id: string;
  product: string;
  planKey: string;
  planName: string;
  status: string;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
};

type Account = {
  account: { id: string; billing_email: string; currency: string };
  links: Array<{ product: string; tenantId: string; role: string; status: string }>;
  subscriptions: Subscription[];
  invoices: Array<{
    invoiceNumber: string;
    status: string;
    currency: string;
    totalMinor: string;
    issuedAt: string;
  }>;
  issues: Array<{ id: string; issueType: string; status: string; createdAt: string }>;
  credits?: { available: string };
};

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(
      typeof payload?.error === "string" ? payload.error : "Subscription operation failed",
    );
  return payload as T;
}

function money(amountMinor: string, currency: string) {
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
  return value
    ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" })
    : "—";
}

export function BillingSubscriptionControls({ plans }: { plans: Plan[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selected, setSelected] = useState<Organization | null>(null);
  const [account, setAccount] = useState<Account | null>(null);
  const [trialPlan, setTrialPlan] = useState(
    plans.find((plan) => plan.product === "growth" && plan.key === "growth-mid")?.key ??
      plans.find((plan) => plan.product === "growth")?.key ??
      "",
  );
  const [trialDays, setTrialDays] = useState("14");
  const [extendDays, setExtendDays] = useState("7");
  const [endOpen, setEndOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const growthPlans = plans.filter(
    (plan) => plan.product === "growth" && plan.status === "active",
  );
  const trial = account?.subscriptions.find(
    (subscription) =>
      subscription.product === "growth" && subscription.status === "trialing",
  );

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const result = await json<{ organizations: Organization[] }>(
        `/api/billing/organizations?q=${encodeURIComponent(query)}&limit=25`,
      );
      setOrganizations(result.organizations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Organization search failed");
    } finally {
      setBusy(false);
    }
  }

  async function load(organization: Organization) {
    setSelected(organization);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      setAccount(
        await json<Account>(
          `/api/billing/accounts/${encodeURIComponent(organization.id)}`,
        ),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Account could not be loaded");
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    if (selected) await load(selected);
  }

  async function startTrial(event: FormEvent) {
    event.preventDefault();
    if (!selected || !account) return;
    const growth = account.links.find(
      (link) => link.product === "growth" && link.status === "active",
    );
    if (!growth) {
      setError("This billing account has no Growth workspace");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await json(
        `/api/billing/orgs/${encodeURIComponent(growth.tenantId)}/subscriptions/assign`,
        {
          method: "POST",
          body: JSON.stringify({
            planKey: trialPlan,
            status: "trialing",
            trialDays: Number(trialDays),
          }),
        },
      );
      setMessage("Trial started.");
      await reload();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trial could not be started");
    } finally {
      setBusy(false);
    }
  }

  async function extendTrial() {
    if (!trial || !account) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await json(
        `/api/billing/accounts/${encodeURIComponent(account.account.id)}/subscriptions/${encodeURIComponent(trial.id)}/trial/extend`,
        { method: "POST", body: JSON.stringify({ days: Number(extendDays) }) },
      );
      setMessage("Trial extended.");
      await reload();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trial could not be extended");
    } finally {
      setBusy(false);
    }
  }

  async function endTrial() {
    if (!trial || !account) return;
    setEndOpen(false);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await json(
        `/api/billing/accounts/${encodeURIComponent(account.account.id)}/subscriptions/${encodeURIComponent(trial.id)}/trial/end`,
        { method: "POST", body: JSON.stringify({}) },
      );
      setMessage("Trial ended. The account is back on its free plan.");
      await reload();
      router.refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Trial could not be ended");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="v-card mt-6 space-y-5 p-[var(--density-card-padding)]">
      <div>
        <h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Trials and subscriptions</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Start, extend or end a workspace trial. Ending a trial restores the free plan and keeps subscription history.
        </p>
      </div>

      {error ? <p role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft p-3 text-sm text-status-danger">{error}</p> : null}
      {message ? <p role="status" className="rounded-md border border-status-success/25 bg-status-success-soft p-3 text-sm text-status-success">{message}</p> : null}

      <form className="flex flex-col gap-2 sm:flex-row" onSubmit={search}>
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search organization, owner email, or ID"
          aria-label="Search organizations"
        />
        <button type="submit" disabled={busy} className={buttonClassName({ size: "sm" })}>Search</button>
      </form>

      {organizations.length ? (
        <div className="divide-y divide-line rounded-md border border-line">
          {organizations.map((organization) => (
            <button
              type="button"
              key={organization.id}
              onClick={() => load(organization)}
              className="flex w-full flex-wrap items-center justify-between gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent"
            >
              <span>
                <span className="block font-medium text-foreground">{organization.name}</span>
                <span className="block text-xs text-muted-foreground">{organization.ownerEmail || organization.slug} · {organization.id}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}

      {selected && account ? (
        <div className="space-y-5 rounded-md border border-line bg-background p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="font-medium text-foreground">{selected.name}</p>
              <p className="text-xs text-muted-foreground">{account.account.billing_email} · {account.account.currency}</p>
            </div>
            {trial ? <Badge variant="attention">Trial ends {date(trial.trialEndsAt)}</Badge> : <Badge variant="secondary">No active trial</Badge>}
          </div>

          <div className="divide-y divide-line rounded-md border border-line">
            {account.subscriptions.length ? (
              account.subscriptions.map((subscription) => (
                <div key={subscription.id} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                  <div>
                    <p className="font-medium text-foreground">{subscription.planName}</p>
                    <p className="text-xs capitalize text-muted-foreground">{subscription.product} · {subscription.status.replaceAll("_", " ")}</p>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {subscription.status === "trialing"
                      ? `Trial ends ${date(subscription.trialEndsAt)}`
                      : `Period ends ${date(subscription.currentPeriodEnd)}`}
                  </p>
                </div>
              ))
            ) : (
              <p className="px-3 py-3 text-sm text-muted-foreground">No subscriptions</p>
            )}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold text-foreground">Linked workspaces</h3>
              <div className="mt-2 divide-y divide-line rounded-md border border-line">
                {account.links.length ? account.links.map((link) => (
                  <div key={`${link.product}:${link.tenantId}`} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="font-medium text-foreground">{link.product}</span>
                    <span className="font-mono text-xs text-muted-foreground">{link.tenantId}</span>
                    <Badge variant={link.status === "active" ? "success" : "secondary"}>{link.status}</Badge>
                  </div>
                )) : <p className="px-3 py-3 text-sm text-muted-foreground">No links</p>}
              </div>
            </div>
            <div>
              <h3 className="text-sm font-semibold text-foreground">AI usage</h3>
              <div className="mt-2 rounded-md border border-line p-3">
                <p className="text-lg font-semibold text-foreground">{usd(account.credits?.available)}</p>
                <p className="text-xs text-muted-foreground">available</p>
              </div>
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-foreground">Invoices</h3>
            <div className="mt-2 overflow-x-auto rounded-md border border-line">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead className="border-b border-line text-xs text-muted-foreground">
                  <tr><th className="px-3 py-2 font-medium">Invoice</th><th className="px-3 py-2 font-medium">Issued</th><th className="px-3 py-2 text-right font-medium">Total</th><th className="px-3 py-2 text-right font-medium">Status</th></tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {account.invoices.length ? account.invoices.map((invoice) => (
                    <tr key={invoice.invoiceNumber}>
                      <td className="px-3 py-2 font-mono text-xs">{invoice.invoiceNumber}</td>
                      <td className="px-3 py-2 text-muted-foreground">{date(invoice.issuedAt)}</td>
                      <td className="px-3 py-2 text-right">{money(invoice.totalMinor, invoice.currency)}</td>
                      <td className="px-3 py-2 text-right capitalize text-muted-foreground">{invoice.status.replaceAll("_", " ")}</td>
                    </tr>
                  )) : <tr><td colSpan={4} className="px-3 py-3 text-muted-foreground">No invoices</td></tr>}
                </tbody>
              </table>
            </div>
          </div>

          {account.issues.length ? (
            <div className="rounded-md border border-status-attention/25 bg-status-attention-soft p-3">
              <h3 className="text-sm font-semibold text-status-attention">Open billing issues</h3>
              <div className="mt-2 space-y-1 text-xs text-status-attention">
                {account.issues.map((issue) => <p key={issue.id}>{issue.issueType.replaceAll("_", " ")} · {date(issue.createdAt)}</p>)}
              </div>
            </div>
          ) : null}

          {trial ? (
            <div className="flex flex-wrap items-end gap-3 rounded-md border border-line p-4">
              <FormField id="trial-extend-days" label="Extend by days">
                <Input
                  id="trial-extend-days"
                  type="number"
                  min="1"
                  max="365"
                  value={extendDays}
                  onChange={(event) => setExtendDays(event.target.value)}
                />
              </FormField>
              <button type="button" onClick={extendTrial} disabled={busy} className={buttonClassName({ size: "sm" })}>
                Extend trial
              </button>
              <button type="button" onClick={() => setEndOpen(true)} disabled={busy} className={buttonClassName({ variant: "destructive", size: "sm" })}>
                End trial
              </button>
            </div>
          ) : (
            <form className="flex flex-wrap items-end gap-3 rounded-md border border-line p-4" onSubmit={startTrial}>
              <FormField id="trial-plan" label="Plan">
                <Select id="trial-plan" value={trialPlan} onChange={(event) => setTrialPlan(event.target.value)} required>
                  {growthPlans.map((plan) => (
                    <option key={plan.key} value={plan.key}>{plan.name}</option>
                  ))}
                </Select>
              </FormField>
              <FormField id="trial-days" label="Days">
                <Input
                  id="trial-days"
                  type="number"
                  min="1"
                  max="365"
                  value={trialDays}
                  onChange={(event) => setTrialDays(event.target.value)}
                  required
                />
              </FormField>
              <button type="submit" disabled={busy || !trialPlan} className={buttonClassName({ size: "sm" })}>
                Start trial
              </button>
            </form>
          )}
        </div>
      ) : null}

      <ConfirmModal
        open={endOpen}
        title="End this trial?"
        message="The workspace returns to the free plan immediately. Subscription history is retained."
        confirmLabel="End trial"
        loadingLabel="Ending..."
        loading={busy}
        confirmVariant="destructive"
        onConfirm={endTrial}
        onCancel={() => setEndOpen(false)}
      />
    </section>
  );
}
