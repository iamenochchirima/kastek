"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

const STATUS_COLORS: Record<string, string> = {
  draft: "bg-white/5 text-text-faint",
  active: "bg-green-500/15 text-green-400",
  paused: "bg-yellow-500/15 text-yellow-400",
  completed: "bg-blue-500/15 text-blue-400",
};

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

  async function handleDelete(id: string) {
    if (!confirm("Delete this campaign and all its leads?")) return;
    setDeleting(id);
    await fetch(`/api/outreach/${id}`, { method: "DELETE" });
    setDeleting(null);
    router.refresh();
  }

  return (
    <div className="bg-surface-raised rounded-xl border border-border overflow-hidden">
      {campaigns.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-text-faint">No campaigns yet</p>
          <Link
            href="/outreach/import"
            className="text-primary text-sm font-medium hover:underline mt-2 inline-block"
          >
            Import your first batch
          </Link>
        </div>
      ) : (
        <table className="w-full">
          <thead>
            <tr className="border-b border-border bg-surface-overlay">
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Campaign
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Status
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Leads
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Sent
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Replies
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Rate
              </th>
              <th className="text-left text-xs font-semibold text-text-muted uppercase tracking-wider px-4 py-3">
                Date
              </th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {campaigns.map((c) => {
              const rate = c.emailsSent > 0 ? Math.round((c.replies / c.emailsSent) * 100) : 0;
              return (
                <tr key={c.id} className="hover:bg-surface-overlay transition-colors">
                  <td className="px-4 py-3">
                    <Link href={`/outreach/${c.id}`} className="hover:text-primary">
                      <p className="font-medium text-sm text-text">{c.name}</p>
                      <p className="text-text-faint text-xs">{c.category}</p>
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`text-xs font-medium px-2.5 py-1 rounded-full capitalize ${STATUS_COLORS[c.status] || ""}`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-sm text-text">{c.totalLeads}</td>
                  <td className="px-4 py-3 text-sm text-text">{c.emailsSent}</td>
                  <td className="px-4 py-3 text-sm text-text">{c.replies}</td>
                  <td className="px-4 py-3 text-sm text-text">{rate}%</td>
                  <td className="px-4 py-3 text-xs text-text-muted">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <button
                      onClick={() => handleDelete(c.id)}
                      disabled={deleting === c.id}
                      className="text-xs text-red-400 hover:text-red-300 disabled:opacity-50"
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
    </div>
  );
}
