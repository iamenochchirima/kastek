"use client";

import { useState } from "react";
import ConfirmModal from "@/components/admin/confirm-modal";
import { StatusBadge } from "@/components/admin/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

export type EarlyAccessApplication = {
  id: string;
  businessName: string;
  contactPerson: string;
  phone: string | null;
  email: string;
  businessType: string | null;
  products: string[];
  notes: string | null;
  status: string;
  cohort: string;
  reviewNotes: string | null;
  decisionReason: string | null;
  organizationId: string | null;
  invitationId: string | null;
  activatedAt: string | null;
  earlyAccessEndsAt: string | null;
  createdAt: string;
};

const capabilities = [
  ["feature.analytics.view", "Analytics"],
  ["feature.inbox.access", "Inbox"],
  ["feature.agents.manage", "Agents"],
  ["feature.campaigns.manage", "Campaigns"],
  ["feature.content.manage", "Content"],
] as const;

function date(value: string | null) {
  return value ? new Date(value).toLocaleDateString() : "—";
}

export function EarlyAccessManager({ initialApplications }: { initialApplications: EarlyAccessApplication[] }) {
  const [applications, setApplications] = useState(initialApplications);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [approvalId, setApprovalId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState("");
  const [durationDays, setDurationDays] = useState("30");
  const [credits, setCredits] = useState("100");
  const [selectedCapabilities, setSelectedCapabilities] = useState<string[]>(capabilities.map(([key]) => key));
  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [revokeId, setRevokeId] = useState<string | null>(null);

  async function refresh() {
    const params = new URLSearchParams();
    if (status) params.set("status", status);
    if (search.trim()) params.set("search", search.trim());
    try {
      const response = await fetch(`/api/core/admin/early-access?${params.toString()}`, { cache: "no-store" });
      if (!response.ok) {
        setMessage("Unable to load applications.");
        return;
      }
      setApplications(((await response.json()).applications ?? []) as EarlyAccessApplication[]);
    } catch {
      setMessage("Unable to load applications.");
    }
  }

  async function post(id: string, action: string, body?: object) {
    setBusyId(id);
    setMessage(null);
    try {
      const response = await fetch(`/api/core/admin/early-access/${id}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
      const result = (await response.json().catch(() => ({}))) as { error?: string };
      if (!response.ok) {
        setMessage(result.error ?? "Unable to update this application.");
        return false;
      }
      await refresh();
      return true;
    } catch {
      setMessage("Unable to update this application.");
      return false;
    } finally {
      setBusyId(null);
    }
  }

  async function startReview(id: string) {
    await post(id, "review", { status: "reviewing" });
  }

  async function approve(id: string, application: EarlyAccessApplication) {
    const ok = await post(id, "approve", {
      workspaceName: workspaceName.trim() || application.businessName,
      durationDays: Number(durationDays),
      credits: Number(credits),
      entitlementKeys: selectedCapabilities,
    });
    if (ok) {
      setApprovalId(null);
      setMessage("Workspace created and invitation sent.");
    }
  }

  async function reject(id: string) {
    if (!rejectionReason.trim()) {
      setMessage("A rejection reason is required.");
      return;
    }
    const ok = await post(id, "review", { status: "rejected", reason: rejectionReason.trim() });
    if (ok) {
      setRejectingId(null);
      setRejectionReason("");
    }
  }

  async function revoke() {
    if (!revokeId) return;
    const ok = await post(revokeId, "revoke", { reason: "Early access withdrawn by an administrator" });
    if (ok) setRevokeId(null);
  }

  function beginApproval(application: EarlyAccessApplication) {
    setApprovalId(application.id);
    setWorkspaceName(application.businessName);
    setDurationDays("30");
    setCredits("100");
    setSelectedCapabilities(capabilities.map(([key]) => key));
  }

  return (
    <div className="space-y-5">
      <Card>
        <CardContent className="flex flex-col gap-3 pt-[var(--density-card-padding)] sm:flex-row">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") void refresh(); }} placeholder="Search business, contact or email" aria-label="Search applications" />
          <Select value={status} onChange={(event) => { setStatus(event.target.value); void refresh(); }} aria-label="Filter by status" className="sm:max-w-48">
            <option value="">All statuses</option>
            {["new", "reviewing", "approved", "invited", "active", "rejected", "expired", "revoked"].map((value) => <option key={value} value={value}>{value}</option>)}
          </Select>
          <Button variant="secondary" onClick={() => void refresh()}>Refresh</Button>
        </CardContent>
      </Card>

      {message ? <p role="status" className="text-sm text-muted-foreground">{message}</p> : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Applications</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Review interest before creating access.</p>
          </div>
          <span className="text-xs tabular-nums text-muted-foreground">{applications.length}</span>
        </CardHeader>
        <CardContent className="space-y-3">
          {!applications.length ? <p className="py-10 text-center text-sm text-muted-foreground">No applications found.</p> : null}
          {applications.map((application) => (
            <article key={application.id} className="rounded-md border border-line bg-background/40 p-4">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="text-sm font-semibold text-foreground">{application.businessName}</h3>
                    <StatusBadge value={application.status} />
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{application.contactPerson} · {application.email}{application.phone ? ` · ${application.phone}` : ""}</p>
                  <p className="mt-2 text-xs text-muted-foreground">{application.businessType?.replaceAll("_", " ") ?? "Business type not supplied"} · {application.cohort} · applied {date(application.createdAt)}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">{application.products.map((product) => <span key={product} className="rounded-full bg-secondary px-2 py-1 text-[11px] text-muted-foreground">{product.replace("kasitek_product_", "").replaceAll("_", " ")}</span>)}</div>
                  {application.notes ? <p className="mt-3 max-w-2xl whitespace-pre-wrap text-sm leading-5 text-foreground">{application.notes}</p> : null}
                  {application.decisionReason ? <p className="mt-3 text-xs text-muted-foreground">Reason: {application.decisionReason}</p> : null}
                  {application.earlyAccessEndsAt ? <p className="mt-2 text-xs text-muted-foreground">Access ends {date(application.earlyAccessEndsAt)}</p> : null}
                </div>

                <div className="flex shrink-0 flex-wrap gap-2 lg:justify-end">
                  {application.status === "new" ? <Button variant="secondary" size="sm" disabled={busyId === application.id} onClick={() => void startReview(application.id)}>Review</Button> : null}
                  {["new", "reviewing"].includes(application.status) ? <Button size="sm" disabled={busyId === application.id} onClick={() => beginApproval(application)}>Approve & invite</Button> : null}
                  {application.status === "reviewing" ? <Button variant="outline" size="sm" disabled={busyId === application.id} onClick={() => setRejectingId(application.id)}>Reject</Button> : null}
                  {application.status === "invited" ? <Button variant="secondary" size="sm" disabled={busyId === application.id} onClick={() => void post(application.id, "resend")}>Resend invite</Button> : null}
                  {["approved", "invited", "active"].includes(application.status) ? <Button variant="destructive" size="sm" disabled={busyId === application.id} onClick={() => setRevokeId(application.id)}>Revoke</Button> : null}
                </div>
              </div>

              {approvalId === application.id ? (
                <div className="mt-4 grid gap-4 border-t border-line pt-4 sm:grid-cols-2 lg:grid-cols-4">
                  <label className="space-y-1.5 text-xs font-medium text-foreground sm:col-span-2"><span>Workspace name</span><Input value={workspaceName} onChange={(event) => setWorkspaceName(event.target.value)} /></label>
                  <label className="space-y-1.5 text-xs font-medium text-foreground"><span>Days</span><Input type="number" min={1} max={365} value={durationDays} onChange={(event) => setDurationDays(event.target.value)} /></label>
                  <label className="space-y-1.5 text-xs font-medium text-foreground"><span>Credits</span><Input type="number" min={1} value={credits} onChange={(event) => setCredits(event.target.value)} /></label>
                  <fieldset className="sm:col-span-2 lg:col-span-4"><legend className="mb-2 text-xs font-medium text-foreground">Capabilities</legend><div className="flex flex-wrap gap-2">{capabilities.map(([key, label]) => <label key={key} className="flex items-center gap-2 rounded-md border border-line px-3 py-2 text-xs text-foreground"><input type="checkbox" checked={selectedCapabilities.includes(key)} onChange={() => setSelectedCapabilities((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key])} />{label}</label>)}</div></fieldset>
                  <div className="flex gap-2 sm:col-span-2 lg:col-span-4"><Button size="sm" disabled={busyId === application.id} onClick={() => void approve(application.id, application)}>{busyId === application.id ? "Creating…" : "Confirm approval"}</Button><Button variant="ghost" size="sm" onClick={() => setApprovalId(null)}>Cancel</Button></div>
                </div>
              ) : null}

              {rejectingId === application.id ? <div className="mt-4 border-t border-line pt-4"><label className="block text-xs font-medium text-foreground"><span>Rejection reason</span><Textarea value={rejectionReason} onChange={(event) => setRejectionReason(event.target.value)} className="mt-1.5" rows={3} /></label><div className="mt-3 flex gap-2"><Button variant="destructive" size="sm" disabled={busyId === application.id} onClick={() => void reject(application.id)}>Reject application</Button><Button variant="ghost" size="sm" onClick={() => setRejectingId(null)}>Cancel</Button></div></div> : null}
            </article>
          ))}
        </CardContent>
      </Card>

      <ConfirmModal open={Boolean(revokeId)} title="Revoke early access?" message="The invitation and unused early-access grants will be closed. Workspace data remains intact." confirmLabel="Revoke access" loading={Boolean(busyId)} onConfirm={() => void revoke()} onCancel={() => setRevokeId(null)} />
    </div>
  );
}
