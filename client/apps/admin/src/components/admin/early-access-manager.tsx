"use client";

import { useMemo, useState } from "react";
import ConfirmModal from "@/components/admin/confirm-modal";
import { StatusBadge } from "@/components/admin/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const PACKAGE_KEY = "beta-2026-01";
const STATUSES = ["new", "approved", "invited", "active", "rejected", "expired", "revoked"];

export type EarlyAccessApplication = {
  id: string;
  businessName: string;
  contactPerson: string;
  email: string;
  products: string[];
  notes: string | null;
  status: string;
  cohort: string;
  decisionReason: string | null;
  organizationId: string | null;
  earlyAccessInvitationId: string | null;
  invitationStatus?: string | null;
  invitationDeliveryStatus?: string | null;
  invitationExpiresAt?: string | null;
  activatedAt: string | null;
  earlyAccessEndsAt: string | null;
  createdAt: string;
};

type BatchApproveResponse = {
  approved?: number;
  invited?: number;
  alreadyProcessed?: number;
  failed?: number;
};

export function EarlyAccessManager({
  initialApplications,
}: {
  initialApplications: EarlyAccessApplication[];
}) {
  const [applications, setApplications] = useState(initialApplications);
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [confirmIds, setConfirmIds] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  const selectable = useMemo(
    () => applications.filter((item) => item.status === "new").map((item) => item.id),
    [applications],
  );
  const allSelected = selectable.length > 0 && selectable.every((id) => selected.includes(id));

  async function refresh(nextStatus = status, nextSearch = search) {
    try {
      const params = new URLSearchParams();
      if (nextStatus) params.set("status", nextStatus);
      if (nextSearch.trim()) params.set("search", nextSearch.trim());
      const response = await fetch(`/api/core/admin/early-access?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) {
        setMessage("Unable to load applications.");
        return;
      }
      setApplications((await response.json()).applications ?? []);
      setSelected([]);
    } catch {
      setMessage("Unable to load applications.");
    }
  }

  async function approve(ids: string[]) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        ids.length === 1
          ? `/api/core/admin/early-access/${ids[0]}/approve`
          : "/api/core/admin/early-access/batch-approve",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            ids.length === 1
              ? { packageKey: PACKAGE_KEY }
              : { applicationIds: ids, packageKey: PACKAGE_KEY },
          ),
        },
      );
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error ?? "Unable to approve applications.");

      if (ids.length === 1) {
        const deliveryFailed = body.application?.invitationDeliveryStatus === "failed";
        setMessage(
          deliveryFailed
            ? "Approval saved; invitation delivery needs attention."
            : "Invitation created.",
        );
      } else {
        const result = body as BatchApproveResponse;
        const failed = result.failed ?? 0;
        const invited = result.invited ?? 0;
        const approved = result.approved ?? 0;
        const skipped = result.alreadyProcessed ?? 0;
        setMessage(
          failed
            ? `${invited} invitations sent; ${failed} need attention.`
            : `${invited || approved} approvals saved${skipped ? `; ${skipped} skipped` : ""}.`,
        );
      }
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to approve applications.");
    } finally {
      setBusy(false);
      setConfirmIds(null);
    }
  }

  async function reject(id: string) {
    if (!reason.trim()) {
      setMessage("A rejection reason is required.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/core/admin/early-access/${id}/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({}))).error ?? "Unable to reject application.",
        );
      }
      setRejecting(null);
      setReason("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to reject application.");
    } finally {
      setBusy(false);
    }
  }

  async function resend(id: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/core/admin/early-access/${id}/resend`, {
        method: "POST",
      });
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({}))).error ?? "Unable to resend invitation.",
        );
      }
      setMessage("Invitation resent.");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to resend invitation.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    if (!reason.trim()) {
      setMessage("A revocation reason is required.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/core/admin/early-access/${id}/revoke`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({}))).error ?? "Unable to revoke access.",
        );
      }
      setRevoking(null);
      setReason("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to revoke access.");
    } finally {
      setBusy(false);
    }
  }

  async function restore(id: string) {
    if (!reason.trim()) {
      setMessage("A restoration reason is required.");
      return;
    }
    setBusy(true);
    try {
      const response = await fetch(`/api/core/admin/early-access/${id}/restore`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: reason.trim() }),
      });
      if (!response.ok) {
        throw new Error(
          (await response.json().catch(() => ({}))).error ?? "Unable to restore access.",
        );
      }
      setRevoking(null);
      setReason("");
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to restore access.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4">
      {message ? (
        <p role="status" className="rounded-md border border-line bg-card px-3 py-2 text-sm text-foreground">
          {message}
        </p>
      ) : null}

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Applications</CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">Approve beta access.</p>
          </div>
          <span className="text-xs text-muted-foreground">{applications.length}</span>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 sm:flex-row">
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search applications"
            aria-label="Search applications"
            onKeyDown={(event) => {
              if (event.key === "Enter") void refresh();
            }}
          />
          <Select
            value={status}
            aria-label="Filter applications by status"
            onChange={(event) => {
              const nextStatus = event.target.value;
              setStatus(nextStatus);
              void refresh(nextStatus, search);
            }}
          >
            <option value="">All statuses</option>
            {STATUSES.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </Select>
          <Button variant="secondary" onClick={() => void refresh()}>
            Refresh
          </Button>
        </CardContent>
      </Card>

      {selectable.length ? (
        <div className="sticky bottom-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-line bg-card p-3 shadow-lg">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              aria-label="Select all new applications on this page"
              checked={allSelected}
              onChange={(event) => setSelected(event.target.checked ? selectable : [])}
            />
            Select page
          </label>
          <Button
            size="sm"
            disabled={!selected.length || busy}
            onClick={() => setConfirmIds(selected)}
          >
            Approve selected ({selected.length})
          </Button>
        </div>
      ) : null}

      <Card>
        <CardContent className="divide-y divide-line p-0">
          {applications.map((item) => (
            <article key={item.id} className="space-y-3 p-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center">
                      <input
                        aria-label={`Select ${item.businessName}`}
                        type="checkbox"
                        disabled={item.status !== "new" || busy}
                        checked={selected.includes(item.id)}
                        onChange={(event) =>
                          setSelected((current) =>
                            event.target.checked
                              ? [...current, item.id]
                              : current.filter((id) => id !== item.id),
                          )
                        }
                      />
                    </label>
                    <strong>{item.businessName}</strong>
                    <StatusBadge value={item.status} />
                  </div>
                  <p className="mt-1 text-sm text-muted-foreground">
                    {item.contactPerson} · {item.email}
                  </p>
                  {item.products.length ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {item.products.join(" · ")}
                    </p>
                  ) : null}
                  {item.invitationDeliveryStatus === "failed" ? (
                    <p className="mt-2 text-xs text-destructive">Invitation email failed.</p>
                  ) : null}
                </div>

                <div className="flex flex-wrap gap-2">
                  {item.status === "new" ? (
                    <>
                      <Button size="sm" disabled={busy} onClick={() => setConfirmIds([item.id])}>
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => {
                          setRejecting(item.id);
                          setRevoking(null);
                          setReason("");
                        }}
                      >
                        Reject
                      </Button>
                    </>
                  ) : null}
                  {["approved", "invited"].includes(item.status) ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => void resend(item.id)}
                    >
                      Resend invite
                    </Button>
                  ) : null}
                  {["approved", "invited", "active"].includes(item.status) ? (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={busy}
                      onClick={() => {
                        setRevoking(item.id);
                        setRejecting(null);
                        setReason("");
                      }}
                    >
                      Revoke
                    </Button>
                  ) : null}
                  {item.status === "revoked" ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={busy}
                      onClick={() => {
                        setRevoking(item.id);
                        setReason("");
                      }}
                    >
                      Restore
                    </Button>
                  ) : null}
                </div>
              </div>

              {rejecting === item.id ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder="Rejection reason"
                  />
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void reject(item.id)}
                  >
                    Reject
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRejecting(null)}>
                    Cancel
                  </Button>
                </div>
              ) : null}

              {revoking === item.id ? (
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Textarea
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                    placeholder={item.status === "revoked" ? "Restoration reason" : "Revocation reason"}
                  />
                  <Button
                    size="sm"
                    variant={item.status === "revoked" ? "secondary" : "destructive"}
                    disabled={busy}
                    onClick={() =>
                      void (item.status === "revoked" ? restore(item.id) : revoke(item.id))
                    }
                  >
                    {item.status === "revoked" ? "Restore" : "Revoke"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setRevoking(null)}>
                    Cancel
                  </Button>
                </div>
              ) : null}
            </article>
          ))}
          {!applications.length ? <p className="p-6 text-sm text-muted-foreground">No applications</p> : null}
        </CardContent>
      </Card>

      <ConfirmModal
        open={Boolean(confirmIds)}
        title={confirmIds?.length === 1 ? "Approve application?" : `Approve ${confirmIds?.length ?? 0} applications?`}
        message="Each applicant will receive a seven-day signup invitation. KasiTek will not create a workspace for them."
        confirmLabel="Approve & invite"
        confirmVariant="primary"
        loadingLabel="Approving…"
        loading={busy}
        onConfirm={() => confirmIds && void approve(confirmIds)}
        onCancel={() => setConfirmIds(null)}
      />
    </div>
  );
}
