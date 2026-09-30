"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ConfirmModal from "@/components/admin/confirm-modal";
import { StatusBadge } from "@/components/admin/status-badge";

type Campaign = {
  id: string;
  name: string;
  category: string;
  status: string;
  totalLeads: number;
  emailsSent: number;
  replies: number;
  createdAt: string;
};

export default function CampaignsTable({ campaigns }: { campaigns: Campaign[] }) {
  const router = useRouter();
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Campaign | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete(id: string) {
    setError(null);
    setPendingDelete(null);
    setDeleting(id);
    const response = await fetch(`/api/outreach/${id}`, { method: "DELETE" });
    if (!response.ok) setError("Unable to delete campaign.");
    setDeleting(null);
    router.refresh();
  }

  return (
    <div className="v-card overflow-hidden">
      {error ? <p role="alert" className="border-b border-status-danger/25 bg-status-danger-soft px-4 py-3 text-sm text-status-danger">{error}</p> : null}
      {campaigns.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm text-muted-foreground">No campaigns yet</p>
          <Link
            href="/outreach/import"
            className="mt-2 inline-block text-sm font-medium text-primary hover:underline"
          >
            Import your first batch
          </Link>
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="admin-table-head border-b border-line">
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Campaign
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Status
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Leads
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Sent
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Replies
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Rate
              </th>
              <th className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Date
              </th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {campaigns.map((c) => {
              const rate = c.emailsSent > 0 ? Math.round((c.replies / c.emailsSent) * 100) : 0;
              return (
                <tr key={c.id} className="transition-colors hover:bg-accent">
                  <td className="px-4 py-3">
                    <Link href={`/outreach/${c.id}`} className="group">
                      <p className="text-sm font-medium text-foreground group-hover:text-primary">{c.name}</p>
                      <p className="text-xs text-muted-foreground">{c.category}</p>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <StatusBadge value={c.status} />
                  </td>
                  <td className="px-4 py-3 text-sm text-foreground">{c.totalLeads}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{c.emailsSent}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{c.replies}</td>
                  <td className="px-4 py-3 text-sm text-foreground">{rate}%</td>
                  <td className="px-4 py-3 text-xs text-muted-foreground">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => setPendingDelete(c)}
                      disabled={deleting === c.id}
                      className="rounded-md px-2 py-1 text-xs font-medium text-status-danger transition-colors hover:bg-status-danger-soft disabled:opacity-50"
                    >
                      {deleting === c.id ? "..." : "Delete"}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <ConfirmModal
        open={pendingDelete !== null}
        title="Delete campaign?"
        message="This also removes all leads in the campaign. This action cannot be undone."
        confirmLabel="Delete"
        loading={pendingDelete !== null && deleting === pendingDelete.id}
        onConfirm={() => pendingDelete && void handleDelete(pendingDelete.id)}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}
