"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { StatusBadge } from "@/components/admin/status-badge";

const STATUSES = [
  { value: "new", label: "New" },
  { value: "contacted", label: "Contacted" },
  { value: "interested", label: "Interested" },
  { value: "quoted", label: "Quoted" },
  { value: "won", label: "Won" },
  { value: "lost", label: "Lost" },
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
          className={cn("rounded-full border border-transparent px-3 py-1.5 text-xs font-medium transition-all", s.value === currentStatus
              ? "bg-primary/10 text-primary ring-2 ring-primary/25 ring-offset-1 ring-offset-background"
              : "border-line bg-secondary text-muted-foreground hover:bg-accent hover:text-foreground")}
        >
          <StatusBadge value={s.value} className="border-0 bg-transparent px-0 py-0 text-inherit" />
        </button>
      ))}
    </div>
  );
}
