"use client";

import { apiUrl } from "@/lib/server-api";
import { useRouter } from "next/navigation";
import { useState } from "react";

export function SubscriptionActionButton({ subscriptionId, cancelAtPeriodEnd }: { subscriptionId: string; cancelAtPeriodEnd: boolean }) {
  const router = useRouter(); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  async function update() { setBusy(true); setError(""); const action = cancelAtPeriodEnd ? "reactivate" : "cancel";
    try { const response = await fetch(apiUrl(`/api/billing/subscriptions/${subscriptionId}/${action}`), { method: "POST", credentials: "include" }); const body = await response.json(); if (!response.ok) throw new Error(body.error || "Subscription update failed"); router.refresh(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Subscription update failed"); } finally { setBusy(false); }
  }
  return <div className="mt-4"><button type="button" onClick={update} disabled={busy} className="text-sm font-medium text-primary disabled:opacity-50">{busy ? "Updating..." : cancelAtPeriodEnd ? "Reactivate subscription" : "Cancel at period end"}</button>{error ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}</div>;
}
