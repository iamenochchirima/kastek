"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { StatusBadge } from "@/components/admin/status-badge";
import { buttonClassName } from "@/components/ui/button";

export default function AgencyStatusToggle({
  workspaceId,
  currentStatus,
}: {
  workspaceId: string;
  currentStatus: string;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  const isActive = currentStatus === "active";
  const nextStatus = isActive ? "suspended" : "active";

  async function toggle() {
    setLoading(true);
    await fetch(`/api/agencies/${workspaceId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: nextStatus }),
    });
    router.refresh();
    setLoading(false);
  }

  return (
    <div className="flex items-center gap-3">
      <StatusBadge value={currentStatus} />
      <button
        onClick={toggle}
        disabled={loading}
        className={buttonClassName({ variant: isActive ? "destructive" : "primary", size: "sm" })}
      >
        {loading ? "…" : isActive ? "Suspend" : "Activate"}
      </button>
    </div>
  );
}
