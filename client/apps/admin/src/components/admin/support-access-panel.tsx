"use client";

import { useState } from "react";
import { buttonClassName } from "@/components/ui/button";

type Grant = {
  id: string;
  adminId: string;
  organizationId: string;
  resourceType: string;
  resourceId?: string | null;
  reason: string;
  expiresAt: string;
  revokedAt?: string | null;
};

export function SupportAccessPanel({ initialGrants, adminId, canManage }: { initialGrants: Grant[]; adminId: string; canManage: boolean }) {
  const [grants, setGrants] = useState(initialGrants);
  const [organizationId, setOrganizationId] = useState("");
  const [resourceType, setResourceType] = useState("organization");
  const [resourceId, setResourceId] = useState("");
  const [reason, setReason] = useState("");
  const [durationMinutes, setDurationMinutes] = useState("30");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function createGrant() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/operations/support-grants", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ adminId, organizationId, resourceType, resourceId: resourceType === "organization" ? undefined : resourceId, reason, durationMinutes: Number(durationMinutes) }),
      });
      const data = await response.json() as Grant & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to grant support access");
      setGrants((current) => [data, ...current]);
      setReason("");
      setMessage("Support access granted with an expiry.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to grant support access");
    } finally {
      setBusy(false);
    }
  }

  async function revokeGrant(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/operations/support-grants/${encodeURIComponent(id)}/revoke`, { method: "POST" });
      const data = await response.json() as Grant & { error?: string };
      if (!response.ok) throw new Error(data.error ?? "Unable to revoke support access");
      setGrants((current) => current.map((grant) => grant.id === id ? data : grant));
      setMessage("Support access revoked.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to revoke support access");
    } finally {
      setBusy(false);
    }
  }

  return <div className="grid gap-5 lg:grid-cols-[1fr_1.2fr]">
    {canManage ? <form className="space-y-3 rounded-lg border border-border bg-background p-4" onSubmit={(event) => { event.preventDefault(); void createGrant(); }}>
      <div><h3 className="text-sm font-semibold text-foreground">Grant temporary support access</h3><p className="mt-1 text-xs text-muted-foreground">Access is scoped to one organization or resource and expires automatically within 60 minutes.</p></div>
      <input required value={organizationId} onChange={(event) => setOrganizationId(event.target.value)} placeholder="Organization ID" className="h-9 w-full rounded-md border border-border bg-card px-3 text-sm" />
      <div className="grid gap-2 sm:grid-cols-2">
        <select value={resourceType} onChange={(event) => setResourceType(event.target.value)} className="h-9 rounded-md border border-border bg-card px-3 text-sm"><option value="organization">Organization</option><option value="conversation">Conversation</option><option value="customer">Customer</option><option value="run">Run</option></select>
        <input value={resourceId} onChange={(event) => setResourceId(event.target.value)} disabled={resourceType === "organization"} placeholder={resourceType === "organization" ? "No resource ID" : "Resource ID"} className="h-9 rounded-md border border-border bg-card px-3 text-sm disabled:opacity-50" />
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_110px]"><input required minLength={8} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Reason for access" className="h-9 rounded-md border border-border bg-card px-3 text-sm" /><input required type="number" min={1} max={60} value={durationMinutes} onChange={(event) => setDurationMinutes(event.target.value)} className="h-9 rounded-md border border-border bg-card px-3 text-sm" /></div>
      <button type="submit" disabled={busy} className={buttonClassName({ variant: "secondary", size: "sm" })}>{busy ? "Saving…" : "Grant access"}</button>
    </form> : <div className="rounded-lg border border-border bg-background p-4"><h3 className="text-sm font-semibold text-foreground">Support access</h3><p className="mt-1 text-xs text-muted-foreground">Only administrators, superadmins, and owners can issue or revoke grants.</p></div>}
    <div className="rounded-lg border border-border bg-background"><div className="border-b border-border px-4 py-3"><h3 className="text-sm font-semibold text-foreground">Active and recent grants</h3></div>{grants.length === 0 ? <p className="px-4 py-8 text-sm text-muted-foreground">No support grants found.</p> : <div className="divide-y divide-border">{grants.map((grant) => <div key={grant.id} className="flex items-start justify-between gap-3 px-4 py-3"><div className="min-w-0"><p className="text-xs font-medium text-foreground">{grant.organizationId} · {grant.resourceType}{grant.resourceId ? ` · ${grant.resourceId}` : ""}</p><p className="mt-1 text-xs text-muted-foreground">{grant.reason} · expires {new Date(grant.expiresAt).toLocaleString()}</p></div>{canManage && !grant.revokedAt ? <button type="button" disabled={busy} onClick={() => void revokeGrant(grant.id)} className={buttonClassName({ variant: "ghost", size: "sm" })}>Revoke</button> : <span className="text-[11px] text-muted-foreground">{grant.revokedAt ? "Revoked" : "Read-only"}</span>}</div>)}</div>}{message ? <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">{message}</p> : null}</div>
  </div>;
}
