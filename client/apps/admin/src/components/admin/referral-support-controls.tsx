"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { buttonClassName } from "@/components/ui/button";
import { StatusBadge } from "@/components/admin/status-badge";

type ReferralItem = {
  id: string;
  code: string;
  codeStatus: string;
  status: string;
  referrerOrgId: string;
  referrerOrgName: string;
  refereeOrgId: string;
  refereeOrgName: string;
  attributedAt: string;
  attributionExpiresAt: string | null;
  qualifiedAt: string | null;
  awardedAt: string | null;
  reversedAt: string | null;
  qualificationReference: string | null;
  reversalReason: string | null;
  referrerGrantId: string | null;
  refereeGrantId: string | null;
  metadata: Record<string, unknown> | null;
};

type Action = {
  kind: "reject" | "reverse" | "code";
  item: ReferralItem;
  nextCodeStatus?: "ACTIVE" | "DISABLED";
};

async function readJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Referral operation failed");
  return payload as T;
}

function statusLabel(status: string) {
  return status.toLowerCase().replaceAll("_", " ").replace(/^\w/, (letter) => letter.toUpperCase());
}

function dateLabel(value: string | null) {
  return value ? new Date(value).toLocaleDateString("en-ZA", { dateStyle: "medium" }) : "—";
}

export function ReferralSupportControls() {
  const [items, setItems] = useState<ReferralItem[]>([]);
  const [status, setStatus] = useState("");
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState("");
  const [reference, setReference] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const query = status ? "?status=" + encodeURIComponent(status) : "";
      const payload = await readJson<{ referrals: ReferralItem[] }>("/api/billing/referrals" + query);
      setItems(payload.referrals);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load referrals");
    } finally {
      setBusy(false);
    }
  }, [status]);

  useEffect(() => {
    void load();
  }, [load]);

  function openAction(nextAction: Action) {
    setAction(nextAction);
    setReason("");
    setReference("");
    setError("");
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!action || !reason.trim() || !reference.trim()) return;
    setBusy(true);
    setError("");
    try {
      if (action.kind === "code") {
        await readJson(
          "/api/billing/referrals/orgs/" + encodeURIComponent(action.item.referrerOrgId) + "/code",
          {
            method: "POST",
            body: JSON.stringify({ status: action.nextCodeStatus, reason }),
          },
        );
      } else {
        await readJson(
          "/api/billing/referrals/" + encodeURIComponent(action.item.id) + "/" + action.kind,
          { method: "POST", body: JSON.stringify({ reason, reference }) },
        );
      }
      setAction(null);
      setMessage("Referral updated.");
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Referral update failed");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground";
  return (
    <section className="mt-6 space-y-5 v-card p-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">Referral support</h2>
          <p className="mt-1 text-sm text-muted-foreground">Inspect referral state and record corrections.</p>
        </div>
        <div className="flex gap-2">
          <select className={input + " w-auto"} value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">All statuses</option>
            <option value="ATTRIBUTED">Attributed</option>
            <option value="QUALIFIED">Qualified</option>
            <option value="AWARDED">Awarded</option>
            <option value="REJECTED">Rejected</option>
            <option value="REVERSED">Reversed</option>
            <option value="EXPIRED">Expired</option>
          </select>
          <button type="button" className={buttonClassName({ variant: "outline", size: "sm" })} onClick={() => void load()} disabled={busy}>
            Refresh
          </button>
        </div>
      </div>
      {error ? <p className="rounded-lg border border-status-danger/30 bg-status-danger-soft p-3 text-sm text-status-danger">{error}</p> : null}
      {message ? <p className="rounded-lg border border-status-success/30 bg-status-success-soft p-3 text-sm text-status-success">{message}</p> : null}
      <div className="divide-y divide-border rounded-lg border border-border">
        {items.length ? items.map((item) => (
          <div key={item.id} className="space-y-3 p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <p className="font-medium text-foreground">{item.referrerOrgName} → {item.refereeOrgName}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.code} · {dateLabel(item.attributedAt)} · {item.id}</p>
              </div>
              <StatusBadge value={item.status} />
            </div>
            <div className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-3">
              <span>Code: {statusLabel(item.codeStatus)}</span>
              <span>Expires: {dateLabel(item.attributionExpiresAt)}</span>
              <span>Payment: {item.qualificationReference || "—"}</span>
            </div>
            {item.reversalReason ? <p className="text-xs text-status-danger">Reason: {item.reversalReason}</p> : null}
            {item.metadata ? (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">Referral details</summary>
                <pre className="mt-2 max-h-40 overflow-auto rounded-md bg-background p-3 text-[11px]">{JSON.stringify(item.metadata, null, 2)}</pre>
              </details>
            ) : null}
            <div className="flex flex-wrap gap-2">
              {item.status === "ATTRIBUTED" || item.status === "QUALIFIED" ? (
                <button type="button" className={buttonClassName({ variant: "secondary", size: "sm", className: "border-status-attention/30 text-status-attention" })} onClick={() => openAction({ kind: "reject", item })}>Reject attribution</button>
              ) : null}
              {item.status === "AWARDED" ? (
                <button type="button" className="rounded-lg border border-status-danger/30 px-3 py-2 text-xs text-status-danger" onClick={() => openAction({ kind: "reverse", item })}>Reverse reward</button>
              ) : null}
              <button type="button" className={buttonClassName({ variant: "ghost", size: "sm" })} onClick={() => openAction({ kind: "code", item, nextCodeStatus: item.codeStatus === "DISABLED" ? "ACTIVE" : "DISABLED" })}>
                {item.codeStatus === "DISABLED" ? "Enable code" : "Disable code"}
              </button>
            </div>
          </div>
        )) : <p className="p-5 text-sm text-muted-foreground">No referrals found.</p>}
      </div>
      {action ? (
        <div className="fixed inset-0 z-[var(--z-overlay)] flex items-center justify-center p-4" role="presentation">
          <div className="fixed inset-0 bg-overlay/70" onClick={() => setAction(null)} />
          <form className="relative v-card w-full max-w-md space-y-4 p-5 shadow-pop" role="dialog" aria-modal="true" aria-labelledby="referral-change-title" onSubmit={submit}>
            <div>
              <h3 id="referral-change-title" className="font-semibold text-foreground">Confirm referral change</h3>
              <p className="mt-1 text-sm text-muted-foreground">This action will be recorded against {action.item.id}.</p>
            </div>
            <textarea className={input} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Support reason" required rows={3} />
            <input className={input} value={reference} onChange={(event) => setReference(event.target.value)} placeholder="Support reference" required />
            <div className="flex justify-end gap-2">
              <button type="button" className={buttonClassName({ variant: "ghost", size: "md" })} onClick={() => setAction(null)} disabled={busy}>Cancel</button>
              <button type="submit" className={buttonClassName({ variant: "primary", size: "md" })} disabled={busy}>{busy ? "Saving…" : "Confirm"}</button>
            </div>
          </form>
        </div>
      ) : null}
    </section>
  );
}
