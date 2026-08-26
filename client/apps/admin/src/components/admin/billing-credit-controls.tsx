"use client";

import { FormEvent, useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";

type Organization = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  balance: number;
  reservedBalance: number;
};

type CreditAccount = {
  orgId: string;
  balance: number;
  reservedBalance: number;
  availableBalance: number;
  grants: Array<{
    id: string;
    source: string;
    amount: number;
    remainingAmount: number;
    startsAt: string;
    endsAt: string | null;
    reason: string | null;
    reference: string | null;
  }>;
  ledger: Array<{
    id: string;
    entryType: string;
    amount: number;
    balanceAfter: number;
    sourceType: string | null;
    createdAt: string;
  }>;
};

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Credit operation failed");
  return payload as T;
}

function idempotencyKey(prefix: string): string {
  return `admin-credit:${prefix}:${crypto.randomUUID()}`;
}

export function BillingCreditControls() {
  const [query, setQuery] = useState("");
  const [organizations, setOrganizations] = useState<Organization[]>([]);
  const [selectedOrganization, setSelectedOrganization] = useState<Organization | null>(null);
  const [account, setAccount] = useState<CreditAccount | null>(null);
  const [amount, setAmount] = useState("");
  const [source, setSource] = useState("MANUAL");
  const [expiry, setExpiry] = useState("");
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [targetBalance, setTargetBalance] = useState("");
  const [resetConfirmation, setResetConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function search(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError(""); setMessage("");
    try {
      const result = await readJson<{ organizations: Organization[] }>(`/api/billing/organizations?q=${encodeURIComponent(query)}&limit=25`);
      setOrganizations(result.organizations);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Organization search failed");
    } finally { setBusy(false); }
  }

  async function selectOrganization(organization: Organization) {
    setSelectedOrganization(organization); setBusy(true); setError(""); setMessage("");
    try { setAccount(await readJson<CreditAccount>(`/api/billing/orgs/${encodeURIComponent(organization.id)}/credits`)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to load credit account"); }
    finally { setBusy(false); }
  }

  async function grant(event: FormEvent) {
    event.preventDefault();
    if (!selectedOrganization) return;
    setBusy(true); setError(""); setMessage("");
    try {
      await readJson(`/api/billing/orgs/${encodeURIComponent(selectedOrganization.id)}/credits/grants`, {
        method: "POST",
        body: JSON.stringify({ amount: Number(amount), source, endsAt: expiry ? new Date(`${expiry}T23:59:59.999Z`).toISOString() : null, reason, reference: reference || null, idempotencyKey: idempotencyKey("grant") }),
      });
      setMessage("Credits granted."); setAmount(""); setReason(""); setReference(""); setExpiry("");
      await selectOrganization(selectedOrganization);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Credit grant failed"); }
    finally { setBusy(false); }
  }

  async function setBalance(event: FormEvent) {
    event.preventDefault();
    if (!selectedOrganization || resetConfirmation !== "RESET") return;
    setBusy(true); setError(""); setMessage("");
    try {
      await readJson(`/api/billing/orgs/${encodeURIComponent(selectedOrganization.id)}/credits/balance`, {
        method: "POST",
        body: JSON.stringify({ targetBalance: Number(targetBalance), reason, reference: reference || null, idempotencyKey: idempotencyKey("set-balance") }),
      });
      setMessage("Credit balance updated."); setTargetBalance(""); setResetConfirmation(""); setReason(""); setReference("");
      await selectOrganization(selectedOrganization);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Balance update failed"); }
    finally { setBusy(false); }
  }

  return <section className="v-card mt-6 space-y-5 p-[var(--density-card-padding)]">
    <div><h2 className="text-base font-semibold tracking-[-0.01em] text-foreground">Credit controls</h2><p className="mt-1 text-sm text-muted-foreground">Manage organization credit balances and grants.</p></div>
    {error ? <p role="alert" className="rounded-md border border-status-danger/25 bg-status-danger-soft p-3 text-sm text-status-danger">{error}</p> : null}
    {message ? <p role="status" className="rounded-md border border-status-success/25 bg-status-success-soft p-3 text-sm text-status-success">{message}</p> : null}
    <form className="flex flex-col gap-2 sm:flex-row" onSubmit={search}>
      <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search organization, owner email, or ID" aria-label="Search organizations" />
      <button type="submit" disabled={busy} className={buttonClassName({ size: "sm" })}>Search</button>
    </form>
    {organizations.length ? <div className="divide-y divide-line rounded-md border border-line">{organizations.map((organization) => <button type="button" key={organization.id} onClick={() => selectOrganization(organization)} className="flex w-full flex-wrap items-center justify-between gap-3 px-3 py-3 text-left text-sm transition-colors hover:bg-accent"><span><span className="block font-medium text-foreground">{organization.name}</span><span className="block text-xs text-muted-foreground">{organization.ownerEmail || organization.slug} · {organization.id}</span></span><span className="text-muted-foreground">{organization.balance.toLocaleString()} credits</span></button>)}</div> : null}
    {selectedOrganization && account ? <div className="space-y-5 rounded-md border border-line bg-background p-4">
      <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="font-medium text-foreground">{selectedOrganization.name}</p><p className="text-xs text-muted-foreground">{selectedOrganization.id}</p></div><div className="text-right"><p className="text-lg font-semibold text-foreground">{account.availableBalance.toLocaleString()} credits available</p><p className="text-xs text-muted-foreground">{account.balance.toLocaleString()} total · {account.reservedBalance.toLocaleString()} reserved</p></div></div>
      <div className="grid gap-5 lg:grid-cols-2">
        <form className="space-y-3 rounded-md border border-line p-4" onSubmit={grant}><h3 className="text-sm font-semibold text-foreground">Grant credits</h3><Input type="number" min="1" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="Amount" required aria-label="Credit amount" /><Select value={source} onChange={(event) => setSource(event.target.value)} aria-label="Credit source"><option value="MANUAL">Manual</option><option value="PROMOTIONAL">Promotional</option><option value="COMPENSATION">Compensation</option></Select><Input type="date" value={expiry} onChange={(event) => setExpiry(event.target.value)} aria-label="Credit expiry" /><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" required aria-label="Grant reason" /><Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Support reference (optional)" aria-label="Support reference" /><button type="submit" disabled={busy} className={buttonClassName({ size: "sm" })}>Grant</button></form>
        <form className="space-y-3 rounded-md border border-status-danger/25 p-4" onSubmit={setBalance}><h3 className="text-sm font-semibold text-foreground">Set balance</h3><Input type="number" min="0" value={targetBalance} onChange={(event) => setTargetBalance(event.target.value)} placeholder="Target balance" required aria-label="Target balance" /><Input value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason" required aria-label="Balance update reason" /><Input value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Support reference (optional)" aria-label="Support reference" /><Input value={resetConfirmation} onChange={(event) => setResetConfirmation(event.target.value)} placeholder="Type RESET to confirm" required aria-label="Reset confirmation" /><button type="submit" disabled={busy || resetConfirmation !== "RESET"} className={buttonClassName({ variant: "destructive", size: "sm" })}>Apply balance</button></form>
      </div>
      <div className="grid gap-5 lg:grid-cols-2"><div><h3 className="text-sm font-semibold text-foreground">Active grants</h3><div className="mt-2 space-y-2 text-xs text-muted-foreground">{account.grants.length ? account.grants.map((grant) => <div className="flex justify-between gap-3 rounded border border-line px-3 py-2" key={grant.id}><span>{grant.source} · {grant.reason || "No reason"}</span><span>{grant.remainingAmount.toLocaleString()} left</span></div>) : <p>No active grants.</p>}</div></div><div><h3 className="text-sm font-semibold text-foreground">Recent ledger</h3><div className="mt-2 space-y-2 text-xs text-muted-foreground">{account.ledger.slice(0, 8).map((entry) => <div className="flex justify-between gap-3 rounded border border-line px-3 py-2" key={entry.id}><span>{entry.entryType} · {entry.sourceType || "system"}</span><span className={entry.amount < 0 ? "text-status-danger" : "text-status-success"}>{entry.amount > 0 ? "+" : ""}{entry.amount.toLocaleString()}</span></div>)}</div></div></div>
    </div> : null}
  </section>;
}
