"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  new: "bg-blue-500/15 text-blue-400",
  contacted: "bg-purple-500/15 text-purple-400",
  interested: "bg-yellow-500/15 text-yellow-400",
  quoted: "bg-orange-500/15 text-orange-400",
  won: "bg-green-500/15 text-green-400",
  lost: "bg-white/5 text-text-faint",
};

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
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  async function handleBulkDelete() {
    if (!confirm(`Delete ${selected.size} lead${selected.size > 1 ? "s" : ""}? This cannot be undone.`)) {
      return;
    }

    setDeleting(true);
    const results = await Promise.allSettled(
      Array.from(selected).map((id) =>
        fetch(`/api/leads/${id}`, { method: "DELETE" })
      )
    );

    const failed = results.filter((r) => r.status === "rejected" || (r.status === "fulfilled" && !r.value.ok));
    if (failed.length > 0) {
      alert(`Failed to delete ${failed.length} lead${failed.length > 1 ? "s" : ""}.`);
    }

    setSelected(new Set());
    setSelectMode(false);
    setDeleting(false);
    router.refresh();
  }

  return (
    <>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        {!selectMode ? (
          <button
            onClick={enterSelectMode}
            className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
          >
            Select
          </button>
        ) : (
          <>
            <button
              onClick={exitSelectMode}
              className="text-xs font-medium text-text-muted hover:text-text px-3 py-1.5 rounded-lg border border-border hover:bg-surface-overlay transition-colors"
            >
              Cancel
            </button>
            {selected.size > 0 && (
              <>
                <span className="text-xs text-text-muted">
                  {selected.size} selected
                </span>
                <button
                  onClick={handleBulkDelete}
                  disabled={deleting}
                  className="bg-red-600 hover:bg-red-700 text-white px-3 py-1 rounded-full text-xs font-medium transition-colors disabled:opacity-50"
                >
                  {deleting ? "Deleting..." : "Delete selected"}
                </button>
              </>
            )}
          </>
        )}
      </div>

      <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
        {leads.length === 0 ? (
          <div className="p-12 text-center">
            <p className="text-text-faint">No leads found</p>
          </div>
        ) : (
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-surface-overlay">
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
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Business
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Contact
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Source
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Status
                </th>
                <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                  Date
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {leads.map((lead) => (
                <tr
                  key={lead.id}
                  className={`hover:bg-surface-overlay transition-colors ${selectMode && selected.has(lead.id) ? "bg-primary/5" : ""}`}
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
                    <Link href={`/leads/${lead.id}`} className="hover:text-primary">
                      <p className="font-medium text-sm text-text">{lead.businessName}</p>
                      <p className="text-text-faint text-xs capitalize">
                        {lead.businessType.replace(/_/g, " ")}
                      </p>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <p className="text-sm text-text">{lead.contactPerson}</p>
                    <p className="text-text-faint text-xs">{lead.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className="text-xs text-text-muted">
                      {SOURCE_LABELS[lead.source] || lead.source}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${
                        STATUS_COLORS[lead.status] || ""
                      }`}
                    >
                      {lead.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {new Date(lead.createdAt).toLocaleDateString()}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
