"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmModal from "@/components/admin/confirm-modal";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

const SOURCE_LABELS: Record<string, string> = {
  website: "Website",
  facebook: "Facebook",
  linkedin: "LinkedIn",
  cold_email: "Cold Email",
  referral: "Referral",
  whatsapp: "WhatsApp",
  walk_in: "Walk-in",
};

type Lead = {
  id: string;
  businessName: string;
  businessType: string;
  contactPerson: string;
  email: string;
  source: string;
  status: string;
  createdAt: string;
};

export default function LeadsTable({ leads }: { leads: Lead[] }) {
  const router = useRouter();
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleting, setDeleting] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const allSelected = leads.length > 0 && selected.size === leads.length;

  function enterSelectMode() {
    setSelectMode(true);
  }

  function exitSelectMode() {
    setSelectMode(false);
    setSelected(new Set());
  }

  function toggleAll() {
    setSelected(allSelected ? new Set() : new Set(leads.map((l) => l.id)));
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    setConfirmOpen(false);
    setError(null);
    setDeleting(true);
    const results = await Promise.allSettled(
      Array.from(selected).map((id) =>
        fetch(`/api/leads/${id}`, { method: "DELETE" })
      )
    );

    const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
    if (failed.length > 0) {
      setError(`Failed to delete ${failed.length} lead${failed.length > 1 ? "s" : ""}.`);
    }

    setSelected(new Set());
    setSelectMode(false);
    setDeleting(false);
    router.refresh();
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-3">
        {!selectMode ? (
          <button
            onClick={enterSelectMode}
            className={buttonClassName({ variant: "secondary", size: "sm" })}
          >
            Select
          </button>
        ) : (
          <>
            <button
              onClick={exitSelectMode}
              className={buttonClassName({ variant: "secondary", size: "sm" })}
            >
              Cancel
            </button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-muted-foreground">
                  {selected.size} selected
                </span>
                <button
                  onClick={() => setConfirmOpen(true)}
                  disabled={deleting}
                  className={buttonClassName({ variant: "destructive", size: "sm" })}
                >
                  {deleting ? "Deleting..." : "Delete selected"}
                </button>
              </>
            )}
          </>
        )}
      </div>

      {error ? <p role="status" className="text-sm text-status-danger">{error}</p> : null}

      <div className="admin-table-wrap">
        {leads.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-sm text-muted-foreground">No leads found</p>
          </div>
        ) : (
          <table className="w-full min-w-[700px]">
            <thead>
              <tr className="admin-table-head border-b border-border">
                {selectMode && (
                  <th className="px-4 py-3 w-10">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="rounded border-border accent-primary"
                    />
                  </th>
                )}
                <th className="px-4 py-3 text-left">
                  Business
                </th>
                <th className="px-4 py-3 text-left">
                  Contact
                </th>
                <th className="px-4 py-3 text-left">
                  Source
                </th>
                <th className="px-4 py-3 text-left">
                  Status
                </th>
                <th className="px-4 py-3 text-left">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={`transition-colors hover:bg-accent ${selectMode && selected.has(lead.id) ? "bg-primary/5" : ""}`}
                >
                  {selectMode && (
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(lead.id)}
                        onChange={() => toggleOne(lead.id)}
                        className="rounded border-border accent-primary"
                      />
                    </td>
                  )}
                  <td className="px-4 py-3">
                    <Link href={`/leads/${lead.id}`} className="group hover:text-primary">
                      <p className="text-sm font-medium text-foreground group-hover:text-primary">{lead.businessName}</p>
                      {lead.businessType ? (
                        <p className="text-xs capitalize text-muted-foreground">
                          {lead.businessType.replace(/_/g, " ")}
                        </p>
                      ) : null}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-foreground">{lead.contactPerson}</p>
                    <p className="text-xs text-muted-foreground">{lead.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-muted-foreground">
                      {SOURCE_LABELS[lead.source] || lead.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={lead.status} />
                  </td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <ConfirmModal
        open={confirmOpen}
        title={`Delete ${selected.size} lead${selected.size === 1 ? "" : "s"}?`}
        message="This action cannot be undone."
        confirmLabel="Delete"
        loading={deleting}
        onConfirm={() => void handleBulkDelete()}
        onCancel={() => setConfirmOpen(false)}
      />
    </>
  );
}
