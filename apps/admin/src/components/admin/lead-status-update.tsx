"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

const STATUSES = [
  { value: "new", label: "New", color: "bg-blue-500/15 text-blue-400" },
  { value: "contacted", label: "Contacted", color: "bg-purple-500/15 text-purple-400" },
  { value: "interested", label: "Interested", color: "bg-yellow-500/15 text-yellow-400" },
  { value: "quoted", label: "Quoted", color: "bg-orange-500/15 text-orange-400" },
  { value: "won", label: "Won", color: "bg-green-500/15 text-green-400" },
  { value: "lost", label: "Lost", color: "bg-white/5 text-text-faint" },
];

export default function LeadStatusUpdate({
  leadId,
  currentStatus,
}: {
  leadId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const updateStatus = async (status: string) => {
    if (status === currentStatus) return;
    setLoading(true);

    await fetch(`/api/leads/${leadId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });

    setLoading(false);
    router.refresh();
  };

  return (
    <div className="flex flex-wrap gap-2">
      {STATUSES.map((s) => (
        <button
          key={s.value}
          onClick={() => updateStatus(s.value)}
          disabled={loading}
          className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all ${
            s.value === currentStatus
              ? `${s.color} ring-2 ring-offset-1 ring-offset-surface-raised ring-primary/50`
              : "bg-surface-overlay text-text-faint hover:text-text-muted hover:bg-border"
          }`}
        >
          {s.label}
        </button>
      ))}
    </div>
  );
}
